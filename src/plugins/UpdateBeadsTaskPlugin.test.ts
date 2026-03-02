import { describe, expect, it, vi, beforeEach } from "vitest";
import { UpdateBeadsTaskPlugin } from "./UpdateBeadsTaskPlugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

describe("UpdateBeadsTaskPlugin", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("allows PMs to set status=done (they manage tasks)", async () => {
    mockInvoke.mockResolvedValueOnce("/tmp/project"); // get_beads_project_path
    mockInvoke.mockResolvedValueOnce("ok"); // beads_run

    const plugin = new UpdateBeadsTaskPlugin("pm-1", "project_manager");
    const result = await plugin.execute({}, { task_id: "bd-42", status: "done" });

    expect(result.result).not.toMatch(/Error/);
    expect(mockInvoke).toHaveBeenCalledWith("beads_run", expect.objectContaining({
      args: ["update", "bd-42", "--status", "done"],
    }));
  });

  /**
   * BUG: A developer's LLM can call update_beads_task({ status: "done" })
   * which directly marks the task as done in Beads — completely bypassing
   * the yield → validate → merge workflow. The developer prompt says
   * "You CANNOT mark the task as done yourself", but the tool doesn't
   * enforce it. This test must FAIL until the bug is fixed.
   */
  it("rejects developers setting status=done (must use yield_for_review)", async () => {
    mockInvoke.mockResolvedValueOnce("/tmp/project"); // get_beads_project_path
    mockInvoke.mockResolvedValueOnce("ok"); // beads_run

    const plugin = new UpdateBeadsTaskPlugin("dev-1", "developer");
    const result = await plugin.execute({}, { task_id: "bd-42", status: "done" });

    expect(result.result).toMatch(/Error/i);
    expect(result.result).toMatch(/yield_for_review/i);
    const callNames = mockInvoke.mock.calls.map((c) => c[0]);
    expect(callNames).not.toContain("beads_run");
  });

  it("allows developers to append_notes (legitimate use)", async () => {
    mockInvoke.mockResolvedValueOnce("/tmp/project"); // get_beads_project_path
    mockInvoke.mockResolvedValueOnce("ok"); // beads_run

    const plugin = new UpdateBeadsTaskPlugin("dev-1", "developer");
    const result = await plugin.execute({}, {
      task_id: "bd-42",
      append_notes: "Fixed the import issue",
    });

    expect(result.result).not.toMatch(/Error/);
  });

  it("allows developers to set status=blocked", async () => {
    mockInvoke.mockResolvedValueOnce("/tmp/project"); // get_beads_project_path
    mockInvoke.mockResolvedValueOnce("ok"); // beads_run

    const plugin = new UpdateBeadsTaskPlugin("dev-1", "developer");
    const result = await plugin.execute({}, {
      task_id: "bd-42",
      status: "blocked",
      append_notes: "Waiting for API credentials",
    });

    expect(result.result).not.toMatch(/Error/);
  });

  it("requires task_id", async () => {
    const plugin = new UpdateBeadsTaskPlugin("pm-1", "project_manager");
    const result = await plugin.execute({}, { task_id: "" });
    expect(result.result).toMatch(/Error/);
  });
});
