import { invoke } from "@tauri-apps/api/core";
import { loadModels, igniteModel, Message, Plugin } from "multi-llm-ts";
import type { LlmChunk } from "multi-llm-ts";
import type { LlmProviderId } from "./types";

export interface AgentRunnerCallbacks {
  onChunk: (chunk: { type: string; text?: string; name?: string; state?: string; status?: string }) => void;
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

/**
 * Load the user's configured LLM settings and return a ready-to-use model.
 * Shared across all agent roles -- every agent uses the same provider/model/key.
 */
async function loadLlmModel() {
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

  return igniteModel(settings.provider, model, { apiKey: apiKey.trim() });
}

/**
 * Run a single LLM agent conversation to completion.
 * This is the core bridge that all agent roles use -- orchestrator, developer, worker, validator.
 */
export async function runAgent(params: AgentRunnerParams): Promise<void> {
  const { systemPrompt, userMessage, plugins, signal, callbacks } = params;

  let fullText = "";
  try {
    const llmModel = await loadLlmModel();
    for (const plugin of plugins) {
      llmModel.addPlugin(plugin);
    }

    const stream = llmModel.generate(
      [
        new Message("system", systemPrompt),
        new Message("user", userMessage),
      ],
      { tools: true, abortSignal: signal },
    );

    for await (const chunk of stream as AsyncIterable<LlmChunk>) {
      if (!chunk || typeof chunk !== "object" || !("type" in chunk)) continue;
      const c = chunk as { type: string; text?: string; name?: string; state?: string; status?: string };

      callbacks.onChunk(c);

      if ((c.type === "content" || c.type === "reasoning") && c.text) {
        fullText += c.text;
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
