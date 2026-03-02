import { describe, expect, it, vi, beforeEach } from "vitest";
import { CompleteTaskPlugin } from "./CompleteTaskPlugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

describe("CompleteTaskPlugin", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  // BUG PROBE: merge_agent with null taskId should NOT call beads_run.
  // If it does, it would prematurely mark the task "done" before the
  // actual git merge succeeds.
  it("merge_agent (null taskId) must NOT update Beads status", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // agent_complete_task

    const plugin = new CompleteTaskPlugin("merge-1", null);
    const result = await plugin.execute({}, {});

    expect(result.result).toBe("Task completed.");
    // Must have called ONLY agent_complete_task, nothing else
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("agent_complete_task", {
      agentId: "merge-1",
    });
    // Specifically must NOT call get_beads_project_path or beads_run
    const callNames = mockInvoke.mock.calls.map((c) => c[0]);
    expect(callNames).not.toContain("get_beads_project_path");
    expect(callNames).not.toContain("beads_run");
  });

  // BUG PROBE: agent_complete_task fails (e.g. developer calling this
  // when they should use yield_for_review). The Beads update should NOT
  // run — otherwise the task is marked "done" in Beads while the agent
  // state machine rejected the transition.
  it("does NOT update Beads when state transition fails", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Developers cannot self-complete"));

    const plugin = new CompleteTaskPlugin("dev-1", "bd-42");
    const result = await plugin.execute({}, {});

    expect(result.result).toContain("Error");
    expect(result.result).toContain("self-complete");
    // beads_run should NOT have been called
    const callNames = mockInvoke.mock.calls.map((c) => c[0]);
    expect(callNames).not.toContain("beads_run");
  });

  // BUG PROBE: Beads update fails but the state transition succeeded.
  // The task is now in "Done" state in the registry but NOT marked "done"
  // in Beads. This is a known best-effort gap.
  it("succeeds even when Beads update fails (best-effort)", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // agent_complete_task OK
    mockInvoke.mockResolvedValueOnce("/tmp/project"); // get_beads_project_path
    mockInvoke.mockRejectedValueOnce(new Error("bd: command not found")); // beads_run fails

    const plugin = new CompleteTaskPlugin("worker-1", "bd-99");
    const result = await plugin.execute({}, {});

    // Should still report success — the agent state transition worked
    expect(result.result).toBe("Task completed.");
  });

  // BUG PROBE: get_beads_project_path returns null (no project configured).
  // Should not attempt beads_run at all.
  it("skips Beads when project path is null", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // agent_complete_task
    mockInvoke.mockResolvedValueOnce(null); // get_beads_project_path → null

    const plugin = new CompleteTaskPlugin("worker-1", "bd-42");
    const result = await plugin.execute({}, {});

    expect(result.result).toBe("Task completed.");
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    const callNames = mockInvoke.mock.calls.map((c) => c[0]);
    expect(callNames).not.toContain("beads_run");
  });

  // BUG PROBE: Concurrent calls to execute() — can it double-complete?
  it("concurrent calls both resolve without crashing", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const plugin = new CompleteTaskPlugin("worker-1", null);
    const [r1, r2] = await Promise.all([
      plugin.execute({}, {}),
      plugin.execute({}, {}),
    ]);

    // Both should resolve. The backend state machine will reject the second
    // one, but the plugin shouldn't throw.
    expect(r1.result).toBeDefined();
    expect(r2.result).toBeDefined();
  });
});
