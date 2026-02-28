import React, { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionLayout } from "../types";
import {
  BEADS_CARD_MIN_W,
  BEADS_CARD_MIN_H,
  GRID_STEP,
} from "../types";
import { cardColorsFromId } from "../utils/cardColors";

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
}

interface BeadsCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onDragStart?: (nodeId: string, layout: SessionLayout) => void;
  scale?: number;
}

function snap(v: number) {
  return Math.round(v / GRID_STEP) * GRID_STEP;
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

const STATUS_ICONS: Record<string, string> = {
  done: "✅",
  "in-progress": "🔄",
  ready: "📋",
  blocked: "🚫",
  open: "⬜",
};

export function BeadsCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  scale = 1,
}: BeadsCardProps) {
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

  const [refreshing, setRefreshing] = useState(false);
  const [tasks, setTasks] = useState<BeadsTask[]>(status?.tasks ?? []);

  useEffect(() => {
    if (status?.tasks) setTasks(status.tasks);
  }, [status?.tasks]);

  const handleRefresh = useCallback(async () => {
    if (!status?.projectPath) return;
    setRefreshing(true);
    try {
      const raw = await invoke<string>("beads_run", {
        projectPath: status.projectPath,
        args: ["list", "--json"],
      });
      const parsed = JSON.parse(raw) as BeadsTask[];
      setTasks(Array.isArray(parsed) ? parsed : []);
    } catch {
      // bd not available or no tasks yet
    } finally {
      setRefreshing(false);
    }
  }, [status?.projectPath]);

  const handlePointerDownDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("[data-resize-handle]")) return;
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
  const isOk = status?.initResult === "Beads initialized.";
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
        height: displayLayout.collapsed ? 48 : displayLayout.h,
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
                    onClick={handleRefresh}
                    disabled={refreshing}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {refreshing ? "..." : "↻"}
                  </button>
                </div>
                {tasks.length === 0 ? (
                  <p className="beads-card-empty">No tasks yet</p>
                ) : (
                  <div className="beads-card-task-list">
                    {[...inProgressTasks, ...readyTasks, ...otherTasks, ...doneTasks].map((t) => (
                      <div key={t.id} className="beads-card-task" data-status={t.status}>
                        <span className="beads-card-task-icon">{STATUS_ICONS[t.status] ?? "⬜"}</span>
                        <span className="beads-card-task-title">{t.title || t.id}</span>
                        <span className="beads-card-task-type">{t.type}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div
            className="beads-card-resize-handle se"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "se")}
            title="Drag to resize"
            aria-label="Resize card"
          />
          <div
            className="beads-card-resize-handle s"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "s")}
          />
          <div
            className="beads-card-resize-handle e"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "e")}
          />
        </>
      )}
    </div>
  );
}
