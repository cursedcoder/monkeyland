import { describe, expect, it, vi } from "vitest";
import { Plugin, DEFAULT_TOOL_TIMEOUT_MS, type PluginParameter, type PluginExecutionContext } from "./Plugin";

class FastPlugin extends Plugin {
  getName() { return "fast_tool"; }
  getDescription() { return "A fast tool"; }
  getParameters(): PluginParameter[] {
    return [{ name: "input", type: "string", description: "input", required: true }];
  }
  async execute(_ctx: PluginExecutionContext, params: any) {
    return { result: `echo: ${params.input}` };
  }
}

class SlowPlugin extends Plugin {
  private delayMs: number;
  constructor(delayMs: number) {
    super();
    this.delayMs = delayMs;
  }
  getName() { return "slow_tool"; }
  getDescription() { return "A slow tool"; }
  getParameters(): PluginParameter[] {
    return [{ name: "input", type: "string", description: "input", required: true }];
  }
  getTimeoutMs() { return 200; }
  async execute(_ctx: PluginExecutionContext, _params: any) {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return { result: "done" };
  }
}

class ThrowingPlugin extends Plugin {
  getName() { return "throwing_tool"; }
  getDescription() { return "Throws errors"; }
  getParameters(): PluginParameter[] {
    return [{ name: "input", type: "string", description: "input", required: true }];
  }
  async execute() {
    throw new Error("something broke");
  }
}

class CustomTimeoutPlugin extends Plugin {
  getName() { return "custom_timeout"; }
  getDescription() { return "Has custom timeout"; }
  getParameters(): PluginParameter[] { return []; }
  getTimeoutMs() { return 5_000; }
  async execute() { return { result: "ok" }; }
}

describe("Plugin base class", () => {
  it("DEFAULT_TOOL_TIMEOUT_MS is 60 seconds", () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(60_000);
  });

  it("getTimeoutMs returns default timeout", () => {
    const plugin = new FastPlugin();
    expect(plugin.getTimeoutMs()).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });

  it("subclass can override getTimeoutMs", () => {
    const plugin = new CustomTimeoutPlugin();
    expect(plugin.getTimeoutMs()).toBe(5_000);
  });

  it("isEnabled returns true by default", () => {
    expect(new FastPlugin().isEnabled()).toBe(true);
  });
});

describe("Plugin.toAiTool() timeout wrapper", () => {
  it("returns result from fast-completing tool", async () => {
    const plugin = new FastPlugin();
    const aiTool = plugin.toAiTool();
    const result = await aiTool.execute({ input: "hello" }, { abortSignal: undefined as any });
    expect(result).toEqual({ result: "echo: hello" });
  });

  it("times out and returns error for hung tool", async () => {
    const plugin = new SlowPlugin(5000);
    const aiTool = plugin.toAiTool();
    const result = await aiTool.execute({ input: "x" }, { abortSignal: undefined as any });
    expect(result.result).toMatch(/timed out/i);
    expect(result.result).toContain("slow_tool");
    expect(result.result).toContain("0.2s");
  }, 2000);

  it("lets tool complete if faster than timeout", async () => {
    const plugin = new SlowPlugin(50);
    const aiTool = plugin.toAiTool();
    const result = await aiTool.execute({ input: "x" }, { abortSignal: undefined as any });
    expect(result).toEqual({ result: "done" });
  });

  it("catches thrown errors and returns error result", async () => {
    const plugin = new ThrowingPlugin();
    const aiTool = plugin.toAiTool();
    const result = await aiTool.execute({ input: "x" }, { abortSignal: undefined as any });
    expect(result.result).toMatch(/Error: something broke/);
  });

  it("clears timeout timer after successful execution (no leaked timers)", async () => {
    vi.useFakeTimers();
    try {
      const plugin = new FastPlugin();
      const aiTool = plugin.toAiTool();

      const promise = aiTool.execute({ input: "hi" }, { abortSignal: undefined as any });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ result: "echo: hi" });
    } finally {
      vi.useRealTimers();
    }
  });
});
