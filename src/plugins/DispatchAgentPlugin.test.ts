import { describe, expect, it, vi } from "vitest";
import { DispatchAgentPlugin, type DispatchAgentFn } from "./DispatchAgentPlugin";

describe("DispatchAgentPlugin", () => {
  const mockDispatch: DispatchAgentFn = vi.fn(async () => "spawned-id-123");

  it("has correct name and is enabled", () => {
    const plugin = new DispatchAgentPlugin("wm-1", mockDispatch);
    expect(plugin.getName()).toBe("dispatch_agent");
    expect(plugin.isEnabled()).toBe(true);
  });

  it("requires task_description parameter", () => {
    const plugin = new DispatchAgentPlugin("wm-1", mockDispatch);
    const params = plugin.getParameters();
    const taskDesc = params.find((p) => p.name === "task_description");
    expect(taskDesc).toBeDefined();
    expect(taskDesc!.required).toBe(true);
  });

  it("dispatches operator with valid task_description", async () => {
    const dispatch = vi.fn(async () => "agent-xyz");
    const plugin = new DispatchAgentPlugin("wm-1", dispatch);
    const result = await plugin.execute({}, {
      task_description: "Browse example.com and summarize",
    });

    expect(result.result).toContain("Agent dispatched");
    expect(result.result).toContain("agent-xyz");
    expect(dispatch).toHaveBeenCalledWith({
      role: "operator",
      taskDescription: "Browse example.com and summarize",
      parentAgentId: "wm-1",
    });
  });

  it("rejects empty task_description", async () => {
    const plugin = new DispatchAgentPlugin("wm-1", mockDispatch);
    const result = await plugin.execute({}, { task_description: "" });
    expect(result.result).toContain("Error");
    expect(result.result).toContain("task_description is required");
  });

  it("rejects whitespace-only task_description", async () => {
    const plugin = new DispatchAgentPlugin("wm-1", mockDispatch);
    const result = await plugin.execute({}, { task_description: "   " });
    expect(result.result).toContain("Error");
  });

  it("rejects role='developer' to enforce Beads workflow", async () => {
    const plugin = new DispatchAgentPlugin("wm-1", mockDispatch);
    const result = await plugin.execute({}, {
      task_description: "Write a new feature",
      role: "developer",
    });
    expect(result.result).toContain("Error");
    expect(result.result).toContain("developer");
    expect(result.result).toContain("Beads");
  });

  it("rejects role='worker' to enforce Beads workflow", async () => {
    const plugin = new DispatchAgentPlugin("wm-1", mockDispatch);
    const result = await plugin.execute({}, {
      task_description: "Do some work",
      role: "worker",
    });
    expect(result.result).toContain("Error");
    expect(result.result).toContain("worker");
  });

  it("falls back to operator when no role specified", async () => {
    const dispatch = vi.fn(async () => "op-1");
    const plugin = new DispatchAgentPlugin("wm-1", dispatch);
    await plugin.execute({}, { task_description: "check something" });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ role: "operator" }),
    );
  });

  it("returns error when dispatch function throws", async () => {
    const failingDispatch: DispatchAgentFn = vi.fn(async () => {
      throw new Error("spawn limit reached");
    });
    const plugin = new DispatchAgentPlugin("wm-1", failingDispatch);
    const result = await plugin.execute({}, {
      task_description: "do something",
    });
    expect(result.result).toContain("Error");
    expect(result.result).toContain("spawn limit reached");
  });

  it("shows running description with truncated task", () => {
    const plugin = new DispatchAgentPlugin("wm-1", mockDispatch);
    const desc = plugin.getRunningDescription("dispatch_agent", {
      task_description: "A".repeat(100),
    });
    expect(desc.length).toBeLessThan(110);
    expect(desc).toContain("Dispatching agent");
  });
});
