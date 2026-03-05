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
import type { InlineOperatorState } from "../App";

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
  wmStreamingContent?: string;
  wmStreamingToolCalls?: Array<{ name: string; status: string }>;
  wmTaskProgress?: { done: number; total: number };
  wmOrchStatus?: "running" | "paused" | "idle";
  wmInlineAgents?: InlineOperatorState[];
  onWMToggleInlineAgent?: (agentId: string) => void;
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
  wmStreamingContent,
  wmStreamingToolCalls,
  wmTaskProgress = { done: 0, total: 0 },
  wmOrchStatus = "idle",
  wmInlineAgents = [],
  onWMToggleInlineAgent,
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

  const onLayoutChangeRef = useRef(onLayoutChange);
  const onLayoutCommitRef = useRef(onLayoutCommit);
  onLayoutChangeRef.current = onLayoutChange;
  onLayoutCommitRef.current = onLayoutCommit;

  const layoutChangeCacheRef = useRef(new Map<string, (l: SessionLayout) => void>());
  const layoutCommitCacheRef = useRef(new Map<string, (l: SessionLayout) => void>());

  const handleCardLayoutChange = useCallback(
    (nodeId: string) => {
      let fn = layoutChangeCacheRef.current.get(nodeId);
      if (!fn) {
        fn = (layout: SessionLayout) => {
          onLayoutChangeRef.current(nodeId, layout);
          if (nodeId === draggingNodeIdRef.current) {
            setLiveDragLayout(layout);
          }
        };
        layoutChangeCacheRef.current.set(nodeId, fn);
      }
      return fn;
    },
    []
  );

  const handleCardLayoutCommit = useCallback(
    (nodeId: string) => {
      let fn = layoutCommitCacheRef.current.get(nodeId);
      if (!fn) {
        fn = (layout: SessionLayout) => {
          onLayoutCommitRef.current(nodeId, layout);
          if (nodeId === draggingNodeIdRef.current) {
            draggingNodeIdRef.current = null;
            setDraggingNodeId(null);
            setLiveDragLayout(null);
          }
        };
        layoutCommitCacheRef.current.set(nodeId, fn);
      }
      return fn;
    },
    []
  );

  const handleDragStart = useCallback((nodeId: string, initialLayout: SessionLayout) => {
    draggingNodeIdRef.current = nodeId;
    setDraggingNodeId(nodeId);
    setLiveDragLayout(initialLayout);
  }, []);

  const onRemoveLayoutRef = useRef(onRemoveLayout);
  const onPromptChangeRef = useRef(onPromptChange);
  const onLaunchRef = useRef(onLaunch);
  const onStopAgentRef = useRef(onStopAgent);
  const onBeadsStatusChangeRef = useRef(onBeadsStatusChange);
  const onAddTaskCardRef = useRef(onAddTaskCard);
  onRemoveLayoutRef.current = onRemoveLayout;
  onPromptChangeRef.current = onPromptChange;
  onLaunchRef.current = onLaunch;
  onStopAgentRef.current = onStopAgent;
  onBeadsStatusChangeRef.current = onBeadsStatusChange;
  onAddTaskCardRef.current = onAddTaskCard;

  const stableCloseCacheRef = useRef(new Map<string, (() => void) | undefined>());
  const stableStopCacheRef = useRef(new Map<string, () => void>());

  const getStableClose = useCallback((nodeId: string): (() => void) | undefined => {
    if (!onRemoveLayoutRef.current) return undefined;
    let fn = stableCloseCacheRef.current.get(nodeId);
    if (!fn) {
      fn = () => onRemoveLayoutRef.current?.(nodeId);
      stableCloseCacheRef.current.set(nodeId, fn);
    }
    return fn;
  }, []);

  const getStableStop = useCallback((nodeId: string): () => void => {
    let fn = stableStopCacheRef.current.get(nodeId);
    if (!fn) {
      fn = () => onStopAgentRef.current?.(nodeId);
      stableStopCacheRef.current.set(nodeId, fn);
    }
    return fn;
  }, []);

  const stableStatusChangeCacheRef = useRef(new Map<string, (status: import("./BeadsCard").BeadsStatus) => void>());
  const getStableStatusChange = useCallback((nodeId: string) => {
    let fn = stableStatusChangeCacheRef.current.get(nodeId);
    if (!fn) {
      fn = (status: import("./BeadsCard").BeadsStatus) => onBeadsStatusChangeRef.current?.(nodeId, status);
      stableStatusChangeCacheRef.current.set(nodeId, fn);
    }
    return fn;
  }, []);

  const stableAddTaskCardCacheRef = useRef(new Map<string, (task: import("../types").BeadsTask) => void>());
  const getStableAddTaskCard = useCallback((nodeId: string) => {
    let fn = stableAddTaskCardCacheRef.current.get(nodeId);
    if (!fn) {
      fn = (task: import("../types").BeadsTask) => onAddTaskCardRef.current?.(nodeId, task);
      stableAddTaskCardCacheRef.current.set(nodeId, fn);
    }
    return fn;
  }, []);

  const stablePromptChangeCacheRef = useRef(new Map<string, (text: string) => void>());
  const getStablePromptChange = useCallback((nodeId: string) => {
    let fn = stablePromptChangeCacheRef.current.get(nodeId);
    if (!fn) {
      fn = (text: string) => onPromptChangeRef.current?.(nodeId, text);
      stablePromptChangeCacheRef.current.set(nodeId, fn);
    }
    return fn;
  }, []);

  const stableLaunchCacheRef = useRef(new Map<string, () => void>());
  const getStableLaunch = useCallback((nodeId: string) => {
    let fn = stableLaunchCacheRef.current.get(nodeId);
    if (!fn) {
      fn = () => onLaunchRef.current?.(nodeId);
      stableLaunchCacheRef.current.set(nodeId, fn);
    }
    return fn;
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

  // Build agent→task mapping for labeled connection lines
  const agentTaskLinks = useMemo(() => {
    const links: { agentId: string; taskId: string; beadsId: string | null }[] = [];
    for (const l of layouts) {
      if (l.node_type !== "agent" && l.node_type !== "worker") continue;
      try {
        const p = JSON.parse(l.payload ?? "{}") as { task_id?: string; status?: string };
        if (p.task_id && p.status !== "stopped" && p.status !== "error" && p.status !== "done") {
          const beadsLayout = layouts.find(bl => bl.node_type === "beads");
          links.push({ agentId: l.session_id, taskId: p.task_id, beadsId: beadsLayout?.session_id ?? null });
        }
      } catch { /* ignore */ }
    }
    return links;
  }, [layouts]);

  const connectionLines = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number; color?: string; label?: string }[] = [];

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

    // Agent → Beads task labeled lines (agent working on specific task)
    for (const link of agentTaskLinks) {
      const agentLayout = effectiveLayoutById.get(link.agentId);
      const beadsLayout = link.beadsId ? effectiveLayoutById.get(link.beadsId) : null;
      if (agentLayout && beadsLayout) {
        lines.push({
          x1: agentLayout.x + agentLayout.w,
          y1: agentLayout.y + agentLayout.h * 0.35,
          x2: beadsLayout.x,
          y2: beadsLayout.y + (beadsLayout.collapsed ? 24 : beadsLayout.h * 0.35),
          color: "#7aa2f7",
          label: link.taskId,
        });
      }
    }

    return lines;
  }, [layouts, effectiveLayoutById, agentTaskLinks]);

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
          {connectionLines.map((line, i) => {
            const pathD = getCurvedPath(line.x1, line.y1, line.x2, line.y2);
            const midX = (line.x1 + line.x2) / 2;
            const midY = (line.y1 + line.y2) / 2;
            return (
              <g key={i}>
                <path
                  d={pathD}
                  fill="none"
                  stroke={line.color ?? "var(--connection-stroke, #7aa2f7)"}
                  strokeWidth="2"
                  strokeOpacity="0.8"
                  strokeLinecap="round"
                />
                {line.label && (
                  <>
                    <rect
                      x={midX - 28}
                      y={midY - 9}
                      width={56}
                      height={18}
                      rx={4}
                      fill="var(--ml-bg-card, #1a1b26)"
                      stroke={line.color ?? "#7aa2f7"}
                      strokeWidth="1"
                      strokeOpacity="0.6"
                    />
                    <text
                      x={midX}
                      y={midY + 4}
                      textAnchor="middle"
                      fontSize="9"
                      fontWeight="700"
                      fontFamily="ui-monospace, monospace"
                      fill={line.color ?? "#7aa2f7"}
                      opacity="0.9"
                    >
                      {line.label.length > 8 ? line.label.slice(0, 7) + "…" : line.label}
                    </text>
                  </>
                )}
              </g>
            );
          })}
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
                streamingContent={wmStreamingContent}
                streamingToolCalls={wmStreamingToolCalls}
                taskProgress={wmTaskProgress}
                orchStatus={wmOrchStatus}
                inlineAgents={wmInlineAgents}
                onToggleInlineAgent={onWMToggleInlineAgent}
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
                onPromptChange={getStablePromptChange(layout.session_id)}
                onLaunch={getStableLaunch(layout.session_id)}
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
                onStatusChange={getStableStatusChange(layout.session_id)}
                onAddTaskCard={getStableAddTaskCard(layout.session_id)}
                onClose={getStableClose(layout.session_id)}
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
                onClose={getStableClose(layout.session_id)}
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
                onClose={getStableClose(layout.session_id)}
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
                onStop={getStableStop(layout.session_id)}
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
              onStop={getStableStop(layout.session_id)}
              scale={viewport.scale}
            />
          );
        })}
      </div>
    </div>
  );
}
