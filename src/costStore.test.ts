import { describe, expect, it, beforeEach, vi } from "vitest";
import { createCostStore, type CostStore } from "./costStore";

// Mock localStorage for testing persistence
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

describe("createCostStore", () => {
  let store: CostStore;

  beforeEach(() => {
    localStorageMock.clear();
    store = createCostStore();
  });

  it("starts with zero cost", () => {
    const state = store.getState();
    expect(state.totalCostUsd).toBe(0);
    expect(state.agents.size).toBe(0);
    expect(state.costLimitUsd).toBeNull();
  });

  it("reportUsage calculates cost correctly", () => {
    // 1000 prompt tokens at $3/M + 500 completion tokens at $15/M
    // = (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1_000_000 = $0.0105
    store.reportUsage("agent-1", "developer", "claude-sonnet", 1000, 500, 3.0, 15.0);

    const state = store.getState();
    expect(state.totalCostUsd).toBeCloseTo(0.0105, 6);
    expect(state.agents.size).toBe(1);
    const agent = state.agents.get("agent-1")!;
    expect(agent.promptTokens).toBe(1000);
    expect(agent.completionTokens).toBe(500);
    expect(agent.costUsd).toBeCloseTo(0.0105, 6);
    expect(agent.role).toBe("developer");
    expect(agent.modelName).toBe("claude-sonnet");
  });

  it("reportUsage accumulates across multiple calls", () => {
    store.reportUsage("agent-1", "developer", "model", 1000, 0, 1.0, 1.0);
    store.reportUsage("agent-1", "developer", "model", 2000, 0, 1.0, 1.0);

    const agent = store.getState().agents.get("agent-1")!;
    expect(agent.promptTokens).toBe(3000);
    // Cost = (1000 + 2000) * 1.0 / 1_000_000 = 0.003
    expect(agent.costUsd).toBeCloseTo(0.003, 6);
  });

  it("reportUsage tracks multiple agents separately", () => {
    store.reportUsage("agent-1", "developer", "model", 1000, 0, 1.0, 1.0);
    store.reportUsage("agent-2", "worker", "model", 500, 0, 1.0, 1.0);

    const state = store.getState();
    expect(state.agents.size).toBe(2);
    expect(state.agents.get("agent-1")!.promptTokens).toBe(1000);
    expect(state.agents.get("agent-2")!.promptTokens).toBe(500);
    // Total cost = (1000 + 500) * 1.0 / 1_000_000
    expect(state.totalCostUsd).toBeCloseTo(0.0015, 6);
  });

  it("setCostLimit persists to localStorage", () => {
    store.setCostLimit(10.0);
    expect(store.getState().costLimitUsd).toBe(10.0);
    expect(localStorageMock.getItem("monkeyland-cost-limit")).toBe("10");

    store.setCostLimit(null);
    expect(store.getState().costLimitUsd).toBeNull();
    expect(localStorageMock.getItem("monkeyland-cost-limit")).toBeNull();
  });

  it("reset clears agents and totalCost but preserves costLimit", () => {
    store.reportUsage("agent-1", "dev", "model", 1000, 500, 3.0, 15.0);
    store.setCostLimit(50.0);

    store.reset();
    const state = store.getState();
    expect(state.totalCostUsd).toBe(0);
    expect(state.agents.size).toBe(0);
    expect(state.costLimitUsd).toBe(50.0);
  });

  it("subscribe notifies on reportUsage", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.reportUsage("a", "dev", "m", 100, 50, 1.0, 1.0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications", () => {
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    unsub();
    store.reportUsage("a", "dev", "m", 100, 50, 1.0, 1.0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("reportUsage persists to localStorage", () => {
    store.reportUsage("agent-1", "dev", "model", 1000, 500, 3.0, 15.0);
    const raw = localStorageMock.getItem("monkeyland-cost-state");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.totalCostUsd).toBeGreaterThan(0);
    expect(parsed.agents).toHaveLength(1);
  });

  it("loads persisted state on creation", () => {
    store.reportUsage("agent-1", "dev", "model", 1000, 500, 3.0, 15.0);
    store.setCostLimit(25.0);
    const savedTotal = store.getState().totalCostUsd;

    // Create a new store — should load from localStorage
    const store2 = createCostStore();
    expect(store2.getState().totalCostUsd).toBeCloseTo(savedTotal, 6);
    expect(store2.getState().costLimitUsd).toBe(25.0);
    expect(store2.getState().agents.size).toBe(1);
  });

  // BUG PROBE: Zero pricing should result in zero cost, not NaN or error
  it("handles zero pricing gracefully", () => {
    store.reportUsage("agent-free", "worker", "local-model", 10000, 5000, 0, 0);
    const agent = store.getState().agents.get("agent-free")!;
    expect(agent.costUsd).toBe(0);
    expect(agent.promptTokens).toBe(10000);
  });

  // BUG PROBE: Very large token counts should not cause overflow
  it("handles large token counts", () => {
    store.reportUsage("agent-big", "dev", "model", 1_000_000, 500_000, 3.0, 15.0);
    const agent = store.getState().agents.get("agent-big")!;
    // Cost = (1M * 3 + 500K * 15) / 1M = 3 + 7.5 = $10.50
    expect(agent.costUsd).toBeCloseTo(10.5, 2);
  });

  // BUG PROBE: Malformed localStorage should not crash store creation
  it("handles corrupted localStorage gracefully", () => {
    localStorageMock.setItem("monkeyland-cost-state", "not json {{{");
    localStorageMock.setItem("monkeyland-cost-limit", "not a number");
    const safeStore = createCostStore();
    expect(safeStore.getState().totalCostUsd).toBe(0);
    expect(safeStore.getState().costLimitUsd).toBeNull();
  });

  // BUG PROBE: Negative cost limit should be rejected by loader
  it("rejects negative cost limit from localStorage", () => {
    localStorageMock.setItem("monkeyland-cost-limit", "-5");
    const safeStore = createCostStore();
    expect(safeStore.getState().costLimitUsd).toBeNull();
  });
});
