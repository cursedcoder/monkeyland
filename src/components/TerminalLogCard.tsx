import React, { useCallback, useMemo, useRef, useState, useEffect } from "react";
import type { SessionLayout } from "../types";
import {
  TERMINAL_LOG_MIN_W,
  TERMINAL_LOG_MIN_H,
  GRID_STEP,
} from "../types";
import { cardColorsFromId } from "../utils/cardColors";

/** Only auto-scroll when user is within this many px of the bottom. */
const AUTO_SCROLL_THRESHOLD_PX = 80;
const AT_BOTTOM_THRESHOLD_PX = 24;

export interface TerminalLogEntry {
  command: string;
  cwd?: string;
  output: string;
  ts: number;
}

interface TerminalLogCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onDragStart?: (nodeId: string, layout: SessionLayout) => void;
  scale?: number;
}

function snap(v: number) {
  return Math.round(v / GRID_STEP) * GRID_STEP;
}

function parseEntries(payload?: string): TerminalLogEntry[] {
  if (!payload) return [];
  try {
    const p = JSON.parse(payload) as { entries?: TerminalLogEntry[] };
    return p.entries ?? [];
  } catch {
    return [];
  }
}

export function TerminalLogCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  scale = 1,
}: TerminalLogCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [liveLayout, setLiveLayout] = useState<SessionLayout | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
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

  const entries = useMemo(() => parseEntries(layout.payload), [layout.payload]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - AUTO_SCROLL_THRESHOLD_PX;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
      setIsAtBottom(true);
    }
  }, [entries.length]);

  const handleBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - AT_BOTTOM_THRESHOLD_PX;
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setIsAtBottom(true);
    }
  }, []);

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
        if (edge.includes("e")) w = Math.max(TERMINAL_LOG_MIN_W, w + dx);
        if (edge.includes("w")) w = Math.max(TERMINAL_LOG_MIN_W, w - dx);
        if (edge.includes("s")) h = Math.max(TERMINAL_LOG_MIN_H, h + dy);
        if (edge.includes("n")) h = Math.max(TERMINAL_LOG_MIN_H, h - dy);
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

  return (
    <div
      ref={cardRef}
      className="terminal-log-card"
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
        className="terminal-log-card-header"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDownDrag}
      >
        <span className="terminal-log-card-title">Terminal Log</span>
        <span className="terminal-log-card-count">{entries.length} cmd{entries.length !== 1 ? "s" : ""}</span>
        <button
          type="button"
          className="terminal-log-card-collapse"
          onClick={handleToggleCollapse}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={layout.collapsed ? "Expand" : "Collapse"}
        >
          {layout.collapsed ? "▶" : "▼"}
        </button>
      </div>
      {!layout.collapsed && (
        <>
          <div
            ref={bodyRef}
            className="terminal-log-card-body"
            onScroll={handleBodyScroll}
          >
            {entries.length === 0 && (
              <p className="terminal-log-card-empty">No commands yet...</p>
            )}
            {entries.map((entry, i) => (
              <div key={i} className="terminal-log-entry">
                <div className="terminal-log-cmd">
                  <span className="terminal-log-prompt">$</span>
                  <span className="terminal-log-cmd-text">{entry.command}</span>
                  {entry.cwd && <span className="terminal-log-cwd">{entry.cwd}</span>}
                </div>
                {entry.output && (
                  <pre className="terminal-log-output">{entry.output}</pre>
                )}
              </div>
            ))}
            {!isAtBottom && entries.length > 0 && (
              <button
                type="button"
                className="terminal-log-card-scroll-to-bottom"
                onClick={(e) => { e.stopPropagation(); scrollToBottom(); }}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="Scroll to bottom"
                title="Scroll to latest"
              >
                ↓ Bottom
              </button>
            )}
          </div>
          <div
            className="terminal-log-card-resize-handle se"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "se")}
            title="Drag to resize"
            aria-label="Resize card"
          />
          <div
            className="terminal-log-card-resize-handle s"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "s")}
          />
          <div
            className="terminal-log-card-resize-handle e"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "e")}
          />
        </>
      )}
    </div>
  );
}
