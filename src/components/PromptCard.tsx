import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionLayout } from "../types";
import {
  GRID_STEP,
  PROMPT_CARD_MIN_W,
  PROMPT_CARD_MIN_H,
} from "../types";

function snap(v: number) {
  return Math.round(v / GRID_STEP) * GRID_STEP;
}

interface PromptCardProps {
  layout: SessionLayout;
  promptText: string;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onPromptChange: (text: string) => void;
  onLaunch: () => void;
}

export function PromptCard({
  layout,
  promptText,
  onLayoutChange,
  onLayoutCommit,
  onPromptChange,
  onLaunch,
}: PromptCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
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
      if (e.button !== 0 || (e.target as HTMLElement).closest("[data-resize-handle]")) return;
      e.stopPropagation(); // so canvas pan does not start
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

  useEffect(() => {
    if (!isDragging && !isResizing) return;

    const onMove = (e: PointerEvent) => {
      if (isDragging) {
        const dx = e.clientX - dragStart.current.x;
        const dy = e.clientY - dragStart.current.y;
        const next = {
          ...layout,
          x: snap(dragStart.current.layoutX + dx),
          y: snap(dragStart.current.layoutY + dy),
        };
        lastEmittedLayout.current = next;
        onLayoutChange(next);
      }
      if (isResizing) {
        const dx = e.clientX - resizeStart.current.x;
        const dy = e.clientY - resizeStart.current.y;
        let { w, h } = resizeStart.current;
        const edge = resizeStart.current.edge;
        if (edge.includes("e")) w = Math.max(PROMPT_CARD_MIN_W, w + dx);
        if (edge.includes("w")) w = Math.max(PROMPT_CARD_MIN_W, w - dx);
        if (edge.includes("s")) h = Math.max(PROMPT_CARD_MIN_H, h + dy);
        if (edge.includes("n")) h = Math.max(PROMPT_CARD_MIN_H, h - dy);
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
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [isDragging, isResizing, layout, onLayoutChange, onLayoutCommit]);

  return (
    <div
      className="prompt-card"
      style={{
        position: "absolute",
        left: layout.x,
        top: layout.y,
        width: layout.w,
        height: layout.h,
        cursor: isDragging ? "grabbing" : "default",
        userSelect: isDragging ? "none" : "auto",
      }}
    >
      <div
        className="prompt-card-header"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDownDrag}
      >
        <span className="prompt-card-title">Prompt</span>
      </div>
      <div className="prompt-card-body">
        <textarea
          className="prompt-card-input"
          placeholder="Describe what you want the agent to do…"
          value={promptText}
          onChange={(e) => onPromptChange(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <button
          type="button"
          className="prompt-card-launch"
          onClick={(e) => {
            e.stopPropagation();
            onLaunch();
          }}
        >
          Launch
        </button>
      </div>
      <div
        className="prompt-card-resize-handle se"
        data-resize-handle
        onPointerDown={(e) => handlePointerDownResize(e, "se")}
      />
      <div
        className="prompt-card-resize-handle s"
        data-resize-handle
        onPointerDown={(e) => handlePointerDownResize(e, "s")}
      />
      <div
        className="prompt-card-resize-handle e"
        data-resize-handle
        onPointerDown={(e) => handlePointerDownResize(e, "e")}
      />
    </div>
  );
}
