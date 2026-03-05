import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { BeadsTask, SessionLayout } from "../types";

export interface ActivityEvent {
  timestamp: number;
  type: "claimed" | "status_change" | "merge" | "validation" | "created" | "completed" | "spawned" | "killed";
  taskId: string;
  agentId?: string;
  detail?: string;
}

export interface BeadsStoreValue {
  tasks: BeadsTask[];
  mergeStatuses: Map<string, { status: string; detail?: string }>;
  agentTaskMap: Map<string, string>;
  activityLog: ActivityEvent[];
  projectPath: string | null;
  setProjectPath: (path: string) => void;
  refresh: (force?: boolean) => Promise<void>;
  isRefreshing: boolean;
  refreshError: string | null;
  updateTaskStatus: (taskId: string, status: string) => Promise<void>;
  updateTaskPriority: (taskId: string, priority: number) => Promise<void>;
  createTask: (title: string, type: string, priority: number, parentId?: string) => Promise<string>;
}

const BeadsStoreContext = createContext<BeadsStoreValue | null>(null);

export function useBeadsStore(): BeadsStoreValue {
  const ctx = useContext(BeadsStoreContext);
  if (!ctx) throw new Error("useBeadsStore must be used within BeadsStoreProvider");
  return ctx;
}

export function useBeadsStoreOptional(): BeadsStoreValue | null {
  return useContext(BeadsStoreContext);
}

interface ProviderProps {
  layouts: SessionLayout[];
  children: React.ReactNode;
}

export function BeadsStoreProvider({ layouts, children }: ProviderProps) {
  const [tasks, setTasks] = useState<BeadsTask[]>([]);
  const [mergeStatuses, setMergeStatuses] = useState<Map<string, { status: string; detail?: string }>>(new Map());
  const [activityLog, setActivityLog] = useState<ActivityEvent[]>([]);
  const [projectPath, setProjectPathState] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;

  const agentTaskMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of layouts) {
      if (l.node_type !== "agent" && l.node_type !== "worker") continue;
      try {
        const p = JSON.parse(l.payload ?? "{}") as { task_id?: string; status?: string };
        if (p.task_id && p.status !== "stopped" && p.status !== "error" && p.status !== "done") {
          map.set(p.task_id, l.session_id);
        }
      } catch { /* ignore */ }
    }
    return map;
  }, [layouts]);

  const addActivity = useCallback((event: Omit<ActivityEvent, "timestamp">) => {
    setActivityLog(prev => [...prev.slice(-199), { ...event, timestamp: Date.now() }]);
  }, []);

  const setProjectPath = useCallback((path: string) => {
    setProjectPathState(path);
  }, []);

  const refresh = useCallback(async (_force = false) => {
    const path = projectPathRef.current;
    if (!path) return;
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      let raw = await invoke<string>("beads_run", {
        projectPath: path,
        args: ["list", "--json", "--all", "--limit", "0"],
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        raw = await invoke<string>("beads_run", {
          projectPath: path,
          args: ["list", "--json"],
        });
        parsed = JSON.parse(raw);
      }
      setTasks(Array.isArray(parsed) ? (parsed as BeadsTask[]) : []);
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : String(e));
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refresh(true);
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];

    listen<{ task_id: string; status: string; detail?: string }>("merge_status", (event) => {
      if (disposed) return;
      const { task_id, status, detail } = event.payload;
      setMergeStatuses(prev => {
        const next = new Map(prev);
        if (status === "done") {
          next.delete(task_id);
        } else {
          next.set(task_id, { status, detail: detail ?? undefined });
        }
        return next;
      });
      addActivity({
        type: status === "done" ? "completed" : "merge",
        taskId: task_id,
        detail: status === "done" ? "Merge completed" : `${status}${detail ? ": " + detail : ""}`,
      });
      void refresh();
    }).then(fn => { if (!disposed) unsubs.push(fn); else fn(); });

    listen<{ agent_id?: string; task_id?: string }>("agent_spawned", (event) => {
      if (disposed) return;
      const { agent_id, task_id } = event.payload ?? {};
      if (task_id) {
        addActivity({ type: "spawned", taskId: task_id, agentId: agent_id, detail: "Agent spawned" });
      }
      void refresh();
    }).then(fn => { if (!disposed) unsubs.push(fn); else fn(); });

    listen<{ agent_id?: string; task_id?: string }>("agent_killed", (event) => {
      if (disposed) return;
      const { task_id } = event.payload ?? {};
      if (task_id) {
        addActivity({ type: "killed", taskId: task_id, detail: "Agent stopped" });
      }
      void refresh();
    }).then(fn => { if (!disposed) unsubs.push(fn); else fn(); });

    listen<{ developer_agent_id?: string; task_id?: string }>("validation_requested", (event) => {
      if (disposed) return;
      const { task_id, developer_agent_id } = event.payload ?? {};
      if (task_id) {
        addActivity({ type: "validation", taskId: task_id, agentId: developer_agent_id, detail: "Validation requested" });
      }
      void refresh();
    }).then(fn => { if (!disposed) unsubs.push(fn); else fn(); });

    return () => {
      disposed = true;
      unsubs.forEach(fn => fn());
    };
  }, [refresh, addActivity]);

  useEffect(() => {
    if (projectPath) void refresh();
  }, [projectPath, refresh]);

  const updateTaskStatus = useCallback(async (taskId: string, status: string) => {
    const path = projectPathRef.current;
    if (!path) return;
    try {
      await invoke<string>("beads_run", {
        projectPath: path,
        args: ["update", taskId, "--status", status],
      });
      addActivity({ type: "status_change", taskId, detail: `Status → ${status}` });
      void refresh(true);
    } catch (e) {
      console.error("[BeadsStore] updateTaskStatus failed:", e);
      throw e;
    }
  }, [refresh, addActivity]);

  const updateTaskPriority = useCallback(async (taskId: string, priority: number) => {
    const path = projectPathRef.current;
    if (!path) return;
    try {
      await invoke<string>("beads_run", {
        projectPath: path,
        args: ["update", taskId, "--priority", String(priority)],
      });
      void refresh(true);
    } catch (e) {
      console.error("[BeadsStore] updateTaskPriority failed:", e);
      throw e;
    }
  }, [refresh]);

  const createTask = useCallback(async (title: string, type: string, priority: number, parentId?: string): Promise<string> => {
    const path = projectPathRef.current;
    if (!path) throw new Error("No project path set");
    const args = ["create", title, "--silent", "--type", type, "--priority", String(priority)];
    if (parentId) args.push("--parent", parentId);
    const id = await invoke<string>("beads_run", { projectPath: path, args });
    const trimmedId = id.trim();
    addActivity({ type: "created", taskId: trimmedId, detail: title });
    void refresh(true);
    return trimmedId;
  }, [refresh, addActivity]);

  const value = useMemo<BeadsStoreValue>(() => ({
    tasks,
    mergeStatuses,
    agentTaskMap,
    activityLog,
    projectPath,
    setProjectPath,
    refresh,
    isRefreshing,
    refreshError,
    updateTaskStatus,
    updateTaskPriority,
    createTask,
  }), [tasks, mergeStatuses, agentTaskMap, activityLog, projectPath, setProjectPath, refresh, isRefreshing, refreshError, updateTaskStatus, updateTaskPriority, createTask]);

  return (
    <BeadsStoreContext.Provider value={value}>
      {children}
    </BeadsStoreContext.Provider>
  );
}
