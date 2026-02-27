import { useRef, useCallback, useMemo } from "react";
import { useCanvasPanZoom } from "../hooks/useCanvasPanZoom";
import { useViewportBounds, rectIntersects } from "../hooks/useViewportBounds";
import { PromptCard } from "./PromptCard";
import { SessionCard } from "./SessionCard";
import type { SessionLayout } from "../types";
import { CULL_MARGIN } from "../types";

interface CanvasProps {
  layouts: SessionLayout[];
  onLayoutChange: (nodeId: string, layout: SessionLayout) => void;
  onLayoutCommit: (nodeId: string, layout: SessionLayout) => void;
  onPromptChange?: (nodeId: string, text: string) => void;
  onLaunch?: (nodeId: string) => void;
}

function parsePromptPayload(payload?: string): string {
  if (!payload) return "";
  try {
    const o = JSON.parse(payload) as { promptText?: string };
    return o.promptText ?? "";
  } catch {
    return "";
  }
}

export function Canvas({
  layouts,
  onLayoutChange,
  onLayoutCommit,
  onPromptChange,
  onLaunch,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    viewport,
    transformStyle,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleWheel,
  } = useCanvasPanZoom(containerRef);

  const bounds = useViewportBounds(containerRef, viewport);

  const visibleIds = useMemo(() => {
    if (!bounds) return new Set<string>();
    const set = new Set<string>();
    for (const l of layouts) {
      const cardRect = {
        left: l.x,
        top: l.y,
        right: l.x + l.w,
        bottom: l.y + (l.collapsed ? 48 : l.h),
      };
      if (rectIntersects(bounds, cardRect, CULL_MARGIN)) {
        set.add(l.session_id);
      }
    }
    return set;
  }, [bounds, layouts]);

  const handleCardLayoutChange = useCallback(
    (nodeId: string) => (layout: SessionLayout) => {
      onLayoutChange(nodeId, layout);
    },
    [onLayoutChange]
  );

  const handleCardLayoutCommit = useCallback(
    (nodeId: string) => (layout: SessionLayout) => {
      onLayoutCommit(nodeId, layout);
    },
    [onLayoutCommit]
  );

  return (
    <div
      ref={containerRef}
      className="canvas-container"
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <div
        className="canvas-stage"
        style={{
          transform: transformStyle,
          transformOrigin: "0 0",
        }}
      >
        {layouts.map((layout) => {
          if (!visibleIds.has(layout.session_id)) return null;
          const nodeType = layout.node_type ?? "agent";

          if (nodeType === "prompt") {
            return (
              <PromptCard
                key={layout.session_id}
                layout={layout}
                promptText={parsePromptPayload(layout.payload)}
                onLayoutChange={handleCardLayoutChange(layout.session_id)}
                onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
                onPromptChange={(text) => onPromptChange?.(layout.session_id, text)}
                onLaunch={() => onLaunch?.(layout.session_id)}
              />
            );
          }

          const index = layouts.filter((l) => (l.node_type ?? "agent") === "agent").indexOf(layout);
          return (
            <SessionCard
              key={layout.session_id}
              layout={layout}
              index={index}
              onLayoutChange={handleCardLayoutChange(layout.session_id)}
              onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
            />
          );
        })}
      </div>
    </div>
  );
}
