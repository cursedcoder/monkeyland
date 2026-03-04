import { Plugin, type PluginParameter, type PluginExecutionContext } from "./Plugin";
import { invoke } from "@tauri-apps/api/core";

/**
 * LLM tool for Workforce Manager / Project Manager to create tasks in Beads.
 * Wraps `bd add` via the Rust `beads_run` command.
 */
export class CreateBeadsTaskPlugin extends Plugin {
  private projectPath: string | null = null;
  private agentId: string | null;

  constructor(agentId: string | null = null) {
    super();
    this.agentId = agentId;
  }

  setProjectPath(path: string) {
    this.projectPath = path;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "create_beads_task";
  }

  getDescription(): string {
    return [
      "Create a task/epic in the Beads task graph.",
      "The task becomes visible to the orchestration loop which auto-assigns it to a Developer or Worker agent.",
      "Returns the created task ID.",
      "You MUST call open_project_with_beads before using this tool.",
    ].join(" ");
  }

  getRunningDescription(
    _tool: string,
    args: { title?: string }
  ): string {
    return `Creating Beads task: ${args.title ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "title",
        type: "string",
        description: "Short title for the task (what to implement)",
        required: true,
      },
      {
        name: "description",
        type: "string",
        description: "Detailed description with acceptance criteria, project path, files to modify, and technical requirements. The Developer seeing this task has NO other context.",
        required: true,
      },
      {
        name: "type",
        type: "string",
        description: "Issue type: epic (→ Project Manager), task/feature/bug (→ Developer), chore (→ Worker). Default: task",
        required: false,
      },
      {
        name: "priority",
        type: "number",
        description: "Priority 0 (highest) to 4 (lowest). Default: 2",
        required: false,
      },
      {
        name: "parent_id",
        type: "string",
        description: "Parent issue ID if this is a subtask of an epic",
        required: false,
      },
      {
        name: "deps",
        type: "string",
        description: "Comma-separated IDs of tasks that must complete before this one can start",
        required: false,
      },
      {
        name: "labels",
        type: "string",
        description: "Comma-separated labels to tag the task (e.g. 'frontend,api,setup')",
        required: false,
      },
      {
        name: "acceptance_criteria",
        type: "string",
        description: "Acceptance criteria — what 'done' looks like. Separate from description for structured display.",
        required: false,
      },
      {
        name: "estimate_minutes",
        type: "number",
        description: "Time estimate in minutes (e.g. 30 for half an hour, 120 for 2 hours)",
        required: false,
      },
      {
        name: "deferred",
        type: "boolean",
        description: "Create as deferred/draft (hidden from bd ready until promoted). PM agents MUST set this to true for all tasks.",
        required: false,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: {
      title: string;
      description?: string;
      type?: string;
      priority?: number;
      parent_id?: string;
      deps?: string;
      labels?: string;
      acceptance_criteria?: string;
      estimate_minutes?: number;
      deferred?: boolean;
    },
  ): Promise<{ result: string }> {
    const title = parameters.title?.trim();
    if (!title) {
      return { result: "Error: title is required." };
    }

    let projectPath = this.projectPath;
    if (!projectPath) {
      try {
        projectPath = await invoke<string | null>("get_beads_project_path");
      } catch {
        /* ignore */
      }
    }
    if (!projectPath) {
      return { result: "Error: No Beads project path set. Call open_project_with_beads first." };
    }

    const args: string[] = ["create", title, "--silent"];

    const issueType = parameters.type || "task";
    args.push("--type", issueType);

    const priority = parameters.priority ?? 2;
    args.push("--priority", String(priority));

    if (parameters.parent_id) {
      args.push("--parent", parameters.parent_id);
    }

    if (parameters.description) {
      args.push("--description", parameters.description);
    }

    if (parameters.deps) {
      args.push("--deps", parameters.deps.split(",").map(s => s.trim()).filter(Boolean).join(","));
    }

    if (parameters.labels) {
      args.push("--labels", parameters.labels.split(",").map(s => s.trim()).filter(Boolean).join(","));
    }

    if (parameters.acceptance_criteria) {
      args.push("--acceptance", parameters.acceptance_criteria);
    }

    if (parameters.estimate_minutes != null && parameters.estimate_minutes > 0) {
      args.push("--estimate", String(parameters.estimate_minutes));
    }

    // Deferred tasks are hidden from bd ready until promoted
    // PM agents should always use deferred=true for draft tasks
    if (parameters.deferred) {
      args.push("--defer", "+100y");
    }

    try {
      // Deduplication logic: check if task already exists
      const listOutput = await invoke<string>("beads_run", {
        projectPath,
        args: ["list", "--json"],
        agentId: this.agentId,
      });
      try {
        const existingTasks = JSON.parse(listOutput.trim());
        if (Array.isArray(existingTasks)) {
          const match = existingTasks.find((t: any) => {
            const sameTitle = t.title?.trim().toLowerCase() === title.toLowerCase();
            const sameType = t.type === issueType || t.issue_type === issueType;
            
            // Description similarity check (simple inclusion or length-based heuristic)
            const descA = (t.description || t.body || "").trim().toLowerCase();
            const descB = (parameters.description || "").trim().toLowerCase();
            const sameDesc = descA === descB || (descA.length > 0 && descB.length > 0 && (descA.includes(descB) || descB.includes(descA)));

            return sameTitle && sameType && sameDesc;
          });
          if (match) {
            const isClosed = match.status === "done" || match.status === "closed";
            if (isClosed) {
              return { result: `[TERMINAL] Work already completed by ID: ${match.id}. Existing task "${title}" is already finished. No new task created.` };
            }
            return { result: `Task already exists (ID: ${match.id}). Reusing existing task.` };
          }
        }
      } catch (e) {
        console.warn("Failed to parse existing tasks for deduplication:", e);
      }

      const stdout = await invoke<string>("beads_run", {
        projectPath,
        args,
        agentId: this.agentId,
      });

      const taskId = stdout.trim();
      const deferredNote = parameters.deferred ? " (deferred - pending PM validation)" : "";

      return { result: `Created ${issueType} "${title}" with ID: ${taskId}${deferredNote}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error creating task: ${msg}` };
    }
  }
}
