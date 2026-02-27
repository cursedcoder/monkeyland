import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadModels, igniteModel, Message } from "multi-llm-ts";
import type { ChatModel } from "multi-llm-ts";
import {
  LLM_PROVIDER_IDS,
  LLM_PROVIDER_LABELS,
  type LlmProviderId,
} from "../types";

const STEPS = ["Provider", "API key", "Model", "Test"] as const;
const TEST_PROMPT = "Hi";

interface LlmSetupWizardProps {
  onComplete: () => void;
  initialProvider?: string;
  initialModel?: string;
}

export function LlmSetupWizard({
  onComplete,
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

  const selectedModel = modelList.find((m) => m.id === modelId) ?? modelList[0];
  const canNext =
    step === 0 ||
    (step === 1 && apiKey.trim().length > 0) ||
    (step === 2 && selectedModel != null) ||
    (step === 3 && testStatus === "ok");

  const loadModelsForProvider = useCallback(async () => {
    if (!apiKey.trim()) return;
    setModelsLoading(true);
    setModelList([]);
    setModelId("");
    try {
      const result = await loadModels(provider, { apiKey: apiKey.trim() });
      if (result?.chat?.length) {
        setModelList(result.chat);
        setModelId(result.chat[0]?.id ?? "");
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
    if (!apiKey.trim() || !selectedModel) return;
    setTestStatus("running");
    setTestError(null);
    try {
      const llmModel = igniteModel(provider, selectedModel, { apiKey: apiKey.trim() });
      // Use streaming so Anthropic (and other providers) don't require long-request handling
      const stream = llmModel.generate([new Message("user", TEST_PROMPT)]);
      for await (const _ of stream) {
        // Consume at least one chunk to verify the connection works
      }
      setTestStatus("ok");
    } catch (e) {
      setTestStatus("error");
      setTestError(e instanceof Error ? e.message : String(e));
    }
  }, [provider, selectedModel, apiKey]);

  const handleSaveAndFinish = useCallback(async () => {
    if (testStatus !== "ok" || !selectedModel) return;
    setSaving(true);
    try {
      await invoke("set_llm_api_key", { provider, apiKey: apiKey.trim() });
      await invoke("save_llm_settings", {
        payload: { provider, model: selectedModel.id },
      });
      await invoke("set_llm_setup_done");
      onComplete();
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [provider, selectedModel, apiKey, testStatus, onComplete]);

  const goNext = useCallback(() => {
    if (step < STEPS.length - 1) setStep((s) => s + 1);
    else if (step === STEPS.length - 1 && testStatus === "ok") handleSaveAndFinish();
  }, [step, testStatus, handleSaveAndFinish]);

  const goBack = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  return (
    <div className="llm-wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="llm-wizard-title">
      <div className="llm-wizard-backdrop" onClick={() => {}} />
      <div className="llm-wizard-card">
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
                <p className="llm-wizard-hint">Go back and enter a valid API key, then return here.</p>
              ) : (
                <select
                  className="llm-wizard-select"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                >
                  {modelList.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}
                    </option>
                  ))}
                </select>
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
                  disabled={!selectedModel}
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
