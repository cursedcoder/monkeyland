import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadModels } from "multi-llm-ts";
import type { ChatModel } from "multi-llm-ts";
import { loadKiloModels } from "../agentRunner";
import { generateText } from "ai";
import { getAiProviderModel } from "../agentRunner";
import { CustomSelect } from "./CustomSelect";
import {
  LLM_PROVIDER_IDS,
  LLM_PROVIDER_LABELS,
  type LlmProviderId,
} from "../types";

const STEPS = ["Provider", "API key", "Model", "Test"] as const;
const TEST_PROMPT = "Hi";

interface LlmSetupWizardProps {
  onComplete: () => void;
  onClose?: () => void;
  initialProvider?: string;
  initialModel?: string;
}

export function LlmSetupWizard({
  onComplete,
  onClose,
  initialProvider = "anthropic",
  initialModel = "",
}: LlmSetupWizardProps) {
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<LlmProviderId>(
    (initialProvider as LlmProviderId) || "anthropic"
  );
  const [apiKey, setApiKey] = useState("");
  const [modelList, setModelList] = useState<ChatModel[]>([]);
  const [modelId, setModelId] = useState(initialModel);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "running" | "ok" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // When provider changes, try to load its saved API key and last used model
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const savedKey = await invoke<string | null>("get_llm_api_key", { provider });
        if (active && savedKey) {
          setApiKey(savedKey);
        } else if (active) {
          setApiKey("");
        }
      } catch {
        if (active) setApiKey("");
      }

      if (active) {
        // If this is the initial provider, we might want to use the initialModel.
        // Otherwise, look up the last used model for this provider in localStorage.
        if (provider === initialProvider && initialModel) {
          setModelId(initialModel);
        } else {
          const savedModel = localStorage.getItem(`llm_model_${provider}`);
          if (savedModel) {
            setModelId(savedModel);
          } else {
            setModelId("");
          }
        }
        
        // Reset test status when provider changes
        setTestStatus("idle");
        setTestError(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [provider, initialProvider, initialModel]);

  const selectedModel = modelList.find((m) => m.id === modelId) ?? modelList[0];
  const canNext =
    step === 0 ||
    (step === 1 && apiKey.trim().length > 0) ||
    (step === 2 && (selectedModel != null || modelId.trim().length > 0)) ||
    (step === 3 && testStatus === "ok");

  const loadModelsForProvider = useCallback(async () => {
    if (!apiKey.trim()) return;
    setModelsLoading(true);
    setModelList([]);
    try {
      if (provider === "kilo") {
        const models = await loadKiloModels(apiKey.trim());
        if (models.length) {
          setModelList(models);
          
          // Only set to the first model if we don't already have a valid modelId selected
          setModelsLoading(false); // Do this before state updates just in case
          setModelId((currentModelId) => {
            const hasCurrent = models.some(m => m.id === currentModelId);
            if (hasCurrent) return currentModelId;
            
            const savedModel = localStorage.getItem(`llm_model_${provider}`);
            const hasSaved = models.some(m => m.id === savedModel);
            if (hasSaved && savedModel) return savedModel;

            return models[0]?.id ?? "";
          });
          return;
        }
      } else {
        const result = await loadModels(provider as LlmProviderId, { apiKey: apiKey.trim() });
        if (result?.chat?.length) {
          setModelList(result.chat);
          
          // Only set to the first model if we don't already have a valid modelId selected
          setModelsLoading(false); // Do this before state updates just in case
          setModelId((currentModelId) => {
            const hasCurrent = result.chat.some(m => m.id === currentModelId);
            if (hasCurrent) return currentModelId;
            
            const savedModel = localStorage.getItem(`llm_model_${provider}`);
            const hasSaved = result.chat.some(m => m.id === savedModel);
            if (hasSaved && savedModel) return savedModel;

            return result.chat[0]?.id ?? "";
          });
          return;
        }
      }
    } catch (_) {
      setModelList([]);
    } finally {
      setModelsLoading(false);
    }
  }, [provider, apiKey]);

  useEffect(() => {
    if (step === 2 && apiKey.trim()) {
      loadModelsForProvider();
    }
  }, [step, apiKey, loadModelsForProvider]);

  const handleTest = useCallback(async () => {
    const finalModelId = selectedModel?.id || modelId.trim();
    if (!apiKey.trim() || !finalModelId) return;
    setTestStatus("running");
    setTestError(null);
    try {
      const aiModel = getAiProviderModel(provider, apiKey.trim(), finalModelId);
      await generateText({
        model: aiModel,
        prompt: TEST_PROMPT,
      });
      setTestStatus("ok");
    } catch (e) {
      setTestStatus("error");
      setTestError(e instanceof Error ? e.message : String(e));
    }
  }, [provider, selectedModel, modelId, apiKey]);

  const handleSaveAndFinish = useCallback(async () => {
    const finalModelId = selectedModel?.id || modelId.trim();
    if (testStatus !== "ok" || !finalModelId) return;
    setSaving(true);
    try {
      await invoke("set_llm_api_key", { provider, apiKey: apiKey.trim() });
      await invoke("save_llm_settings", {
        payload: { provider, model: finalModelId },
      });
      localStorage.setItem(`llm_model_${provider}`, finalModelId);
      await invoke("set_llm_setup_done");
      onComplete();
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [provider, selectedModel, modelId, apiKey, testStatus, onComplete]);

  const goNext = useCallback(() => {
    if (step < STEPS.length - 1) setStep((s) => s + 1);
    else if (step === STEPS.length - 1 && testStatus === "ok") handleSaveAndFinish();
  }, [step, testStatus, handleSaveAndFinish]);

  const goBack = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  return (
    <div className="llm-wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="llm-wizard-title">
      <div className="llm-wizard-backdrop" onClick={onClose ? onClose : () => {}} />
      <div className="llm-wizard-card">
        {onClose && (
          <button type="button" className="llm-wizard-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        )}
        <h2 id="llm-wizard-title" className="llm-wizard-title">
          Set up your LLM
        </h2>
        <div className="llm-wizard-steps">
          {STEPS.map((label, i) => (
            <span
              key={label}
              className={`llm-wizard-step ${i === step ? "active" : ""} ${i < step ? "done" : ""}`}
            >
              {i + 1}. {label}
            </span>
          ))}
        </div>

        <div className="llm-wizard-body">
          {step === 0 && (
            <>
              <p className="llm-wizard-label">Choose a provider</p>
              <div className="llm-wizard-providers">
                {LLM_PROVIDER_IDS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`llm-wizard-provider-btn ${provider === p ? "selected" : ""}`}
                    onClick={() => setProvider(p)}
                  >
                    {LLM_PROVIDER_LABELS[p]}
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <p className="llm-wizard-label">Enter your API key for {LLM_PROVIDER_LABELS[provider]}</p>
              <input
                type="password"
                className="llm-wizard-input"
                placeholder="sk-… or api key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
              />
              <p className="llm-wizard-hint">Stored locally on your machine. Never sent to us.</p>
            </>
          )}

          {step === 2 && (
            <>
              <p className="llm-wizard-label">Pick a model</p>
              {modelsLoading ? (
                <p className="llm-wizard-loading">Loading models…</p>
              ) : modelList.length === 0 ? (
                <>
                  <p className="llm-wizard-hint">Could not load models automatically. Please type the model ID.</p>
                  <input
                    type="text"
                    className="llm-wizard-input"
                    placeholder="e.g. anthropic/claude-opus-4.6"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                  />
                </>
              ) : (
                <CustomSelect
                  value={modelId}
                  options={modelList.map((m) => ({
                    value: m.id,
                    label: m.name || m.id,
                  }))}
                  onChange={(value) => setModelId(value)}
                />
              )}
            </>
          )}

          {step === 3 && (
            <>
              <p className="llm-wizard-label">Test the connection</p>
              <p className="llm-wizard-hint">
                We’ll send a short test message to make sure your key and model work.
              </p>
              {testStatus === "idle" && (
                <button
                  type="button"
                  className="llm-wizard-btn primary"
                  onClick={handleTest}
                  disabled={!selectedModel && !modelId.trim()}
                >
                  Test connection
                </button>
              )}
              {testStatus === "running" && (
                <p className="llm-wizard-loading">Testing…</p>
              )}
              {testStatus === "ok" && (
                <p className="llm-wizard-success">Connection succeeded. You can save and continue.</p>
              )}
              {testStatus === "error" && testError && (
                <p className="llm-wizard-error">{testError}</p>
              )}
              {testStatus === "ok" && (
                <button
                  type="button"
                  className="llm-wizard-btn primary"
                  onClick={handleSaveAndFinish}
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Save & finish"}
                </button>
              )}
            </>
          )}
        </div>

        <div className="llm-wizard-actions">
          <button
            type="button"
            className="llm-wizard-btn secondary"
            onClick={goBack}
            disabled={step === 0}
          >
            Back
          </button>
          {step < 3 && (
            <button
              type="button"
              className="llm-wizard-btn primary"
              onClick={goNext}
              disabled={!canNext}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
