import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SessionLayout, AgentRole } from "../types";
import {
  SESSION_CARD_MIN_W,
  SESSION_CARD_MIN_H,
  SESSION_CARD_MAX_H,
  GRID_STEP,
} from "../types";
import { cardColorsFromId } from "../utils/cardColors";

const AUTO_SCROLL_THRESHOLD_PX = 80;
const AT_BOTTOM_THRESHOLD_PX = 24;
const STALE_THRESHOLD_S = 60;

const ELAPSED_STYLE_NORMAL: React.CSSProperties = {
  marginLeft: 8,
  fontSize: "0.8em",
  fontVariantNumeric: "tabular-nums",
  color: "inherit",
  opacity: 0.6,
};
const ELAPSED_STYLE_STALE: React.CSSProperties = {
  marginLeft: 8,
  fontSize: "0.8em",
  fontVariantNumeric: "tabular-nums",
  color: "#f5a623",
  opacity: 1,
};

function ElapsedBadge({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startedAt) / 1000));
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const stale = elapsed >= STALE_THRESHOLD_S;
  return (
    <span
      className="session-card-elapsed"
      style={stale ? ELAPSED_STYLE_STALE : ELAPSED_STYLE_NORMAL}
      title={stale ? "Agent has been running for a while" : "Elapsed time"}
    >
      {label}
    </span>
  );
}

const ROLE_LABELS: Record<AgentRole, string> = {
  workforce_manager: "Workforce",
  project_manager: "PM",
  developer: "Developer",
  operator: "Operator",
  worker: "Worker",
  validator: "Validator",
  merge_agent: "Merge",
};

/** Execution phase labels for developer agents. */
const PHASE_LABELS: Record<string, string> = {
  planning: "Planning",
  implementing: "Implementing",
  testing: "Testing",
  finalizing: "Finalizing",
  revising: "Revising",
};

/** Phase badge colors. */
const PHASE_COLORS: Record<string, string> = {
  planning: "#6366f1",     // indigo
  implementing: "#f59e0b", // amber
  testing: "#10b981",      // emerald
  finalizing: "#8b5cf6",   // violet
  revising: "#ef4444",     // red
};

/** PM execution phase labels. */
const PM_PHASE_LABELS: Record<string, string> = {
  exploration: "Exploring",
  task_drafting: "Drafting Tasks",
  dependency_review: "Reviewing Deps",
  finalization: "Finalizing",
  revising: "Revising",
};

/** PM phase badge colors. */
const PM_PHASE_COLORS: Record<string, string> = {
  exploration: "#3b82f6",      // blue
  task_drafting: "#f59e0b",     // amber
  dependency_review: "#8b5cf6", // violet
  finalization: "#10b981",     // emerald
  revising: "#ef4444",         // red
};

/** WM execution phase labels. */
const WM_PHASE_LABELS: Record<string, string> = {
  initial: "Ready",
  project_setup: "Setting Up",
  planning: "Planning",
  executing: "Executing",
  monitoring: "Monitoring",
  intervening: "Intervening",
  concluding: "Wrapping Up",
};

/** WM phase badge colors. */
const WM_PHASE_COLORS: Record<string, string> = {
  initial: "#6b7280",        // gray
  project_setup: "#3b82f6",  // blue
  planning: "#f59e0b",       // amber
  executing: "#10b981",      // emerald
  monitoring: "#8b5cf6",     // violet
  intervening: "#ef4444",    // red
  concluding: "#06b6d4",     // cyan
};


interface ParsedPayload {
  role: AgentRole | null;
  executionPhase: string | null;
  pmPhase: string | null;
  wmPhase: string | null;
  status: string | null;
  sourcePromptId?: string;
  answer?: string;
  errorMessage?: string;
  toolActivity?: string;
  toolCalls?: Array<{ name: string; status: string }>;
  turnStartedAt?: number;
  task_id?: string;
  taskTitle?: string;
  taskType?: string;
  taskPriority?: number;
  taskDescription?: string;
}

