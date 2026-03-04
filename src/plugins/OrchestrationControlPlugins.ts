import { invoke } from "@tauri-apps/api/core";
import {
  Plugin,
  type PluginParameter,
  type PluginExecutionContext,
} from "./Plugin";

export class PauseOrchestrationPlugin extends Plugin {
  getName(): string {
    return "pause_orchestration";
  }

  getDescription(): string {
    return "Pause the orchestration loop. All agents will stop receiving new tasks until resumed. Use when the user requests to pause work or before making significant changes.";
  }

  getRunningDescription(): string {
    return "Pausing orchestration...";
  }

  getParameters(): PluginParameter[] {
    return [];
  }

  async execute(
    _context: PluginExecutionContext,
    _parameters: Record<string, never>
  ): Promise<{ result: string }> {
    try {
      await invoke("orch_pause");
      return { result: "Orchestration paused. No new tasks will be dispatched until resumed." };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error pausing orchestration: ${msg}` };
    }
  }
}

export class ResumeOrchestrationPlugin extends Plugin {
  getName(): string {
    return "resume_orchestration";
  }

  getDescription(): string {
    return "Resume the orchestration loop after a USER-REQUESTED pause. Do NOT call this unless the user explicitly asked to pause previously. Orchestration auto-pauses/resumes during your processing — that is normal and not something you need to fix.";
  }

  getRunningDescription(): string {
    return "Resuming orchestration...";
  }

  getParameters(): PluginParameter[] {
    return [];
  }

  async execute(
    _context: PluginExecutionContext,
    _parameters: Record<string, never>
  ): Promise<{ result: string }> {
    try {
      await invoke("orch_resume");
      return { result: "Orchestration resumed. Agents will continue processing tasks." };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error resuming orchestration: ${msg}` };
    }
  }
}

export class CancelTaskPlugin extends Plugin {
  getName(): string {
    return "cancel_task";
  }

  getDescription(): string {
    return "Cancel all agents working on a specific task. Use when the user wants to stop work on a particular task or when a task is no longer relevant.";
  }

