import React, { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SessionLayout, BeadsTask } from "../types";
import {
  BEADS_CARD_MIN_W,
  BEADS_CARD_MIN_H,
  BEADS_CARD_MAX_H,
  GRID_STEP,
} from "../types";
import { cardColorsFromId } from "../utils/cardColors";
import { snap } from "../utils/layoutHelpers";
import { useBeadsStoreOptional } from "../stores/beadsStore";
import { BeadsDependencyGraph } from "./BeadsDependencyGraph";

export interface BeadsStatus {
  projectPath: string;
  initResult: string;
  tasks?: BeadsTask[];
  lastRefresh?: number;
}

export interface BeadsDependency {
  issue_id: string;
  depends_on_id: string;
  type: "blocks" | "parent-child" | string;
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
  void unlistenPromise.then(fn => fn()).catch(() => {});
}

function safeInvokeUnlisten(unlisten: () => void | Promise<void>) {
  void Promise.resolve().then(() => unlisten()).catch(() => {});
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

type ViewMode = "board" | "graph";
type StatusFilter = "all" | "active" | "ready" | "blocked" | "done";
type TypeFilter = "all" | string;

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "ready", label: "Ready" },
  { value: "in_progress", label: "In Progress" },
  { value: "blocked", label: "Blocked" },
  { value: "closed", label: "Done" },
];

const PRIORITY_OPTIONS: { value: number; label: string; icon: string }[] = [
  { value: 0, label: "Critical", icon: "🔴" },
  { value: 1, label: "High", icon: "🟠" },
  { value: 2, label: "Medium", icon: "🟡" },
  { value: 3, label: "Low", icon: "🔵" },
  { value: 4, label: "Lowest", icon: "⚪" },
];

const TASK_TYPES = ["task", "feature", "bug", "chore", "epic", "story", "subtask", "improvement"];

