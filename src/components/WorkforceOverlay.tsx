import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCostStore } from "../costStore";
import { WM_PHASE_LABELS, type WMPhase } from "../constants/phases";
import "./WorkforceOverlay.css";

interface AgentStatusResponse {
  total_slots: number;
  used_slots: number;
  by_role: Record<string, number>;
  queue_depth: number;
}

interface WorkforceOverlayProps {
  wmPhase?: WMPhase;
  orchStatus?: "running" | "paused" | "idle";
}

const ROLE_BADGES: Record<string, string> = {
  workforce_manager: "WM",
  project_manager: "PM",
  developer: "DEV",
  operator: "OP",
  worker: "WRK",
  validator: "VAL",
};

function badge(role: string): string {
  return ROLE_BADGES[role] ?? role.slice(0, 3).toUpperCase();
}

function formatCost(usd: number): string {
  if (usd < 0.0001) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function WorkforceOverlay({ wmPhase, orchStatus }: WorkforceOverlayProps = {}) {
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

  const agentEntries = useMemo(() => Array.from(agents.values()), [agents]);

  const { activeCount, totalSlots, totalTokens, hasActivity, sortedRoles } = useMemo(() => {
    const registryCount = status ? Object.values(status.by_role).reduce((a, b) => a + b, 0) : 0;
    const _activeCount = Math.max(registryCount, agentEntries.length);
    const _totalSlots = status?.total_slots ?? 100;
    const _totalTokens = agentEntries.reduce((sum, a) => sum + a.promptTokens + a.completionTokens, 0);
    const _hasActivity = totalCostUsd > 0 || agentEntries.length > 0;

    const byRole = agentEntries.reduce(
      (acc, a) => {
        const role = a.role;
        const cur = acc.get(role) ?? { costUsd: 0, promptTokens: 0, completionTokens: 0 };
        acc.set(role, {
          costUsd: cur.costUsd + a.costUsd,
          promptTokens: cur.promptTokens + a.promptTokens,
          completionTokens: cur.completionTokens + a.completionTokens,
        });
        return acc;
      },
      new Map<string, { costUsd: number; promptTokens: number; completionTokens: number }>()
    );
    const roleOrder = [
      "workforce_manager",
      "project_manager",
      "developer",
      "operator",
      "worker",
      "validator",
    ];
    const _sortedRoles = Array.from(byRole.entries()).sort(
      (a, b) => roleOrder.indexOf(a[0]) - roleOrder.indexOf(b[0]) || a[0].localeCompare(b[0])
    );

    return {
      activeCount: _activeCount,
      totalSlots: _totalSlots,
      totalTokens: _totalTokens,
      hasActivity: _hasActivity,
      sortedRoles: _sortedRoles,
    };
  }, [agentEntries, status, totalCostUsd]);

  if (!hasActivity) return null;

  return (
    <div className="workforce-overlay">
      {wmPhase && wmPhase !== "initial" && (
        <div className="workforce-overlay__wm-status">
          <span className="workforce-overlay__wm-phase">
            WM: {WM_PHASE_LABELS[wmPhase]}
          </span>
          {orchStatus && orchStatus !== "idle" && (
            <span className={`workforce-overlay__orch-status workforce-overlay__orch-status--${orchStatus}`}>
              {orchStatus === "running" ? "Running" : "Paused"}
            </span>
          )}
        </div>
      )}
      <div className="workforce-overlay__header">
        <span>Agents: {activeCount}/{totalSlots}</span>
        {totalTokens > 0 && <span>Tokens: {formatTokens(totalTokens)}</span>}
        <span>Cost: {formatCost(totalCostUsd)}</span>
      </div>
      {sortedRoles.length > 0 && (
        <div className="workforce-overlay__list">
          {sortedRoles.map(([role, agg]) => {
            const roleTokens = agg.promptTokens + agg.completionTokens;
            return (
              <div key={role} className="workforce-overlay__row">
                <span className="workforce-overlay__badge">{badge(role)}</span>
                <span className="workforce-overlay__role">{role.replace(/_/g, " ")}</span>
                {roleTokens > 0 && (
                  <span className="workforce-overlay__tokens">{formatTokens(roleTokens)}</span>
                )}
                <span className="workforce-overlay__cost">{formatCost(agg.costUsd)}</span>
              </div>
            );
          })}
        </div>
      )}
      {status && status.queue_depth > 0 && (
        <div className="workforce-overlay__footer">Queue: {status.queue_depth}</div>
      )}
    </div>
  );
}