const EMPTY_PAYLOAD: ParsedPayload = {
  role: null,
  executionPhase: null,
  pmPhase: null,
  wmPhase: null,
  status: null,
};

function parsePayload(payload: string | undefined): ParsedPayload {
  if (!payload) return EMPTY_PAYLOAD;
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    return {
      role: typeof p.role === "string" && Object.prototype.hasOwnProperty.call(ROLE_LABELS, p.role)
        ? p.role as AgentRole
        : null,
      executionPhase: typeof p.executionPhase === "string" && Object.prototype.hasOwnProperty.call(PHASE_LABELS, p.executionPhase)
        ? p.executionPhase
        : null,
      pmPhase: typeof p.pmExecutionPhase === "string" && Object.prototype.hasOwnProperty.call(PM_PHASE_LABELS, p.pmExecutionPhase)
        ? p.pmExecutionPhase
        : null,
      wmPhase: typeof p.wmPhase === "string" && Object.prototype.hasOwnProperty.call(WM_PHASE_LABELS, p.wmPhase)
        ? p.wmPhase
        : null,
      status: typeof p.status === "string" ? p.status : null,
      sourcePromptId: typeof p.sourcePromptId === "string" ? p.sourcePromptId : undefined,
      answer: typeof p.answer === "string" ? p.answer : undefined,
      errorMessage: typeof p.errorMessage === "string" ? p.errorMessage : undefined,
      toolActivity: typeof p.toolActivity === "string" ? p.toolActivity : undefined,
      toolCalls: Array.isArray(p.toolCalls) ? p.toolCalls as Array<{ name: string; status: string }> : undefined,
      turnStartedAt: typeof p.turnStartedAt === "number" ? p.turnStartedAt : undefined,
      task_id: typeof p.task_id === "string" ? p.task_id : undefined,
      taskTitle: typeof p.taskTitle === "string" ? p.taskTitle : undefined,
      taskType: typeof p.taskType === "string" ? p.taskType : undefined,
      taskPriority: typeof p.taskPriority === "number" ? p.taskPriority : undefined,
      taskDescription: typeof p.taskDescription === "string" ? p.taskDescription : undefined,
    };
  } catch {
    return EMPTY_PAYLOAD;
  }
}


/** Big colorful footer bar showing execution phase - visible when zoomed out */
function PhaseFooter({ phase, roleType }: { phase: string; roleType: "developer" | "pm" | "wm" }) {
  let label: string;
  let color: string;
  let title: string;

  if (roleType === "pm") {
    label = PM_PHASE_LABELS[phase] ?? phase;
    color = PM_PHASE_COLORS[phase] ?? "#6b7280";
    title = `PM phase: ${label}`;
  } else if (roleType === "wm") {
    label = WM_PHASE_LABELS[phase] ?? phase;
    color = WM_PHASE_COLORS[phase] ?? "#6b7280";
    title = `WM phase: ${label}`;
  } else {
    label = PHASE_LABELS[phase] ?? phase;
    color = PHASE_COLORS[phase] ?? "#6b7280";
    title = `Execution phase: ${label}`;
  }
  
  return (
    <div
      className="session-card-phase-footer"
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: 28,
        backgroundColor: color,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        fontSize: "0.85em",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        borderBottomLeftRadius: 8,
        borderBottomRightRadius: 8,
        zIndex: 10,
      }}
      title={title}
    >
      {label}
    </div>
  );
}

interface SessionCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onDragStart?: (nodeId: string, layout: SessionLayout) => void;
  onStop?: () => void;
  index: number;
  scale?: number;
}

function snap(v: number) {
  return Math.round(v / GRID_STEP) * GRID_STEP;
}

