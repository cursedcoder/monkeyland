import { Plugin, type PluginParameter, type PluginExecutionContext } from "./Plugin";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalLogEntry } from "../components/TerminalLogCard";

export type AddTerminalLogNodeFn = (agentNodeId: string) => string;
export type UpdateTerminalLogFn = (nodeId: string, entries: TerminalLogEntry[]) => void;

/**
 * LLM agent tool that runs shell commands via bash -c subprocess.
 * Each call starts a FRESH shell -- no state persists between calls.
 * Creates a terminal log card on the canvas showing command history.
 */
export class TerminalToolPlugin extends Plugin {
  private agentNodeId: string;
  private addLogNode: AddTerminalLogNodeFn;
  private updateLog: UpdateTerminalLogFn;
  private logNodeId: string | null = null;
  private entries: TerminalLogEntry[] = [];
  private sessionId: string;
  private defaultCwd: string | null;

  constructor(
    agentNodeId: string,
    addLogNode: AddTerminalLogNodeFn,
    updateLog: UpdateTerminalLogFn,
    defaultCwd?: string | null,
  ) {
    super();
    this.agentNodeId = agentNodeId;
    this.addLogNode = addLogNode;
    this.updateLog = updateLog;
    this.sessionId = `exec-${Date.now()}`;
    this.defaultCwd = defaultCwd ?? null;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "run_terminal_command";
  }

  getDescription(): string {
    return [
      "Run a shell command via /bin/bash -c and return stdout+stderr.",
      "IMPORTANT: Each call starts a FRESH shell. No state (cwd, env vars) persists between calls.",
      "Use the 'cwd' parameter to set the working directory instead of 'cd'.",
      "Commands have a 2-minute timeout. stdin is closed, so interactive prompts get EOF.",
      "For interactive installers, use --yes or -y flags (e.g. 'npx --yes create-vite').",
      "For creating or editing files, prefer the write_file tool instead.",
      "For long-running servers: use 'nohup cmd > /tmp/out.log 2>&1 & echo started' then check the log in a follow-up call.",
    ].join(" ");
  }

  getRunningDescription(_tool: string, args: { command?: string }): string {
    return `Running: ${args.command ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "command",
        type: "string",
        description: "The shell command to execute (bash -c)",
        required: true,
      },
      {
        name: "cwd",
        type: "string",
        description: `Working directory for the command (absolute path).${this.defaultCwd ? ` Defaults to ${this.defaultCwd} if not set.` : ""}`,
        required: false,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { command: string; cwd?: string },
  ): Promise<{ output: string }> {
    if (!this.logNodeId) {
      this.logNodeId = this.addLogNode(this.agentNodeId);
    }

    const output = await invoke<string>("terminal_exec", {
      payload: {
        session_id: this.sessionId,
        command: parameters.command,
        timeout_ms: 120_000,
        cwd: parameters.cwd ?? this.defaultCwd ?? null,
        agent_id: this.agentNodeId,
      },
    });

    const entry: TerminalLogEntry = {
      command: parameters.command,
      cwd: parameters.cwd,
      output,
      ts: Date.now(),
    };
    this.entries.push(entry);
    this.updateLog(this.logNodeId, [...this.entries]);

    return { output };
  }
}
