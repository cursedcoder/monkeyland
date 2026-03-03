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

/** Only auto-scroll when user is within this many px of the bottom (lets them read without being yanked down). */
const AUTO_SCROLL_THRESHOLD_PX = 80;
/** Consider "at bottom" for showing/hiding the scroll-to-bottom button. */
const AT_BOTTOM_THRESHOLD_PX = 24;
/** Threshold in seconds after which the elapsed timer turns amber. */
const STALE_THRESHOLD_S = 60;

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
      style={{
        marginLeft: 8,
        fontSize: "0.8em",
        fontVariantNumeric: "tabular-nums",
        color: stale ? "#f5a623" : "inherit",
        opacity: stale ? 1 : 0.6,
      }}
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


function parseRole(payload: string | undefined): AgentRole | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as { role?: string };
    if (p.role && Object.prototype.hasOwnProperty.call(ROLE_LABELS, p.role))
      return p.role as AgentRole;
  } catch {
    /* ignore */
  }
  return null;
}

function parsePhase(payload: string | undefined): string | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as { executionPhase?: string };
    if (p.executionPhase && Object.prototype.hasOwnProperty.call(PHASE_LABELS, p.executionPhase))
      return p.executionPhase;
  } catch {
    /* ignore */
  }
  return null;
}

function parsePMPhase(payload: string | undefined): string | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as { pmExecutionPhase?: string };
    if (p.pmExecutionPhase && Object.prototype.hasOwnProperty.call(PM_PHASE_LABELS, p.pmExecutionPhase))
      return p.pmExecutionPhase;
  } catch {
    /* ignore */
  }
  return null;
}

function parseWMPhase(payload: string | undefined): string | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as { wmPhase?: string };
    if (p.wmPhase && Object.prototype.hasOwnProperty.call(WM_PHASE_LABELS, p.wmPhase))
      return p.wmPhase;
  } catch {
    /* ignore */
  }
  return null;
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

export function SessionCard({
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

  // Auto-scroll to bottom only when user is already near bottom (lets them scroll up to read)
  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    try {
      const p = JSON.parse(layout.payload ?? "{}") as {
        status?: string;
        answer?: string;
      };
      if (p.status === "loading" || p.status === "done" || p.status === "in_review") {
        const nearBottom =
          el.scrollTop + el.clientHeight >= el.scrollHeight - AUTO_SCROLL_THRESHOLD_PX;
        if (nearBottom) {
          el.scrollTop = el.scrollHeight;
          setIsAtBottom(true);
        }
        // Auto-grow card height when content overflows (up to SESSION_CARD_MAX_H)
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
    } catch {
      /* ignore */
    }
  }, [layout.payload, layout.collapsed]);

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
          {parseRole(layout.payload) ? ROLE_LABELS[parseRole(layout.payload)!] : `Agent ${index + 1}`}
        </span>
        <div className="session-card-header-actions">
          {(() => {
            try {
              const p = JSON.parse(layout.payload ?? "{}") as { status?: string };
              if (p.status === "loading" && onStop) {
                return (
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
                );
              }
            } catch { /* ignore */ }
            return null;
          })()}
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
          {(() => {
            try {
              const p = JSON.parse(layout.payload ?? "{}") as {
                task_id?: string; taskTitle?: string; taskType?: string;
                taskPriority?: number; taskDescription?: string; role?: string;
              };
              const showBrief = p.task_id && (p.taskTitle || p.taskDescription);
              if (showBrief) {
                return (
                  <div className="session-card-brief">
                    <div className="session-card-brief__header">
                      {p.taskType && (
                        <span className={`session-card-brief__type session-card-brief__type--${p.taskType}`}>
                          {p.taskType}
                        </span>
                      )}
                      <span className="session-card-brief__id">{p.task_id}</span>
                      {p.taskPriority != null && (
                        <span className={`session-card-brief__priority session-card-brief__priority--p${p.taskPriority}`}>
                          P{p.taskPriority}
                        </span>
                      )}
                    </div>
                    {p.taskTitle && (
                      <div className="session-card-brief__title">{p.taskTitle}</div>
                    )}
                    {p.taskDescription && (
                      <div className="session-card-brief__desc">{p.taskDescription.length > 200 ? p.taskDescription.slice(0, 200) + "..." : p.taskDescription}</div>
                    )}
                  </div>
                );
              }
            } catch { /* */ }
            return null;
          })()}
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
            {(() => {
            try {
              const p = JSON.parse(layout.payload ?? "{}") as {
                sourcePromptId?: string;
                status?: string;
                answer?: string;
                errorMessage?: string;
                toolActivity?: string;
                turnStartedAt?: number;
              };
              if (p.status === "loading") {
                return (
                  <div className="session-card-response">
                    <p className="session-card-response-loading">
                      {p.toolActivity || "Thinking\u2026"}
                      {p.turnStartedAt ? <ElapsedBadge startedAt={p.turnStartedAt} /> : null}
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
              if (p.status === "stopped") {
                return (
                  <div className="session-card-response">
                    <p className="session-card-response-stopped">Stopped</p>
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
              if (p.status === "in_review") {
                return (
                  <div className="session-card-response">
                    <p className="session-card-response-loading">
                      {p.toolActivity || "Awaiting validation\u2026"}
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
          {/* Phase footer for developer, PM, and WM agents */}
          {parseRole(layout.payload) === "developer" && parsePhase(layout.payload) && (
            <PhaseFooter phase={parsePhase(layout.payload)!} roleType="developer" />
          )}
          {parseRole(layout.payload) === "project_manager" && parsePMPhase(layout.payload) && (
            <PhaseFooter phase={parsePMPhase(layout.payload)!} roleType="pm" />
          )}
          {parseRole(layout.payload) === "workforce_manager" && parseWMPhase(layout.payload) && (
            <PhaseFooter phase={parseWMPhase(layout.payload)!} roleType="wm" />
          )}
        </>
      )}
    </div>
  );
}
