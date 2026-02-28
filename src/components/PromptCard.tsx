import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionLayout } from "../types";
import {
  GRID_STEP,
  PROMPT_CARD_MIN_W,
  PROMPT_CARD_MIN_H,
} from "../types";
import { cardColorsFromId } from "../utils/cardColors";

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
  /** Canvas scale (zoom); used so drag/resize deltas match cursor in screen space */
  scale?: number;
}

export function PromptCard({
  layout,
  promptText,
  onLayoutChange,
  onLayoutCommit,
  onPromptChange,
  onLaunch,
  scale = 1,
}: PromptCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [liveLayout, setLiveLayout] = useState<SessionLayout | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const lastEmittedLayout = useRef<SessionLayout>(layout);
  const cardColors = useMemo(() => cardColorsFromId(layout.session_id), [layout.session_id]);
  const dragStart = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 });
  const resizeStart = useRef({
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    edge: "" as string,
  });
  const layoutRef = useRef(layout);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const onLayoutCommitRef = useRef(onLayoutCommit);
  const setLiveLayoutRef = useRef(setLiveLayout);
  layoutRef.current = layout;
  onLayoutChangeRef.current = onLayoutChange;
  onLayoutCommitRef.current = onLayoutCommit;
  setLiveLayoutRef.current = setLiveLayout;
  const displayLayout = liveLayout ?? layout;

  const handlePointerDownDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("[data-resize-handle]")) return;
      e.preventDefault(); // prevent text selection / default drag behavior
      e.stopPropagation(); // so canvas pan does not start
      e.currentTarget.setPointerCapture(e.pointerId);
      setLiveLayout(layout);
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

  useEffect(() => {
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
        if (edge.includes("e")) w = Math.max(PROMPT_CARD_MIN_W, w + dx);
        if (edge.includes("w")) w = Math.max(PROMPT_CARD_MIN_W, w - dx);
        if (edge.includes("s")) h = Math.max(PROMPT_CARD_MIN_H, h + dy);
        if (edge.includes("n")) h = Math.max(PROMPT_CARD_MIN_H, h - dy);
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

  return (
    <div
      ref={cardRef}
      className="prompt-card"
      style={{
        position: "absolute",
        left: displayLayout.x,
        top: displayLayout.y,
        width: displayLayout.w,
        height: displayLayout.h,
        cursor: isDragging ? "grabbing" : "default",
        userSelect: isDragging ? "none" : "auto",
        ["--card-accent" as string]: cardColors.primary,
        ["--card-accent-muted" as string]: cardColors.secondary,
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
        title="Drag to resize width and height"
        aria-label="Resize card"
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