  getRunningDescription(_tool: string, args: { task_id?: string }): string {
    return `Canceling task ${args.task_id ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "task_id",
        type: "string",
        description: "The Beads task ID to cancel (e.g., 'bd-123')",
        required: true,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { task_id: string }
  ): Promise<{ result: string }> {
    const taskId = parameters.task_id?.trim();
    if (!taskId) {
      return { result: "Error: task_id is required." };
    }
    try {
      const canceledIds = await invoke<string[]>("orch_cancel_task", {
        taskId,
      });
      if (canceledIds.length === 0) {
        return { result: `No agents found working on task ${taskId}.` };
      }
      return {
        result: `Canceled ${canceledIds.length} agent(s) working on task ${taskId}: ${canceledIds.join(", ")}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error canceling task: ${msg}` };
    }
  }
}

export class MessageAgentPlugin extends Plugin {
  getName(): string {
    return "message_agent";
  }

  getDescription(): string {
    return "Send a directive message to a running agent. The agent will receive this message in its next poll cycle. Use for micromanagement or priority changes.";
  }

  getRunningDescription(_tool: string, args: { agent_id?: string }): string {
    return `Sending message to agent ${args.agent_id ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "agent_id",
        type: "string",
        description: "The agent ID to send the message to",
        required: true,
      },
      {
        name: "directive",
        type: "string",
        description: "The message/directive to send to the agent",
        required: true,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { agent_id: string; directive: string }
  ): Promise<{ result: string }> {
    const agentId = parameters.agent_id?.trim();
    const directive = parameters.directive?.trim();
    if (!agentId) {
      return { result: "Error: agent_id is required." };
    }
    if (!directive) {
      return { result: "Error: directive is required." };
    }
    try {
      const delivered = await invoke<boolean>("orch_inject_directive", {
        targetAgentId: agentId,
        directive,
      });
      if (delivered) {
        return {
          result: `Directive sent to agent ${agentId}. It will receive the message on its next poll.`,
        };
      } else {
        return { result: `Agent ${agentId} not found or not active.` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error sending directive: ${msg}` };
    }
  }
}

export interface ActiveAgentInfo {
  id: string;
  role: string;
  state: string;
  task_id: string | null;
  phase: string | null;
}

export interface OrchStatusResult {
  state: string;
  is_running: boolean;
  is_paused: boolean;
  active_agents: ActiveAgentInfo[];
  project_path: string | null;
  frontend_cards?: {
    type: string;
    project_path?: string;
    task_id?: string;
  }[];
}

export class GetOrchestrationStatusPlugin extends Plugin {
  private getFrontendCards: () => OrchStatusResult["frontend_cards"];

  constructor(getFrontendCards: () => OrchStatusResult["frontend_cards"] = () => []) {
    super();
    this.getFrontendCards = getFrontendCards;
  }

  getName(): string {
    return "get_orchestration_status";
  }

  getDescription(): string {
    return "Get the current status of the orchestration system, including active agents, their tasks, project info, and existing cards on the canvas.";
  }

  getRunningDescription(): string {
    return "Getting orchestration status...";
  }

  getParameters(): PluginParameter[] {
    return [];
  }

  async execute(
    _context: PluginExecutionContext,
    _parameters: Record<string, never>
  ): Promise<{ result: string }> {
    try {
      const status = await invoke<OrchStatusResult>("orch_get_status");
      const frontendCards = this.getFrontendCards();

      // The WM temporarily pauses orchestration while processing messages.
      // Report "running" so the LLM doesn't mislead the user — orchestration
      // auto-resumes once the WM finishes responding.
      const effectiveState = status.is_paused ? "running (auto-resumes after this response)" : status.state;

      const lines: string[] = [];
      lines.push(`Orchestration: ${effectiveState}`);

      if (status.project_path) {
        lines.push(`Project: ${status.project_path}`);
      }

      if (status.active_agents.length === 0) {
        lines.push("Active agents: none");
      } else {
        lines.push(`Active agents (${status.active_agents.length}):`);
        for (const agent of status.active_agents) {
          const taskPart = agent.task_id ? ` [task: ${agent.task_id}]` : "";
          const phasePart = agent.phase ? ` (${agent.phase})` : "";
          lines.push(`  - ${agent.role}: ${agent.state}${phasePart}${taskPart}`);
        }
      }

      if (frontendCards && frontendCards.length > 0) {
        lines.push(`Frontend Cards (${frontendCards.length}):`);
        for (const card of frontendCards) {
          const projectPart = card.project_path ? ` [project: ${card.project_path}]` : "";
          const taskPart = card.task_id ? ` [task: ${card.task_id}]` : "";
          lines.push(`  - ${card.type}${projectPart}${taskPart}`);
        }
      }

      return { result: lines.join("\n") };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error getting status: ${msg}` };
    }
  }
}

export class ReprioritizeTaskPlugin extends Plugin {
  getName(): string {
    return "reprioritize_task";
  }

  getDescription(): string {
    return "Change the priority of a Beads task. Higher priority tasks are processed first. This uses the Beads CLI to update task metadata.";
  }

  getRunningDescription(_tool: string, args: { task_id?: string }): string {
    return `Reprioritizing task ${args.task_id ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "task_id",
        type: "string",
        description: "The Beads task ID to reprioritize (e.g., 'bd-123')",
        required: true,
      },
      {
        name: "priority",
        type: "string",
        description: "New priority level: 'high', 'medium', or 'low'",
        required: true,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { task_id: string; priority: string }
  ): Promise<{ result: string }> {
    const taskId = parameters.task_id?.trim();
    const priority = parameters.priority?.trim().toLowerCase();
    if (!taskId) {
      return { result: "Error: task_id is required." };
    }
    if (!priority || !["high", "medium", "low"].includes(priority)) {
      return {
        result: "Error: priority must be 'high', 'medium', or 'low'.",
      };
    }
    return {
      result: `Task ${taskId} priority would be set to ${priority}. (Note: Beads priority update integration pending)`,
    };
  }
}
