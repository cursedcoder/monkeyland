import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LlmSetupWizard } from "./LlmSetupWizard";
import { LLM_PROVIDER_LABELS, type LlmProviderId } from "../types";

interface LlmSettingsPayload {
  provider: string;
  model: string;
}

export function LlmSettings() {
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");

  const checkSetup = useCallback(async () => {
    try {
      const done = await invoke<boolean>("get_llm_setup_done");
      setSetupDone(done);
      if (done) {
        const payload = await invoke<LlmSettingsPayload>("load_llm_settings");
        setProvider(payload.provider);
        setModel(payload.model);
      }
    } catch (_) {
      setSetupDone(false);
    }
  }, []);

  useEffect(() => {
    checkSetup();
  }, [checkSetup]);

  const handleWizardComplete = useCallback(() => {
    setWizardOpen(false);
    setSetupDone(true);
    checkSetup();
  }, [checkSetup]);

  if (setupDone === null) {
    return null;
  }

  if (!setupDone || wizardOpen) {
    return (
      <LlmSetupWizard
        onComplete={handleWizardComplete}
        initialProvider={provider || "anthropic"}
        initialModel={model}
      />
    );
  }

  const providerLabel =
    provider && LLM_PROVIDER_LABELS[provider as LlmProviderId]
      ? LLM_PROVIDER_LABELS[provider as LlmProviderId]
      : provider;

  return (
    <button
      type="button"
      className="llm-settings-chip"
      onClick={() => setWizardOpen(true)}
      title="Change LLM provider and model"
    >
      <strong>{providerLabel}</strong>
      <span>·</span>
      <span>{model || "—"}</span>
    </button>
  );
}
