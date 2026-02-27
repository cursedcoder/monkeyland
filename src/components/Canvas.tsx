import { useRef, useCallback, useMemo } from "react";
import { useCanvasPanZoom } from "../hooks/useCanvasPanZoom";
import { useViewportBounds, rectIntersects } from "../hooks/useViewportBounds";
import { PromptCard } from "./PromptCard";
import { SessionCard } from "./SessionCard";
import { TerminalCard } from "./TerminalCard";
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

  const connectionLines = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number; color?: string }[] = [];
    const nodeById = new Map(layouts.map((l) => [l.session_id, l]));

    for (const layout of layouts) {
      if (!layout.payload) continue;
      try {
        const p = JSON.parse(layout.payload) as {
          sourcePromptId?: string;
          parentAgentId?: string;
        };

        // Prompt → Agent connection
        if (layout.node_type === "agent" && p.sourcePromptId) {
          const prompt = nodeById.get(p.sourcePromptId);
          if (prompt) {
            lines.push({
              x1: prompt.x + prompt.w / 2,
              y1: prompt.y + prompt.h,
              x2: layout.x + layout.w / 2,
              y2: layout.y,
            });
          }
        }

        // Agent → Terminal connection
        if (layout.node_type === "terminal" && p.parentAgentId) {
          const agent = nodeById.get(p.parentAgentId);
          if (agent) {
            lines.push({
              x1: agent.x + agent.w,
              y1: agent.y + agent.h / 2,
              x2: layout.x,
              y2: layout.y + (layout.collapsed ? 24 : layout.h / 2),
              color: "#9ece6a",
            });
          }
        }
      } catch {
        /* ignore */
      }
    }
    return lines;
  }, [layouts]);

  const svgSize = 8000;
  const svgViewBox = `0 0 ${svgSize} ${svgSize}`;

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
        <svg
          className="canvas-connections"
          width={svgSize}
          height={svgSize}
          viewBox={svgViewBox}
          preserveAspectRatio="none"
          style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
        >
          {connectionLines.map((line, i) => (
            <line
              key={i}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke={line.color ?? "var(--connection-stroke, #7aa2f7)"}
              strokeWidth="2"
              strokeOpacity="0.8"
            />
          ))}
        </svg>
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
                scale={viewport.scale}
              />
            );
          }

          if (nodeType === "terminal") {
            return (
              <TerminalCard
                key={layout.session_id}
                layout={layout}
                onLayoutChange={handleCardLayoutChange(layout.session_id)}
                onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
                scale={viewport.scale}
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
              scale={viewport.scale}
            />
          );
        })}
      </div>
    </div>
  );
}
