import { invoke } from "@tauri-apps/api/core";
import { loadModels, type ChatModel } from "multi-llm-ts";
import { Plugin } from "./plugins/Plugin";
import type { LlmProviderId } from "./types";
import { streamText, type ModelMessage, type Tool, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

export interface LlmUsageData {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ModelInfo {
  modelName: string;
  inputPricePerM: number;
  outputPricePerM: number;
}

export interface AgentRunnerCallbacks {
  onChunk: (chunk: { type: string; text?: string; name?: string; state?: string; status?: string }) => void;
  onUsage?: (usage: LlmUsageData) => void;
  onModelLoaded?: (info: ModelInfo) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
  onStopped: (fullText: string) => void;
}

export interface Attachment {
  data: string;
  mimeType: string;
}

export interface AgentRunnerParams {
  systemPrompt: string;
  userMessage: string;
  plugins: Plugin[];
  signal: AbortSignal;
  callbacks: AgentRunnerCallbacks;
  attachment?: Attachment;
}

export interface LoadedModel {
  model: any;
  modelName: string;
  inputPricePerM: number;
  outputPricePerM: number;
}

/**
 * Fallback pricing ($/M tokens) for providers whose model objects lack pricing data.
 * Patterns are matched against the model ID (case-insensitive, first match wins).
 */
const FALLBACK_PRICING: Array<[RegExp, number, number]> = [
  // Google Gemini — prices per 1M tokens (input, output)
  [/gemini.*3\.1.*pro/i,         1.25,   10.00],
  [/gemini.*3.*pro/i,            1.25,   10.00],
  [/gemini.*2\.5.*pro/i,         1.25,   10.00],
  [/gemini.*2\.5.*flash/i,       0.15,    0.60],
  [/gemini.*flash.*lite/i,       0.075,   0.30],
  [/gemini.*3.*flash/i,          0.15,    0.60],
  [/gemini.*2\.0.*flash/i,       0.10,    0.40],
  [/gemini.*flash/i,             0.10,    0.40],
  [/gemini.*pro/i,               1.25,   10.00],
  // Anthropic
  [/claude.*opus/i,              15.00,   75.00],
  [/claude.*sonnet/i,             3.00,   15.00],
  [/claude.*haiku/i,              0.25,    1.25],
  // OpenAI
  [/gpt-4o-mini/i,               0.15,    0.60],
  [/gpt-4o/i,                    2.50,   10.00],
  [/gpt-4-turbo/i,              10.00,   30.00],
  [/o1-mini/i,                   3.00,   12.00],
  [/o1/i,                       15.00,   60.00],
  // DeepSeek
  [/deepseek/i,                  0.14,    0.28],
];

function fallbackPricing(modelId: string): { input: number; output: number } {
  for (const [pattern, input, output] of FALLBACK_PRICING) {
    if (pattern.test(modelId)) return { input, output };
  }
  return { input: 0, output: 0 };
}

let _kiloProxyUrl: string | null = null;
async function getKiloProxyUrl(): Promise<string> {
  if (_kiloProxyUrl === null) {
    _kiloProxyUrl = await invoke<string>("get_kilo_proxy_url");
  }
  return _kiloProxyUrl;
}

export async function getAiProviderModel(providerId: string, apiKey: string, modelId: string) {
  switch (providerId) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "kilo": {
      const proxyUrl = await getKiloProxyUrl();
      const baseURL = proxyUrl ? `${proxyUrl}/v1` : "https://api.kilo.ai/api/gateway/v1";
      return createOpenAI({ baseURL, apiKey })(modelId);
    }
    case "openrouter":
      return createOpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey })(modelId);
    case "deepseek":
      return createOpenAI({ baseURL: "https://api.deepseek.com/v1", apiKey })(modelId);
    case "groq":
      return createOpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey })(modelId);
    case "lmstudio":
      return createOpenAI({ baseURL: "http://localhost:1234/v1", apiKey: apiKey || "lmstudio" })(modelId);
    case "ollama":
      return createOpenAI({ baseURL: "http://localhost:11434/v1", apiKey: apiKey || "ollama" })(modelId);
    case "cerebras":
      return createOpenAI({ baseURL: "https://api.cerebras.ai/v1", apiKey })(modelId);
    case "mistralai":
      return createOpenAI({ baseURL: "https://api.mistral.ai/v1", apiKey })(modelId);
    case "xai":
      return createOpenAI({ baseURL: "https://api.x.ai/v1", apiKey })(modelId);
    case "azure":
      // Azure requires specific setup, fallback to OpenAI for now or use createAzure if installed
      return createOpenAI({ apiKey })(modelId);
    default:
      return createOpenAI({ apiKey })(modelId);
  }
}

export async function loadKiloModels(apiKey: string): Promise<ChatModel[]> {
  try {
    const data = await invoke<{ data: any[] }>("fetch_json", {
      url: "https://api.kilo.ai/api/gateway/models",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (data && Array.isArray(data.data)) {
      return data.data.map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        capabilities: {
          tools: m.supported_parameters?.includes("tools") ?? false,
          vision: m.architecture?.input_modalities?.includes("image") ?? false,
          reasoning: m.supported_parameters?.includes("reasoning") ?? false,
          caching: false,
        },
        pricing: m.pricing ? {
          prompt: m.pricing.prompt,
          completion: m.pricing.completion,
        } : undefined,
      })) as ChatModel[];
    }
    return [];
  } catch (e) {
    console.error("Error loading Kilo models:", e);
    return [];
  }
}

