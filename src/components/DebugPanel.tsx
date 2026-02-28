import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCostStore } from "../costStore";
import "./DebugPanel.css";

interface DebugPanelProps {
  onCopyDebug: () => void;
  debugCopied: boolean;
}

interface AgentStatusResponse {
  total_slots: number;
  used_slots: number;
  by_role: Record<string, number>;
  queue_depth: number;
}

const CONFIGURABLE_ROLES = [
  { key: "workforce_manager", label: "Workforce Manager" },
  { key: "project_manager", label: "Project Manager" },
  { key: "developer", label: "Developer" },
  { key: "worker", label: "Worker" },
];

export function DebugPanel({ onCopyDebug, debugCopied }: DebugPanelProps) {
  const [open, setOpen] = useState(false);
  const { totalCostUsd, costLimitUsd, setCostLimit } = useCostStore();
  const [costLimitInput, setCostLimitInput] = useState("");
  const [roleLimits, setRoleLimits] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<AgentStatusResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await invoke<AgentStatusResponse>("agent_status");
        if (!cancelled) setStatus(s);
      } catch { /* */ }
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [open]);

  const handleCostLimitSave = useCallback(() => {
    const val = parseFloat(costLimitInput);
    if (!costLimitInput.trim() || isNaN(val)) {
      setCostLimit(null);
    } else {
      setCostLimit(val);
    }
  }, [costLimitInput, setCostLimit]);

  const handleRoleLimitSave = useCallback(async (role: string) => {
    const raw = roleLimits[role];
    const val = raw ? parseInt(raw, 10) : null;
    try {
      await invoke("set_role_config", {
        role,
        maxCount: val != null && !isNaN(val) ? val : null,
      });
    } catch (e) {
      console.warn("Failed to set role config:", e);
    }
  }, [roleLimits]);

  const costLimitReached = costLimitUsd != null && totalCostUsd >= costLimitUsd;

  return (
    <div className="debug-panel-container">
      {!open && (
        <button
          type="button"
          className="debug-panel-toggle"
          onClick={() => setOpen(true)}
          title="Open debug & control panel"
        >
          &#9881;
        </button>
      )}
      {open && (
        <div className="debug-panel">
          <div className="debug-panel__header">
            <span>Controls</span>
            <button
              type="button"
              className="debug-panel__close"
              onClick={() => setOpen(false)}
            >
              &times;
            </button>
          </div>

          <section className="debug-panel__section">
            <button
              type="button"
              className="debug-panel__action"
              onClick={onCopyDebug}
            >
              {debugCopied ? "Copied!" : "Copy debug data"}
            </button>
          </section>

          <section className="debug-panel__section">
            <label className="debug-panel__label">
              Cost limit (USD)
              {costLimitReached && <span className="debug-panel__warn"> REACHED</span>}
            </label>
            <div className="debug-panel__row">
              <input
                type="number"
                step="0.01"
                min="0"
                className="debug-panel__input"
                placeholder={costLimitUsd != null ? String(costLimitUsd) : "none"}
                value={costLimitInput}
                onChange={(e) => setCostLimitInput(e.target.value)}
              />
              <button
                type="button"
                className="debug-panel__save"
                onClick={handleCostLimitSave}
              >
                Set
              </button>
            </div>
            <div className="debug-panel__hint">
              Total spent: ${totalCostUsd.toFixed(4)}
            </div>
          </section>

          <section className="debug-panel__section">
            <label className="debug-panel__label">Agent limits (per role)</label>
            {CONFIGURABLE_ROLES.map(({ key, label }) => (
              <div key={key} className="debug-panel__role-row">
                <span className="debug-panel__role-label">
                  {label}
                  {status?.by_role[key] != null && (
                    <span className="debug-panel__role-count"> ({status.by_role[key]})</span>
                  )}
                </span>
                <input
                  type="number"
                  min="0"
                  className="debug-panel__input debug-panel__input--small"
                  placeholder="max"
                  value={roleLimits[key] ?? ""}
                  onChange={(e) => setRoleLimits((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                <button
                  type="button"
                  className="debug-panel__save"
                  onClick={() => handleRoleLimitSave(key)}
                >
                  Set
                </button>
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
