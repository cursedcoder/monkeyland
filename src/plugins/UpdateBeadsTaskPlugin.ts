import { Plugin, type PluginParameter, type PluginExecutionContext } from "./Plugin";
import { invoke } from "@tauri-apps/api/core";

/**
 * LLM tool for PM / Developer to update existing tasks in Beads.
 * Wraps `bd update <id>` with common fields.
 */
export class UpdateBeadsTaskPlugin extends Plugin {
  private agentId: string | null;
  private role: string;

  constructor(agentId: string | null = null, role: string = "unknown") {
    super();
    this.agentId = agentId;
    this.role = role;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "update_beads_task";
  }

  getDescription(): string {
    return [
      "Update an existing task in the Beads task graph.",
      "Use to change status, priority, assignee, labels, description, or append progress notes.",
      "Requires the task ID.",
    ].join(" ");
  }

  getRunningDescription(
    _tool: string,
    args: { task_id?: string },
  ): string {
    return `Updating Beads task: ${args.task_id ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "task_id",
        type: "string",
        description: "The Beads task ID to update (e.g. 'bd-a1b2c3')",
        required: true,
      },
      {
        name: "status",
        type: "string",
        description: "New status: open, in_progress, blocked, done",
        required: false,
      },
      {
        name: "priority",
        type: "string",
        description: "New priority: 0 (highest) to 4 (lowest)",
        required: false,
      },
      {
        name: "assignee",
        type: "string",
        description: "New assignee name or ID",
        required: false,
      },
      {
        name: "description",
        type: "string",
        description: "Replace the task description with this text",
        required: false,
      },
      {
        name: "append_notes",
        type: "string",
        description: "Append text to the task's notes (progress updates, blockers, etc.)",
        required: false,
      },
      {
        name: "add_labels",
        type: "string",
        description: "Comma-separated labels to add to the task",
        required: false,
      },
      {
        name: "remove_labels",
        type: "string",
        description: "Comma-separated labels to remove from the task",
        required: false,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: {
      task_id: string;
      status?: string;
      priority?: string;
      assignee?: string;
      description?: string;
      append_notes?: string;
      add_labels?: string;
      remove_labels?: string;
    },
  ): Promise<{ result: string }> {
    const taskId = parameters.task_id?.trim();
    if (!taskId) {
      return { result: "Error: task_id is required." };
    }

    if (this.role === "developer" && parameters.status?.toLowerCase() === "done") {
      return {
        result: "Error: Developers cannot mark tasks as done directly. Use yield_for_review to submit your work for validation.",
      };
    }

    let projectPath: string | null = null;
    try {
      projectPath = await invoke<string | null>("get_beads_project_path");
    } catch {
      /* ignore */
    }
    if (!projectPath) {
      return { result: "Error: No Beads project path set. Call open_project_with_beads first." };
    }

    const args: string[] = ["update", taskId];

    if (parameters.status) {
      args.push("--status", parameters.status);
    }
    if (parameters.priority) {
      args.push("--priority", parameters.priority);
    }
    if (parameters.assignee) {
      args.push("--assignee", parameters.assignee);
    }
    if (parameters.description) {
      args.push("--description", parameters.description);
    }
    if (parameters.append_notes) {
      args.push("--append-notes", parameters.append_notes);
    }
    if (parameters.add_labels) {
      for (const label of parameters.add_labels.split(",").map(s => s.trim()).filter(Boolean)) {
        args.push("--add-label", label);
      }
    }
    if (parameters.remove_labels) {
      for (const label of parameters.remove_labels.split(",").map(s => s.trim()).filter(Boolean)) {
        args.push("--remove-label", label);
      }
    }

    if (args.length === 2) {
      return { result: "Error: No fields to update. Provide at least one field (status, priority, etc.)." };
    }

    try {
      await invoke<string>("beads_run", {
        projectPath,
        args,
        agentId: this.agentId,
      });

      return { result: `Updated task ${taskId}.` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error updating task: ${msg}` };
    }
  }
}
