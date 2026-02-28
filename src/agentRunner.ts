import { invoke } from "@tauri-apps/api/core";
import { loadModels, igniteModel, Message, Plugin } from "multi-llm-ts";
import type { LlmChunk } from "multi-llm-ts";
import type { LlmProviderId } from "./types";

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

export interface AgentRunnerParams {
  systemPrompt: string;
  userMessage: string;
  plugins: Plugin[];
  signal: AbortSignal;
  callbacks: AgentRunnerCallbacks;
}

export interface LoadedModel {
  engine: ReturnType<typeof igniteModel>;
  modelName: string;
  inputPricePerM: number;
  outputPricePerM: number;
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
  if (!apiKey?.trim()) {
    throw new Error("LLM not configured. Set up API key in settings.");
  }

  const modelsResult = await loadModels(settings.provider as LlmProviderId, {
    apiKey: apiKey.trim(),
  });
  const model = modelsResult?.chat?.find((m) => m.id === settings.model) ?? modelsResult?.chat?.[0];
  if (!model) {
    throw new Error("No model available.");
  }

  const modelAny = model as Record<string, unknown>;
  const pricing = modelAny.pricing as Record<string, unknown> | undefined;
  // Pricing formats vary by provider:
  //   OpenRouter: { prompt: "0.000003", completion: "0.000015" } (string, $/token)
  //   Other:      { input: 0.000003, output: 0.000015 } (number, $/token)
  // We normalize to price-per-million-tokens for costStore.
  const inputPricePerM = pricing
    ? (typeof pricing.input === "number" ? pricing.input * 1_000_000
       : typeof pricing.prompt === "string" ? parseFloat(pricing.prompt) * 1_000_000
       : 0)
    : 0;
  const outputPricePerM = pricing
    ? (typeof pricing.output === "number" ? pricing.output * 1_000_000
       : typeof pricing.completion === "string" ? parseFloat(pricing.completion) * 1_000_000
       : 0)
    : 0;

  return {
    engine: igniteModel(settings.provider, model, { apiKey: apiKey.trim() }),
    modelName: model.name ?? model.id,
    inputPricePerM,
    outputPricePerM,
  };
}

/**
 * Run a single LLM agent conversation to completion.
 * This is the core bridge that all agent roles use -- orchestrator, developer, worker, validator.
 */
export async function runAgent(params: AgentRunnerParams): Promise<void> {
  const { systemPrompt, userMessage, plugins, signal, callbacks } = params;

  let fullText = "";
  const loaded = await loadLlmModel();
  callbacks.onModelLoaded?.({
    modelName: loaded.modelName,
    inputPricePerM: loaded.inputPricePerM,
    outputPricePerM: loaded.outputPricePerM,
  });
  try {
    for (const plugin of plugins) {
      loaded.engine.addPlugin(plugin);
    }

    const stream = loaded.engine.generate(
      [
        new Message("system", systemPrompt),
        new Message("user", userMessage),
      ],
      { tools: true, usage: true, abortSignal: signal },
    );

    for await (const chunk of stream as AsyncIterable<LlmChunk>) {
      if (!chunk || typeof chunk !== "object" || !("type" in chunk)) continue;
      const c = chunk as Record<string, unknown>;

      callbacks.onChunk(c as { type: string; text?: string; name?: string; state?: string; status?: string });

      if ((c.type === "content" || c.type === "reasoning") && typeof c.text === "string") {
        fullText += c.text;
      }

      // Extract usage from dedicated "usage" chunks or from usage attached to other chunk types.
      const usagePayload = (c.type === "usage" ? c.usage : c.usage) as Record<string, unknown> | undefined;
      if (usagePayload && typeof usagePayload === "object") {
        // Handle both OpenAI (prompt_tokens) and Anthropic (input_tokens) field names.
        const prompt = Number(usagePayload.prompt_tokens ?? usagePayload.input_tokens ?? 0) || 0;
        const completion = Number(usagePayload.completion_tokens ?? usagePayload.output_tokens ?? 0) || 0;
        if (prompt > 0 || completion > 0) {
          callbacks.onUsage?.({ prompt_tokens: prompt, completion_tokens: completion });
        }
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
