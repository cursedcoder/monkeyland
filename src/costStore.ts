import { createContext, useContext, useCallback, useRef, useSyncExternalStore } from "react";

const COST_LIMIT_STORAGE_KEY = "monkeyland-cost-limit";
const COST_STATE_STORAGE_KEY = "monkeyland-cost-state";

export interface AgentCostEntry {
  agentId: string;
  role: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface CostState {
  agents: Map<string, AgentCostEntry>;
  totalCostUsd: number;
  costLimitUsd: number | null;
}

export interface CostStore {
  getState: () => CostState;
  subscribe: (cb: () => void) => () => void;
  reportUsage: (
    agentId: string,
    role: string,
    modelName: string,
    promptTokens: number,
    completionTokens: number,
    inputPricePerM: number,
    outputPricePerM: number,
  ) => void;
  setCostLimit: (limit: number | null) => void;
  reset: () => void;
}

function loadPersistedCostLimit(): number | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(COST_LIMIT_STORAGE_KEY);
    if (raw == null || raw === "") return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function loadPersistedCostState(): Partial<CostState> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(COST_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as {
      totalCostUsd?: number;
      agents?: Array<[string, AgentCostEntry]>;
    };
    const out: Partial<CostState> = {};
    if (Number.isFinite(parsed.totalCostUsd) && parsed.totalCostUsd! >= 0) {
      out.totalCostUsd = parsed.totalCostUsd!;
    }
    if (Array.isArray(parsed.agents) && parsed.agents.length > 0) {
      out.agents = new Map(parsed.agents as [string, AgentCostEntry][]);
    }
    return out;
  } catch {
    return {};
  }
}

function persistCostLimit(limit: number | null) {
  try {
    if (limit == null) localStorage.removeItem(COST_LIMIT_STORAGE_KEY);
    else localStorage.setItem(COST_LIMIT_STORAGE_KEY, String(limit));
  } catch {
    /* ignore */
  }
}

function persistCostState(state: CostState) {
  try {
    const payload = {
      totalCostUsd: state.totalCostUsd,
      agents: Array.from(state.agents.entries()),
    };
    localStorage.setItem(COST_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function createInitialState(): CostState {
  const persisted = loadPersistedCostState();
  const costLimit = loadPersistedCostLimit();
  return {
    agents: persisted.agents ?? new Map(),
    totalCostUsd: persisted.totalCostUsd ?? 0,
    costLimitUsd: costLimit,
  };
}

export function createCostStore(): CostStore {
  let state = createInitialState();
  const listeners = new Set<() => void>();

  function emit() {
    for (const l of listeners) l();
  }

  return {
    getState: () => state,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    reportUsage(agentId, role, modelName, promptTokens, completionTokens, inputPricePerM, outputPricePerM) {
      const next = new Map(state.agents);
      const prev = next.get(agentId);
      const deltaCost =
        (promptTokens * inputPricePerM + completionTokens * outputPricePerM) / 1_000_000;

      const entry: AgentCostEntry = {
        agentId,
        role,
        modelName,
        promptTokens: (prev?.promptTokens ?? 0) + promptTokens,
        completionTokens: (prev?.completionTokens ?? 0) + completionTokens,
        costUsd: (prev?.costUsd ?? 0) + deltaCost,
      };
      next.set(agentId, entry);

      state = {
        ...state,
        agents: next,
        totalCostUsd: state.totalCostUsd + deltaCost,
      };
      persistCostState(state);
      emit();
    },

    setCostLimit(limit) {
      state = { ...state, costLimitUsd: limit };
      persistCostLimit(limit);
      emit();
    },

    reset() {
      try { localStorage.removeItem(COST_STATE_STORAGE_KEY); } catch { /* ignore */ }
      state = {
        agents: new Map(),
        totalCostUsd: 0,
        costLimitUsd: state.costLimitUsd,
      };
      emit();
    },
  };
}

export const CostStoreContext = createContext<CostStore | null>(null);

export function useCostStore(): CostState & Pick<CostStore, "reportUsage" | "setCostLimit" | "reset"> {
  const store = useContext(CostStoreContext);
  if (!store) throw new Error("useCostStore must be used within CostStoreContext.Provider");

  const state = useSyncExternalStore(store.subscribe, store.getState);
  return {
    ...state,
    reportUsage: store.reportUsage,
    setCostLimit: store.setCostLimit,
    reset: store.reset,
  };
}

export function useCostStoreRef(): CostStore {
  const store = useContext(CostStoreContext);
  if (!store) throw new Error("useCostStoreRef must be used within CostStoreContext.Provider");
  return store;
}

/** Stable ref to just the reportUsage function — safe to call from callbacks without re-renders. */
export function useReportUsage() {
  const store = useContext(CostStoreContext);
  if (!store) throw new Error("useReportUsage must be used within CostStoreContext.Provider");
  const ref = useRef(store.reportUsage);
  ref.current = store.reportUsage;
  return useCallback(
    (...args: Parameters<CostStore["reportUsage"]>) => ref.current(...args),
    [],
  );
}
