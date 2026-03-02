import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCostStore } from "../costStore";
import "./DebugPanel.css";

const ROLE_LIMITS_STORAGE_KEY = "monkeyland-debug-role-limits";

interface DebugPanelProps {
  onCopyDebug: () => void;
  debugCopied: boolean;
  onStopAll: () => void;
}

interface AgentStatusResponse {
  total_slots: number;
  used_slots: number;
  by_role: Record<string, number>;
  queue_depth: number;
}

interface OrchestrationMetricsResponse {
  merge_queue_depth: number;
  merge_retry_count: number;
  validation_timeout_blocks: number;
  safety_mode_enabled: boolean;
}

const CONFIGURABLE_ROLES = [
  { key: "workforce_manager", label: "Workforce Manager" },
  { key: "project_manager", label: "Project Manager" },
  { key: "developer", label: "Developer" },
  { key: "worker", label: "Worker" },
];

type OrchState = "idle" | "running" | "paused";
function orchStateFromRaw(raw: number): OrchState {
  if (raw === 1) return "running";
  if (raw === 2) return "paused";
  return "idle";
}

function loadPersistedRoleLimits(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(ROLE_LIMITS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const key of CONFIGURABLE_ROLES.map((r) => r.key)) {
      const v = parsed[key];
      if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[key] = String(v);
      else if (typeof v === "string" && v.trim() !== "") out[key] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function persistRoleLimits(limits: Record<string, string>) {
  try {
    localStorage.setItem(ROLE_LIMITS_STORAGE_KEY, JSON.stringify(limits));
  } catch {
    /* ignore */
  }
}

export function DebugPanel({
  onCopyDebug,
  debugCopied,
  onStopAll,
}: DebugPanelProps) {
  const [open, setOpen] = useState(false);
  const { totalCostUsd, costLimitUsd, setCostLimit } = useCostStore();
  const [costLimitInput, setCostLimitInput] = useState("");
  const [roleLimits, setRoleLimits] = useState<Record<string, string>>(loadPersistedRoleLimits);
  const [status, setStatus] = useState<AgentStatusResponse | null>(null);
  const [orchState, setOrchState] = useState<OrchState>("idle");
  const [orchMetrics, setOrchMetrics] = useState<OrchestrationMetricsResponse | null>(null);
  const [safetyModeEnabled, setSafetyModeEnabled] = useState(false);

  // When panel opens, sync cost limit input from persisted store if empty.
  useEffect(() => {
    if (open && costLimitUsd != null && costLimitInput === "") {
      setCostLimitInput(String(costLimitUsd));
    }
  }, [open, costLimitUsd, costLimitInput]);

  // Apply persisted role limits to backend on mount so backend and UI stay in sync.
  useEffect(() => {
    const limits = loadPersistedRoleLimits();
    for (const [role, str] of Object.entries(limits)) {
      const val = parseInt(str, 10);
      if (!Number.isNaN(val) && val >= 0) {
        invoke("set_role_config", { role, maxCount: val }).catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const [s, rawOrch, metrics, safety] = await Promise.all([
          invoke<AgentStatusResponse>("agent_status"),
          invoke<number>("orch_get_state"),
          invoke<OrchestrationMetricsResponse>("orch_get_metrics"),
          invoke<boolean>("get_safety_mode"),
        ]);
        if (!cancelled) {
          setStatus(s);
          setOrchState(orchStateFromRaw(rawOrch));
          setOrchMetrics(metrics);
          setSafetyModeEnabled(safety);
        }
      } catch { /* */ }
    };
    poll();
    const iv = setInterval(poll, 2000);
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
    const nextLimits = { ...roleLimits, [role]: raw ?? "" };
    persistRoleLimits(nextLimits);
    try {
      await invoke("set_role_config", {
        role,
        maxCount: val != null && !isNaN(val) ? val : null,
      });
    } catch (e) {
      console.warn("Failed to set role config:", e);
    }
  }, [roleLimits]);

  const handleOrchStart = useCallback(async () => {
    try {
      await invoke("orch_start");
      setOrchState("running");
    } catch (e) {
      console.warn("orch_start failed:", e);
    }
  }, []);

  const handleOrchPause = useCallback(async () => {
    try {
      await invoke("orch_pause");
      setOrchState("paused");
    } catch (e) {
      console.warn("orch_pause failed:", e);
    }
  }, []);

  const handleOrchStopAll = useCallback(() => {
    invoke("orch_pause").catch(() => {});
    setOrchState("paused");
    onStopAll();
  }, [onStopAll]);

  const handleSafetyToggle = useCallback(async () => {
    const next = !safetyModeEnabled;
    setSafetyModeEnabled(next);
    try {
      await invoke("set_safety_mode", { enabled: next });
    } catch (e) {
      console.warn("set_safety_mode failed:", e);
      setSafetyModeEnabled(!next);
    }
  }, [safetyModeEnabled]);

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
            <label className="debug-panel__label">Orchestration</label>
            <div className="debug-panel__orch-row">
              <span className="debug-panel__orch-state">State: {orchState}</span>
              {orchState === "idle" && (
                <button
                  type="button"
                  className="debug-panel__btn debug-panel__btn--start"
                  onClick={handleOrchStart}
                  title="Start the orchestration loop (spawns developers from Beads tasks)"
                >
                  Start
                </button>
              )}
              {orchState === "running" && (
                <>
                  <button
                    type="button"
                    className="debug-panel__btn debug-panel__btn--pause"
                    onClick={handleOrchPause}
                    title="Pause (no new agents spawned)"
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className="debug-panel__btn debug-panel__btn--stop"
                    onClick={handleOrchStopAll}
                    title="Pause and stop all running agents"
                  >
                    Stop all
                  </button>
                </>
              )}
              {orchState === "paused" && (
                <>
                  <button
                    type="button"
                    className="debug-panel__btn debug-panel__btn--start"
                    onClick={handleOrchStart}
                    title="Resume the orchestration loop"
                  >
                    Resume
                  </button>
                  <button
                    type="button"
                    className="debug-panel__btn debug-panel__btn--stop"
                    onClick={handleOrchStopAll}
                    title="Stop all running agents"
                  >
                    Stop all
                  </button>
                </>
              )}
            </div>
            <div className="debug-panel__hint">
              Merge queue: {orchMetrics?.merge_queue_depth ?? 0} · retries: {orchMetrics?.merge_retry_count ?? 0} · timeout blocks: {orchMetrics?.validation_timeout_blocks ?? 0}
            </div>
            <div className="debug-panel__orch-row" style={{ marginTop: 8 }}>
              <span className="debug-panel__orch-state">Safety mode: {safetyModeEnabled ? "on" : "off"}</span>
              <button
                type="button"
                className="debug-panel__btn debug-panel__btn--pause"
                onClick={handleSafetyToggle}
                title="Conservative runtime mode with lower orchestration throughput"
              >
                {safetyModeEnabled ? "Disable" : "Enable"}
              </button>
            </div>
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
