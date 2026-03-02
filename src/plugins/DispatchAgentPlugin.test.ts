import { describe, expect, it, vi } from "vitest";
import { DispatchAgentPlugin, type DispatchAgentFn } from "./DispatchAgentPlugin";

describe("DispatchAgentPlugin", () => {
  const noopDispatch: DispatchAgentFn = vi.fn(async () => "spawned-id");

  // BUG PROBE: LLM passes role="developer" to bypass Beads workflow.
  // This must be rejected — developer agents need a Beads task to get
  // a worktree and go through the merge train.
  it("rejects developer role to prevent Beads bypass", async () => {
    const dispatch = vi.fn(async () => "evil-dev");
    const plugin = new DispatchAgentPlugin("wm-1", dispatch);
    const result = await plugin.execute({}, {
      task_description: "implement feature X",
      role: "developer",
    });

    expect(result.result).toContain("Error");
    expect(result.result).toContain("developer");
    expect(dispatch).not.toHaveBeenCalled();
  });

  // BUG PROBE: Same for worker role
  it("rejects worker role to prevent Beads bypass", async () => {
    const dispatch = vi.fn(async () => "evil-worker");
    const plugin = new DispatchAgentPlugin("wm-1", dispatch);
    const result = await plugin.execute({}, {
      task_description: "run tests",
      role: "worker",
    });

    expect(result.result).toContain("Error");
    expect(dispatch).not.toHaveBeenCalled();
  });

  // BUG PROBE: LLM passes role="Developer" (capitalized). Does the check
  // still catch it? If it only checks === "developer", uppercase bypasses.
  it("rejects case-variant role strings", async () => {
    const dispatch = vi.fn(async () => "bypass-id");
    const plugin = new DispatchAgentPlugin("wm-1", dispatch);

    const r1 = await plugin.execute({}, {
      task_description: "x",
      role: "Developer",
    });
    const r2 = await plugin.execute({}, {
      task_description: "x",
      role: "WORKER",
    });

    // If either of these dispatched successfully, the case check is broken
    expect(dispatch).not.toHaveBeenCalled();
    expect(r1.result).toContain("Error");
    expect(r2.result).toContain("Error");
  });

  // BUG PROBE: role parameter is set to something unexpected like
  // "merge_agent" or "validator" — should these be blocked?
  it("allows non-blocked role values (falls back to operator)", async () => {
    const dispatch = vi.fn(async () => "op-id");
    const plugin = new DispatchAgentPlugin("wm-1", dispatch);
    const result = await plugin.execute({}, {
      task_description: "check something",
      role: "validator", // not in the blocked list
    });

    // Current behavior: any role not "developer"/"worker" gets silently
    // overridden to "operator". This is safe but surprising.
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ role: "operator" }),
    );
    expect(result.result).toContain("Agent dispatched");
  });

  // BUG PROBE: Empty task description — LLM sends "" or whitespace
  it("rejects empty/whitespace task_description", async () => {
    const plugin = new DispatchAgentPlugin("wm-1", noopDispatch);

    const r1 = await plugin.execute({}, { task_description: "" });
    const r2 = await plugin.execute({}, { task_description: "   " });
    const r3 = await plugin.execute({}, { task_description: "\n\t" });

    expect(r1.result).toContain("Error");
    expect(r2.result).toContain("Error");
    expect(r3.result).toContain("Error");
  });

  // BUG PROBE: dispatchAgent throws — should surface the error, not crash
  it("surfaces dispatch errors cleanly", async () => {
    const failing: DispatchAgentFn = vi.fn(async () => {
      throw new Error("Role operator at max_count 10");
    });
    const plugin = new DispatchAgentPlugin("wm-1", failing);
    const result = await plugin.execute({}, {
      task_description: "do something",
    });

    expect(result.result).toContain("Error");
    expect(result.result).toContain("max_count");
  });

  // BUG PROBE: XSS/injection in task_description — the description is
  // passed directly to the backend. Does it contain script tags?
  it("passes task_description through to dispatch verbatim", async () => {
    const dispatch = vi.fn(async () => "id");
    const plugin = new DispatchAgentPlugin("wm-1", dispatch);
    const malicious = '<script>alert("xss")</script>';

    await plugin.execute({}, { task_description: malicious });

    // The description should be passed through as-is (no escaping at plugin level)
    // — it's the backend's job to sanitize if needed
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ taskDescription: malicious }),
    );
  });
});
