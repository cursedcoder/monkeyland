import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LlmSetupWizard } from "./LlmSetupWizard";
import { LLM_PROVIDER_IDS, LLM_PROVIDER_LABELS, type LlmProviderId } from "../types";
import { loadModels, type ChatModel } from "multi-llm-ts";
import { loadKiloModels } from "../agentRunner";
import { CustomSelect } from "./CustomSelect";

interface LlmSettingsPayload {
  provider: string;
  model: string;
}

export function LlmSettings() {
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [modelInput, setModelInput] = useState("");
  
  const [provisionedProviders, setProvisionedProviders] = useState<string[]>([]);
  const [modelList, setModelList] = useState<ChatModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const fetchProvisioned = useCallback(async () => {
    const provs: string[] = [];
    for (const p of LLM_PROVIDER_IDS) {
      try {
        const key = await invoke<string | null>("get_llm_api_key", { provider: p });
        if (key && key.trim().length > 0) {
          provs.push(p);
        }
      } catch { /* ignore */ }
    }
    setProvisionedProviders(provs);
  }, []);

  const checkSetup = useCallback(async () => {
    try {
      const done = await invoke<boolean>("get_llm_setup_done");
      setSetupDone(done);
      if (done) {
        const payload = await invoke<LlmSettingsPayload>("load_llm_settings");
        setProvider(payload.provider);
        setModel(payload.model);
        setModelInput(payload.model);
        fetchProvisioned();
      }
    } catch (_) {
      setSetupDone(false);
    }
  }, [fetchProvisioned]);

  useEffect(() => {
    checkSetup();
  }, [checkSetup]);

  const loadModelsForProvider = useCallback(async (prov: string) => {
    setModelsLoading(true);
    setModelList([]);
    try {
      const apiKey = await invoke<string | null>("get_llm_api_key", { provider: prov });
      if (!apiKey) {
        setModelsLoading(false);
        return;
      }
      
      if (prov === "kilo") {
        const models = await loadKiloModels(apiKey.trim());
        if (models.length) {
          setModelList(models);
        }
      } else {
        const result = await loadModels(prov as LlmProviderId, { apiKey: apiKey.trim() });
        if (result?.chat?.length) {
          setModelList(result.chat);
        }
      }
    } catch (_) {
      setModelList([]);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (popoverOpen && provider) {
      loadModelsForProvider(provider);
      fetchProvisioned();
    }
  }, [popoverOpen, provider, loadModelsForProvider, fetchProvisioned]);

  const handleWizardComplete = useCallback(() => {
    setWizardOpen(false);
    setSetupDone(true);
    checkSetup();
  }, [checkSetup]);

  const switchProvider = async (newProvider: string) => {
    setProvider(newProvider);
    setModelsLoading(true);
    setModelList([]);
    
    let nextModel = localStorage.getItem(`llm_model_${newProvider}`) || "";
    
    try {
      const apiKey = await invoke<string | null>("get_llm_api_key", { provider: newProvider });
      if (apiKey) {
        if (newProvider === "kilo") {
          const models = await loadKiloModels(apiKey.trim());
          if (models.length) {
            setModelList(models);
            if (!nextModel || !models.some(m => m.id === nextModel)) {
              nextModel = models[0].id;
            }
          }
        } else {
          const result = await loadModels(newProvider as LlmProviderId, { apiKey: apiKey.trim() });
          if (result?.chat?.length) {
            setModelList(result.chat);
            if (!nextModel || !result.chat.some(m => m.id === nextModel)) {
              nextModel = result.chat[0].id;
            }
          }
        }
      }
    } catch { /* ignore */ }
    
    setModelsLoading(false);
    setModel(nextModel);
    setModelInput(nextModel);
    
    if (nextModel) {
      await invoke("save_llm_settings", { payload: { provider: newProvider, model: nextModel } });
      localStorage.setItem(`llm_model_${newProvider}`, nextModel);
    }
  };

  const switchModel = async (newModel: string) => {
    if (!newModel.trim()) return;
    setModel(newModel);
    setModelInput(newModel);
    await invoke("save_llm_settings", { payload: { provider, model: newModel } });
    localStorage.setItem(`llm_model_${provider}`, newModel);
  };

  if (setupDone === null) {
    return null;
  }

  if (!setupDone || wizardOpen) {
    return (
      <LlmSetupWizard
        onComplete={handleWizardComplete}
        onClose={setupDone ? () => setWizardOpen(false) : undefined}
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
    <div className="llm-settings-container">
      <button
        type="button"
        className="llm-settings-chip"
        onClick={() => setPopoverOpen(!popoverOpen)}
        title="Change LLM provider and model"
      >
        <strong>{providerLabel}</strong>
        <span>·</span>
        <span>{model || "—"}</span>
      </button>

      {popoverOpen && (
        <>
          <div className="llm-settings-popover-backdrop" onClick={() => setPopoverOpen(false)} />
          <div className="llm-settings-popover">
            <div className="llm-settings-popover-item">
              <div className="llm-settings-popover-label">Provider</div>
              <CustomSelect
                value={provider}
                options={[
                  ...provisionedProviders.map((p) => ({
                    value: p,
                    label: LLM_PROVIDER_LABELS[p as LlmProviderId] || p,
                  })),
                  { value: "ADD_NEW", label: "+ Add new provider...", className: "add-new" },
                ]}
                onChange={(value) => {
                  if (value === "ADD_NEW") {
                    setWizardOpen(true);
                    setPopoverOpen(false);
                  } else {
                    switchProvider(value);
                  }
                }}
              />
            </div>

            <div className="llm-settings-popover-item">
              <div className="llm-settings-popover-label">Model</div>
              {modelsLoading ? (
                <div className="llm-settings-popover-loading">Loading models...</div>
              ) : modelList.length === 0 ? (
                <input 
                  type="text" 
                  className="llm-settings-input" 
                  value={modelInput} 
                  onChange={(e) => setModelInput(e.target.value)}
                  onBlur={() => switchModel(modelInput)}
                  onKeyDown={(e) => e.key === 'Enter' && switchModel(modelInput)}
                  placeholder="e.g. anthropic/claude-opus-4.6"
                />
              ) : (
                <CustomSelect
                  value={model}
                  options={modelList.map((m) => ({
                    value: m.id,
                    label: m.name || m.id,
                  }))}
                  onChange={(value) => switchModel(value)}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
