import { tool } from "ai";
import { z } from "zod";

export interface PluginParameter {
  name: string;
  type: "string" | "number" | "boolean" | "boolean | null" | "string | null" | "number | null";
  description: string;
  required?: boolean;
}

export interface PluginExecutionContext {
  // Add any context properties if needed, though most plugins seem to ignore it
}

export abstract class Plugin {
  abstract getName(): string;
  abstract getDescription(): string;
  abstract getParameters(): PluginParameter[];
  abstract execute(context: PluginExecutionContext, parameters: any): Promise<any>;
  
  isEnabled(): boolean {
    return true;
  }

  getRunningDescription(toolName: string, _args: any): string {
    return `Running ${toolName}...`;
  }

  toAiTool() {
    const params = this.getParameters();
    
    // Build a Zod schema dynamically from the PluginParameter array
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

    return tool({
      description: this.getDescription(),
      inputSchema: z.object(schemaShape),
      execute: async (args: any) => {
        return await this.execute({}, args);
      }
    });
  }
}
