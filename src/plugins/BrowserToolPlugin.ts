import { Plugin } from "multi-llm-ts";
import type { PluginParameter, PluginExecutionContext } from "multi-llm-ts";
import { invoke } from "@tauri-apps/api/core";

export type AddBrowserNodeFn = (agentNodeId: string, port: number) => string;

export class BrowserToolPlugin extends Plugin {
  private agentNodeId: string;
  private addBrowserNode: AddBrowserNodeFn;
  private browserSessionId: string | null = null;
  private port: number | null = null;

  constructor(agentNodeId: string, addBrowserNode: AddBrowserNodeFn) {
    super();
    this.agentNodeId = agentNodeId;
    this.addBrowserNode = addBrowserNode;
  }

  isEnabled(): boolean {
    return true;
  }

  getName(): string {
    return "browser_action";
  }

  getDescription(): string {
    return [
      "Interact with a web browser to view and test web pages.",
      "Actions:",
      "- navigate: Go to a URL. Requires 'url'. Returns page title and text content.",
      "- click: Click an element. Requires 'selector' (CSS).",
      "- type: Type text into an input. Requires 'selector' and 'text'.",
      "- screenshot: Capture a screenshot of the current page.",
      "- get_content: Get the visible text content of the page.",
      "- evaluate: Run JavaScript on the page. Requires 'javascript'.",
    ].join(" ");
  }

  getRunningDescription(
    _tool: string,
    args: { action?: string; url?: string },
  ): string {
    if (args.action === "navigate") return `Navigating to ${args.url ?? "..."}`;
    return `Browser: ${args.action ?? "..."}`;
  }

  getParameters(): PluginParameter[] {
    return [
      {
        name: "action",
        type: "string",
        description:
          "The browser action: navigate, click, type, screenshot, get_content, evaluate",
        required: true,
      },
      {
        name: "url",
        type: "string",
        description: "URL to navigate to (for navigate action)",
        required: false,
      },
      {
        name: "selector",
        type: "string",
        description: "CSS selector of the target element (for click/type actions)",
        required: false,
      },
      {
        name: "text",
        type: "string",
        description: "Text to type into the element (for type action)",
        required: false,
      },
      {
        name: "javascript",
        type: "string",
        description: "JavaScript code to evaluate on the page (for evaluate action)",
        required: false,
      },
    ];
  }

  async execute(
    _context: PluginExecutionContext,
    parameters: {
      action: string;
      url?: string;
      selector?: string;
      text?: string;
      javascript?: string;
    },
  ): Promise<{ result: string }> {
    if (!this.port) {
      this.port = await invoke<number>("browser_ensure_started");
    }

    if (!this.browserSessionId) {
      this.browserSessionId = this.addBrowserNode(this.agentNodeId, this.port);

      const resp = await fetch(
        `http://127.0.0.1:${this.port}/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: this.browserSessionId }),
        },
      );
      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Failed to create browser session: ${err}`);
      }
    }

    const base = `http://127.0.0.1:${this.port}/session/${this.browserSessionId}`;
    let body: Record<string, string> = {};

    switch (parameters.action) {
      case "navigate":
        body = { url: parameters.url ?? "" };
        break;
      case "click":
        body = { selector: parameters.selector ?? "" };
        break;
      case "type":
        body = {
          selector: parameters.selector ?? "",
          text: parameters.text ?? "",
        };
        break;
      case "screenshot":
      case "get_content":
        break;
      case "evaluate":
        body = { javascript: parameters.javascript ?? "" };
        break;
      default:
        return { result: `Unknown action: ${parameters.action}` };
    }

    const resp = await fetch(`${base}/${parameters.action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { result: `Error: ${errText}` };
    }

    const data = await resp.json();

    switch (parameters.action) {
      case "navigate":
        return {
          result: `Navigated to ${data.url}\nTitle: ${data.title}\n\nContent:\n${data.content}`,
        };
      case "click":
        return { result: `Clicked ${parameters.selector}. Page: ${data.url}` };
      case "type":
        return { result: `Typed "${parameters.text}" into ${parameters.selector}` };
      case "screenshot":
        return { result: "Screenshot captured. The user can see it in the browser card." };
      case "get_content":
        return {
          result: `Page: ${data.url}\nTitle: ${data.title}\n\nContent:\n${data.content}`,
        };
      case "evaluate":
        return { result: `Result: ${data.result}` };
      default:
        return { result: JSON.stringify(data) };
    }
  }
}
