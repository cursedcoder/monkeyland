import React, { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SessionLayout } from "../types";
import {
  BEADS_CARD_MIN_W,
  BEADS_CARD_MIN_H,
  BEADS_CARD_MAX_H,
  GRID_STEP,
} from "../types";
import { cardColorsFromId } from "../utils/cardColors";
import { snap } from "../utils/layoutHelpers";

export interface BeadsStatus {
  projectPath: string;
  initResult: string;
  tasks?: BeadsTask[];
  lastRefresh?: number;
}

export interface BeadsTask {
  id: string;
  title: string;
  type: string;
  status: string;
  description?: string;
  body?: string;
  issue_type?: string;
  priority?: number;
  deps?: string[] | string;
  blocked_by?: string[] | string;
  parent_id?: string;
  parentId?: string;
  epic_id?: string;
  epic_name?: string;
  labels?: string[];
  assignee?: string;
  reporter?: string;
  created_at?: string;
  updated_at?: string;
}

interface BeadsCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onDragStart?: (nodeId: string, layout: SessionLayout) => void;
  onStatusChange?: (status: BeadsStatus) => void;
  onAddTaskCard?: (task: BeadsTask) => void;
  onClose?: () => void;
  scale?: number;
}

function parseStatus(payload?: string): BeadsStatus | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as { beadsStatus?: BeadsStatus };
    return p.beadsStatus ?? null;
  } catch {
    return null;
  }
}

function safeUnlisten(unlistenPromise: Promise<() => void>) {
  void unlistenPromise
    .then((fn) => fn())
    .catch(() => {
      // Listener may already be removed during teardown/race conditions.
    });
}

function safeInvokeUnlisten(unlisten: () => void | Promise<void>) {
  void Promise.resolve()
    .then(() => unlisten())
    .catch(() => {
      // Listener may already be removed during teardown/race conditions.
    });
}

const TYPE_ICONS: Record<string, string> = {
  bug: "🐞",
  story: "📘",
  task: "📋",
  epic: "⚡",
  feature: "🚀",
  subtask: "🔹",
  chore: "🔧",
  improvement: "📈",
};

