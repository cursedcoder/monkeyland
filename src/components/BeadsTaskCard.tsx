import React, { useCallback, useMemo, useRef, useState } from "react";
import type { SessionLayout, BeadsTask } from "../types";
import {
  BEADS_TASK_CARD_MIN_W,
  BEADS_TASK_CARD_MIN_H,
} from "../types";
import { cardColorsFromId } from "../utils/cardColors";
import { snap } from "../utils/layoutHelpers";

interface BeadsTaskCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onDragStart?: (nodeId: string, layout: SessionLayout) => void;
  onClose?: () => void;
  scale?: number;
}

const STATUS_LABELS: Record<string, string> = {
  done: "Done",
  "in-progress": "In Progress",
  ready: "Ready",
  blocked: "Blocked",
  open: "Open",
};

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

const PRIORITY_LABELS: Record<string, { label: string; icon: string }> = {
  "0": { label: "Critical", icon: "🔴" },
  "1": { label: "High", icon: "🟠" },
  "2": { label: "Medium", icon: "🟡" },
  "3": { label: "Low", icon: "🔵" },
  "4": { label: "Lowest", icon: "⚪" },
};

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
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function BeadsTaskCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  onClose,
  scale = 1,
}: BeadsTaskCardProps) {
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

  const task = useMemo(() => {
    try {
      return JSON.parse(layout.payload ?? "{}") as BeadsTask & { parentBeadsId: string };
    } catch {
      return null;
    }
  }, [layout.payload]);

  const displayLayout = liveLayout ?? layout;
  const taskType = task?.type || task?.issue_type || "task";
  const description = task?.description || task?.body || "";
  const priority =
    typeof task?.priority === "number" && Number.isFinite(task.priority)
      ? String(task.priority)
      : "";
  const deps = Array.isArray(task?.deps)
    ? task.deps.filter(Boolean)
    : typeof task?.deps === "string" && task.deps
      ? task.deps.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const blockedBy = Array.isArray(task?.blocked_by)
    ? task.blocked_by.filter(Boolean)
    : typeof task?.blocked_by === "string" && task.blocked_by
      ? task.blocked_by.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const parent = task?.parent_id || task?.parentId || "";
  const assignee = task?.assignee || "";
  const reporter = task?.reporter || "";
  const epicName = task?.epic_name || task?.epic_id || "";
  const labels = Array.isArray(task?.labels) ? task.labels.filter(Boolean) : [];

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

  const priorityInfo = priority ? PRIORITY_LABELS[priority] : null;
  const createdAgo = relativeTime(task?.created_at);
  const updatedAgo = relativeTime(task?.updated_at);

  if (!task) return null;

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
      {/* Colored left accent stripe by type */}
      <div className="beads-task-card-stripe" data-type={taskType} />

      {/* Top bar: drag handle, type badge, key, status, close */}
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
        <span className="beads-task-card-status-badge" data-status={task.status}>
          {STATUS_LABELS[task.status] ?? task.status}
        </span>
        {onClose && (
          <button
            type="button"
            className="beads-task-card-close"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            onPointerDown={(e) => e.stopPropagation()}
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

      {/* Primary meta chips: priority, assignee, reporter, epic */}
      <div className="beads-task-card-meta">
        {priorityInfo && (
          <span className="beads-task-card-priority-chip" data-priority={priority}>
            {priorityInfo.icon} {priorityInfo.label}
          </span>
        )}
        {epicName && (
          <span className="beads-task-card-meta-chip beads-task-card-epic-chip">
            ⚡ {epicName}
          </span>
        )}
        {assignee && (
          <span className="beads-task-card-meta-chip">
            👤 {assignee}
          </span>
        )}
        {reporter && reporter !== assignee && (
          <span className="beads-task-card-meta-chip">
            ✍️ {reporter}
          </span>
        )}
        {parent && (
          <span className="beads-task-card-meta-chip beads-task-card-parent-chip">
            ⬆ {parent}
          </span>
        )}
        {labels.map((label) => (
          <span key={label} className="beads-task-card-label-chip">
            🏷️ {label}
          </span>
        ))}
      </div>

      {/* Blocked by — shown prominently in red when present */}
      {blockedBy.length > 0 && (
        <div className="beads-task-card-blocked-section">
          <span className="beads-task-card-blocked-label">🚫 Blocked by</span>
          <div className="beads-task-card-blocked-chips">
            {blockedBy.map((b) => (
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
            {deps.map((d) => (
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

      {/* Footer: timestamps */}
      {(createdAgo || updatedAgo) && (
        <div className="beads-task-card-footer">
          {createdAgo && <span>🕐 Created {createdAgo}</span>}
          {updatedAgo && createdAgo && <span className="beads-task-card-footer-sep">·</span>}
          {updatedAgo && <span>✏️ Updated {updatedAgo}</span>}
        </div>
      )}

      <div
        className="beads-task-card-resize-handle se"
        data-resize-handle
        onPointerDown={(e) => handlePointerDownResize(e, "se")}
        title="Drag to resize"
        aria-label="Resize card"
      />
      <div
        className="beads-task-card-resize-handle s"
        data-resize-handle
        onPointerDown={(e) => handlePointerDownResize(e, "s")}
      />
      <div
        className="beads-task-card-resize-handle e"
        data-resize-handle
        onPointerDown={(e) => handlePointerDownResize(e, "e")}
      />
    </div>
  );
}