/**
 * Load the user's configured LLM settings and return a ready-to-use model.
 * Shared across all agent roles -- every agent uses the same provider/model/key.
 */
async function loadLlmModel(): Promise<LoadedModel> {
  const settings = await invoke<{ provider: string; model: string }>("load_llm_settings");
  const apiKey = await invoke<string | null>("get_llm_api_key", {
    provider: settings.provider,
  });
  
  // Some local providers might not need an API key
  const isLocal = settings.provider === "lmstudio" || settings.provider === "ollama";
  if (!isLocal && !apiKey?.trim()) {
    throw new Error("LLM not configured. Set up API key in settings.");
  }

  // We still use multi-llm-ts to fetch the model metadata/pricing for consistency with the wizard
  let modelMeta: ChatModel | undefined;
  
  if (settings.provider === "kilo") {
    const kiloModels = await loadKiloModels(apiKey?.trim() || "local");
    modelMeta = kiloModels.find((m) => m.id === settings.model) ?? kiloModels[0];
  } else {
    const modelsResult = await loadModels(settings.provider as LlmProviderId, {
      apiKey: apiKey?.trim() || "local",
    });
    modelMeta = modelsResult?.chat?.find((m) => m.id === settings.model) ?? modelsResult?.chat?.[0];
  }
  
  // If not found in the list (e.g. manually typed), create a fallback meta
  const actualModelId = modelMeta?.id || settings.model;
  if (!actualModelId) {
    throw new Error("No model available.");
  }

  const modelAny = (modelMeta || {}) as Record<string, unknown>;
  const pricing = modelAny.pricing as Record<string, unknown> | undefined;
  
  let inputPricePerM = pricing
    ? (typeof pricing.input === "number" ? pricing.input * 1_000_000
       : typeof pricing.prompt === "string" ? parseFloat(pricing.prompt) * 1_000_000
       : 0)
    : 0;
  let outputPricePerM = pricing
    ? (typeof pricing.output === "number" ? pricing.output * 1_000_000
       : typeof pricing.completion === "string" ? parseFloat(pricing.completion) * 1_000_000
       : 0)
    : 0;

  if (inputPricePerM === 0 && outputPricePerM === 0) {
    const fb = fallbackPricing(actualModelId);
    inputPricePerM = fb.input;
    outputPricePerM = fb.output;
  }

  const aiModel = await getAiProviderModel(settings.provider, apiKey?.trim() || "", actualModelId);

  return {
    model: aiModel,
    modelName: modelMeta?.name ?? actualModelId,
    inputPricePerM,
    outputPricePerM,
  };
}

/**
 * Run a single LLM agent conversation to completion.
 * This is the core bridge that all agent roles use -- orchestrator, developer, worker, validator.
 */
export async function runAgent(params: AgentRunnerParams): Promise<void> {
  const { systemPrompt, userMessage, plugins, signal, callbacks, attachment } = params;

  let fullText = "";
  const loaded = await loadLlmModel();
  callbacks.onModelLoaded?.({
    modelName: loaded.modelName,
    inputPricePerM: loaded.inputPricePerM,
    outputPricePerM: loaded.outputPricePerM,
  });
  
  try {
    const tools: Record<string, Tool> = {};
    for (const plugin of plugins) {
      if (plugin.isEnabled()) {
        tools[plugin.getName()] = plugin.toAiTool();
      }
    }

    const messages: ModelMessage[] = [
      { role: "system", content: systemPrompt }
    ];

    if (attachment) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: userMessage },
          { 
            type: "image", 
            image: attachment.data,
            mediaType: attachment.mimeType
          }
        ]
      });
    } else {
      messages.push({ role: "user", content: userMessage });
    }

    const result = streamText({
      model: loaded.model,
      messages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      stopWhen: stepCountIs(10), // Allow the model to call tools and continue
      abortSignal: signal,
      onStepFinish: (event) => {
        if (event.usage) {
          callbacks.onUsage?.({
            prompt_tokens: event.usage.inputTokens || 0,
            completion_tokens: event.usage.outputTokens || 0
          });
        }
      }
    });

    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        fullText += chunk.text;
        callbacks.onChunk({ type: "content", text: chunk.text });
      } else if (chunk.type === "reasoning-delta") {
        fullText += chunk.text;
        callbacks.onChunk({ type: "reasoning", text: chunk.text });
      } else if (chunk.type === "tool-call") {
        callbacks.onChunk({ 
          type: "tool", 
          name: chunk.toolName, 
          state: "running",
          text: `Running ${chunk.toolName}...` 
        });
      } else if (chunk.type === "tool-result") {
        callbacks.onChunk({ 
          type: "tool", 
          name: chunk.toolName, 
          state: "done",
          status: "success"
        });
      } else if (chunk.type === "error") {
        callbacks.onError(String(chunk.error));
      }
    }

    callbacks.onDone(fullText);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      callbacks.onStopped(fullText);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      callbacks.onError(msg);
    }
  }
}
