import { Plugin } from "multi-llm-ts";
import type { PluginParameter, PluginExecutionContext } from "multi-llm-ts";
import { invoke } from "@tauri-apps/api/core";

/**
 * Developer-only tool. When a developer finishes their task, they call this
 * instead of marking the task as done. The state machine transitions to Yielded,
 * and the orchestration loop spawns 3 validators (Code Review, Business Logic, Scope).
 *
 * The developer CANNOT self-complete. Only the orchestration loop can mark a task
 * as Done after all 3 validators pass.
 */
export class YieldForReviewPlugin extends Plugin {
  private agentId: string;

  constructor(agentId: string, _taskId: string | null = null) {
    super();
    this.agentId = agentId;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "yield_for_review";
  }

  getDescription(): string {
    return [
      "Submit your work for validation. You MUST call this when your task is complete.",
      "Three validators (Code Review, Business Logic, Scope) will analyze your changes.",
      "If all pass, the task is marked done automatically. If any fail, you get feedback and can retry.",
      "You have up to 3 attempts. Provide a brief summary of what you changed.",
    ].join(" ");
  }

  getRunningDescription(): string {
    return "Submitting work for validation...";
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "diff_summary",
        type: "string",
        description: "Brief summary of what you changed and why (helps validators)",
        required: true,
      },
      {
        name: "git_branch",
        type: "string",
        description: "Git branch name where changes were committed (if applicable)",
        required: false,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { diff_summary: string; git_branch?: string },
  ): Promise<{ result: string }> {
    try {
      await invoke("agent_yield", {
        agent_id: this.agentId,
        payload: {
          status: "yielded",
          git_branch: parameters.git_branch ?? null,
          diff_summary: parameters.diff_summary ?? "No summary provided",
        },
      });
      return {
        result: [
          "Work submitted for review. 3 validators will analyze your changes.",
          "Wait for the validation result. If all pass, the task is marked done.",
          "If any fail, you will receive feedback and can fix the issues.",
        ].join(" "),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error submitting for review: ${msg}` };
    }
  }
}
