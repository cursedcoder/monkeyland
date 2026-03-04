import { Plugin, type PluginParameter, type PluginExecutionContext } from "./Plugin";
import { invoke } from "@tauri-apps/api/core";

export class SanitizeProjectPlugin extends Plugin {
  private agentId: string | null;

  constructor(agentId: string | null = null) {
    super();
    this.agentId = agentId;
  }

  setProjectPath(_path: string) {
    // Not used by this plugin but required by interface if called by App.tsx
  }

  getName(): string {
    return "sanitize_project";
  }

  getDescription(): string {
    return [
      "Analyze the project for duplicate or 'zombie' tasks (incomplete tasks with no active agents).",
      "Automatically archives redundant or stale tasks while preserving completed or active work.",
      "Call this as the first step when opening an existing project to ensure a clean state.",
    ].join(" ");
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "project_path",
        type: "string",
        description: "Absolute path to the project root.",
        required: true,
      },
      {
        name: "dry_run",
        type: "boolean",
        description: "If true, only report what would be cleaned up without performing actions.",
        required: false,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { project_path: string; dry_run?: boolean }
  ): Promise<{ result: string }> {
    const path = parameters.project_path?.trim();
    if (!path) {
      return { result: "Error: project_path is required." };
    }

    try {
      // 1. Pause orchestration to prevent race conditions
      let wasRunning = false;
      try {
        const status = await invoke<{ is_running: boolean }>("orch_get_status");
        wasRunning = status.is_running;
        if (wasRunning) {
          await invoke("orch_pause");
        }
      } catch (e) {
        console.warn("Failed to check/pause orchestration:", e);
      }

      // 2. Fetch all tasks
      const listOutput = await invoke<string>("beads_run", {
        projectPath: path,
        args: ["list", "--json", "--all"],
        agentId: this.agentId,
      });
      const tasks = JSON.parse(listOutput.trim());
      if (!Array.isArray(tasks)) {
        return { result: "No tasks found to sanitize." };
      }

      // 3. Identify active tasks from frontend context
      const activeTaskIds = new Set<string>();
      if (_context.layouts) {
        _context.layouts.forEach(l => {
          try {
            const p = JSON.parse(l.payload ?? "{}");
            if (p.task_id && p.status === "loading") {
              activeTaskIds.add(p.task_id);
            }
          } catch { /* ignore */ }
        });
      }

      const now = Date.now();
      const ZOMBIE_GRACE_PERIOD_MS = 5 * 60 * 1000;

      // 4. Group tasks by Title + Type for deduplication
      const groups = new Map<string, any[]>();
      tasks.forEach(t => {
        const key = `${t.type || t.issue_type}:${(t.title || "").trim().toLowerCase()}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(t);
      });

      const toArchive = new Set<string>();
      const summaries: string[] = [];

      for (const group of groups.values()) {
        if (group.length <= 1) continue;

        // Find the "Winner"
        // Priority: 1. Closed/Done, 2. Active (has agent), 3. Most recently updated
        group.sort((a, b) => {
          const aClosed = a.status === "done" || a.status === "closed";
          const bClosed = b.status === "done" || b.status === "closed";
          if (aClosed && !bClosed) return -1;
          if (!aClosed && bClosed) return 1;

          const aActive = activeTaskIds.has(a.id);
          const bActive = activeTaskIds.has(b.id);
          if (aActive && !bActive) return -1;
          if (!aActive && bActive) return 1;

          const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
          const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
          return bTime - aTime;
        });

        const winner = group[0];
        const losers = group.slice(1);

        losers.forEach(l => {
          // Only archive if it's not active OR it's a stale zombie
          const isStale = l.updated_at ? (now - new Date(l.updated_at).getTime()) > ZOMBIE_GRACE_PERIOD_MS : true;
          if (!activeTaskIds.has(l.id) && isStale) {
            toArchive.add(l.id);
          }
        });

        if (toArchive.size > 0) {
          summaries.push(`Found duplicates for "${winner.title}": kept ${winner.id}, flagged ${losers.map(l => l.id).join(", ")} for removal.`);
        }
      }

      // 5. Recursive cleanup: find all children of tasks to be archived
      const findChildren = (parentIds: Set<string>) => {
        const children = new Set<string>();
        tasks.forEach(t => {
          const parentId = t.parent || t.parent_id;
          if (parentId && parentIds.has(parentId)) {
            children.add(t.id);
          }
        });
        return children;
      };

      let currentSet = new Set(toArchive);
      while (currentSet.size > 0) {
        const children = findChildren(currentSet);
        const newChildren = Array.from(children).filter(id => !toArchive.has(id));
        if (newChildren.length === 0) break;
        newChildren.forEach(id => toArchive.add(id));
        currentSet = new Set(newChildren);
      }

      // 6. Perform Archiving
      if (!parameters.dry_run && toArchive.size > 0) {
        for (const id of toArchive) {
          try {
            await invoke("beads_run", {
              projectPath: path,
              args: ["close", id, "--reason", "Auto-closed: zombie/duplicate detected by sanitize"],
              agentId: this.agentId,
            });
          } catch (e) {
            console.warn(`Failed to archive task ${id}:`, e);
          }
        }
      }

      // 7. Resume orchestration if it was running
      if (wasRunning) {
        await invoke("orch_resume");
      }

      // 8. Check if work is already completed by a "Winner"
      let workAlreadyCompleted = false;
      let completedTaskId = "";
      for (const group of groups.values()) {
        const winner = group.sort((a, b) => {
          const aClosed = a.status === "done" || a.status === "closed";
          const bClosed = b.status === "done" || b.status === "closed";
          if (aClosed && !bClosed) return -1;
          if (!aClosed && bClosed) return 1;
          return 0;
        })[0];

        if (winner && (winner.status === "done" || winner.status === "closed")) {
          workAlreadyCompleted = true;
          completedTaskId = winner.id;
          break;
        }
      }

      const actionWord = parameters.dry_run ? "Would have archived" : "Archived";
      let resultMsg = toArchive.size > 0 
        ? `${actionWord} ${toArchive.size} zombie/duplicate tasks.\n${summaries.join("\n")}`
        : "Project is clean. No zombie or duplicate tasks found.";

      if (workAlreadyCompleted) {
        resultMsg = `[TERMINAL] Work already completed by ID: ${completedTaskId}. ${resultMsg}`;
        return { 
          result: resultMsg,
          // @ts-ignore - adding custom field for LLM branching
          work_already_completed: true,
          completed_task_id: completedTaskId
        };
      }

      return { result: resultMsg };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error during sanitization: ${msg}` };
    }
  }
}
