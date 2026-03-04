import { Plugin, type PluginParameter, type PluginExecutionContext } from "./Plugin";
import { invoke } from "@tauri-apps/api/core";
import type { BeadsStatus } from "../components/BeadsCard";

export type AddBeadsNodeFn = (agentNodeId: string) => string;
export type UpdateBeadsStatusFn = (nodeId: string, status: BeadsStatus) => void;

/**
 * LLM agent tool to open a project and set it up for Beads (task graph).
 * Creates a Beads status card on the canvas when called.
 */
export class BeadsToolPlugin extends Plugin {
  private canvasNodeId: string;
  private backendAgentId: string | null;
  private addBeadsNode: AddBeadsNodeFn;
  private updateStatus: UpdateBeadsStatusFn;
  private beadsNodeId: string | null = null;

  constructor(
    canvasNodeId: string,
    backendAgentId: string | null,
    addBeadsNode: AddBeadsNodeFn,
    updateStatus: UpdateBeadsStatusFn,
  ) {
    super();
    this.canvasNodeId = canvasNodeId;
    this.backendAgentId = backendAgentId;
    this.addBeadsNode = addBeadsNode;
    this.updateStatus = updateStatus;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "open_project_with_beads";
  }

  getDescription(): string {
    return [
      "Open a project and set it up for Beads (git-backed task graph).",
      "Call this after creating a project directory to enable task tracking.",
      "If bd is not installed, this will gracefully skip — the project still works.",
      "Parameters: project_path (required), init (optional, default true).",
    ].join(" ");
  }

  getRunningDescription(
    _tool: string,
    args: { project_path?: string }
  ): string {
    return `Opening project with Beads: ${args.project_path ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "project_path",
        type: "string",
        description: "Absolute path to the project root (where bd init will run)",
        required: true,
      },
      {
        name: "init",
        type: "boolean",
        description: "Run bd init --quiet in the project (default true)",
        required: false,
      },
      {
        name: "start_dolt",
        type: "boolean",
        description: "Deprecated, Dolt server is always started automatically.",
        required: false,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: {
      project_path: string;
      init?: boolean;
      start_dolt?: boolean;
    },
  ): Promise<{ result: string; stopAgent?: boolean }> {
    const path = parameters.project_path?.trim();
    if (!path) {
      return { result: "Error: project_path is required." };
    }

    // Check if a Beads card for this project already exists on the canvas
    const existingBeadsCard = _context.layouts?.find(l => {
      if (l.node_type !== "beads") return false;
      try {
        const p = JSON.parse(l.payload ?? "{}");
        return p.beadsStatus?.projectPath === path;
      } catch {
        return false;
      }
    });

    if (existingBeadsCard) {
      this.beadsNodeId = existingBeadsCard.session_id;
    }

    if (!this.beadsNodeId) {
      this.beadsNodeId = this.addBeadsNode(this.canvasNodeId);
    }

    const doInit = parameters.init !== false;

    const steps: string[] = [];

    try {
      await invoke("beads_dolt_start", { projectPath: path, agentId: this.backendAgentId });
      steps.push("Dolt server ready.");

      await invoke("set_beads_project_path", { projectPath: path, agentId: this.backendAgentId });
      steps.push("Project path set.");

      let initResult = "Project path set.";

      if (doInit) {
        initResult = await invoke<string>("beads_init", { projectPath: path, agentId: this.backendAgentId });
        steps.push(initResult);
      }

      this.updateStatus(this.beadsNodeId, {
        projectPath: path,
        initResult,
        lastRefresh: Date.now(),
      });

      // Safety net: if the project was already initialized, do a quick check
      // for completed state. The WM brain does the heavy lifting before the LLM
      // runs, but if the LLM still calls this tool, we catch it here.
      if (initResult.includes("already initialized")) {
        try {
          const raw = await invoke<string>("beads_run", {
            projectPath: path,
            args: ["list", "--json", "--all"],
            agentId: this.backendAgentId,
          });
          const tasks = JSON.parse(raw.trim());
          if (Array.isArray(tasks)) {
            const epics = tasks.filter((t: { type?: string; issue_type?: string }) =>
              t.type === "epic" || t.issue_type === "epic"
            );
            const closedEpics = epics.filter((t: { status: string }) =>
              t.status === "done" || t.status === "closed"
            );
            const openEpics = epics.filter((t: { status: string }) =>
              t.status !== "done" && t.status !== "closed"
            );
            if (closedEpics.length > 0 && openEpics.length === 0) {
              // Don't force-abort — the WM brain already did the authoritative
              // inspection before the LLM ran. If the LLM still chose to call
              // this tool, it's doing so intentionally (e.g. to create new work
              // on a completed project). Return a hint but let it proceed.
              return {
                result: `Project "${path}" has completed epics and no open ones. Previous work is finished — create new tasks if the user requested additional work.`,
              };
            }
          }
        } catch {
          // Quick check failed — not critical, continue normally
        }
      }

      return { result: steps.join(" ") };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[BeadsToolPlugin] open_project_with_beads failed for "${path}":`, msg);

      this.updateStatus(this.beadsNodeId, {
        projectPath: path,
        initResult: `Error: ${msg}`,
        lastRefresh: Date.now(),
      });

      return { result: `Error: ${msg}` };
    }
  }
}