export function BeadsCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  onStatusChange,
  onAddTaskCard,
  onClose,
  scale = 1,
}: BeadsCardProps) {
  const MIN_AUTO_REFRESH_GAP_MS = 2000;
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [liveLayout, setLiveLayout] = useState<SessionLayout | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const lastEmittedLayout = useRef<SessionLayout>(layout);
  const cardColors = useMemo(() => cardColorsFromId(layout.session_id), [layout.session_id]);
  const dragStart = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, edge: "" as string });
  const layoutRef = useRef(layout);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const onLayoutCommitRef = useRef(onLayoutCommit);
  const setLiveLayoutRef = useRef(setLiveLayout);
  layoutRef.current = layout;
  onLayoutChangeRef.current = onLayoutChange;
  onLayoutCommitRef.current = onLayoutCommit;
  setLiveLayoutRef.current = setLiveLayout;
  const displayLayout = liveLayout ?? layout;

  const status = useMemo(() => parseStatus(layout.payload), [layout.payload]);
  const projectPath = status?.projectPath;
  const initResult = status?.initResult ?? "";

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [autoRefreshPaused, setAutoRefreshPaused] = useState(false);
  const [tasks, setTasks] = useState<BeadsTask[]>(status?.tasks ?? []);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);
  const lastAutoRefreshAtRef = useRef(0);

  const epicId = useMemo(() => {
    const epic = tasks.find(
      (t) => (t.type === "epic" || t.issue_type === "epic"),
    );
    return epic?.id ?? null;
  }, [tasks]);

  const handleRefresh = useCallback(async (force = false) => {
    if (!projectPath) {
      return;
    }
    if (!force && autoRefreshPaused) {
      return;
    }
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    setRefreshing(true);
    setRefreshError(null);
    try {
      // Prefer a full list so child tasks under epics are visible.
      let raw = await invoke<string>("beads_run", {
        projectPath,
        args: ["list", "--json", "--all", "--limit", "0"],
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Fallback for older bd versions/outputs.
        raw = await invoke<string>("beads_run", {
          projectPath,
          args: ["list", "--json"],
        });
        parsed = JSON.parse(raw);
      }
      const nextTasks = Array.isArray(parsed) ? (parsed as BeadsTask[]) : [];
      setTasks(nextTasks);
      const prevTasks = status?.tasks ?? [];
      if (JSON.stringify(prevTasks) !== JSON.stringify(nextTasks)) {
        onStatusChange?.({
          projectPath,
          initResult,
          tasks: nextTasks,
          lastRefresh: Date.now(),
        });
      }
      if (autoRefreshPaused) {
        setAutoRefreshPaused(false);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRefreshError(msg);
      if (/no beads database found/i.test(msg)) {
        setAutoRefreshPaused(true);
      }
    } finally {
      refreshInFlightRef.current = false;
      setRefreshing(false);
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void handleRefresh(force);
      }
    }
  }, [autoRefreshPaused, initResult, onStatusChange, projectPath]);

  const handleOpenTask = useCallback(
    async (task: BeadsTask) => {
      if (!onAddTaskCard) return;
      if (!status?.projectPath) {
        onAddTaskCard(task);
        return;
      }
      try {
        const raw = await invoke<string>("beads_run", {
          projectPath: status.projectPath,
          args: ["show", task.id, "--json"],
        });
        const parsed = JSON.parse(raw.trim());
        const detail =
          (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
        if (!detail || typeof detail !== "object") {
          onAddTaskCard(task);
          return;
        }
        onAddTaskCard({
          ...task,
          id: String(detail.id ?? task.id),
          title: String(detail.title ?? task.title),
          type: String(detail.type ?? detail.issue_type ?? task.type),
          status: String(detail.status ?? task.status),
          description:
            typeof detail.description === "string"
              ? detail.description
              : typeof detail.body === "string"
                ? detail.body
                : undefined,
          body: typeof detail.body === "string" ? detail.body : undefined,
          issue_type: typeof detail.issue_type === "string" ? detail.issue_type : undefined,
          priority: typeof detail.priority === "number" ? detail.priority : undefined,
          deps:
            typeof detail.deps === "string" || Array.isArray(detail.deps)
              ? (detail.deps as string[] | string)
              : undefined,
          parent_id:
            typeof detail.parent_id === "string"
              ? detail.parent_id
              : typeof detail.parentId === "string"
                ? detail.parentId
                : undefined,
          parentId:
            typeof detail.parentId === "string"
              ? detail.parentId
              : typeof detail.parent_id === "string"
                ? detail.parent_id
                : undefined,
          blocked_by:
            typeof detail.blocked_by === "string" || Array.isArray(detail.blocked_by)
              ? (detail.blocked_by as string[] | string)
              : undefined,
          epic_id: typeof detail.epic_id === "string" ? detail.epic_id : undefined,
          epic_name: typeof detail.epic_name === "string" ? detail.epic_name : undefined,
          labels: Array.isArray(detail.labels) ? (detail.labels as string[]) : undefined,
          assignee: typeof detail.assignee === "string" ? detail.assignee : undefined,
          reporter: typeof detail.reporter === "string" ? detail.reporter : undefined,
          created_at: typeof detail.created_at === "string" ? detail.created_at : undefined,
          updated_at: typeof detail.updated_at === "string" ? detail.updated_at : undefined,
        });
      } catch {
        onAddTaskCard(task);
      }
    },
    [onAddTaskCard, status?.projectPath]
  );

  useEffect(() => {
    if (status?.tasks) {
      setTasks(status.tasks);
    }
  }, [status?.tasks]);

  const scheduleRefresh = useCallback(
    (force = false) => {
      if (!projectPath || layout.collapsed) return;
      if (!force) {
        const now = Date.now();
        if (now - lastAutoRefreshAtRef.current < MIN_AUTO_REFRESH_GAP_MS) {
          return;
        }
      }
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        if (!force) {
          lastAutoRefreshAtRef.current = Date.now();
        }
        void handleRefresh(force);
      }, 300);
    },
    [handleRefresh, layout.collapsed, projectPath]
  );

  useEffect(() => {
    if (!projectPath || layout.collapsed) return;
    void handleRefresh(false);
  }, [projectPath, layout.collapsed, handleRefresh]);

  useEffect(() => {
    if (!projectPath || layout.collapsed) return;
    let disposed = false;
    const unsubs: Array<() => void | Promise<void>> = [];
    const events = [
      "agent_spawned",
      "agent_killed",
      "validation_requested",
      "merge_status",
    ] as const;

    Promise.all(events.map((evt) => listen(evt, () => scheduleRefresh(false))))
      .then((fns) => {
        if (disposed) {
          fns.forEach((fn) => safeInvokeUnlisten(fn));
          return;
        }
        unsubs.push(...fns);
      })
      .catch(() => {
        // Non-fatal: manual refresh remains available.
      });

    return () => {
      disposed = true;
      unsubs.forEach((fn) => safeInvokeUnlisten(fn));
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [layout.collapsed, projectPath, scheduleRefresh]);

  const [epicProgress, setEpicProgress] = useState<{ total: number; done: number; in_progress: number; open: number } | null>(null);

  useEffect(() => {
    const unlisten = listen<{
      epic_id: string;
      total: number;
      done: number;
      in_progress: number;
      open: number;
    }>("epic_progress", (event) => {
      if (epicId && event.payload.epic_id === epicId) {
        setEpicProgress(event.payload);
      }
    });
    return () => { safeUnlisten(unlisten); };
  }, [epicId]);

  // Merge status per task (from orchestration merge_status events)
  const [mergeStatuses, setMergeStatuses] = useState<Map<string, { status: string; detail?: string }>>(new Map());

  useEffect(() => {
    const unlisten = listen<{
      task_id: string;
      status: string;
      detail?: string;
    }>("merge_status", (event) => {
      const { task_id, status: st, detail } = event.payload;
      setMergeStatuses((prev) => {
        const next = new Map(prev);
        if (st === "done") {
          next.delete(task_id);
        } else {
          next.set(task_id, { status: st, detail: detail ?? undefined });
        }
        return next;
      });
    });
    return () => { safeUnlisten(unlisten); };
  }, []);

  // Sync the actual rendered height back into the layout so the canvas
  // knows the card's real footprint (used by hit-testing / connectors).
  useEffect(() => {
    if (layout.collapsed || isResizing || !cardRef.current) return;
    const el = cardRef.current;
    const observer = new ResizeObserver(() => {
      const renderedH = el.offsetHeight;
      const clamped = Math.min(Math.max(renderedH, BEADS_CARD_MIN_H), BEADS_CARD_MAX_H);
      const snapped = Math.round(clamped / GRID_STEP) * GRID_STEP;
      if (snapped !== layoutRef.current.h) {
        const next = { ...layoutRef.current, h: snapped };
        onLayoutChangeRef.current(next);
        onLayoutCommitRef.current(next);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [layout.collapsed, isResizing]);

  const handlePointerDownDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("[data-resize-handle]") || (e.target as HTMLElement).closest("[data-no-drag]")) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setLiveLayout(layout);
      setIsDragging(true);
      onDragStart?.(layout.session_id, layout);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        layoutX: layout.x,
        layoutY: layout.y,
      };
    },
    [layout, onDragStart]
  );

  const handlePointerDownResize = useCallback(
    (e: React.PointerEvent, edge: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setLiveLayout(layout);
      setIsResizing(true);
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        w: layout.w,
        h: layout.h,
        edge,
      };
    },
    [layout.w, layout.h]
  );

  React.useEffect(() => {
    if (!isDragging && !isResizing) return;
    document.body.style.userSelect = "none";

    const onMove = (e: PointerEvent) => {
      const s = scale;
      const currentLayout = layoutRef.current;
      if (isDragging) {
        const dx = (e.clientX - dragStart.current.x) / s;
        const dy = (e.clientY - dragStart.current.y) / s;
        const next = {
          ...currentLayout,
          x: snap(dragStart.current.layoutX + dx),
          y: snap(dragStart.current.layoutY + dy),
        };
        lastEmittedLayout.current = next;
        setLiveLayoutRef.current(next);
        onLayoutChangeRef.current(next);
      }
      if (isResizing) {
        const dx = (e.clientX - resizeStart.current.x) / s;
        const dy = (e.clientY - resizeStart.current.y) / s;
        let { w, h } = resizeStart.current;
        const edge = resizeStart.current.edge;
        if (edge.includes("e")) w = Math.max(BEADS_CARD_MIN_W, w + dx);
        if (edge.includes("w")) w = Math.max(BEADS_CARD_MIN_W, w - dx);
        if (edge.includes("s")) h = Math.max(BEADS_CARD_MIN_H, h + dy);
        if (edge.includes("n")) h = Math.max(BEADS_CARD_MIN_H, h - dy);
        const next = { ...currentLayout, w: snap(w), h: snap(h) };
        lastEmittedLayout.current = next;
        setLiveLayoutRef.current(next);
        onLayoutChangeRef.current(next);
      }
    };

    const onUp = () => {
      setLiveLayoutRef.current(null);
      setIsDragging(false);
      setIsResizing(false);
      onLayoutCommitRef.current(lastEmittedLayout.current);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [isDragging, isResizing, scale]);

  const handleToggleCollapse = useCallback(() => {
    onLayoutChange({ ...layout, collapsed: !layout.collapsed });
    onLayoutCommit({ ...layout, collapsed: !layout.collapsed });
  }, [layout, onLayoutChange, onLayoutCommit]);

  const isSkipped = status?.initResult?.includes("skipped") || status?.initResult?.includes("not found");
  const isWarning = status?.initResult?.includes("warning");
  const isOk = status?.initResult === "Beads initialized." || status?.initResult === "Beads already initialized.";
  const shortPath = status?.projectPath
    ? status.projectPath.length > 30
      ? "..." + status.projectPath.slice(-27)
      : status.projectPath
    : "—";

  const doneTasks = tasks.filter((t) => t.status === "done");
  const inProgressTasks = tasks.filter((t) => t.status === "in-progress");
  const readyTasks = tasks.filter((t) => t.status === "ready");
  const otherTasks = tasks.filter(
    (t) => !["done", "in-progress", "ready"].includes(t.status)
  );

  return (
    <div
      ref={cardRef}
      className="beads-card"
      style={{
        position: "absolute",
        left: displayLayout.x,
        top: displayLayout.y,
        width: displayLayout.w,
        height: displayLayout.collapsed ? 48 : "auto",
        maxHeight: displayLayout.collapsed ? 48 : BEADS_CARD_MAX_H,
        cursor: "default",
        userSelect: isDragging ? "none" : "auto",
        ["--card-accent" as string]: cardColors.primary,
        ["--card-accent-muted" as string]: cardColors.secondary,
      }}
    >
      <div
        className="beads-card-header"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDownDrag}
      >
        <span className="beads-card-title">Beads</span>
        <span className="beads-card-status-badge" data-status={isOk ? "ok" : isSkipped ? "skip" : isWarning ? "warn" : "init"}>
          {isOk ? "Active" : isSkipped ? "Skipped" : isWarning ? "Warning" : "..."}
        </span>
        <button
          type="button"
          className="beads-card-collapse"
          onClick={handleToggleCollapse}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={layout.collapsed ? "Expand" : "Collapse"}
        >
          {layout.collapsed ? "▶" : "▼"}
        </button>
        {onClose && (
          <button
            type="button"
            className="beads-card-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            data-no-drag
            aria-label="Close"
          >
            ×
          </button>
        )}
      </div>
      {!layout.collapsed && (
        <>
          <div className="beads-card-body">
            <div className="beads-card-info">
              <span className="beads-card-label">Project</span>
              <span className="beads-card-value" title={status?.projectPath}>{shortPath}</span>
            </div>
            <div className="beads-card-info">
              <span className="beads-card-label">Status</span>
              <span className="beads-card-value beads-card-init-msg">{status?.initResult ?? "Initializing..."}</span>
            </div>

            {isOk && (
              <div className="beads-card-tasks">
                <div className="beads-card-tasks-header">
                  <span className="beads-card-label">Tasks</span>
                  <button
                    type="button"
                    className="beads-card-refresh"
                    onClick={() => {
                      setAutoRefreshPaused(false);
                      void handleRefresh(true);
                    }}
                    disabled={refreshing}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {refreshing ? "..." : "↻"}
                  </button>
                </div>
                {refreshError && (
                  <p className="beads-card-empty" style={{ color: "#f7768e", marginBottom: 8 }}>
                    Refresh failed: {refreshError}
                  </p>
                )}
                {epicProgress && epicProgress.total > 0 && (
                  <div className="beads-card-progress">
                    <div className="beads-card-progress-bar">
                      <div
                        className="beads-card-progress-fill"
                        style={{ width: `${Math.round((epicProgress.done / epicProgress.total) * 100)}%` }}
                      />
                    </div>
                    <span className="beads-card-progress-label">
                      {epicProgress.done}/{epicProgress.total} done
                      {epicProgress.in_progress > 0 && ` · ${epicProgress.in_progress} active`}
                    </span>
                  </div>
                )}
                {tasks.length === 0 ? (
                  <>
                    <p className="beads-card-empty">No tasks yet</p>
                  </>
                ) : (
                  <div className="beads-card-task-list">
                    {[...inProgressTasks, ...readyTasks, ...otherTasks, ...doneTasks].map((t) => {
                      const taskType = t.type || t.issue_type || "task";
                      const mergeInfo = mergeStatuses.get(t.id);
                      return (
                        <div
                          key={t.id}
                          className="beads-card-task"
                          data-status={t.status}
                          onClick={() => void handleOpenTask(t)}
                          style={{ cursor: "pointer" }}
                        >
                          <span className="beads-card-task-type-icon" data-type={taskType}>
                            {TYPE_ICONS[taskType] ?? "📌"}
                          </span>
                          <span className="beads-card-task-key">{t.id}</span>
                          <span className="beads-card-task-title">{t.title || t.id}</span>
                          {mergeInfo ? (
                            <span
                              className="beads-card-task-merge-badge"
                              data-merge-status={mergeInfo.status}
                              title={mergeInfo.detail ?? undefined}
                            >
                              {mergeInfo.status === "merging" ? "Merging…"
                                : mergeInfo.status === "conflict" ? "Conflict"
                                : mergeInfo.status === "failed" ? "Merge failed"
                                : mergeInfo.status}
                            </span>
                          ) : (
                            <span className="beads-card-task-status-badge" data-status={t.status}>
                              {t.status === "in-progress" ? "In Progress"
                                : t.status === "done" ? "Done"
                                : t.status === "ready" ? "Ready"
                                : t.status === "blocked" ? "Blocked"
                                : t.status}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          <div
            className="beads-card-resize-handle e"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "e")}
            title="Drag to resize width"
            aria-label="Resize card width"
          />
        </>
      )}
    </div>
  );
}
