import { Plugin } from "multi-llm-ts";
import type { PluginParameter, PluginExecutionContext } from "multi-llm-ts";
import { invoke } from "@tauri-apps/api/core";

export type AddTerminalNodeFn = (agentNodeId: string) => string;

/**
 * LLM agent tool that runs commands in a PTY terminal.
 * When invoked, creates a visible terminal node on the canvas,
 * executes the command, and returns the output to the LLM.
 */
export class TerminalToolPlugin extends Plugin {
  private agentNodeId: string;
  private addTerminalNode: AddTerminalNodeFn;
  private terminalSessionId: string | null = null;

  constructor(agentNodeId: string, addTerminalNode: AddTerminalNodeFn) {
    super();
    this.agentNodeId = agentNodeId;
    this.addTerminalNode = addTerminalNode;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "run_terminal_command";
  }

  getDescription(): string {
    return "Run a shell command in a terminal. Use this to execute commands, install packages, build projects, run tests, read files, etc. The command runs in a real shell and you get the output back.";
  }

  getRunningDescription(_tool: string, args: { command?: string }): string {
    return `Running: ${args.command ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "command",
        type: "string",
        description: "The shell command to execute",
        required: true,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { command: string },
  ): Promise<{ output: string }> {
    if (!this.terminalSessionId) {
      this.terminalSessionId = this.addTerminalNode(this.agentNodeId);
      await invoke("terminal_spawn", {
        payload: { session_id: this.terminalSessionId, cols: 120, rows: 30 },
      });
      // Give shell a moment to initialize
      await new Promise((r) => setTimeout(r, 500));
    }

    const output = await invoke<string>("terminal_exec", {
      payload: {
        session_id: this.terminalSessionId,
        command: parameters.command,
        timeout_ms: 30_000,
      },
    });

    return { output };
  }
}