export const SessionCard = React.memo(function SessionCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  onStop,
  index,
  scale = 1,
}: SessionCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [liveLayout, setLiveLayout] = useState<SessionLayout | null>(null);
  /** True when user is near the bottom; false when they've scrolled up (show "Scroll to bottom"). */
  const [isAtBottom, setIsAtBottom] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
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
  const parsed = useMemo(() => parsePayload(layout.payload), [layout.payload]);

  const handlePointerDownDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("[data-resize-handle]"))
        return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setLiveLayout(layout);
      setIsDragging(true);
      onDragStart?.(layout.session_id, layout);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        layoutX: layout.x,
        layoutY: layout.y,
      };
    },
    [layout, onDragStart]
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

  React.useEffect(() => {
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
        if (edge.includes("e")) w = Math.max(SESSION_CARD_MIN_W, w + dx);
        if (edge.includes("w")) w = Math.max(SESSION_CARD_MIN_W, w - dx);
        if (edge.includes("s")) h = Math.max(SESSION_CARD_MIN_H, h + dy);
        if (edge.includes("n")) h = Math.max(SESSION_CARD_MIN_H, h - dy);
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

  const handleToggleCollapse = useCallback(() => {
    onLayoutChange({ ...layout, collapsed: !layout.collapsed });
    onLayoutCommit({ ...layout, collapsed: !layout.collapsed });
  }, [layout, onLayoutChange, onLayoutCommit]);

  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    if (parsed.status === "loading" || parsed.status === "done" || parsed.status === "in_review") {
      const nearBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - AUTO_SCROLL_THRESHOLD_PX;
      if (nearBottom) {
        el.scrollTop = el.scrollHeight;
        setIsAtBottom(true);
      }
      const rafId = requestAnimationFrame(() => {
        if (!bodyScrollRef.current || layoutRef.current.collapsed) return;
        const { scrollHeight, clientHeight } = bodyScrollRef.current;
        const curH = layoutRef.current.h;
        if (scrollHeight > clientHeight && curH < SESSION_CARD_MAX_H) {
          const newH = Math.min(curH + (scrollHeight - clientHeight), SESSION_CARD_MAX_H);
          const snapped = Math.round(newH / GRID_STEP) * GRID_STEP;
          if (snapped > curH) {
            const next = { ...layoutRef.current, h: snapped };
            onLayoutChangeRef.current(next);
            onLayoutCommitRef.current(next);
          }
        }
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [parsed.status, parsed.answer, layout.collapsed]);

  const handleBodyScroll = useCallback(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - AT_BOTTOM_THRESHOLD_PX;
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = bodyScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setIsAtBottom(true);
    }
  }, []);

  return (
    <div
      ref={cardRef}
      className="session-card"
      style={{
        position: "absolute",
        left: displayLayout.x,
        top: displayLayout.y,
        width: displayLayout.w,
        height: displayLayout.collapsed ? 48 : displayLayout.h,
        cursor: "default",
        ["--card-accent" as string]: cardColors.primary,
        ["--card-accent-muted" as string]: cardColors.secondary,
      }}
    >
      <div
        className="session-card-header"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDownDrag}
      >
        <span className="session-card-title">
          {parsed.role ? ROLE_LABELS[parsed.role] : `Agent ${index + 1}`}
        </span>
        <div className="session-card-header-actions">
          {parsed.status === "loading" && onStop && (
            <button
              type="button"
              className="session-card-stop"
              onClick={(e) => { e.stopPropagation(); onStop(); }}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label="Stop agent"
              title="Stop agent"
            >
              Stop
            </button>
          )}
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
      </div>
      {!layout.collapsed && (
        <>
          {parsed.task_id && (parsed.taskTitle || parsed.taskDescription) && (
            <div className="session-card-brief">
              <div className="session-card-brief__header">
                {parsed.taskType && (
                  <span className={`session-card-brief__type session-card-brief__type--${parsed.taskType}`}>
                    {parsed.taskType}
                  </span>
                )}
                <span className="session-card-brief__id">{parsed.task_id}</span>
                {parsed.taskPriority != null && (
                  <span className={`session-card-brief__priority session-card-brief__priority--p${parsed.taskPriority}`}>
                    P{parsed.taskPriority}
                  </span>
                )}
              </div>
              {parsed.taskTitle && (
                <div className="session-card-brief__title">{parsed.taskTitle}</div>
              )}
              {parsed.taskDescription && (
                <div className="session-card-brief__desc">{parsed.taskDescription.length > 200 ? parsed.taskDescription.slice(0, 200) + "..." : parsed.taskDescription}</div>
              )}
            </div>
          )}
          <div
            ref={bodyScrollRef}
            className="session-card-body"
            onScroll={handleBodyScroll}
            onPointerDown={(e) => {
              if (!(e.target as HTMLElement).closest("[data-resize-handle]"))
                e.stopPropagation();
            }}
            onPointerUp={(e) => {
              if ((e.target as HTMLElement).closest("[data-resize-handle]"))
                return;
              e.stopPropagation();
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {parsed.status === "loading" ? (
              <div className="session-card-response">
                <p className="session-card-response-loading">
                  {parsed.toolActivity || "Thinking\u2026"}
                  {parsed.turnStartedAt ? <ElapsedBadge startedAt={parsed.turnStartedAt} /> : null}
                </p>
                {parsed.toolCalls && parsed.toolCalls.length > 0 && (
                  <div className="session-card-tool-badges">
                    {parsed.toolCalls.map((tc, i) => (
                      <span key={i} className={`session-card-tool-badge session-card-tool-badge--${tc.status}`}>
                        {tc.name}: {tc.status}
                      </span>
                    ))}
                  </div>
                )}
                {parsed.answer ? (
                  <div className="session-card-response-text session-card-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {parsed.answer}
                    </ReactMarkdown>
                  </div>
                ) : null}
              </div>
            ) : parsed.status === "stopped" ? (
              <div className="session-card-response">
                <p className="session-card-response-stopped">Stopped</p>
                {parsed.answer ? (
                  <div className="session-card-response-text session-card-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {parsed.answer}
                    </ReactMarkdown>
                  </div>
                ) : null}
              </div>
            ) : parsed.status === "error" ? (
              <div className="session-card-response session-card-response-error">
                <p className="session-card-response-error-msg">
                  {parsed.errorMessage ?? "Error"}
                </p>
                {parsed.answer ? (
                  <div className="session-card-response-text session-card-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {parsed.answer}
                    </ReactMarkdown>
                  </div>
                ) : null}
              </div>
            ) : parsed.status === "in_review" ? (
              <div className="session-card-response">
                <p className="session-card-response-loading">
                  {parsed.toolActivity || "Awaiting validation\u2026"}
                </p>
                {parsed.answer ? (
                  <div className="session-card-response-text session-card-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {parsed.answer}
                    </ReactMarkdown>
                  </div>
                ) : null}
              </div>
            ) : parsed.status === "done" && parsed.answer != null ? (
              <div className="session-card-response">
                <div className="session-card-response-text session-card-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {parsed.answer}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="session-card-placeholder">
                Waiting for prompt\u2026
              </div>
            )}
            {!isAtBottom && (
              <button
                type="button"
                className="session-card-scroll-to-bottom"
                onClick={(e) => { e.stopPropagation(); scrollToBottom(); }}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="Scroll to bottom"
                title="Scroll to latest"
              >
                ↓ Bottom
              </button>
            )}
          </div>
          <div
            className="session-card-resize-handle se"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "se")}
            title="Drag to resize width and height"
            aria-label="Resize card"
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
          {parsed.role === "developer" && parsed.executionPhase && parsed.status !== "done" && (
            <PhaseFooter phase={parsed.executionPhase} roleType="developer" />
          )}
          {parsed.role === "project_manager" && parsed.pmPhase && parsed.status !== "done" && (
            <PhaseFooter phase={parsed.pmPhase} roleType="pm" />
          )}
          {parsed.role === "workforce_manager" && parsed.wmPhase && parsed.status !== "done" && (
            <PhaseFooter phase={parsed.wmPhase} roleType="wm" />
          )}
        </>
      )}
    </div>
  );
});
