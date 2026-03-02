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

  it("has correct name and is enabled", () => {
    const plugin = new CompleteTaskPlugin("agent-1", "bd-42");
    expect(plugin.getName()).toBe("complete_task");
    expect(plugin.isEnabled()).toBe(true);
    expect(plugin.getParameters()).toEqual([]);
  });

  it("calls agent_complete_task and updates Beads when taskId is provided", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // agent_complete_task
    mockInvoke.mockResolvedValueOnce("/tmp/project"); // get_beads_project_path
    mockInvoke.mockResolvedValueOnce("ok"); // beads_run

    const plugin = new CompleteTaskPlugin("agent-1", "bd-42");
    const result = await plugin.execute({}, {});

    expect(result.result).toBe("Task completed.");
    expect(mockInvoke).toHaveBeenCalledWith("agent_complete_task", {
      agentId: "agent-1",
    });
    expect(mockInvoke).toHaveBeenCalledWith("beads_run", {
      projectPath: "/tmp/project",
      args: ["update", "bd-42", "--status", "done"],
    });
  });

  it("skips Beads update when taskId is null (merge_agent case)", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // agent_complete_task

    const plugin = new CompleteTaskPlugin("merge-1", null);
    const result = await plugin.execute({}, {});

    expect(result.result).toBe("Task completed.");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("agent_complete_task", {
      agentId: "merge-1",
    });
  });

  it("returns error message when agent_complete_task fails", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("state machine rejected"));

    const plugin = new CompleteTaskPlugin("agent-1", "bd-42");
    const result = await plugin.execute({}, {});

    expect(result.result).toContain("Error:");
    expect(result.result).toContain("state machine rejected");
  });

  it("succeeds even if Beads update fails (best-effort)", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // agent_complete_task
    mockInvoke.mockResolvedValueOnce("/tmp/project"); // get_beads_project_path
    mockInvoke.mockRejectedValueOnce(new Error("bd not found")); // beads_run fails

    const plugin = new CompleteTaskPlugin("agent-1", "bd-42");
    const result = await plugin.execute({}, {});

    expect(result.result).toBe("Task completed.");
  });

  it("succeeds when project path is null", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // agent_complete_task
    mockInvoke.mockResolvedValueOnce(null); // get_beads_project_path returns null

    const plugin = new CompleteTaskPlugin("agent-1", "bd-42");
    const result = await plugin.execute({}, {});

    expect(result.result).toBe("Task completed.");
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});
