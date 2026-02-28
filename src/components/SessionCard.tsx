import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SessionLayout } from "../types";
import {
  SESSION_CARD_MIN_W,
  SESSION_CARD_MIN_H,
  SESSION_CARD_MAX_H,
  GRID_STEP,
} from "../types";

interface SessionCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  index: number;
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
  const bodyScrollRef = useRef<HTMLDivElement>(null);
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
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
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
      e.preventDefault();
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
    document.body.style.userSelect = "none";

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
      setIsDragging(false);
      setIsResizing(false);
      onLayoutCommit(lastEmittedLayout.current);
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
  }, [isDragging, isResizing, layout, onLayoutChange, onLayoutCommit, scale]);

  const handleToggleCollapse = useCallback(() => {
    onLayoutChange({ ...layout, collapsed: !layout.collapsed });
    onLayoutCommit({ ...layout, collapsed: !layout.collapsed });
  }, [layout, onLayoutChange, onLayoutCommit]);

  // Auto-scroll to bottom and auto-grow height when LLM content updates
  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    try {
      const p = JSON.parse(layout.payload ?? "{}") as {
        status?: string;
        answer?: string;
      };
      if (p.status === "loading" || p.status === "done") {
        el.scrollTop = el.scrollHeight;
        // Auto-grow card height when content overflows (up to SESSION_CARD_MAX_H)
        const rafId = requestAnimationFrame(() => {
          if (!bodyScrollRef.current || layout.collapsed) return;
          const { scrollHeight, clientHeight } = bodyScrollRef.current;
          if (scrollHeight > clientHeight && layout.h < SESSION_CARD_MAX_H) {
            const overflow = scrollHeight - clientHeight;
            const newH = Math.min(
              layout.h + overflow,
              SESSION_CARD_MAX_H
            );
            if (newH > layout.h) {
              const next = { ...layout, h: Math.round(newH / GRID_STEP) * GRID_STEP };
              onLayoutChange(next);
              onLayoutCommit(next);
            }
          }
        });
        return () => cancelAnimationFrame(rafId);
      }
    } catch {
      /* ignore */
    }
  }, [layout.payload, layout.collapsed, layout.h, layout, onLayoutChange, onLayoutCommit]);

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
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={layout.collapsed ? "Expand" : "Collapse"}
        >
          {layout.collapsed ? "▶" : "▼"}
        </button>
      </div>
      {!layout.collapsed && (
        <div
          ref={bodyScrollRef}
          className="session-card-body"
          onPointerDown={(e) => {
            if (!(e.target as HTMLElement).closest("[data-resize-handle]"))
              e.stopPropagation();
          }}
          onPointerUp={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(() => {
            try {
              const p = JSON.parse(layout.payload ?? "{}") as {
                sourcePromptId?: string;
                status?: string;
                answer?: string;
                errorMessage?: string;
                toolActivity?: string;
              };
              if (p.status === "loading") {
                return (
                  <div className="session-card-response">
                    <p className="session-card-response-loading">
                      {p.toolActivity || "Thinking\u2026"}
                    </p>
                    {p.answer ? (
                      <div className="session-card-response-text session-card-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {p.answer}
                        </ReactMarkdown>
                      </div>
                    ) : null}
                  </div>
                );
              }
              if (p.status === "error") {
                return (
                  <div className="session-card-response session-card-response-error">
                    <p className="session-card-response-error-msg">
                      {p.errorMessage ?? "Error"}
                    </p>
                  </div>
                );
              }
              if (p.status === "done" && p.answer != null) {
                return (
                  <div className="session-card-response">
                    <div className="session-card-response-text session-card-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {p.answer}
                      </ReactMarkdown>
                    </div>
                  </div>
                );
              }
            } catch {
              /* ignore */
            }
            return (
              <div className="session-card-placeholder">
                Waiting for prompt\u2026
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
