import { Plugin } from "multi-llm-ts";
import type { PluginParameter, PluginExecutionContext } from "multi-llm-ts";
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

    const args: string[] = ["add", title];

    const issueType = parameters.type || "task";
    args.push("--type", issueType);

    const priority = parameters.priority ?? 2;
    args.push("--priority", String(priority));

    if (parameters.parent_id) {
      args.push("--parent", parameters.parent_id);
    }

    if (parameters.deps) {
      for (const dep of parameters.deps.split(",").map(s => s.trim()).filter(Boolean)) {
        args.push("--after", dep);
      }
    }

    try {
      const stdout = await invoke<string>("beads_run", {
        project_path: projectPath,
        args,
        agent_id: this.agentId,
      });

      const idMatch = stdout.match(/([A-Z0-9]+-\d+|[a-z0-9-]+)/);
      const taskId = idMatch ? idMatch[0] : stdout.trim().split("\n")[0];

      if (parameters.description) {
        try {
          await invoke<string>("beads_run", {
            project_path: projectPath,
            args: ["update", taskId, "--body", parameters.description],
            agent_id: this.agentId,
          });
        } catch {
          /* body update is best-effort */
        }
      }

      return { result: `Created ${issueType} "${title}" with ID: ${taskId}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error creating task: ${msg}` };
    }
  }
}
