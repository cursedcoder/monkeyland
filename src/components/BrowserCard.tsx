import React, { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLayout } from "../types";
import {
  BROWSER_CARD_MIN_W,
  BROWSER_CARD_MIN_H,
  GRID_STEP,
} from "../types";

interface BrowserCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  scale?: number;
}

function snap(v: number) {
  return Math.round(v / GRID_STEP) * GRID_STEP;
}

function parseBrowserPayload(payload?: string): {
  parentAgentId?: string;
  browserPort?: number;
} {
  if (!payload) return {};
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

export function BrowserCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  scale = 1,
}: BrowserCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [frameUrl, setFrameUrl] = useState("about:blank");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const lastEmittedLayout = useRef<SessionLayout>(layout);
  const dragStart = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, edge: "" as string });
  const eventSourceRef = useRef<EventSource | null>(null);

  const { browserPort } = parseBrowserPayload(layout.payload);

  useEffect(() => {
    if (!browserPort || layout.collapsed) return;

    const url = `http://127.0.0.1:${browserPort}/session/${layout.session_id}/screencast`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { data?: string; url?: string };
        if (msg.data) {
          setFrameSrc(`data:image/jpeg;base64,${msg.data}`);
        }
        if (msg.url) {
          setFrameUrl(msg.url);
        }
      } catch { /* ignore */ }
    };

    es.onerror = () => {
      // Retry is automatic with EventSource
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [browserPort, layout.session_id, layout.collapsed]);

  const handlePointerDownDrag = useCallback(
    (e: React.PointerEvent) => {
      if (
        e.button !== 0 ||
        (e.target as HTMLElement).closest("[data-resize-handle]")
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      if (cardRef.current) cardRef.current.style.userSelect = "none";
      setIsDragging(true);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        layoutX: layout.x,
        layoutY: layout.y,
      };
    },
    [layout.x, layout.y],
  );

  const handlePointerDownResize = useCallback(
    (e: React.PointerEvent, edge: string) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsResizing(true);
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        w: layout.w,
        h: layout.h,
        edge,
      };
    },
    [layout.w, layout.h],
  );

  useEffect(() => {
    if (!isDragging && !isResizing) return;

    const onMove = (e: PointerEvent) => {
      const s = scale;
      if (isDragging) {
        const dx = (e.clientX - dragStart.current.x) / s;
        const dy = (e.clientY - dragStart.current.y) / s;
        const next = {
          ...layout,
          x: snap(dragStart.current.layoutX + dx),
          y: snap(dragStart.current.layoutY + dy),
        };
        lastEmittedLayout.current = next;
        onLayoutChange(next);
      }
      if (isResizing) {
        const dx = (e.clientX - resizeStart.current.x) / s;
        const dy = (e.clientY - resizeStart.current.y) / s;
        let { w, h } = resizeStart.current;
        const edge = resizeStart.current.edge;
        if (edge.includes("e")) w = Math.max(BROWSER_CARD_MIN_W, w + dx);
        if (edge.includes("w")) w = Math.max(BROWSER_CARD_MIN_W, w - dx);
        if (edge.includes("s")) h = Math.max(BROWSER_CARD_MIN_H, h + dy);
        if (edge.includes("n")) h = Math.max(BROWSER_CARD_MIN_H, h - dy);
        const next = { ...layout, w: snap(w), h: snap(h) };
        lastEmittedLayout.current = next;
        onLayoutChange(next);
      }
    };

    const onUp = () => {
      if (cardRef.current) cardRef.current.style.userSelect = "";
      setIsDragging(false);
      setIsResizing(false);
      onLayoutCommit(lastEmittedLayout.current);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [isDragging, isResizing, layout, onLayoutChange, onLayoutCommit, scale]);

  const handleToggleCollapse = useCallback(() => {
    onLayoutChange({ ...layout, collapsed: !layout.collapsed });
    onLayoutCommit({ ...layout, collapsed: !layout.collapsed });
  }, [layout, onLayoutChange, onLayoutCommit]);

  return (
    <div
      ref={cardRef}
      className="browser-card"
      style={{
        position: "absolute",
        left: layout.x,
        top: layout.y,
        width: layout.w,
        height: layout.collapsed ? 48 : layout.h,
        cursor: "default",
        userSelect: isDragging ? "none" : "auto",
      }}
    >
      <div
        className="browser-card-header"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDownDrag}
      >
        <span className="browser-card-title">Browser</span>
        <span className="browser-card-url" title={frameUrl}>
          {frameUrl}
        </span>
        <button
          type="button"
          className="browser-card-collapse"
          onClick={handleToggleCollapse}
          aria-label={layout.collapsed ? "Expand" : "Collapse"}
        >
          {layout.collapsed ? "\u25B6" : "\u25BC"}
        </button>
      </div>
      {!layout.collapsed && (
        <div className="browser-card-body">
          {frameSrc ? (
            <img
              className="browser-card-frame"
              src={frameSrc}
              alt="Browser view"
              draggable={false}
            />
          ) : (
            <div className="browser-card-placeholder">
              Waiting for browser...
            </div>
          )}
          <div
            className="browser-card-resize-handle se"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "se")}
          />
          <div
            className="browser-card-resize-handle s"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "s")}
          />
          <div
            className="browser-card-resize-handle e"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "e")}
          />
        </div>
      )}
    </div>
  );
}
