import { tool } from "ai";
import { z } from "zod";

import type { SessionLayout } from "../types";

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export interface PluginParameter {
  name: string;
  type: "string" | "number" | "boolean" | "boolean | null" | "string | null" | "number | null";
  description: string;
  required?: boolean;
}

export interface PluginExecutionContext {
  layouts?: SessionLayout[];
  abortController?: AbortController;
}

export abstract class Plugin {
  abstract getName(): string;
  abstract getDescription(): string;
  abstract getParameters(): PluginParameter[];
  abstract execute(context: PluginExecutionContext, parameters: any, options?: { abortSignal?: AbortSignal }): Promise<any>;

  /** Per-tool timeout override. Subclasses can increase for slow tools. */
  getTimeoutMs(): number {
    return DEFAULT_TOOL_TIMEOUT_MS;
  }
  
  isEnabled(): boolean {
    return true;
  }

  getRunningDescription(toolName: string, _args: any): string {
    return `Running ${toolName}...`;
  }

  toAiTool(context: PluginExecutionContext = {}) {
    const params = this.getParameters();
    
    const schemaShape: Record<string, z.ZodTypeAny> = {};
    
    for (const param of params) {
      let zodType: z.ZodTypeAny;
      
      if (param.type.includes("string")) {
        zodType = z.string();
      } else if (param.type.includes("number")) {
        zodType = z.number();
      } else if (param.type.includes("boolean")) {
        zodType = z.boolean();
      } else {
        zodType = z.any();
      }
      
      if (param.description) {
        zodType = zodType.describe(param.description);
      }
      
      if (!param.required) {
        zodType = zodType.optional();
      }
      
      schemaShape[param.name] = zodType;
    }

    const timeoutMs = this.getTimeoutMs();
    const pluginName = this.getName();

    return tool({
      description: this.getDescription(),
      inputSchema: z.object(schemaShape),
      execute: async (args: any, { abortSignal }: { abortSignal?: AbortSignal } = {}) => {
        let timer: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`TOOL_TIMEOUT:${pluginName}:${timeoutMs}`)),
            timeoutMs,
          );
        });

        try {
          const result = await Promise.race([
            this.execute(context, args, { abortSignal }),
            timeoutPromise,
          ]);
          clearTimeout(timer);
          if (result?.stopAgent && context.abortController) {
            console.log(`[${pluginName}] Plugin requested agent stop — aborting controller`);
            context.abortController.abort("plugin_stop");
          }
          return result;
        } catch (e) {
          clearTimeout(timer);
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.startsWith("TOOL_TIMEOUT:")) {
            return { result: `Error: ${pluginName} timed out after ${timeoutMs / 1000}s. The operation took too long and was aborted.` };
          }
          return { result: `Error: ${msg}` };
        }
      }
    });
  }
}
