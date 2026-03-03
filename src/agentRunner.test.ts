import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => {
    const chatFn = vi.fn((modelId: string) => ({ modelId, provider: "openai" }));
    const fn = vi.fn((modelId: string) => ({ modelId, provider: "openai" }));
    (fn as unknown as { chat: typeof chatFn }).chat = chatFn;
    return fn;
  }),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() =>
    vi.fn((modelId: string) => ({ modelId, provider: "anthropic" })),
  ),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() =>
    vi.fn((modelId: string) => ({ modelId, provider: "google" })),
  ),
}));

vi.mock("multi-llm-ts", () => ({
  loadModels: vi.fn(),
}));

const { mockStreamText, mockStepCountIs } = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
  mockStepCountIs: vi.fn(() => () => false),
}));
vi.mock("ai", () => ({
  streamText: mockStreamText,
  stepCountIs: mockStepCountIs,
  tool: vi.fn((opts: any) => opts),
}));

import { invoke } from "@tauri-apps/api/core";
import { getAiProviderModel, loadKiloModels, runAgent, type AgentRunnerCallbacks } from "./agentRunner";
import { loadModels } from "multi-llm-ts";

const mockInvoke = vi.mocked(invoke);

/**
 * We import fallbackPricing indirectly by testing the module's exports.
 * Since fallbackPricing is not exported, we test it via getAiProviderModel
 * behavior and directly test the FALLBACK_PRICING patterns.
 *
 * For fallbackPricing we re-implement the lookup to validate the table.
 */

// Re-create the fallback pricing table to test pattern matching correctness.
// This mirrors the FALLBACK_PRICING const in agentRunner.ts.
const FALLBACK_PRICING: Array<[RegExp, number, number]> = [
  [/gemini.*3\.1.*pro/i, 1.25, 10.0],
  [/gemini.*3.*pro/i, 1.25, 10.0],
  [/gemini.*2\.5.*pro/i, 1.25, 10.0],
  [/gemini.*2\.5.*flash/i, 0.15, 0.6],
  [/gemini.*flash.*lite/i, 0.075, 0.3],
  [/gemini.*3.*flash/i, 0.15, 0.6],
  [/gemini.*2\.0.*flash/i, 0.1, 0.4],
  [/gemini.*flash/i, 0.1, 0.4],
  [/gemini.*pro/i, 1.25, 10.0],
  [/claude.*opus/i, 15.0, 75.0],
  [/claude.*sonnet/i, 3.0, 15.0],
  [/claude.*haiku/i, 0.25, 1.25],
  [/gpt-4o-mini/i, 0.15, 0.6],
  [/gpt-4o/i, 2.5, 10.0],
  [/gpt-4-turbo/i, 10.0, 30.0],
  [/o1-mini/i, 3.0, 12.0],
  [/o1/i, 15.0, 60.0],
  [/deepseek/i, 0.14, 0.28],
];

function fallbackPricing(modelId: string): { input: number; output: number } {
  for (const [pattern, input, output] of FALLBACK_PRICING) {
    if (pattern.test(modelId)) return { input, output };
  }
  return { input: 0, output: 0 };
}

