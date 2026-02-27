import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LlmSettings as LlmSettingsType } from "../types";
import {
  LLM_PROVIDERS,
  LLM_MODELS,
  type LlmProvider,
} from "../types";

interface LlmSettingsPayload {
  provider: string;
  model: string;
}

export function LlmSettings() {
  const [provider, setProvider] = useState<string>("anthropic");
  const [model, setModel] = useState<string>("");

  const loadSettings = useCallback(async () => {
    try {
      const payload = await invoke<LlmSettingsPayload>("load_llm_settings");
      const p = LLM_PROVIDERS.includes(payload.provider as LlmProvider)
        ? (payload.provider as LlmProvider)
        : "anthropic";
      setProvider(p);
      const models = LLM_MODELS[p];
      const m =
        payload.model && models.includes(payload.model)
          ? payload.model
          : models[0] ?? "";
      setModel(m);
    } catch (_) {
      setProvider("anthropic");
      setModel("claude-sonnet-4-20250514");
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const saveSettings = useCallback(
    async (next: LlmSettingsType) => {
      try {
        await invoke("save_llm_settings", { payload: next });
      } catch (e) {
        console.warn("Failed to save LLM settings", e);
      }
    },
    []
  );

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const nextProvider = e.target.value as LlmProvider;
      setProvider(nextProvider);
      const models = LLM_MODELS[nextProvider];
      const nextModel = models[0] ?? "";
      setModel(nextModel);
      saveSettings({ provider: nextProvider, model: nextModel });
    },
    [saveSettings]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const nextModel = e.target.value;
      setModel(nextModel);
      saveSettings({ provider, model: nextModel });
    },
    [provider, saveSettings]
  );

  const models = LLM_PROVIDERS.includes(provider as LlmProvider)
    ? LLM_MODELS[provider as LlmProvider]
    : [];
  const modelValue =
    model && models.includes(model) ? model : models[0] ?? "";

  return (
    <div className="llm-settings">
      <label className="llm-settings-label">
        <span>Provider</span>
        <select
          className="llm-settings-select"
          value={provider}
          onChange={handleProviderChange}
          aria-label="LLM provider"
        >
          {LLM_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p === "anthropic" ? "Anthropic" : p === "openai" ? "OpenAI" : p}
            </option>
          ))}
        </select>
      </label>
      <label className="llm-settings-label">
        <span>Model</span>
        <select
          className="llm-settings-select"
          value={modelValue}
          onChange={handleModelChange}
          aria-label="LLM model"
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
