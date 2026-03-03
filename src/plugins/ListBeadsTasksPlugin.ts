import { Plugin, type PluginParameter, type PluginExecutionContext } from "./Plugin";
import { invoke } from "@tauri-apps/api/core";

/**
 * LLM tool for Project Manager to list tasks in Beads.
 * Wraps `bd list` via the Rust `beads_run` command.
 */
export class ListBeadsTasksPlugin extends Plugin {
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
    return "list_beads_tasks";
  }

  getDescription(): string {
    return [
      "List all tasks in the Beads task graph.",
      "Returns JSON array of tasks with id, title, type, status, parent, and dependencies.",
      "Use this to see what tasks exist before creating new ones or to verify your task breakdown.",
    ].join(" ");
  }

  getRunningDescription(
    _tool: string,
    args: { parent_id?: string }
  ): string {
    return args.parent_id
      ? `Listing tasks under ${args.parent_id}...`
      : "Listing all Beads tasks...";
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "parent_id",
        type: "string",
        description: "Optional: filter to show only tasks under this parent (e.g. an epic ID)",
        required: false,
      },
      {
        name: "status",
        type: "string",
        description: "Optional: filter by status (e.g. 'deferred', 'todo', 'in_progress', 'done')",
        required: false,
      },
    ];
  }

  async execute(
    tool: string,
    args: Record<string, unknown>,
    _ctx: PluginExecutionContext
  ): Promise<string> {
    if (tool !== "list_beads_tasks") {
      throw new Error(`Unknown tool: ${tool}`);
    }

    // Resolve project path from agent if not already set
    if (!this.projectPath && this.agentId) {
      try {
        const path = await invoke<string | null>("get_beads_project_path");
        if (path) this.projectPath = path;
      } catch {
        // Ignore - will fail below with helpful message
      }
    }

    if (!this.projectPath) {
      return JSON.stringify({
        error: "Beads project path not set. Ensure open_project_with_beads was called first.",
      });
    }

    try {
      const cmdArgs: string[] = ["list", "--json"];

      // Add parent filter if provided
      const parentId = args.parent_id;
      if (typeof parentId === "string" && parentId.trim()) {
        cmdArgs.push("--parent", parentId.trim());
      }

      // Add status filter if provided
      const status = args.status;
      if (typeof status === "string" && status.trim()) {
        cmdArgs.push("--status", status.trim());
      }

      const rawOutput = await invoke<string>("beads_run", {
        projectPath: this.projectPath,
        args: cmdArgs,
      });

      // Parse and format for readability
      try {
        const tasks = JSON.parse(rawOutput.trim());
        if (!Array.isArray(tasks)) {
          return JSON.stringify({ tasks: [tasks] });
        }

        // Format task summary for easier reading
        const summary = tasks.map((t: Record<string, unknown>) => ({
          id: t.id,
          title: t.title,
          type: t.type ?? t.issue_type,
          status: t.status,
          parent: t.parent ?? t.parent_id,
          deps: extractDeps(t),
        }));

        return JSON.stringify({ count: tasks.length, tasks: summary }, null, 2);
      } catch {
        // Return raw output if parsing fails
        return rawOutput;
      }
    } catch (e) {
      return JSON.stringify({
        error: `Failed to list tasks: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}

/**
 * Extract dependency IDs from a task's dependencies field.
 * Handles both simple arrays and structured {depends_on_id, type} format.
 */
function extractDeps(task: Record<string, unknown>): string[] {
  // Check for structured dependencies array first
  const dependencies = task.dependencies;
  if (Array.isArray(dependencies)) {
    return dependencies
      .filter((d: unknown) => {
        const dep = d as Record<string, unknown>;
        return dep.type === "blocks";
      })
      .map((d: unknown) => {
        const dep = d as Record<string, unknown>;
        return String(dep.depends_on_id ?? "");
      })
      .filter(Boolean);
  }

  // Fall back to simple deps/blocked_by
  const deps = task.deps ?? task.blocked_by;
  if (!deps) return [];
  if (Array.isArray(deps)) return deps.map(String);
  if (typeof deps === "string") return deps.split(",").map(d => d.trim()).filter(Boolean);
  return [];
}
