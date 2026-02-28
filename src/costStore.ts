import { createContext, useContext, useCallback, useRef, useSyncExternalStore } from "react";

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

function createInitialState(): CostState {
  return { agents: new Map(), totalCostUsd: 0, costLimitUsd: null };
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
      emit();
    },

    setCostLimit(limit) {
      state = { ...state, costLimitUsd: limit };
      emit();
    },

    reset() {
      state = createInitialState();
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
