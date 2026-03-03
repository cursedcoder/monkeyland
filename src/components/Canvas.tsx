import { useRef, useCallback, useMemo, useState } from "react";
import { useCanvasPanZoom } from "../hooks/useCanvasPanZoom";
import { useViewportBounds, rectIntersects } from "../hooks/useViewportBounds";
import { SessionCard } from "./SessionCard";
import { TerminalCard } from "./TerminalCard";
import { BrowserCard } from "./BrowserCard";
import { BeadsCard } from "./BeadsCard";
import { BeadsTaskCard } from "./BeadsTaskCard";
import { TerminalLogCard } from "./TerminalLogCard";
import { ValidatorCard } from "./ValidatorCard";
import { WMChatCard, type WMChatMessage, type WMPhase } from "./WMChatCard";
import type { SessionLayout } from "../types";
import { CULL_MARGIN } from "../types";

interface CanvasProps {
  layouts: SessionLayout[];
  onLayoutChange: (nodeId: string, layout: SessionLayout) => void;
  onLayoutCommit: (nodeId: string, layout: SessionLayout) => void;
  onRemoveLayout?: (nodeId: string) => void;
  onPromptChange?: (nodeId: string, text: string) => void;
  onLaunch?: (nodeId: string) => void;
  onStopAgent?: (nodeId: string) => void;
  onAddTaskCard?: (parentBeadsId: string, task: import("../types").BeadsTask) => void;
  onBeadsStatusChange?: (nodeId: string, status: import("./BeadsCard").BeadsStatus) => void;
  wmChatMessages?: WMChatMessage[];
  wmPhase?: WMPhase;
  wmIsProcessing?: boolean;
  wmTaskProgress?: { done: number; total: number };
  wmOrchStatus?: "running" | "paused" | "idle";
  onWMSendMessage?: (text: string) => void;
  onWMPause?: () => void;
  onWMResume?: () => void;
  onWMCancelAll?: () => void;
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
  onRemoveLayout,
  onPromptChange,
  onLaunch,
  onStopAgent,
  onAddTaskCard,
  onBeadsStatusChange,
  wmChatMessages = [],
  wmPhase = "initial",
  wmIsProcessing = false,
  wmTaskProgress = { done: 0, total: 0 },
  wmOrchStatus = "idle",
  onWMSendMessage,
  onWMPause,
  onWMResume,
  onWMCancelAll,
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
          parent_agent_id?: string;
          parentBeadsId?: string;
        };
        const parentId = p.parentAgentId ?? p.parent_agent_id ?? p.parentBeadsId;

        // WM Chat / Prompt → Agent connection (use effective layout so lines follow dragged cards)
        // sourcePromptId points to the original prompt card which may now be a wm_chat card
        if (layout.node_type === "agent" && p.sourcePromptId) {
          const wmOrPrompt = effectiveLayoutById.get(p.sourcePromptId);
          const agent = sourceOrTargetLayout;
          if (wmOrPrompt && agent) {
            lines.push({
              x1: wmOrPrompt.x + wmOrPrompt.w / 2,
              y1: wmOrPrompt.y + wmOrPrompt.h,
              x2: agent.x + agent.w / 2,
              y2: agent.y,
            });
          }
        }

        // Agent → Terminal / TerminalLog connection
        if ((layout.node_type === "terminal" || layout.node_type === "terminal_log") && parentId) {
          const agent = effectiveLayoutById.get(parentId);
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
        if (layout.node_type === "browser" && parentId) {
          const agent = effectiveLayoutById.get(parentId);
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

        // Agent → Beads connection
        if (layout.node_type === "beads" && parentId) {
          const agent = effectiveLayoutById.get(parentId);
          const beads = sourceOrTargetLayout;
          if (agent && beads) {
            lines.push({
              x1: agent.x + agent.w,
              y1: agent.y + agent.h / 2,
              x2: beads.x,
              y2: beads.y + (beads.collapsed ? 24 : beads.h / 2),
              color: "#f7768e",
            });
          }
        }

        // Beads → BeadsTask connection
        if (layout.node_type === "beads_task" && parentId) {
          const beads = effectiveLayoutById.get(parentId);
          const task = sourceOrTargetLayout;
          if (beads && task) {
            lines.push({
              x1: beads.x + beads.w,
              y1: beads.y + (beads.collapsed ? 24 : beads.h / 2),
              x2: task.x,
              y2: task.y + task.h / 2,
              color: "#f7768e",
            });
          }
        }

        // Agent → Agent / Worker / Validator (orchestration hierarchy)
        if ((layout.node_type === "agent" || layout.node_type === "worker" || layout.node_type === "validator") && parentId) {
          const parentLayout = effectiveLayoutById.get(parentId);
          const child = sourceOrTargetLayout;
          if (parentLayout && child && parentLayout.session_id !== child.session_id) {
            const colorMap: Record<string, string> = {
              worker: "#e0af68",
              validator: "#7dcfff",
              agent: "#ff9e64",
            };
            lines.push({
              x1: parentLayout.x + parentLayout.w / 2,
              y1: parentLayout.y + parentLayout.h,
              x2: child.x + child.w / 2,
              y2: child.y,
              color: colorMap[layout.node_type ?? "agent"] ?? "#ff9e64",
            });
          }
        }
      } catch {
        /* ignore */
      }
    }
    return lines;
  }, [layouts, effectiveLayoutById]);

  const agentLikeIndexById = useMemo(() => {
    const map = new Map<string, number>();
    let index = 0;
    for (const l of layouts) {
      const nodeType = l.node_type ?? "agent";
      if (nodeType === "agent" || nodeType === "worker") {
        map.set(l.session_id, index++);
      }
    }
    return map;
  }, [layouts]);

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

          if (nodeType === "wm_chat") {
            return (
              <WMChatCard
                key={layout.session_id}
                layout={layout}
                mode="chat"
                messages={wmChatMessages}
                wmPhase={wmPhase}
                isProcessing={wmIsProcessing}
                taskProgress={wmTaskProgress}
                orchStatus={wmOrchStatus}
                onSendMessage={onWMSendMessage}
                onPause={onWMPause}
                onResume={onWMResume}
                onCancelAll={onWMCancelAll}
                onLayoutChange={handleCardLayoutChange(layout.session_id)}
                onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
                onDragStart={handleDragStart}
                scale={viewport.scale}
              />
            );
          }

          if (nodeType === "prompt") {
            return (
              <WMChatCard
                key={layout.session_id}
                layout={layout}
                mode="prompt"
                promptText={parsePromptPayload(layout.payload)}
                onPromptChange={(text) => onPromptChange?.(layout.session_id, text)}
                onLaunch={() => onLaunch?.(layout.session_id)}
                onLayoutChange={handleCardLayoutChange(layout.session_id)}
                onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
                onDragStart={handleDragStart}
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

          if (nodeType === "beads") {
            return (
              <BeadsCard
                key={layout.session_id}
                layout={layout}
                onLayoutChange={handleCardLayoutChange(layout.session_id)}
                onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
                onDragStart={handleDragStart}
                onStatusChange={(status) => onBeadsStatusChange?.(layout.session_id, status)}
                onAddTaskCard={(task) => onAddTaskCard?.(layout.session_id, task)}
                onClose={onRemoveLayout ? () => onRemoveLayout(layout.session_id) : undefined}
                scale={viewport.scale}
              />
            );
          }

          if (nodeType === "beads_task") {
            return (
              <BeadsTaskCard
                key={layout.session_id}
                layout={layout}
                onLayoutChange={handleCardLayoutChange(layout.session_id)}
                onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
                onDragStart={handleDragStart}
                onClose={onRemoveLayout ? () => onRemoveLayout(layout.session_id) : undefined}
                scale={viewport.scale}
              />
            );
          }

          if (nodeType === "terminal_log") {
            return (
              <TerminalLogCard
                key={layout.session_id}
                layout={layout}
                onLayoutChange={handleCardLayoutChange(layout.session_id)}
                onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
                onDragStart={handleDragStart}
                scale={viewport.scale}
              />
            );
          }

          if (nodeType === "validator") {
            return (
              <ValidatorCard
                key={layout.session_id}
                layout={layout}
                onLayoutChange={handleCardLayoutChange(layout.session_id)}
                onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
                onDragStart={handleDragStart}
                onStop={() => onStopAgent?.(layout.session_id)}
                scale={viewport.scale}
              />
            );
          }

          // agent, worker: SessionCard
          const index = agentLikeIndexById.get(layout.session_id) ?? 0;
          return (
            <SessionCard
              key={layout.session_id}
              layout={layout}
              index={index}
              onLayoutChange={handleCardLayoutChange(layout.session_id)}
              onLayoutCommit={handleCardLayoutCommit(layout.session_id)}
              onDragStart={handleDragStart}
              onStop={() => onStopAgent?.(layout.session_id)}
              scale={viewport.scale}
            />
          );
        })}
      </div>
    </div>
  );
}
