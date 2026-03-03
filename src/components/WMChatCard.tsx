import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SessionLayout } from "../types";
import { GRID_STEP } from "../types";
import { cardColorsFromId } from "../utils/cardColors";

/** WM conversation phases */
export type WMPhase =
  | "initial"
  | "project_setup"
  | "planning"
  | "executing"
  | "monitoring"
  | "intervening"
  | "concluding";

const WM_PHASE_LABELS: Record<WMPhase, string> = {
  initial: "Ready",
  project_setup: "Setting Up",
  planning: "Planning",
  executing: "Executing",
  monitoring: "Monitoring",
  intervening: "Intervening",
  concluding: "Wrapping Up",
};

const WM_PHASE_COLORS: Record<WMPhase, string> = {
  initial: "#6b7280",
  project_setup: "#3b82f6",
  planning: "#f59e0b",
  executing: "#10b981",
  monitoring: "#8b5cf6",
  intervening: "#ef4444",
  concluding: "#06b6d4",
};

export interface WMChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: Array<{ name: string; status: string }>;
}

function snap(v: number) {
  return Math.round(v / GRID_STEP) * GRID_STEP;
}

const WM_CHAT_CARD_MIN_W = 400;
const WM_CHAT_CARD_MIN_H = 360;

interface WMChatCardProps {
  layout: SessionLayout;
  messages: WMChatMessage[];
  wmPhase: WMPhase;
  isProcessing: boolean;
  taskProgress: { done: number; total: number };
  orchStatus: "running" | "paused" | "idle";
  onSendMessage: (text: string) => void;
  onPause: () => void;
  onResume: () => void;
  onCancelAll: () => void;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onDragStart?: (nodeId: string, layout: SessionLayout) => void;
  scale?: number;
}

