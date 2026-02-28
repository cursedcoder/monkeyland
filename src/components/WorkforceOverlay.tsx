import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCostStore } from "../costStore";
import "./WorkforceOverlay.css";

interface AgentStatusResponse {
  total_slots: number;
  used_slots: number;
  by_role: Record<string, number>;
  queue_depth: number;
}

const ROLE_BADGES: Record<string, string> = {
  workforce_manager: "WM",
  project_manager: "PM",
  developer: "DEV",
  worker: "WRK",
  code_review_validator: "CR",
  business_logic_validator: "BL",
  scope_validator: "SC",
};

function badge(role: string): string {
  return ROLE_BADGES[role] ?? role.slice(0, 3).toUpperCase();
}

function formatCost(usd: number): string {
  if (usd < 0.001) return "$0.00";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function WorkforceOverlay() {
  const { agents, totalCostUsd } = useCostStore();
  const [status, setStatus] = useState<AgentStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await invoke<AgentStatusResponse>("agent_status");
        if (!cancelled) setStatus(s);
      } catch { /* registry not ready yet */ }
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  const activeCount = status ? Object.values(status.by_role).reduce((a, b) => a + b, 0) : 0;
  const totalSlots = status?.total_slots ?? 100;
  const agentEntries = Array.from(agents.values());
  const hasActivity = totalCostUsd > 0 || agentEntries.length > 0;

  if (!hasActivity) return null;

  return (
    <div className="workforce-overlay">
      <div className="workforce-overlay__header">
        <span>Agents: {activeCount}/{totalSlots}</span>
        <span>Cost: {formatCost(totalCostUsd)}</span>
      </div>
      {agentEntries.length > 0 && (
        <div className="workforce-overlay__list">
          {agentEntries.map((a) => (
            <div key={a.agentId} className="workforce-overlay__row">
              <span className="workforce-overlay__badge">{badge(a.role)}</span>
              <span className="workforce-overlay__id" title={a.agentId}>
                {a.agentId.length > 10 ? a.agentId.slice(0, 10) + ".." : a.agentId}
              </span>
              <span className="workforce-overlay__model">{a.modelName}</span>
              <span className="workforce-overlay__cost">{formatCost(a.costUsd)}</span>
            </div>
          ))}
        </div>
      )}
      {status && status.queue_depth > 0 && (
        <div className="workforce-overlay__footer">Queue: {status.queue_depth}</div>
      )}
    </div>
  );
}
