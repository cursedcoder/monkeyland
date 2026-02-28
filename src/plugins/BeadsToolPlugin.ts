import { Plugin } from "multi-llm-ts";
import type { PluginParameter, PluginExecutionContext } from "multi-llm-ts";
import { invoke } from "@tauri-apps/api/core";
import type { BeadsStatus } from "../components/BeadsCard";

export type AddBeadsNodeFn = (agentNodeId: string) => string;
export type UpdateBeadsStatusFn = (nodeId: string, status: BeadsStatus) => void;

/**
 * LLM agent tool to open a project and set it up for Beads (task graph).
 * Creates a Beads status card on the canvas when called.
 */
export class BeadsToolPlugin extends Plugin {
  private agentNodeId: string;
  private addBeadsNode: AddBeadsNodeFn;
  private updateStatus: UpdateBeadsStatusFn;
  private beadsNodeId: string | null = null;

  constructor(
    agentNodeId: string,
    addBeadsNode: AddBeadsNodeFn,
    updateStatus: UpdateBeadsStatusFn,
  ) {
    super();
    this.agentNodeId = agentNodeId;
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
      "Parameters: project_path (required), init (optional, default true), start_dolt (optional, default false).",
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
        description: "Start bd dolt start in background for multi-agent (default false)",
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
  ): Promise<{ result: string }> {
    const path = parameters.project_path?.trim();
    if (!path) {
      return { result: "Error: project_path is required." };
    }

    if (!this.beadsNodeId) {
      this.beadsNodeId = this.addBeadsNode(this.agentNodeId);
    }

    const doInit = parameters.init !== false;
    const doDolt = parameters.start_dolt === true;

    const steps: string[] = [];

    try {
      await invoke("set_beads_project_path", { project_path: path });
      steps.push("Project path set.");

      let initResult = "Project path set.";

      if (doInit) {
        initResult = await invoke<string>("beads_init", { project_path: path });
        steps.push(initResult);
      }

      if (doDolt) {
        await invoke("beads_dolt_start", { project_path: path });
        steps.push("Dolt server starting in background.");
      }

      this.updateStatus(this.beadsNodeId, {
        projectPath: path,
        initResult,
        lastRefresh: Date.now(),
      });

      return { result: steps.join(" ") };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      this.updateStatus(this.beadsNodeId, {
        projectPath: path,
        initResult: `Error: ${msg}`,
        lastRefresh: Date.now(),
      });

      return { result: `Error: ${msg}` };
    }
  }
}
