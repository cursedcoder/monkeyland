import { Plugin } from "multi-llm-ts";
import type { PluginParameter, PluginExecutionContext } from "multi-llm-ts";
import { invoke } from "@tauri-apps/api/core";

/**
 * LLM agent tool that writes file content to disk via the Rust backend.
 * Avoids the escaping and heredoc problems of writing files through a PTY shell.
 */
export class WriteFileToolPlugin extends Plugin {
  private agentId: string | null;

  constructor(agentId: string | null = null) {
    super();
    this.agentId = agentId;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "write_file";
  }

  getDescription(): string {
    return [
      "Write content to a file on disk. Creates the file if it does not exist, overwrites if it does.",
      "Use this instead of shell commands (cat, echo, heredoc) when you need to create or update files.",
      "Parent directories are created automatically.",
    ].join(" ");
  }

  getRunningDescription(_tool: string, args: { path?: string }): string {
    return `Writing file: ${args.path ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "path",
        type: "string",
        description: "Absolute path of the file to write",
        required: true,
      },
      {
        name: "content",
        type: "string",
        description: "The full content to write to the file",
        required: true,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { path: string; content: string },
  ): Promise<{ result: string }> {
    const path = parameters.path?.trim();
    if (!path) {
      return { result: "Error: path is required." };
    }

    try {
      await invoke("write_file", {
        path,
        content: parameters.content ?? "",
        agentId: this.agentId,
      });
      return { result: `File written: ${path}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: `Error writing file: ${msg}` };
    }
  }
}
