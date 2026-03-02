import { Plugin, type PluginParameter, type PluginExecutionContext } from "./Plugin";
import { invoke } from "@tauri-apps/api/core";

export type AddBrowserNodeFn = (agentNodeId: string, port: number, sessionId?: string) => string;

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

  getTimeoutMs(): number {
    return 90_000;
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
      "- content: Get the visible text content of the page.",
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
          "The browser action: navigate, click, type, screenshot, content, evaluate",
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
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ result: string }> {
    const TIMEOUT_MS = 45_000;

    const fetchWithTimeout = (url: string, init: RequestInit = {}): Promise<Response> => {
      const signals: AbortSignal[] = [AbortSignal.timeout(TIMEOUT_MS)];
      if (options?.abortSignal) signals.push(options.abortSignal);
      return fetch(url, { ...init, signal: AbortSignal.any(signals) });
    };

    if (!this.port) {
      this.port = await invoke<number>("browser_ensure_started", { agentId: this.agentNodeId });
    }

    if (!this.browserSessionId) {
      const sessionId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const resp = await fetchWithTimeout(
        `http://127.0.0.1:${this.port}/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        },
      );
      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Failed to create browser session: ${err}`);
      }

      this.browserSessionId = this.addBrowserNode(this.agentNodeId, this.port, sessionId);
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
      case "content":
      case "get_content":
        break;
      case "evaluate":
        body = { javascript: parameters.javascript ?? "" };
        break;
      default:
        return { result: `Unknown action: ${parameters.action}` };
    }

    const serverAction = parameters.action === "get_content" ? "content" : parameters.action;
    let resp: Response;
    try {
      resp = await fetchWithTimeout(`${base}/${serverAction}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        return { result: `Error: browser action "${parameters.action}" timed out after ${TIMEOUT_MS / 1000}s` };
      }
      throw e;
    }

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
      case "content":
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
