import { describe, expect, it } from "vitest";
import {
  getDefaultSize,
  getMinSize,
  type CanvasNodeType,
  PROMPT_CARD_DEFAULT_W, PROMPT_CARD_DEFAULT_H,
  PROMPT_CARD_MIN_W, PROMPT_CARD_MIN_H,
  SESSION_CARD_DEFAULT_W, SESSION_CARD_DEFAULT_H,
  SESSION_CARD_MIN_W, SESSION_CARD_MIN_H,
  WORKER_CARD_DEFAULT_W, WORKER_CARD_DEFAULT_H,
  WORKER_CARD_MIN_W, WORKER_CARD_MIN_H,
  VALIDATOR_CARD_DEFAULT_W, VALIDATOR_CARD_DEFAULT_H,
  BEADS_CARD_DEFAULT_W, BEADS_CARD_DEFAULT_H,
  BEADS_CARD_MIN_W, BEADS_CARD_MIN_H,
  BEADS_TASK_CARD_DEFAULT_W, BEADS_TASK_CARD_DEFAULT_H,
  BEADS_TASK_CARD_MIN_W, BEADS_TASK_CARD_MIN_H,
  TERMINAL_LOG_DEFAULT_W, TERMINAL_LOG_DEFAULT_H,
  TERMINAL_LOG_MIN_W, TERMINAL_LOG_MIN_H,
} from "./types";

describe("getDefaultSize", () => {
  it("returns correct size for prompt", () => {
    expect(getDefaultSize("prompt")).toEqual({ w: PROMPT_CARD_DEFAULT_W, h: PROMPT_CARD_DEFAULT_H });
  });

  it("returns correct size for worker", () => {
    expect(getDefaultSize("worker")).toEqual({ w: WORKER_CARD_DEFAULT_W, h: WORKER_CARD_DEFAULT_H });
  });

  it("returns correct size for validator", () => {
    expect(getDefaultSize("validator")).toEqual({ w: VALIDATOR_CARD_DEFAULT_W, h: VALIDATOR_CARD_DEFAULT_H });
  });

  it("returns correct size for beads", () => {
    expect(getDefaultSize("beads")).toEqual({ w: BEADS_CARD_DEFAULT_W, h: BEADS_CARD_DEFAULT_H });
  });

  it("returns correct size for beads_task", () => {
    expect(getDefaultSize("beads_task")).toEqual({ w: BEADS_TASK_CARD_DEFAULT_W, h: BEADS_TASK_CARD_DEFAULT_H });
  });

  it("returns correct size for terminal_log", () => {
    expect(getDefaultSize("terminal_log")).toEqual({ w: TERMINAL_LOG_DEFAULT_W, h: TERMINAL_LOG_DEFAULT_H });
  });

  it("falls back to session card defaults for agent type", () => {
    expect(getDefaultSize("agent")).toEqual({ w: SESSION_CARD_DEFAULT_W, h: SESSION_CARD_DEFAULT_H });
  });

  it("falls back to session card defaults for terminal type", () => {
    expect(getDefaultSize("terminal")).toEqual({ w: SESSION_CARD_DEFAULT_W, h: SESSION_CARD_DEFAULT_H });
  });

  it("falls back to session card defaults for browser type", () => {
    expect(getDefaultSize("browser")).toEqual({ w: SESSION_CARD_DEFAULT_W, h: SESSION_CARD_DEFAULT_H });
  });

  // BUG PROBE: all returned sizes should have positive w and h
  it("all node types return positive dimensions", () => {
    const types: CanvasNodeType[] = ["prompt", "agent", "terminal", "terminal_log", "browser", "worker", "validator", "beads", "beads_task"];
    for (const t of types) {
      const size = getDefaultSize(t);
      expect(size.w).toBeGreaterThan(0);
      expect(size.h).toBeGreaterThan(0);
    }
  });
});

describe("getMinSize", () => {
  it("returns correct min size for prompt", () => {
    expect(getMinSize("prompt")).toEqual({ w: PROMPT_CARD_MIN_W, h: PROMPT_CARD_MIN_H });
  });

  it("returns correct min size for worker", () => {
    expect(getMinSize("worker")).toEqual({ w: WORKER_CARD_MIN_W, h: WORKER_CARD_MIN_H });
  });

  // BUG PROBE: validator uses WORKER_CARD_MIN values in the code (intentional? or copy-paste bug?)
  it("validator min size uses worker card minimums (documents current behavior)", () => {
    const size = getMinSize("validator");
    expect(size).toEqual({ w: WORKER_CARD_MIN_W, h: WORKER_CARD_MIN_H });
  });

  it("returns correct min size for beads", () => {
    expect(getMinSize("beads")).toEqual({ w: BEADS_CARD_MIN_W, h: BEADS_CARD_MIN_H });
  });

  it("returns correct min size for beads_task", () => {
    expect(getMinSize("beads_task")).toEqual({ w: BEADS_TASK_CARD_MIN_W, h: BEADS_TASK_CARD_MIN_H });
  });

  it("returns correct min size for terminal_log", () => {
    expect(getMinSize("terminal_log")).toEqual({ w: TERMINAL_LOG_MIN_W, h: TERMINAL_LOG_MIN_H });
  });

  it("falls back to session card minimums for unknown types", () => {
    expect(getMinSize("agent")).toEqual({ w: SESSION_CARD_MIN_W, h: SESSION_CARD_MIN_H });
  });

  // BUG PROBE: min sizes should never exceed default sizes
  it("min sizes never exceed default sizes", () => {
    const types: CanvasNodeType[] = ["prompt", "agent", "terminal", "terminal_log", "browser", "worker", "validator", "beads", "beads_task"];
    for (const t of types) {
      const def = getDefaultSize(t);
      const min = getMinSize(t);
      expect(min.w).toBeLessThanOrEqual(def.w);
      expect(min.h).toBeLessThanOrEqual(def.h);
    }
  });

  // BUG PROBE: all returned min sizes should be positive
  it("all node types return positive min dimensions", () => {
    const types: CanvasNodeType[] = ["prompt", "agent", "terminal", "terminal_log", "browser", "worker", "validator", "beads", "beads_task"];
    for (const t of types) {
      const size = getMinSize(t);
      expect(size.w).toBeGreaterThan(0);
      expect(size.h).toBeGreaterThan(0);
    }
  });
});
