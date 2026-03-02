import { Plugin, type PluginParameter, type PluginExecutionContext } from "./Plugin";

export type DispatchAgentFn = (params: {
  role: "operator" | "developer" | "worker";
  taskDescription: string;
  parentAgentId: string;
}) => Promise<string>;

/**
 * WM tool to spawn an agent directly for quick/non-project tasks.
 * Bypasses Beads — no project init, no PM, no orchestration loop.
 * The spawned agent gets its full tool set (browser, terminal, files).
 */
export class DispatchAgentPlugin extends Plugin {
  private agentNodeId: string;
  private dispatchAgent: DispatchAgentFn;

  constructor(agentNodeId: string, dispatchAgent: DispatchAgentFn) {
    super();
    this.agentNodeId = agentNodeId;
    this.dispatchAgent = dispatchAgent;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "dispatch_agent";
  }

  getDescription(): string {
    return [
      "Dispatch an agent directly for a quick task that does NOT require a code project.",
      "Use this for: browsing a URL, running a quick shell command, answering a question, fetching data.",
      "Do NOT use this for tasks that require creating or modifying a codebase — use the Beads workflow instead.",
      "The dispatched agent gets full tool access (browser, terminal, file read/write).",
    ].join(" ");
  }

  getRunningDescription(_tool: string, args: { task_description?: string }): string {
    return `Dispatching agent: ${args.task_description?.slice(0, 60) ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "task_description",
        type: "string",
        description: "Clear description of what the agent should do. Be specific — the agent has no other context.",
        required: true,
      },
      {
        name: "role",
        type: "string",
        description: "Agent role: 'operator' (default and only option — browse, run commands, read files). For code work, use the Beads workflow instead.",
        required: false,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { task_description: string; role?: string },
  ): Promise<{ result: string }> {
    const desc = parameters.task_description?.trim();
    if (!desc) {
      return { result: "Error: task_description is required." };
    }
    if (parameters.role === "developer" || parameters.role === "worker") {
      return {
        result: `Error: cannot dispatch a '${parameters.role}' without a Beads task. Use the Beads workflow (open_project_with_beads → create_beads_task) for code work.`,
      };
    }
    const role = "operator" as const;

    try {
      const agentId = await this.dispatchAgent({
        role,
        taskDescription: desc,
        parentAgentId: this.agentNodeId,
      });
      return { result: `Agent dispatched (${role}): ${agentId}. It will handle the task independently.` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error dispatching agent: ${msg}` };
    }
  }
}