export const BeadsCard = React.memo(function BeadsCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  onStatusChange,
  onAddTaskCard,
  onClose,
  scale = 1,
}: BeadsCardProps) {
  const store = useBeadsStoreOptional();
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

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; task: BeadsTask } | null>(null);

  // Local task state (synced with store when available)
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [autoRefreshPaused, setAutoRefreshPaused] = useState(false);
  const [localTasks, setLocalTasks] = useState<BeadsTask[]>(status?.tasks ?? []);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);
  const lastAutoRefreshAtRef = useRef(0);

  // Sync project path to store
  useEffect(() => {
    if (projectPath && store) {
      store.setProjectPath(projectPath);
    }
  }, [projectPath, store]);

  // Use store tasks when available, fall back to local
  const tasks = store?.tasks?.length ? store.tasks : localTasks;
  const mergeStatuses = store?.mergeStatuses ?? new Map<string, { status: string; detail?: string }>();
  const agentTaskMap = store?.agentTaskMap ?? new Map<string, string>();
  const storeRefreshing = store?.isRefreshing ?? false;

  const epicId = useMemo(() => {
    const epic = tasks.find(t => t.type === "epic" || t.issue_type === "epic");
    return epic?.id ?? null;
  }, [tasks]);

  const handleRefresh = useCallback(async (force = false) => {
    if (store) {
      await store.refresh(force);
      return;
    }
    if (!projectPath) return;
    if (!force && autoRefreshPaused) return;
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    setRefreshing(true);
    setRefreshError(null);
    try {
      let raw = await invoke<string>("beads_run", {
        projectPath,
        args: ["list", "--json", "--all", "--limit", "0"],
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        raw = await invoke<string>("beads_run", {
          projectPath,
          args: ["list", "--json"],
        });
        parsed = JSON.parse(raw);
      }
      const nextTasks = Array.isArray(parsed) ? (parsed as BeadsTask[]) : [];
      setLocalTasks(nextTasks);
      const prevTasks = status?.tasks ?? [];
      if (JSON.stringify(prevTasks) !== JSON.stringify(nextTasks)) {
        onStatusChange?.({
          projectPath,
          initResult,
          tasks: nextTasks,
          lastRefresh: Date.now(),
        });
      }
      if (autoRefreshPaused) setAutoRefreshPaused(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRefreshError(msg);
      if (/no beads database found/i.test(msg)) setAutoRefreshPaused(true);
    } finally {
      refreshInFlightRef.current = false;
      setRefreshing(false);
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void handleRefresh(force);
      }
    }
  }, [autoRefreshPaused, initResult, onStatusChange, projectPath, store, status?.tasks]);

  // Persist store tasks back to layout payload
  useEffect(() => {
    if (store?.tasks?.length && projectPath) {
      onStatusChange?.({
        projectPath,
        initResult,
        tasks: store.tasks,
        lastRefresh: Date.now(),
      });
    }
  }, [store?.tasks, projectPath, initResult, onStatusChange]);

  const handleOpenTask = useCallback(
    async (task: BeadsTask) => {
      if (!onAddTaskCard) return;
      if (!projectPath) { onAddTaskCard(task); return; }
      try {
        const raw = await invoke<string>("beads_run", {
          projectPath,
          args: ["show", task.id, "--json"],
        });
        const parsed = JSON.parse(raw.trim());
        const detail = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
        if (!detail || typeof detail !== "object") { onAddTaskCard(task); return; }
        onAddTaskCard({
          ...task,
          id: String(detail.id ?? task.id),
          title: String(detail.title ?? task.title),
          type: String(detail.type ?? detail.issue_type ?? task.type),
          status: String(detail.status ?? task.status),
          description: typeof detail.description === "string" ? detail.description : typeof detail.body === "string" ? detail.body : undefined,
          body: typeof detail.body === "string" ? detail.body : undefined,
          issue_type: typeof detail.issue_type === "string" ? detail.issue_type : undefined,
          priority: typeof detail.priority === "number" ? detail.priority : undefined,
          deps: typeof detail.deps === "string" || Array.isArray(detail.deps) ? (detail.deps as string[] | string) : undefined,
          parent: typeof detail.parent === "string" ? detail.parent : typeof detail.parent_id === "string" ? detail.parent_id : typeof detail.parentId === "string" ? detail.parentId : undefined,
          parent_id: typeof detail.parent_id === "string" ? detail.parent_id : typeof detail.parent === "string" ? detail.parent : typeof detail.parentId === "string" ? detail.parentId : undefined,
          parentId: typeof detail.parentId === "string" ? detail.parentId : typeof detail.parent === "string" ? detail.parent : typeof detail.parent_id === "string" ? detail.parent_id : undefined,
          blocked_by: typeof detail.blocked_by === "string" || Array.isArray(detail.blocked_by) ? (detail.blocked_by as string[] | string) : undefined,
          dependencies: Array.isArray(detail.dependencies) ? detail.dependencies : undefined,
          dependency_count: typeof detail.dependency_count === "number" ? detail.dependency_count : undefined,
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
    [onAddTaskCard, projectPath],
  );

  useEffect(() => {
    if (status?.tasks) setLocalTasks(status.tasks);
  }, [status?.tasks]);

  const scheduleRefresh = useCallback(
    (force = false) => {
      if (!projectPath || layout.collapsed) return;
      if (!force) {
        const now = Date.now();
        if (now - lastAutoRefreshAtRef.current < MIN_AUTO_REFRESH_GAP_MS) return;
      }
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        if (!force) lastAutoRefreshAtRef.current = Date.now();
        void handleRefresh(force);
      }, 300);
    },
    [handleRefresh, layout.collapsed, projectPath],
  );

  useEffect(() => {
    if (!projectPath || layout.collapsed) return;
    void handleRefresh(false);
  }, [projectPath, layout.collapsed, handleRefresh]);

  // Event-driven refresh (only when store is not handling it)
  useEffect(() => {
    if (store || !projectPath || layout.collapsed) return;
    let disposed = false;
    const unsubs: Array<() => void | Promise<void>> = [];
    const events = ["agent_spawned", "agent_killed", "validation_requested", "merge_status"] as const;
    Promise.all(events.map(evt => listen(evt, () => scheduleRefresh(false))))
      .then(fns => {
        if (disposed) { fns.forEach(fn => safeInvokeUnlisten(fn)); return; }
        unsubs.push(...fns);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubs.forEach(fn => safeInvokeUnlisten(fn));
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [layout.collapsed, projectPath, scheduleRefresh, store]);

  const [epicProgress, setEpicProgress] = useState<{ total: number; done: number; in_progress: number; open: number } | null>(null);
  void epicProgress;

  useEffect(() => {
    const unlisten = listen<{
      epic_id: string; total: number; done: number; in_progress: number; open: number;
    }>("epic_progress", event => {
      if (epicId && event.payload.epic_id === epicId) setEpicProgress(event.payload);
    });
    return () => { safeUnlisten(unlisten); };
  }, [epicId]);

  // Local merge statuses fallback
  const [localMergeStatuses, setLocalMergeStatuses] = useState<Map<string, { status: string; detail?: string }>>(new Map());
  useEffect(() => {
    if (store) return;
    const unlisten = listen<{ task_id: string; status: string; detail?: string }>("merge_status", event => {
      const { task_id, status: st, detail } = event.payload;
      setLocalMergeStatuses(prev => {
        const next = new Map(prev);
        if (st === "done") next.delete(task_id);
        else next.set(task_id, { status: st, detail: detail ?? undefined });
        return next;
      });
    });
    return () => { safeUnlisten(unlisten); };
  }, [store]);

  const effectiveMergeStatuses = store ? mergeStatuses : localMergeStatuses;

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

  // --- Drag/resize handlers (unchanged logic) ---
  const handlePointerDownDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("[data-resize-handle]") || (e.target as HTMLElement).closest("[data-no-drag]")) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setLiveLayout(layout);
      setIsDragging(true);
      onDragStart?.(layout.session_id, layout);
      dragStart.current = { x: e.clientX, y: e.clientY, layoutX: layout.x, layoutY: layout.y };
    },
    [layout, onDragStart],
  );

  const handlePointerDownResize = useCallback(
    (e: React.PointerEvent, edge: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setLiveLayout(layout);
      setIsResizing(true);
      resizeStart.current = { x: e.clientX, y: e.clientY, w: layout.w, h: layout.h, edge };
    },
    [layout.w, layout.h],
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
        const next = { ...currentLayout, x: snap(dragStart.current.layoutX + dx), y: snap(dragStart.current.layoutY + dy) };
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

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [contextMenu]);

  // --- Derived data ---
  const isSkipped = status?.initResult?.includes("skipped") || status?.initResult?.includes("not found");
  const isWarning = status?.initResult?.includes("warning");
  const isOk = status?.initResult === "Beads initialized." || status?.initResult === "Beads already initialized.";

  const shortPath = status?.projectPath
    ? status.projectPath.length > 30 ? "..." + status.projectPath.slice(-27) : status.projectPath
    : "—";

  // Task groups for board
  const { readyTasks, activeTasks, reviewTasks, doneTasks, blockedTasks } = useMemo(() => {
    const ready: BeadsTask[] = [];
    const active: BeadsTask[] = [];
    const review: BeadsTask[] = [];
    const done: BeadsTask[] = [];
    const blocked: BeadsTask[] = [];
    for (const t of tasks) {
      if (t.type === "epic" || t.issue_type === "epic") continue;
      const hasActiveAgent = agentTaskMap.has(t.id);
      const mergeInfo = effectiveMergeStatuses.get(t.id);
      if (t.status === "done" || t.status === "closed") { done.push(t); continue; }
      if (t.status === "blocked") { blocked.push(t); continue; }
      if (mergeInfo) { review.push(t); continue; }
      if (t.status === "in-progress" || hasActiveAgent) { active.push(t); continue; }
      if (t.status === "ready" || t.status === "open") { ready.push(t); continue; }
      ready.push(t);
    }
    return { readyTasks: ready, activeTasks: active, reviewTasks: review, doneTasks: done, blockedTasks: blocked };
  }, [tasks, agentTaskMap, effectiveMergeStatuses]);

  // Counts for summary
  const totalNonEpic = readyTasks.length + activeTasks.length + reviewTasks.length + doneTasks.length + blockedTasks.length;
  const activeCount = activeTasks.length + reviewTasks.length;
  const blockedCount = blockedTasks.length;
  const doneCount = doneTasks.length;
  const progressPct = totalNonEpic > 0 ? Math.round((doneCount / totalNonEpic) * 100) : 0;

  // Filtered tasks for board/graph
  const filteredTasks = useMemo(() => {
    let filtered = tasks.filter(t => t.type !== "epic" && t.issue_type !== "epic");
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(t => t.id.toLowerCase().includes(q) || (t.title || "").toLowerCase().includes(q));
    }
    if (statusFilter !== "all") {
      filtered = filtered.filter(t => {
        switch (statusFilter) {
          case "active": return t.status === "in-progress" || agentTaskMap.has(t.id);
          case "ready": return t.status === "ready" || t.status === "open";
          case "blocked": return t.status === "blocked";
          case "done": return t.status === "done" || t.status === "closed";
          default: return true;
        }
      });
    }
    if (typeFilter !== "all") {
      filtered = filtered.filter(t => (t.type || t.issue_type) === typeFilter);
    }
    return filtered;
  }, [tasks, searchQuery, statusFilter, typeFilter, agentTaskMap]);

  // Get unique types for filter dropdown
  const availableTypes = useMemo(() => {
    const types = new Set<string>();
    for (const t of tasks) {
      const tt = t.type || t.issue_type;
      if (tt && tt !== "epic") types.add(tt);
    }
    return Array.from(types).sort();
  }, [tasks]);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, task: BeadsTask) => {
    e.preventDefault();
    e.stopPropagation();
    const cardRect = cardRef.current?.getBoundingClientRect();
    const x = e.clientX - (cardRect?.left ?? 0);
    const y = e.clientY - (cardRect?.top ?? 0);
    setContextMenu({ x, y, task });
  }, []);

  const handleContextAction = useCallback(async (action: string, value: string | number) => {
    if (!contextMenu) return;
    const task = contextMenu.task;
    setContextMenu(null);
    try {
      if (action === "status" && store) {
        await store.updateTaskStatus(task.id, String(value));
      } else if (action === "priority" && store) {
        await store.updateTaskPriority(task.id, Number(value));
      } else if (action === "status" && projectPath) {
        await invoke<string>("beads_run", { projectPath, args: ["update", task.id, "--status", String(value)] });
        void handleRefresh(true);
      } else if (action === "priority" && projectPath) {
        await invoke<string>("beads_run", { projectPath, args: ["update", task.id, "--priority", String(value)] });
        void handleRefresh(true);
      }
    } catch (e) {
      console.error("[BeadsCard] Context action failed:", e);
    }
  }, [contextMenu, store, projectPath, handleRefresh]);

  // Inline creation
  const [createTitle, setCreateTitle] = useState("");
  const [createType, setCreateType] = useState("task");
  const [createPriority, setCreatePriority] = useState(2);
  const [createParent, setCreateParent] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!createTitle.trim()) return;
    setIsCreating(true);
    try {
      if (store) {
        await store.createTask(createTitle.trim(), createType, createPriority, createParent || undefined);
      } else if (projectPath) {
        const args = ["create", createTitle.trim(), "--silent", "--type", createType, "--priority", String(createPriority)];
        if (createParent) args.push("--parent", createParent);
        await invoke<string>("beads_run", { projectPath, args });
        void handleRefresh(true);
      }
      setCreateTitle("");
      setShowCreateForm(false);
    } catch (e) {
      console.error("[BeadsCard] Create task failed:", e);
    } finally {
      setIsCreating(false);
    }
  }, [createTitle, createType, createPriority, createParent, store, projectPath, handleRefresh]);

  const [doneExpanded, setDoneExpanded] = useState(false);
  const isAnyRefreshing = refreshing || storeRefreshing;
  const effectiveRefreshError = store?.refreshError ?? refreshError;

  // Board column component
  const renderColumn = (title: string, columnTasks: BeadsTask[], columnKey: string, collapsible = false) => {
    const isCollapsed = collapsible && !doneExpanded;
    return (
      <div className="beads-board-column" data-column={columnKey} key={columnKey}>
        <div
          className="beads-board-column-header"
          onClick={collapsible ? () => setDoneExpanded(!doneExpanded) : undefined}
          style={collapsible ? { cursor: "pointer" } : undefined}
        >
          <span className="beads-board-column-title">{title}</span>
          <span className="beads-board-column-count">{columnTasks.length}</span>
          {collapsible && <span className="beads-board-column-toggle">{isCollapsed ? "▸" : "▾"}</span>}
        </div>
        {!isCollapsed && (
          <div className="beads-board-column-body">
            {columnTasks.map(t => {
              const taskType = t.type || t.issue_type || "task";
              const isActive = agentTaskMap.has(t.id);
              const mergeInfo = effectiveMergeStatuses.get(t.id);
              return (
                <div
                  key={t.id}
                  className={`beads-board-chip${isActive ? " beads-board-chip-active" : ""}`}
                  data-status={t.status}
                  onClick={() => void handleOpenTask(t)}
                  onContextMenu={e => handleContextMenu(e, t)}
                  data-no-drag
                >
                  <span className="beads-board-chip-icon" data-type={taskType}>
                    {TYPE_ICONS[taskType] ?? "📌"}
                  </span>
                  <span className="beads-board-chip-id">{t.id}</span>
                  <span className="beads-board-chip-title">{t.title || t.id}</span>
                  {isActive && <span className="beads-board-chip-bolt" title="Agent working">⚡</span>}
                  {mergeInfo && (
                    <span className="beads-board-chip-merge" data-merge-status={mergeInfo.status} title={mergeInfo.detail}>
                      {mergeInfo.status === "merging" ? "M" : mergeInfo.status === "conflict" ? "!" : "✗"}
                    </span>
                  )}
                </div>
              );
            })}
            {columnTasks.length === 0 && <div className="beads-board-column-empty">—</div>}
          </div>
        )}
      </div>
    );
  };

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
      {/* Header */}
      <div
        className="beads-card-header"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDownDrag}
      >
        <span className="beads-card-title">Beads</span>

        {/* Smart collapsed summary */}
        {layout.collapsed && isOk && totalNonEpic > 0 && (
          <div className="beads-collapsed-summary" data-no-drag>
            <div className="beads-collapsed-progress">
              <div className="beads-collapsed-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="beads-collapsed-stat">{doneCount}/{totalNonEpic}</span>
            {activeCount > 0 && <span className="beads-collapsed-stat beads-collapsed-active">⚡{activeCount}</span>}
            {blockedCount > 0 && <span className="beads-collapsed-stat beads-collapsed-blocked">🚫{blockedCount}</span>}
          </div>
        )}

        {layout.collapsed && !isOk && (
          <span className="beads-card-status-badge" data-status={isSkipped ? "skip" : isWarning ? "warn" : "init"}>
            {isSkipped ? "Skipped" : isWarning ? "Warning" : "..."}
          </span>
        )}

        {!layout.collapsed && (
          <span className="beads-card-status-badge" data-status={isOk ? "ok" : isSkipped ? "skip" : isWarning ? "warn" : "init"}>
            {isOk ? "Active" : isSkipped ? "Skipped" : isWarning ? "Warning" : "..."}
          </span>
        )}

        {!layout.collapsed && isOk && (
          <div className="beads-view-toggle" data-no-drag>
            <button
              type="button"
              className={viewMode === "board" ? "active" : ""}
              onClick={() => setViewMode("board")}
              onPointerDown={e => e.stopPropagation()}
            >
              Board
            </button>
            <button
              type="button"
              className={viewMode === "graph" ? "active" : ""}
              onClick={() => setViewMode("graph")}
              onPointerDown={e => e.stopPropagation()}
            >
              Graph
            </button>
          </div>
        )}

        {!layout.collapsed && isOk && (
          <button
            type="button"
            className="beads-card-refresh"
            onClick={() => { setAutoRefreshPaused(false); void handleRefresh(true); }}
            disabled={isAnyRefreshing}
            onPointerDown={e => e.stopPropagation()}
            data-no-drag
          >
            {isAnyRefreshing ? "..." : "↻"}
          </button>
        )}

        <button
          type="button"
          className="beads-card-collapse"
          onClick={handleToggleCollapse}
          onPointerDown={e => e.stopPropagation()}
          data-no-drag
          aria-label={layout.collapsed ? "Expand" : "Collapse"}
        >
          {layout.collapsed ? "▶" : "▼"}
        </button>
        {onClose && (
          <button
            type="button"
            className="beads-card-close"
            onClick={e => { e.stopPropagation(); onClose(); }}
            onPointerDown={e => e.stopPropagation()}
            data-no-drag
            aria-label="Close"
          >
            ×
          </button>
        )}
      </div>

      {/* Expanded body */}
      {!layout.collapsed && (
        <>
          <div className="beads-card-body">
            {/* Init info - shown only when not yet active */}
            {!isOk && (
              <>
                <div className="beads-card-info">
                  <span className="beads-card-label">Project</span>
                  <span className="beads-card-value" title={status?.projectPath}>{shortPath}</span>
                </div>
                <div className="beads-card-info">
                  <span className="beads-card-label">Status</span>
                  <span className="beads-card-value beads-card-init-msg">{status?.initResult ?? "Initializing..."}</span>
                </div>
              </>
            )}

            {isOk && (
              <>
                {effectiveRefreshError && (
                  <p className="beads-card-empty" style={{ color: "#f7768e", marginBottom: 4 }}>
                    Refresh failed: {effectiveRefreshError}
                  </p>
                )}

                {/* Filter bar */}
                {tasks.length > 3 && (
                  <div className="beads-filter-bar" data-no-drag>
                    <input
                      className="beads-filter-input"
                      type="text"
                      placeholder="Search..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      onPointerDown={e => e.stopPropagation()}
                    />
                    <select
                      className="beads-filter-select"
                      value={statusFilter}
                      onChange={e => setStatusFilter(e.target.value as StatusFilter)}
                      onPointerDown={e => e.stopPropagation()}
                    >
                      <option value="all">All status</option>
                      <option value="active">Active</option>
                      <option value="ready">Ready</option>
                      <option value="blocked">Blocked</option>
                      <option value="done">Done</option>
                    </select>
                    {availableTypes.length > 1 && (
                      <select
                        className="beads-filter-select"
                        value={typeFilter}
                        onChange={e => setTypeFilter(e.target.value)}
                        onPointerDown={e => e.stopPropagation()}
                      >
                        <option value="all">All types</option>
                        {availableTypes.map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                {/* Board or Graph view */}
                {viewMode === "board" ? (
                  tasks.length === 0 ? (
                    <p className="beads-card-empty">No tasks yet</p>
                  ) : (
                    <div className="beads-board">
                      {renderColumn("Ready", readyTasks.filter(t => filteredTasks.includes(t)), "ready")}
                      {renderColumn("Active", activeTasks.filter(t => filteredTasks.includes(t)), "active")}
                      {renderColumn("Review", reviewTasks.filter(t => filteredTasks.includes(t)), "review")}
                      {blockedTasks.length > 0 && renderColumn("Blocked", blockedTasks.filter(t => filteredTasks.includes(t)), "blocked")}
                      {renderColumn("Done", doneTasks.filter(t => filteredTasks.includes(t)), "done", true)}
                    </div>
                  )
                ) : (
                  <BeadsDependencyGraph
                    tasks={filteredTasks}
                    agentTaskMap={agentTaskMap}
                    onSelectTask={t => void handleOpenTask(t)}
                  />
                )}

                {/* Progress footer */}
                {totalNonEpic > 0 && (
                  <div className="beads-card-progress">
                    <div className="beads-card-progress-bar">
                      <div className="beads-card-progress-fill" style={{ width: `${progressPct}%` }} />
                    </div>
                    <span className="beads-card-progress-label">
                      {doneCount}/{totalNonEpic} done
                      {activeCount > 0 && ` · ${activeCount} active`}
                      {blockedCount > 0 && ` · ${blockedCount} blocked`}
                    </span>
                  </div>
                )}

                {/* Inline task creation */}
                {showCreateForm ? (
                  <div className="beads-create-form" data-no-drag>
                    <input
                      className="beads-create-title"
                      type="text"
                      placeholder="Task title..."
                      value={createTitle}
                      onChange={e => setCreateTitle(e.target.value)}
                      onPointerDown={e => e.stopPropagation()}
                      onKeyDown={e => { if (e.key === "Enter") void handleCreate(); if (e.key === "Escape") setShowCreateForm(false); }}
                      autoFocus
                    />
                    <div className="beads-create-row">
                      <select
                        className="beads-create-select"
                        value={createType}
                        onChange={e => setCreateType(e.target.value)}
                        onPointerDown={e => e.stopPropagation()}
                      >
                        {TASK_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <select
                        className="beads-create-select"
                        value={createPriority}
                        onChange={e => setCreatePriority(Number(e.target.value))}
                        onPointerDown={e => e.stopPropagation()}
                      >
                        {PRIORITY_OPTIONS.map(p => (
                          <option key={p.value} value={p.value}>{p.icon} {p.label}</option>
                        ))}
                      </select>
                      {epicId && (
                        <select
                          className="beads-create-select"
                          value={createParent}
                          onChange={e => setCreateParent(e.target.value)}
                          onPointerDown={e => e.stopPropagation()}
                        >
                          <option value="">No parent</option>
                          <option value={epicId}>{epicId}</option>
                        </select>
                      )}
                    </div>
                    <div className="beads-create-actions">
                      <button
                        type="button"
                        className="beads-create-btn beads-create-btn-primary"
                        onClick={() => void handleCreate()}
                        disabled={!createTitle.trim() || isCreating}
                        onPointerDown={e => e.stopPropagation()}
                      >
                        {isCreating ? "..." : "Create"}
                      </button>
                      <button
                        type="button"
                        className="beads-create-btn"
                        onClick={() => setShowCreateForm(false)}
                        onPointerDown={e => e.stopPropagation()}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : isOk && (
                  <button
                    type="button"
                    className="beads-add-task-btn"
                    onClick={() => setShowCreateForm(true)}
                    onPointerDown={e => e.stopPropagation()}
                    data-no-drag
                  >
                    + New Task
                  </button>
                )}
              </>
            )}
          </div>

          {/* Context menu */}
          {contextMenu && (
            <div
              className="beads-context-menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onPointerDown={e => e.stopPropagation()}
              data-no-drag
            >
              <div className="beads-context-menu-section">Status</div>
              {STATUS_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className="beads-context-menu-item"
                  data-active={contextMenu.task.status === opt.value || (opt.value === "in_progress" && contextMenu.task.status === "in-progress")}
                  onClick={() => void handleContextAction("status", opt.value)}
                >
                  {opt.label}
                </button>
              ))}
              <div className="beads-context-menu-divider" />
              <div className="beads-context-menu-section">Priority</div>
              {PRIORITY_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className="beads-context-menu-item"
                  data-active={contextMenu.task.priority === opt.value}
                  onClick={() => void handleContextAction("priority", opt.value)}
                >
                  {opt.icon} {opt.label}
                </button>
              ))}
            </div>
          )}

          <div
            className="beads-card-resize-handle e"
            data-resize-handle
            onPointerDown={e => handlePointerDownResize(e, "e")}
            title="Drag to resize width"
            aria-label="Resize card width"
          />
        </>
      )}
    </div>
  );
});
