import { Plugin, type PluginParameter, type PluginExecutionContext } from "./Plugin";
import { invoke } from "@tauri-apps/api/core";

/**
 * Non-developer agents (Worker, PM, WM, Validators) call this to mark their task as done.
 * The state machine enforces that Developers CANNOT use this -- they must use yield_for_review.
 */
export class CompleteTaskPlugin extends Plugin {
  private agentId: string;
  private taskId: string | null;

  constructor(agentId: string, taskId: string | null = null) {
    super();
    this.agentId = agentId;
    this.taskId = taskId;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "complete_task";
  }

  getDescription(): string {
    return "Mark your task as complete. Call this when you have finished your assigned work.";
  }

  getRunningDescription(): string {
    return "Completing task...";
  }

  getParameters(): PluginParameter[] {
    return [];
  }

  async execute(
    _context: PluginExecutionContext,
  ): Promise<{ result: string }> {
    try {
      await invoke("agent_complete_task", { agentId: this.agentId });

      if (this.taskId) {
        try {
          const projectPath = await invoke<string | null>("get_beads_project_path");
          if (projectPath) {
            await invoke<string>("beads_run", {
              projectPath,
              args: ["update", this.taskId, "--status", "done"],
            });
          }
        } catch {
          /* Beads update is best-effort */
        }
      }

      return { result: "Task completed." };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error: ${msg}` };
    }
  }
}
