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

  const pricing = (model as Record<string, unknown>).pricing as { input?: number; output?: number; prompt?: string; completion?: string } | undefined;
  const inputPricePerM = pricing?.input ?? (pricing?.prompt ? parseFloat(pricing.prompt) * 1_000_000 : 0);
  const outputPricePerM = pricing?.output ?? (pricing?.completion ? parseFloat(pricing.completion) * 1_000_000 : 0);

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
      { tools: true, abortSignal: signal },
    );

    for await (const chunk of stream as AsyncIterable<LlmChunk>) {
      if (!chunk || typeof chunk !== "object" || !("type" in chunk)) continue;
      const c = chunk as Record<string, unknown>;

      callbacks.onChunk(c as { type: string; text?: string; name?: string; state?: string; status?: string });

      if ((c.type === "content" || c.type === "reasoning") && typeof c.text === "string") {
        fullText += c.text;
      }

      if (c.type === "usage" && c.usage && typeof c.usage === "object") {
        const u = c.usage as { prompt_tokens?: number; completion_tokens?: number };
        callbacks.onUsage?.({
          prompt_tokens: u.prompt_tokens ?? 0,
          completion_tokens: u.completion_tokens ?? 0,
        });
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
