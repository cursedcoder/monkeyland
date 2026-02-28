import { Plugin } from "multi-llm-ts";
import type { PluginParameter, PluginExecutionContext } from "multi-llm-ts";
import { invoke } from "@tauri-apps/api/core";

/**
 * LLM agent tool that reads file content from disk.
 * Useful for verifying files were created/modified correctly.
 */
export class ReadFileToolPlugin extends Plugin {
  private agentId: string | null;

  constructor(agentId: string | null = null) {
    super();
    this.agentId = agentId;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "read_file";
  }

  getDescription(): string {
    return [
      "Read the contents of a file on disk.",
      "Returns the full text content (truncated at 32KB for very large files).",
      "Use this to verify files you've created or to inspect existing files.",
    ].join(" ");
  }

  getRunningDescription(_tool: string, args: { path?: string }): string {
    return `Reading file: ${args.path ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "path",
        type: "string",
        description: "Absolute path of the file to read",
        required: true,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: { path: string },
  ): Promise<{ content: string }> {
    const path = parameters.path?.trim();
    if (!path) {
      return { content: "Error: path is required." };
    }

    try {
      const content = await invoke<string>("read_file", { path, agent_id: this.agentId });
      return { content };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: `Error: ${msg}` };
    }
  }
}