describe("fallbackPricing", () => {
  it("matches Gemini 2.5 Pro", () => {
    const result = fallbackPricing("gemini-2.5-pro-preview-05-06");
    expect(result.input).toBe(1.25);
    expect(result.output).toBe(10.0);
  });

  it("matches Gemini 2.5 Flash", () => {
    const result = fallbackPricing("gemini-2.5-flash-preview-04-17");
    expect(result.input).toBe(0.15);
    expect(result.output).toBe(0.6);
  });

  it("matches Gemini 2.0 Flash", () => {
    const result = fallbackPricing("gemini-2.0-flash");
    expect(result.input).toBe(0.1);
    expect(result.output).toBe(0.4);
  });

  it("matches Claude Opus", () => {
    const result = fallbackPricing("claude-opus-4-20250514");
    expect(result.input).toBe(15.0);
    expect(result.output).toBe(75.0);
  });

  it("matches Claude Sonnet", () => {
    const result = fallbackPricing("claude-sonnet-4-20250514");
    expect(result.input).toBe(3.0);
    expect(result.output).toBe(15.0);
  });

  it("matches Claude Haiku", () => {
    const result = fallbackPricing("claude-3-haiku-20240307");
    expect(result.input).toBe(0.25);
    expect(result.output).toBe(1.25);
  });

  it("matches GPT-4o-mini before GPT-4o (order matters)", () => {
    const mini = fallbackPricing("gpt-4o-mini");
    expect(mini.input).toBe(0.15);
    expect(mini.output).toBe(0.6);

    const full = fallbackPricing("gpt-4o");
    expect(full.input).toBe(2.5);
    expect(full.output).toBe(10.0);
  });

  it("matches GPT-4 Turbo", () => {
    const result = fallbackPricing("gpt-4-turbo-2024-04-09");
    expect(result.input).toBe(10.0);
    expect(result.output).toBe(30.0);
  });

  it("matches o1-mini before o1 (order matters)", () => {
    const mini = fallbackPricing("o1-mini");
    expect(mini.input).toBe(3.0);
    expect(mini.output).toBe(12.0);

    const full = fallbackPricing("o1");
    expect(full.input).toBe(15.0);
    expect(full.output).toBe(60.0);
  });

  it("matches DeepSeek", () => {
    const result = fallbackPricing("deepseek-chat");
    expect(result.input).toBe(0.14);
    expect(result.output).toBe(0.28);
  });

  it("returns zero for unknown models", () => {
    const result = fallbackPricing("totally-unknown-model-v99");
    expect(result.input).toBe(0);
    expect(result.output).toBe(0);
  });

  it("is case-insensitive", () => {
    const upper = fallbackPricing("CLAUDE-SONNET-4");
    expect(upper.input).toBe(3.0);
    const lower = fallbackPricing("claude-sonnet-4");
    expect(lower.input).toBe(3.0);
  });

  // BUG PROBE: Gemini Flash Lite should match the lite-specific pattern,
  // not the generic flash pattern. If patterns are reordered, lite would
  // get the wrong pricing.
  it("Gemini Flash Lite uses lite-specific pricing", () => {
    const result = fallbackPricing("gemini-2.0-flash-lite");
    expect(result.input).toBe(0.075);
    expect(result.output).toBe(0.3);
  });
});

describe("getAiProviderModel", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("returns anthropic model for anthropic provider", async () => {
    const result = await getAiProviderModel("anthropic", "sk-test", "claude-sonnet-4");
    expect(result).toEqual(
      expect.objectContaining({ modelId: "claude-sonnet-4", provider: "anthropic" }),
    );
  });

  it("returns google model for google provider", async () => {
    const result = await getAiProviderModel("google", "goog-key", "gemini-2.5-pro");
    expect(result).toEqual(
      expect.objectContaining({ modelId: "gemini-2.5-pro", provider: "google" }),
    );
  });

  it("returns openai model for openai provider", async () => {
    const result = await getAiProviderModel("openai", "sk-openai", "gpt-4o");
    expect(result).toEqual(
      expect.objectContaining({ modelId: "gpt-4o", provider: "openai" }),
    );
  });

  it("uses kilo proxy URL for kilo provider", async () => {
    mockInvoke.mockResolvedValueOnce("http://127.0.0.1:9999");

    const result = await getAiProviderModel("kilo", "kilo-key", "gpt-4o");
    expect(mockInvoke).toHaveBeenCalledWith("get_kilo_proxy_url");
    expect(result).toBeDefined();
  });

  it("falls back to openai for unknown provider", async () => {
    const result = await getAiProviderModel("custom-provider", "key", "model-x");
    expect(result).toBeDefined();
  });
});