export function WMChatCard({
  layout,
  messages,
  wmPhase,
  isProcessing,
  taskProgress,
  orchStatus,
  onSendMessage,
  onPause,
  onResume,
  onCancelAll,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  scale = 1,
}: WMChatCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [liveLayout, setLiveLayout] = useState<SessionLayout | null>(null);
  const [inputText, setInputText] = useState("");
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showConfirmDialog, setShowConfirmDialog] = useState<"cancel_all" | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastEmittedLayout = useRef<SessionLayout>(layout);
  const cardColors = useMemo(() => cardColorsFromId(layout.session_id), [layout.session_id]);

  const dragStart = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, edge: "" as string });
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
        if (edge.includes("e")) w = Math.max(WM_CHAT_CARD_MIN_W, w + dx);
        if (edge.includes("w")) w = Math.max(WM_CHAT_CARD_MIN_W, w - dx);
        if (edge.includes("s")) h = Math.max(WM_CHAT_CARD_MIN_H, h + dy);
        if (edge.includes("n")) h = Math.max(WM_CHAT_CARD_MIN_H, h - dy);
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

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (isAtBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isAtBottom]);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = messagesRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setIsAtBottom(true);
    }
  }, []);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isProcessing) return;
    onSendMessage(text);
    setInputText("");
  }, [inputText, isProcessing, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleCancelAllClick = useCallback(() => {
    setShowConfirmDialog("cancel_all");
  }, []);

  const handleConfirmCancelAll = useCallback(() => {
    onCancelAll();
    setShowConfirmDialog(null);
  }, [onCancelAll]);

  const handleDismissDialog = useCallback(() => {
    setShowConfirmDialog(null);
  }, []);

  return (
    <div
      ref={cardRef}
      className="wm-chat-card"
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
      {/* Header */}
      <div
        className="wm-chat-card-header"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDownDrag}
      >
        <div className="wm-chat-card-header-left">
          <span className="wm-chat-card-title">Workforce Manager</span>
          <span
            className="wm-chat-card-phase-badge"
            style={{ backgroundColor: WM_PHASE_COLORS[wmPhase] }}
          >
            {WM_PHASE_LABELS[wmPhase]}
          </span>
        </div>
        <div className="wm-chat-card-header-right">
          {taskProgress.total > 0 && (
            <span className="wm-chat-card-progress">
              {taskProgress.done}/{taskProgress.total} tasks
            </span>
          )}
          <span
            className={`wm-chat-card-orch-status wm-chat-card-orch-status--${orchStatus}`}
          >
            {orchStatus === "running" ? "Running" : orchStatus === "paused" ? "Paused" : "Idle"}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={messagesRef}
        className="wm-chat-card-messages"
        onScroll={handleMessagesScroll}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {messages.length === 0 && !isProcessing && (
          <div className="wm-chat-card-empty">
            Start a conversation with the Workforce Manager
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`wm-chat-card-message wm-chat-card-message--${msg.role}`}
          >
            <div className="wm-chat-card-message-avatar">
              {msg.role === "user" ? "You" : "WM"}
            </div>
            <div className="wm-chat-card-message-content">
              {msg.role === "assistant" ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.content}
                </ReactMarkdown>
              ) : (
                <p>{msg.content}</p>
              )}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="wm-chat-card-message-tools">
                  {msg.toolCalls.map((tc, i) => (
                    <span key={i} className="wm-chat-card-tool-badge">
                      {tc.name}: {tc.status}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {isProcessing && (
          <div className="wm-chat-card-message wm-chat-card-message--assistant wm-chat-card-message--processing">
            <div className="wm-chat-card-message-avatar">WM</div>
            <div className="wm-chat-card-message-content">
              <div className="wm-chat-card-typing">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}
        {!isAtBottom && (
          <button
            type="button"
            className="wm-chat-card-scroll-btn"
            onClick={scrollToBottom}
          >
            Scroll to bottom
          </button>
        )}
      </div>

      {/* Quick Actions */}
      <div className="wm-chat-card-actions" onPointerDown={(e) => e.stopPropagation()}>
        {orchStatus === "running" ? (
          <button type="button" onClick={onPause} className="wm-chat-card-action-btn">
            Pause
          </button>
        ) : orchStatus === "paused" ? (
          <button type="button" onClick={onResume} className="wm-chat-card-action-btn">
            Resume
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleCancelAllClick}
          className="wm-chat-card-action-btn wm-chat-card-action-btn--danger"
          disabled={orchStatus === "idle"}
        >
          Cancel All
        </button>
      </div>

      {/* Confirmation Dialog */}
      {showConfirmDialog === "cancel_all" && (
        <div className="wm-chat-card-dialog-overlay" onPointerDown={(e) => e.stopPropagation()}>
          <div className="wm-chat-card-dialog">
            <div className="wm-chat-card-dialog-title">Cancel All Agents?</div>
            <div className="wm-chat-card-dialog-message">
              This will stop all running agents and cancel their tasks. This action cannot be undone.
            </div>
            <div className="wm-chat-card-dialog-actions">
              <button
                type="button"
                className="wm-chat-card-dialog-btn wm-chat-card-dialog-btn--secondary"
                onClick={handleDismissDialog}
              >
                Keep Working
              </button>
              <button
                type="button"
                className="wm-chat-card-dialog-btn wm-chat-card-dialog-btn--danger"
                onClick={handleConfirmCancelAll}
              >
                Yes, Cancel All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="wm-chat-card-input-area" onPointerDown={(e) => e.stopPropagation()}>
        <textarea
          ref={inputRef}
          className="wm-chat-card-input"
          placeholder={isProcessing ? "WM is thinking..." : "Type a message..."}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isProcessing}
        />
        <button
          type="button"
          className="wm-chat-card-send-btn"
          onClick={handleSend}
          disabled={isProcessing || !inputText.trim()}
        >
          Send
        </button>
      </div>

      {/* Resize handles */}
      <div
        className="wm-chat-card-resize-handle se"
        data-resize-handle
        onPointerDown={(e) => handlePointerDownResize(e, "se")}
        title="Drag to resize"
        aria-label="Resize card"
      />
      <div
        className="wm-chat-card-resize-handle s"
        data-resize-handle
        onPointerDown={(e) => handlePointerDownResize(e, "s")}
      />
      <div
        className="wm-chat-card-resize-handle e"
        data-resize-handle
        onPointerDown={(e) => handlePointerDownResize(e, "e")}
      />
    </div>
  );
}
