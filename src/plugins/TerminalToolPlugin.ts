import { Plugin, type PluginParameter, type PluginExecutionContext } from "./Plugin";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalLogEntry } from "../components/TerminalLogCard";

const MAX_TERMINAL_LOG_ENTRIES = 200;
const MAX_TERMINAL_OUTPUT_CHARS = 12_000;
const MAX_TERMINAL_TOTAL_CHARS = 250_000;
const LIVE_UPDATE_INTERVAL_MS = 800;

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

  private pruneEntries(): void {
    while (this.entries.length > MAX_TERMINAL_LOG_ENTRIES) {
      this.entries.shift();
    }
    let totalChars = this.entries.reduce((acc, e) => acc + e.output.length, 0);
    while (totalChars > MAX_TERMINAL_TOTAL_CHARS && this.entries.length > 1) {
      const removed = this.entries.shift();
      totalChars -= removed?.output.length ?? 0;
    }
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

    const entry: TerminalLogEntry = {
      command: parameters.command,
      cwd: parameters.cwd,
      output: "Running command...",
      ts: Date.now(),
    };
    this.entries.push(entry);
    this.pruneEntries();
    this.updateLog(this.logNodeId, [...this.entries]);

    const entryIndex = this.entries.length - 1;
    const startedAt = Date.now();
    let tick = 0;
    const liveTimer = window.setInterval(() => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const dots = ".".repeat((tick % 3) + 1);
      tick += 1;
      if (this.entries[entryIndex]) {
        this.entries[entryIndex] = {
          ...this.entries[entryIndex],
          output: `Running command${dots}\nElapsed: ${elapsed}s`,
          ts: Date.now(),
        };
        this.updateLog(this.logNodeId!, [...this.entries]);
      }
    }, LIVE_UPDATE_INTERVAL_MS);

    try {
      const output = await invoke<string>("terminal_exec", {
        payload: {
          session_id: this.sessionId,
          command: parameters.command,
          timeout_ms: 120_000,
          cwd: parameters.cwd ?? this.defaultCwd ?? null,
          agent_id: this.agentNodeId,
        },
      });

      if (this.entries[entryIndex]) {
        this.entries[entryIndex] = {
          ...this.entries[entryIndex],
          output:
            output.length > MAX_TERMINAL_OUTPUT_CHARS
              ? `... [output truncated, showing last ${MAX_TERMINAL_OUTPUT_CHARS} chars]\n${output.slice(-MAX_TERMINAL_OUTPUT_CHARS)}`
              : output,
          ts: Date.now(),
        };
      }
      this.pruneEntries();
      this.updateLog(this.logNodeId, [...this.entries]);
      return { output };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (this.entries[entryIndex]) {
        this.entries[entryIndex] = {
          ...this.entries[entryIndex],
          output: `Command failed:\n${msg}`,
          ts: Date.now(),
        };
        this.updateLog(this.logNodeId, [...this.entries]);
      }
      throw e;
    } finally {
      window.clearInterval(liveTimer);
    }
  }
}
