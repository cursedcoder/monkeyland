import { Plugin } from "multi-llm-ts";
import type { PluginParameter, PluginExecutionContext } from "multi-llm-ts";
import { invoke } from "@tauri-apps/api/core";

/**
 * LLM tool for Developer / Worker to mark their assigned task as done in Beads.
 * Wraps `bd update <id> --status done`.
 */
export class MarkTaskDonePlugin extends Plugin {
  private taskId: string | null;

  constructor(taskId: string | null = null) {
    super();
    this.taskId = taskId;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "mark_task_done";
  }

  getDescription(): string {
    return [
      "Mark the current task as done in the Beads task graph.",
      "Call this when you have completed your assigned task.",
      "If no task_id is provided, uses your pre-assigned task.",
    ].join(" ");
  }

  getRunningDescription(): string {
    return "Marking task as done...";
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "task_id",
        type: "string",
        description: "The Beads task ID to mark as done. Optional if pre-assigned.",
        required: false,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { task_id?: string },
  ): Promise<{ result: string }> {
    const taskId = parameters.task_id?.trim() || this.taskId;
    if (!taskId) {
      return { result: "Error: No task_id provided and none pre-assigned." };
    }

    let projectPath: string | null = null;
    try {
      projectPath = await invoke<string | null>("get_beads_project_path");
    } catch {
      /* ignore */
    }
    if (!projectPath) {
      return { result: "Error: No Beads project path set." };
    }

    try {
      await invoke<string>("beads_run", {
        project_path: projectPath,
        args: ["update", taskId, "--status", "done"],
      });
      return { result: `Task ${taskId} marked as done.` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error marking task done: ${msg}` };
    }
  }
}
