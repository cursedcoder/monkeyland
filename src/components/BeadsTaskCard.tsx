import React, { useMemo, useRef, useState } from "react";
import type { SessionLayout, BeadsTask } from "../types";
import { GRID_STEP } from "../types";
import { cardColorsFromId } from "../utils/cardColors";

interface BeadsTaskCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onDragStart?: (nodeId: string, layout: SessionLayout) => void;
  scale?: number;
}

function snap(v: number) {
  return Math.round(v / GRID_STEP) * GRID_STEP;
}

const STATUS_ICONS: Record<string, string> = {
  done: "✅",
  "in-progress": "🔄",
  ready: "📋",
  blocked: "🚫",
  open: "⬜",
};

export function BeadsTaskCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  scale = 1,
}: BeadsTaskCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [liveLayout, setLiveLayout] = useState<SessionLayout | null>(null);
  const cardColors = useMemo(() => cardColorsFromId(layout.session_id), [layout.session_id]);
  const dragStart = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

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
    ? task.deps.join(", ")
    : typeof task?.deps === "string"
      ? task.deps
      : "";
  const parent = task?.parent_id || task?.parentId || "";
  const assignee = task?.assignee || "";

  const handlePointerDownDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
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
  };

  React.useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - dragStart.current.x) / scale;
      const dy = (e.clientY - dragStart.current.y) / scale;
      const next = {
        ...layoutRef.current,
        x: snap(dragStart.current.layoutX + dx),
        y: snap(dragStart.current.layoutY + dy),
      };
      setLiveLayout(next);
      onLayoutChange(next);
    };
    const onUp = () => {
      setIsDragging(false);
      setLiveLayout(null);
      onLayoutCommit(liveLayout ?? layoutRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [isDragging, scale, onLayoutChange, onLayoutCommit, liveLayout]);

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
      <div
        className="beads-task-card-header"
        onPointerDown={handlePointerDownDrag}
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
      >
        <span className="beads-task-card-icon">{STATUS_ICONS[task.status] ?? "⬜"}</span>
        <span className="beads-task-card-title">{task.title || task.id}</span>
      </div>
      <div className="beads-task-card-body">
        <div className="beads-task-card-info">
          <span className="beads-task-card-label">ID</span>
          <span className="beads-task-card-value">{task.id}</span>
        </div>
        <div className="beads-task-card-info">
          <span className="beads-task-card-label">Type</span>
          <span className="beads-task-card-value">{taskType}</span>
        </div>
        <div className="beads-task-card-info">
          <span className="beads-task-card-label">Status</span>
          <span className="beads-task-card-value">{task.status}</span>
        </div>
        {priority && (
          <div className="beads-task-card-info">
            <span className="beads-task-card-label">Priority</span>
            <span className="beads-task-card-value">P{priority}</span>
          </div>
        )}
        {parent && (
          <div className="beads-task-card-info">
            <span className="beads-task-card-label">Parent</span>
            <span className="beads-task-card-value">{parent}</span>
          </div>
        )}
        {deps && (
          <div className="beads-task-card-info">
            <span className="beads-task-card-label">Deps</span>
            <span className="beads-task-card-value">{deps}</span>
          </div>
        )}
        {assignee && (
          <div className="beads-task-card-info">
            <span className="beads-task-card-label">Assignee</span>
            <span className="beads-task-card-value">{assignee}</span>
          </div>
        )}
        {description && (
          <div className="beads-task-card-description">
            <span className="beads-task-card-label">Description</span>
            <p className="beads-task-card-description-text">{description}</p>
          </div>
        )}
      </div>
    </div>
  );
}
