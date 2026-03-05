import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SessionLayout, BeadsTask } from "../types";
import {
  BEADS_TASK_CARD_MIN_W,
  BEADS_TASK_CARD_MIN_H,
} from "../types";
import { cardColorsFromId } from "../utils/cardColors";
import { snap } from "../utils/layoutHelpers";
import { useBeadsStoreOptional, type ActivityEvent } from "../stores/beadsStore";

interface BeadsTaskCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onDragStart?: (nodeId: string, layout: SessionLayout) => void;
  onClose?: () => void;
  scale?: number;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "ready", label: "Ready" },
  { value: "in_progress", label: "In Progress" },
  { value: "blocked", label: "Blocked" },
  { value: "closed", label: "Done" },
];

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

const PRIORITY_OPTIONS: { value: number; label: string; icon: string }[] = [
  { value: 0, label: "Critical", icon: "🔴" },
  { value: 1, label: "High", icon: "🟠" },
  { value: 2, label: "Medium", icon: "🟡" },
  { value: 3, label: "Low", icon: "🔵" },
  { value: 4, label: "Lowest", icon: "⚪" },
];

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff)) return "";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatEventTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export const BeadsTaskCard = React.memo(function BeadsTaskCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  onClose,
  scale = 1,
}: BeadsTaskCardProps) {
  const store = useBeadsStoreOptional();
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [liveLayout, setLiveLayout] = useState<SessionLayout | null>(null);
  const cardColors = useMemo(() => cardColorsFromId(layout.session_id), [layout.session_id]);
  const dragStart = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, edge: "" as string });
  const layoutRef = useRef(layout);
  const lastEmittedLayout = useRef<SessionLayout>(layout);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const onLayoutCommitRef = useRef(onLayoutCommit);
  const setLiveLayoutRef = useRef(setLiveLayout);
  layoutRef.current = layout;
  onLayoutChangeRef.current = onLayoutChange;
  onLayoutCommitRef.current = onLayoutCommit;
  setLiveLayoutRef.current = setLiveLayout;

  // Parse task from layout payload
  const payloadTask = useMemo(() => {
    try {
      return JSON.parse(layout.payload ?? "{}") as BeadsTask & { parentBeadsId: string };
    } catch {
      return null;
    }
  }, [layout.payload]);

  // Live task from store (if available)
  const liveTask = useMemo(() => {
    if (!store || !payloadTask?.id) return null;
    return store.tasks.find(t => t.id === payloadTask.id) ?? null;
  }, [store, payloadTask?.id, store?.tasks]);

  const task = liveTask ?? payloadTask;
  const displayLayout = liveLayout ?? layout;

  // Merge status from store
  const mergeInfo = useMemo(() => {
    if (!task?.id) return null;
    return store?.mergeStatuses.get(task.id) ?? null;
  }, [store?.mergeStatuses, task?.id]);

  // Agent working on this task
  const activeAgentId = useMemo(() => {
    if (!task?.id) return null;
    return store?.agentTaskMap.get(task.id) ?? null;
  }, [store?.agentTaskMap, task?.id]);

  // Activity log for this task
  const taskActivity = useMemo<ActivityEvent[]>(() => {
    if (!store || !task?.id) return [];
    return store.activityLog.filter(e => e.taskId === task.id);
  }, [store?.activityLog, task?.id]);

  // Live local merge status fallback
  const [localMergeStatus, setLocalMergeStatus] = useState<{ status: string; detail?: string } | null>(null);
  useEffect(() => {
    if (store || !task?.id) return;
    const unlisten = listen<{ task_id: string; status: string; detail?: string }>("merge_status", event => {
      if (event.payload.task_id === task.id) {
        if (event.payload.status === "done") setLocalMergeStatus(null);
        else setLocalMergeStatus({ status: event.payload.status, detail: event.payload.detail });
      }
    });
    return () => { void unlisten.then(fn => fn()).catch(() => {}); };
  }, [store, task?.id]);

  const effectiveMergeInfo = mergeInfo ?? localMergeStatus;

  const { taskType, description, priority, deps, blockedBy, parent, assignee, epicName, labels } = useMemo(() => {
    const _taskType = task?.type || task?.issue_type || "task";
    const _description = task?.description || task?.body || "";
    const _priority = typeof task?.priority === "number" && Number.isFinite(task.priority) ? String(task.priority) : "";
    const _deps = Array.isArray(task?.deps)
      ? task.deps.filter(Boolean)
      : typeof task?.deps === "string" && task.deps
        ? task.deps.split(",").map(s => s.trim()).filter(Boolean)
        : [];
    const _blockedBy = Array.isArray(task?.blocked_by)
      ? task.blocked_by.filter(Boolean)
      : typeof task?.blocked_by === "string" && task.blocked_by
        ? task.blocked_by.split(",").map(s => s.trim()).filter(Boolean)
        : [];
    return {
      taskType: _taskType,
      description: _description,
      priority: _priority,
      deps: _deps,
      blockedBy: _blockedBy,
      parent: task?.parent_id || task?.parentId || "",
      assignee: task?.assignee || "",
      epicName: task?.epic_name || task?.epic_id || "",
      labels: Array.isArray(task?.labels) ? task.labels.filter(Boolean) : [],
    };
  }, [task]);

  // Editable fields
  const handleStatusChange = useCallback(async (newStatus: string) => {
    if (!task?.id || !store) return;
    try {
      await store.updateTaskStatus(task.id, newStatus);
    } catch (e) {
      console.error("[BeadsTaskCard] Status update failed:", e);
    }
  }, [task?.id, store]);

  const handlePriorityChange = useCallback(async (newPriority: number) => {
    if (!task?.id || !store) return;
    try {
      await store.updateTaskPriority(task.id, newPriority);
    } catch (e) {
      console.error("[BeadsTaskCard] Priority update failed:", e);
    }
  }, [task?.id, store]);

  // --- Drag/resize (same infrastructure) ---
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
        if (edge.includes("e")) w = Math.max(BEADS_TASK_CARD_MIN_W, w + dx);
        if (edge.includes("w")) w = Math.max(BEADS_TASK_CARD_MIN_W, w - dx);
        if (edge.includes("s")) h = Math.max(BEADS_TASK_CARD_MIN_H, h + dy);
        if (edge.includes("n")) h = Math.max(BEADS_TASK_CARD_MIN_H, h - dy);
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

  const _priorityInfo = priority ? PRIORITY_OPTIONS.find(p => String(p.value) === priority) : null;
  void _priorityInfo;
  const createdAgo = relativeTime(task?.created_at);
  const updatedAgo = relativeTime(task?.updated_at);

  if (!task) return null;

  const currentStatus = task.status === "in-progress" ? "in_progress" : task.status === "done" ? "closed" : task.status;

  return (
    <div
      className="beads-task-card"
      style={{
        position: "absolute",
        left: displayLayout.x,
        top: displayLayout.y,
        width: displayLayout.w,
        height: displayLayout.h,
        ["--card-accent" as string]: cardColors.primary,
        ["--card-accent-muted" as string]: cardColors.secondary,
      }}
    >
      <div className="beads-task-card-stripe" data-type={taskType} />

      {/* Header */}
      <div
        className="beads-task-card-header"
        onPointerDown={handlePointerDownDrag}
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
      >
        <span className="beads-task-card-type-badge" data-type={taskType}>
          <span className="beads-task-card-type-icon">{TYPE_ICONS[taskType] ?? "📌"}</span>
          <span className="beads-task-card-type-label">{taskType}</span>
        </span>
        <span className="beads-task-card-key">{task.id}</span>
        <div className="beads-task-card-header-spacer" />
        {activeAgentId && <span className="beads-task-card-agent-badge" title={`Agent: ${activeAgentId}`}>⚡ Working</span>}
        {effectiveMergeInfo && (
          <span className="beads-task-card-merge-badge" data-merge-status={effectiveMergeInfo.status}>
            {effectiveMergeInfo.status === "merging" ? "Merging…" : effectiveMergeInfo.status === "conflict" ? "Conflict" : effectiveMergeInfo.status}
          </span>
        )}
        {onClose && (
          <button
            type="button"
            className="beads-task-card-close"
            onClick={e => { e.stopPropagation(); onClose(); }}
            onPointerDown={e => e.stopPropagation()}
            data-no-drag
            aria-label="Close"
          >
            ×
          </button>
        )}
      </div>

      {/* Title */}
      <div className="beads-task-card-title-row">
        <h3 className="beads-task-card-title">{task.title || task.id}</h3>
      </div>

      {/* Editable fields */}
      <div className="beads-task-card-fields" data-no-drag>
        <div className="beads-task-card-field-row">
          <span className="beads-task-card-field-label">Status</span>
          <select
            className="beads-task-card-field-select"
            value={currentStatus}
            onChange={e => void handleStatusChange(e.target.value)}
            onPointerDown={e => e.stopPropagation()}
          >
            {STATUS_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="beads-task-card-field-row">
          <span className="beads-task-card-field-label">Priority</span>
          <select
            className="beads-task-card-field-select"
            value={typeof task.priority === "number" ? task.priority : ""}
            onChange={e => void handlePriorityChange(Number(e.target.value))}
            onPointerDown={e => e.stopPropagation()}
          >
            <option value="" disabled>—</option>
            {PRIORITY_OPTIONS.map(p => (
              <option key={p.value} value={p.value}>{p.icon} {p.label}</option>
            ))}
          </select>
        </div>
        {assignee && (
          <div className="beads-task-card-field-row">
            <span className="beads-task-card-field-label">Assignee</span>
            <span className="beads-task-card-field-value">👤 {assignee}</span>
          </div>
        )}
        {epicName && (
          <div className="beads-task-card-field-row">
            <span className="beads-task-card-field-label">Epic</span>
            <span className="beads-task-card-field-value">⚡ {epicName}</span>
          </div>
        )}
        {parent && (
          <div className="beads-task-card-field-row">
            <span className="beads-task-card-field-label">Parent</span>
            <span className="beads-task-card-field-value beads-task-card-mono">⬆ {parent}</span>
          </div>
        )}
      </div>

      {/* Labels */}
      {labels.length > 0 && (
        <div className="beads-task-card-meta">
          {labels.map(label => (
            <span key={label} className="beads-task-card-label-chip">🏷️ {label}</span>
          ))}
        </div>
      )}

      {/* Blocked by */}
      {blockedBy.length > 0 && (
        <div className="beads-task-card-blocked-section">
          <span className="beads-task-card-blocked-label">🚫 Blocked by</span>
          <div className="beads-task-card-blocked-chips">
            {blockedBy.map(b => (
              <span key={b} className="beads-task-card-blocked-chip">{b}</span>
            ))}
          </div>
        </div>
      )}

      {/* Depends on */}
      {deps.length > 0 && (
        <div className="beads-task-card-deps-section">
          <span className="beads-task-card-deps-label">🔗 Depends on</span>
          <div className="beads-task-card-deps-chips">
            {deps.map(d => (
              <span key={d} className="beads-task-card-dep-chip">{d}</span>
            ))}
          </div>
        </div>
      )}

      {/* Description */}
      {description && (
        <div className="beads-task-card-body">
          <div className="beads-task-card-section-label">Description</div>
          <p className="beads-task-card-description-text">{description}</p>
        </div>
      )}

      {/* Activity log */}
      {taskActivity.length > 0 && (
        <div className="beads-task-card-activity" data-no-drag>
          <div className="beads-task-card-section-label">Activity</div>
          <div className="beads-task-card-activity-list">
            {taskActivity.slice(-10).map((evt, i) => (
              <div key={i} className="beads-task-card-activity-item" data-type={evt.type}>
                <span className="beads-task-card-activity-time">{formatEventTime(evt.timestamp)}</span>
                <span className="beads-task-card-activity-detail">{evt.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer: timestamps + actions */}
      <div className="beads-task-card-footer">
        <div className="beads-task-card-footer-times">
          {createdAgo && <span>Created {createdAgo}</span>}
          {updatedAgo && createdAgo && <span className="beads-task-card-footer-sep">·</span>}
          {updatedAgo && <span>Updated {updatedAgo}</span>}
        </div>
        <div className="beads-task-card-actions" data-no-drag>
          {(task.status === "done" || task.status === "closed") && (
            <button
              type="button"
              className="beads-task-card-action-btn"
              onClick={() => void handleStatusChange("open")}
              onPointerDown={e => e.stopPropagation()}
            >
              Re-open
            </button>
          )}
          {task.status === "blocked" && (
            <button
              type="button"
              className="beads-task-card-action-btn"
              onClick={() => void handleStatusChange("ready")}
              onPointerDown={e => e.stopPropagation()}
            >
              Unblock
            </button>
          )}
        </div>
      </div>

      <div className="beads-task-card-resize-handle se" data-resize-handle onPointerDown={e => handlePointerDownResize(e, "se")} title="Drag to resize" aria-label="Resize card" />
      <div className="beads-task-card-resize-handle s" data-resize-handle onPointerDown={e => handlePointerDownResize(e, "s")} />
      <div className="beads-task-card-resize-handle e" data-resize-handle onPointerDown={e => handlePointerDownResize(e, "e")} />
    </div>
  );
});
