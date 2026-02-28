import { useRef, useCallback, useMemo, useState } from "react";
import { useCanvasPanZoom } from "../hooks/useCanvasPanZoom";
import { useViewportBounds, rectIntersects } from "../hooks/useViewportBounds";
import { PromptCard } from "./PromptCard";
import { SessionCard } from "./SessionCard";
import { TerminalCard } from "./TerminalCard";
import { BrowserCard } from "./BrowserCard";
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

/** Build SVG path d for a curved line from (x1,y1) to (x2,y2) using quadratic Bezier. */
function getCurvedPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bend: number = 0.25
): string {
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const perpX = (-dy / len) * len * bend;
  const perpY = (dx / len) * len * bend;
  const cpx = midX + perpX;
  const cpy = midY + perpY;
  return `M ${x1} ${y1} Q ${cpx} ${cpy} ${x2} ${y2}`;
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

  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [liveDragLayout, setLiveDragLayout] = useState<SessionLayout | null>(null);
  const draggingNodeIdRef = useRef<string | null>(null);
  draggingNodeIdRef.current = draggingNodeId;

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
    // Always show the card being dragged so it and its lines stay visible
    if (draggingNodeId) set.add(draggingNodeId);
    return set;
  }, [bounds, layouts, draggingNodeId]);

  const handleCardLayoutChange = useCallback(
    (nodeId: string) => (layout: SessionLayout) => {
      onLayoutChange(nodeId, layout);
      if (nodeId === draggingNodeIdRef.current) {
        setLiveDragLayout(layout);
      }
    },
    [onLayoutChange]
  );

  const handleCardLayoutCommit = useCallback(
    (nodeId: string) => (layout: SessionLayout) => {
      onLayoutCommit(nodeId, layout);
      if (nodeId === draggingNodeIdRef.current) {
        draggingNodeIdRef.current = null;
        setDraggingNodeId(null);
        setLiveDragLayout(null);
      }
    },
    [onLayoutCommit]
  );

  const handleDragStart = useCallback((nodeId: string, initialLayout: SessionLayout) => {
    draggingNodeIdRef.current = nodeId;
    setDraggingNodeId(nodeId);
    setLiveDragLayout(initialLayout);
  }, []);

  /** Effective layout per node: use live drag position when that node is being dragged. */
  const effectiveLayoutById = useMemo(() => {
    const map = new Map<string, SessionLayout>();
    for (const l of layouts) {
      map.set(
        l.session_id,
        l.session_id === draggingNodeId && liveDragLayout ? liveDragLayout : l
      );
    }
    return map;
  }, [layouts, draggingNodeId, liveDragLayout]);

  const connectionLines = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number; color?: string }[] = [];

    for (const layout of layouts) {
      const sourceOrTargetLayout = effectiveLayoutById.get(layout.session_id);
      if (!sourceOrTargetLayout) continue;
      if (!layout.payload) continue;
      try {
        const p = JSON.parse(layout.payload) as {
          sourcePromptId?: string;
          parentAgentId?: string;
        };

        // Prompt → Agent connection (use effective layout so lines follow dragged cards)
        if (layout.node_type === "agent" && p.sourcePromptId) {
          const prompt = effectiveLayoutById.get(p.sourcePromptId);
          const agent = sourceOrTargetLayout;
          if (prompt && agent) {
            lines.push({
              x1: prompt.x + prompt.w / 2,
              y1: prompt.y + prompt.h,
              x2: agent.x + agent.w / 2,
              y2: agent.y,
            });
          }
        }

        // Agent → Terminal connection
        if (layout.node_type === "terminal" && p.parentAgentId) {
          const agent = effectiveLayoutById.get(p.parentAgentId);
          const terminal = sourceOrTargetLayout;
          if (agent && terminal) {
            lines.push({
              x1: agent.x + agent.w,
              y1: agent.y + agent.h / 2,
              x2: terminal.x,
              y2: terminal.y + (terminal.collapsed ? 24 : terminal.h / 2),
              color: "#9ece6a",
            });
          }
        }

        // Agent → Browser connection
        if (layout.node_type === "browser" && p.parentAgentId) {
          const agent = effectiveLayoutById.get(p.parentAgentId);
          const browser = sourceOrTargetLayout;
          if (agent && browser) {
            lines.push({
              x1: agent.x + agent.w / 2,
              y1: agent.y + agent.h,
              x2: browser.x + browser.w / 2,
              y2: browser.y,
              color: "#bb9af7",
            });
          }
        }
      } catch {
        /* ignore */
      }
    }
    return lines;
  }, [layouts, effectiveLayoutById]);

  // ViewBox and SVG extend into negative coords so lines don't clip when cards are dragged left/up
  const svgExtent = 8000;
  const svgSize = svgExtent * 2;
  const svgViewBox = `${-svgExtent} ${-svgExtent} ${svgSize} ${svgSize}`;

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
          style={{
            position: "absolute",
            left: -svgExtent,
            top: -svgExtent,
            pointerEvents: "none",
          }}
        >
          {connectionLines.map((line, i) => (
            <path
              key={i}
              d={getCurvedPath(line.x1, line.y1, line.x2, line.y2)}
              fill="none"
              stroke={line.color ?? "var(--connection-stroke, #7aa2f7)"}
              strokeWidth="2"
              strokeOpacity="0.8"
              strokeLinecap="round"
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
                onDragStart={handleDragStart}
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
                onDragStart={handleDragStart}
                scale={viewport.scale}
              />
            );
          }

          if (nodeType === "browser") {
            return (
              <BrowserCard
                key={layout.session_id}
                layout={layout}
                onLayoutChange={handleCardLayoutChange(layout.session_id)}
                onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
                onDragStart={handleDragStart}
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
              onDragStart={handleDragStart}
              scale={viewport.scale}
            />
          );
        })}
      </div>
    </div>
  );
}
