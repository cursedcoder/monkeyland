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

/** Developer agent execution phases. */
export type ExecutionPhase = "planning" | "implementing" | "testing" | "finalizing" | "revising";

/** Events that trigger phase transitions. */
export type PhaseEvent = 
  | "plan_complete"
  | "impl_complete"
  | "tests_passed"
  | "tests_failed"
  | "validation_failed"
  | "revision_complete"
  | "reset";

/**
 * Get the current execution phase for a developer agent.
 * Returns null if the agent doesn't exist or is not a developer.
 */
export async function getAgentPhase(agentId: string): Promise<ExecutionPhase | null> {
  const phase = await invoke<string | null>("agent_get_phase", { agentId });
  return phase as ExecutionPhase | null;
}

/**
 * Transition a developer agent to a new execution phase.
 * Returns the new phase name on success.
 */
export async function transitionAgentPhase(
  agentId: string,
  event: PhaseEvent
): Promise<ExecutionPhase | null> {
  const newPhase = await invoke<string | null>("agent_transition_phase", { agentId, event });
  return newPhase as ExecutionPhase | null;
}

/**
 * Detect if a tool call should suggest a phase transition.
 * This is a heuristic for auto-detecting phase changes based on tool usage.
 */
export function suggestPhaseTransition(
  toolName: string,
  currentPhase: ExecutionPhase | null
): PhaseEvent | null {
  if (!currentPhase) return null;

  switch (currentPhase) {
    case "planning":
      // If write_file is called in planning, suggest moving to implementing
      if (toolName === "write_file") {
        return "plan_complete";
      }
      break;
    case "implementing":
      // If browser is used in implementing, suggest moving to testing
      if (toolName === "browser_action" || toolName === "browser_navigate") {
        return "impl_complete";
      }
      // If run_terminal_command looks like a test command, suggest testing
      break;
    case "revising":
      // After revision, if tests are run, could suggest revision_complete
      break;
  }
  return null;
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
  onDone: (fullText: string) => void | Promise<void>;
  onError: (error: string) => void | Promise<void>;
  onStopped: (fullText: string) => void | Promise<void>;
  /** Called when the agent's execution phase changes (developer agents only). */
  onPhaseChange?: (phase: ExecutionPhase) => void;
}

export interface Attachment {
  data: string;
  mimeType: string;
}

export interface AgentRunnerParams {
  systemPrompt: string;
  /** Single user message (for one-shot turns). Ignored if `messages` is provided. */
  userMessage?: string;
  /** Full conversation history for multi-turn support. If provided, takes precedence over userMessage. */
  messages?: ModelMessage[];
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
      const baseURL = proxyUrl ? proxyUrl : "https://api.kilo.ai/api/gateway";
      return createOpenAI({ baseURL, apiKey }).chat(modelId);
    }
    case "openrouter":
      return createOpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey }).chat(modelId);
    case "deepseek":
      return createOpenAI({ baseURL: "https://api.deepseek.com/v1", apiKey }).chat(modelId);
    case "groq":
      return createOpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey }).chat(modelId);
    case "lmstudio":
      return createOpenAI({ baseURL: "http://localhost:1234/v1", apiKey: apiKey || "lmstudio" }).chat(modelId);
    case "ollama":
      return createOpenAI({ baseURL: "http://localhost:11434/v1", apiKey: apiKey || "ollama" }).chat(modelId);
    case "cerebras":
      return createOpenAI({ baseURL: "https://api.cerebras.ai/v1", apiKey }).chat(modelId);
    case "mistralai":
      return createOpenAI({ baseURL: "https://api.mistral.ai/v1", apiKey }).chat(modelId);
    case "xai":
      return createOpenAI({ baseURL: "https://api.x.ai/v1", apiKey }).chat(modelId);
    case "azure":
      return createOpenAI({ apiKey }).chat(modelId);
    default:
      return createOpenAI({ apiKey }).chat(modelId);
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
 * 
 * For multi-turn conversations, pass the full conversation history via `messages`.
 * For single-turn (one-shot), pass `userMessage` which will be wrapped with the system prompt.
 */
const MAX_RATE_LIMIT_RETRIES = 3;
const INITIAL_BACKOFF_MS = 5000;

function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lowerMsg = msg.toLowerCase();
  return (
    lowerMsg.includes("too many requests") ||
    lowerMsg.includes("rate_limit") ||
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("429") ||
    lowerMsg.includes("quota") ||
    lowerMsg.includes("retryerror")
  );
}

export async function runAgent(params: AgentRunnerParams): Promise<void> {
  const { systemPrompt, userMessage, messages: inputMessages, plugins, signal, callbacks, attachment } = params;

  let fullText = "";
  let terminalState: "none" | "done" | "error" | "stopped" = "none";
  const emitDone = async () => {
    if (terminalState !== "none") return;
    terminalState = "done";
    await callbacks.onDone(fullText);
  };
  const emitError = async (msg: string) => {
    if (terminalState !== "none") return;
    terminalState = "error";
    await callbacks.onError(msg);
  };
  const emitStopped = async () => {
    if (terminalState !== "none") return;
    terminalState = "stopped";
    await callbacks.onStopped(fullText);
  };

  const loaded = await loadLlmModel();
  callbacks.onModelLoaded?.({
    modelName: loaded.modelName,
    inputPricePerM: loaded.inputPricePerM,
    outputPricePerM: loaded.outputPricePerM,
  });
  
  let rateLimitRetries = 0;
  while (rateLimitRetries <= MAX_RATE_LIMIT_RETRIES) {
  try {
    const tools: Record<string, Tool> = {};
    for (const plugin of plugins) {
      if (plugin.isEnabled()) {
        tools[plugin.getName()] = plugin.toAiTool();
      }
    }

    // Build messages array: either from provided conversation history or single userMessage
    let messages: ModelMessage[];
    
    if (inputMessages && inputMessages.length > 0) {
      // Multi-turn: prepend system prompt to provided conversation history
      messages = [
        { role: "system", content: systemPrompt },
        ...inputMessages.filter((m) => m.role !== "system"),
      ];
    } else {
      // Single-turn: build from userMessage
      const msg = userMessage ?? "";
      messages = [
        { role: "system", content: systemPrompt }
      ];

      if (attachment) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: msg },
            { 
              type: "image", 
              image: attachment.data,
              mediaType: attachment.mimeType
            }
          ]
        });
      } else {
        messages.push({ role: "user", content: msg });
      }
    }

    const result = streamText({
      model: loaded.model,
      messages,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      stopWhen: stepCountIs(10),
      abortSignal: signal,
      maxRetries: 5,
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
        await emitError(String(chunk.error));
        break;
      }
    }

    await emitDone();
    return;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      await emitStopped();
      return;
    }
    
    const msg = e instanceof Error ? e.message : String(e);
    
    if (isRateLimitError(e) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
      rateLimitRetries++;
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, rateLimitRetries - 1);
      console.warn(`[agentRunner] Rate limit hit, retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} after ${backoffMs}ms: ${msg}`);
      callbacks.onChunk({ type: "content", text: `\n\n[Rate limited, retrying in ${backoffMs / 1000}s...]\n\n` });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      fullText = "";
      continue;
    }
    
    await emitError(msg);
    return;
  }
  }
}
