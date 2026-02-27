import React, { useCallback, useRef, useState } from "react";
import type { SessionLayout } from "../types";
import {
  SESSION_CARD_MIN_W,
  SESSION_CARD_MIN_H,
  GRID_STEP,
} from "../types";

interface SessionCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  index: number;
  /** Canvas scale (zoom); used so drag/resize deltas match cursor in screen space */
  scale?: number;
}

function snap(v: number) {
  return Math.round(v / GRID_STEP) * GRID_STEP;
}

export function SessionCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  index,
  scale = 1,
}: SessionCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const lastEmittedLayout = useRef<SessionLayout>(layout);
  const dragStart = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 });
  const resizeStart = useRef({
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    edge: "" as string,
  });

  const handlePointerDownDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("[data-resize-handle]"))
        return;
      e.preventDefault(); // prevent text selection / default drag behavior
      e.stopPropagation(); // so canvas pan does not start
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
    [layout.x, layout.y]
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
    [layout.w, layout.h]
  );

  React.useEffect(() => {
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
        if (edge.includes("e")) w = Math.max(SESSION_CARD_MIN_W, w + dx);
        if (edge.includes("w")) w = Math.max(SESSION_CARD_MIN_W, w - dx);
        if (edge.includes("s")) h = Math.max(SESSION_CARD_MIN_H, h + dy);
        if (edge.includes("n")) h = Math.max(SESSION_CARD_MIN_H, h - dy);
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
      className="session-card"
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
        className="session-card-header"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDownDrag}
      >
        <span className="session-card-title">Agent {index + 1}</span>
        <button
          type="button"
          className="session-card-collapse"
          onClick={handleToggleCollapse}
          aria-label={layout.collapsed ? "Expand" : "Collapse"}
        >
          {layout.collapsed ? "▶" : "▼"}
        </button>
      </div>
      {!layout.collapsed && (
        <div className="session-card-body">
          {(() => {
            try {
              const p = JSON.parse(layout.payload ?? "{}") as {
                sourcePromptId?: string;
                status?: string;
                answer?: string;
                errorMessage?: string;
              };
              if (p.status === "loading") {
                return (
                  <div className="session-card-response">
                    <p className="session-card-response-loading">Loading…</p>
                    {p.answer ? (
                      <div className="session-card-response-text">{p.answer}</div>
                    ) : null}
                  </div>
                );
              }
              if (p.status === "error") {
                return (
                  <div className="session-card-response session-card-response-error">
                    <p className="session-card-response-error-msg">{p.errorMessage ?? "Error"}</p>
                  </div>
                );
              }
              if (p.status === "done" && p.answer != null) {
                return (
                  <div className="session-card-response">
                    <div className="session-card-response-text">{p.answer}</div>
                  </div>
                );
              }
            } catch {
              /* ignore */
            }
            return (
              <div className="session-card-placeholder">
                Terminal + browser (Stage 3–4)
              </div>
            );
          })()}
          <div
            className="session-card-resize-handle se"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "se")}
          />
          <div
            className="session-card-resize-handle s"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "s")}
          />
          <div
            className="session-card-resize-handle e"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "e")}
          />
        </div>
      )}
    </div>
  );
}