describe("loadKiloModels", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("parses model list from fetch_json response", async () => {
    mockInvoke.mockResolvedValueOnce({
      data: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          supported_parameters: ["tools", "reasoning"],
          architecture: { input_modalities: ["text", "image"] },
          pricing: { prompt: "0.0000025", completion: "0.00001" },
        },
        {
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          supported_parameters: ["tools"],
          architecture: { input_modalities: ["text"] },
        },
      ],
    });

    const models = await loadKiloModels("kilo-key");

    expect(mockInvoke).toHaveBeenCalledWith("fetch_json", {
      url: "https://api.kilo.ai/api/gateway/models",
      headers: { Authorization: "Bearer kilo-key" },
    });
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("gpt-4o");
    expect(models[0].name).toBe("GPT-4o");
    expect(models[0].capabilities.tools).toBe(true);
    expect(models[0].capabilities.vision).toBe(true);
    expect(models[1].capabilities.vision).toBe(false);
  });

  it("returns empty array when fetch_json fails", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Network error"));

    const models = await loadKiloModels("bad-key");
    expect(models).toEqual([]);
  });

  it("returns empty array when response has no data array", async () => {
    mockInvoke.mockResolvedValueOnce({ data: null });

    const models = await loadKiloModels("key");
    expect(models).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runAgent tests
// ---------------------------------------------------------------------------

function fakeStream(chunks: Array<Record<string, any>>) {
  return {
    fullStream: (async function* () {
      for (const c of chunks) yield c;
    })(),
  };
}

function setupLoadLlmModel() {
  const mockLoadModels = vi.mocked(loadModels);
  mockLoadModels.mockResolvedValue({
    chat: [
      {
        id: "test-model",
        name: "Test Model",
        capabilities: { tools: true, vision: false, reasoning: false, caching: false },
        pricing: { prompt: "0.000003", completion: "0.000015" },
      },
    ],
  } as any);
  mockInvoke
    .mockResolvedValueOnce({ provider: "openai", model: "test-model" })
    .mockResolvedValueOnce("sk-test-key");
}

function makeCallbacks(overrides?: Partial<AgentRunnerCallbacks>): AgentRunnerCallbacks {
  return {
    onChunk: vi.fn(),
    onUsage: vi.fn(),
    onModelLoaded: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onStopped: vi.fn(),
    ...overrides,
  };
}

describe("runAgent", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockStreamText.mockReset();
  });

  it("streams text-delta chunks and calls onDone with concatenated text", async () => {
    setupLoadLlmModel();
    mockStreamText.mockReturnValueOnce(fakeStream([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "World" },
    ]));
    const cb = makeCallbacks();
    const controller = new AbortController();

    await runAgent({
      systemPrompt: "test",
      userMessage: "hi",
      plugins: [],
      signal: controller.signal,
      callbacks: cb,
    });

    expect(cb.onChunk).toHaveBeenCalledWith({ type: "content", text: "Hello " });
    expect(cb.onChunk).toHaveBeenCalledWith({ type: "content", text: "World" });
    expect(cb.onDone).toHaveBeenCalledWith("Hello World");
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it("handles tool-call and tool-result chunks", async () => {
    setupLoadLlmModel();
    mockStreamText.mockReturnValueOnce(fakeStream([
      { type: "tool-call", toolName: "write_file" },
      { type: "tool-result", toolName: "write_file" },
    ]));
    const cb = makeCallbacks();

    await runAgent({
      systemPrompt: "test",
      userMessage: "hi",
      plugins: [],
      signal: new AbortController().signal,
      callbacks: cb,
    });

    expect(cb.onChunk).toHaveBeenCalledWith(expect.objectContaining({
      type: "tool", name: "write_file", state: "running",
    }));
    expect(cb.onChunk).toHaveBeenCalledWith(expect.objectContaining({
      type: "tool", name: "write_file", state: "done", status: "success",
    }));
    expect(cb.onDone).toHaveBeenCalled();
  });

  it("handles reasoning-delta chunks", async () => {
    setupLoadLlmModel();
    mockStreamText.mockReturnValueOnce(fakeStream([
      { type: "reasoning-delta", text: "thinking..." },
    ]));
    const cb = makeCallbacks();

    await runAgent({
      systemPrompt: "test",
      userMessage: "hi",
      plugins: [],
      signal: new AbortController().signal,
      callbacks: cb,
    });

    expect(cb.onChunk).toHaveBeenCalledWith({ type: "reasoning", text: "thinking..." });
    expect(cb.onDone).toHaveBeenCalledWith("thinking...");
  });

  it("calls onError on stream error chunk", async () => {
    setupLoadLlmModel();
    mockStreamText.mockReturnValueOnce(fakeStream([
      { type: "text-delta", text: "partial" },
      { type: "error", error: "rate_limit_exceeded" },
    ]));
    const cb = makeCallbacks();

    await runAgent({
      systemPrompt: "test",
      userMessage: "hi",
      plugins: [],
      signal: new AbortController().signal,
      callbacks: cb,
    });

    expect(cb.onError).toHaveBeenCalledWith("rate_limit_exceeded");
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it("calls onStopped when signal is aborted", async () => {
    setupLoadLlmModel();
    const abortError = new DOMException("signal is aborted", "AbortError");
    mockStreamText.mockImplementationOnce(() => { throw abortError; });
    const cb = makeCallbacks();

    await runAgent({
      systemPrompt: "test",
      userMessage: "hi",
      plugins: [],
      signal: new AbortController().signal,
      callbacks: cb,
    });

    expect(cb.onStopped).toHaveBeenCalled();
    expect(cb.onDone).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it("calls onError when streamText throws non-abort error", async () => {
    setupLoadLlmModel();
    mockStreamText.mockImplementationOnce(() => { throw new Error("network failure"); });
    const cb = makeCallbacks();

    await runAgent({
      systemPrompt: "test",
      userMessage: "hi",
      plugins: [],
      signal: new AbortController().signal,
      callbacks: cb,
    });

    expect(cb.onError).toHaveBeenCalledWith("network failure");
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it("only fires the first terminal callback (error before done)", async () => {
    setupLoadLlmModel();
    mockStreamText.mockReturnValueOnce(fakeStream([
      { type: "error", error: "fail" },
    ]));
    const cb = makeCallbacks();

    await runAgent({
      systemPrompt: "test",
      userMessage: "hi",
      plugins: [],
      signal: new AbortController().signal,
      callbacks: cb,
    });

    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it("passes tools: undefined when no plugins provided", async () => {
    setupLoadLlmModel();
    mockStreamText.mockReturnValueOnce(fakeStream([]));

    await runAgent({
      systemPrompt: "test",
      userMessage: "hi",
      plugins: [],
      signal: new AbortController().signal,
      callbacks: makeCallbacks(),
    });

    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({ tools: undefined }),
    );
  });

  it("filters out disabled plugins", async () => {
    setupLoadLlmModel();
    mockStreamText.mockReturnValueOnce(fakeStream([]));

    const enabledPlugin = {
      isEnabled: () => true,
      getName: () => "enabled_tool",
      toAiTool: () => ({ description: "enabled" }),
    };
    const disabledPlugin = {
      isEnabled: () => false,
      getName: () => "disabled_tool",
      toAiTool: () => ({ description: "disabled" }),
    };

    await runAgent({
      systemPrompt: "test",
      userMessage: "hi",
      plugins: [enabledPlugin as any, disabledPlugin as any],
      signal: new AbortController().signal,
      callbacks: makeCallbacks(),
    });

    const toolsArg = mockStreamText.mock.calls[0][0].tools;
    expect(toolsArg).toHaveProperty("enabled_tool");
    expect(toolsArg).not.toHaveProperty("disabled_tool");
  });

  it("includes image content block when attachment is provided", async () => {
    setupLoadLlmModel();
    mockStreamText.mockReturnValueOnce(fakeStream([]));

    await runAgent({
      systemPrompt: "test",
      userMessage: "check this",
      plugins: [],
      signal: new AbortController().signal,
      callbacks: makeCallbacks(),
      attachment: { data: "base64data", mimeType: "image/png" },
    });

    const messages = mockStreamText.mock.calls[0][0].messages;
    const userMsg = messages[1];
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "check this" }),
      expect.objectContaining({ type: "image", image: "base64data", mediaType: "image/png" }),
    ]));
  });

  it("calls onModelLoaded with model info", async () => {
    setupLoadLlmModel();
    mockStreamText.mockReturnValueOnce(fakeStream([]));
    const cb = makeCallbacks();

    await runAgent({
      systemPrompt: "test",
      userMessage: "hi",
      plugins: [],
      signal: new AbortController().signal,
      callbacks: cb,
    });

    expect(cb.onModelLoaded).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: expect.any(String) }),
    );
  });
});
