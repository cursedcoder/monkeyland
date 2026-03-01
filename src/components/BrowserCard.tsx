import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionLayout } from "../types";
import {
  BROWSER_CARD_MIN_W,
  BROWSER_CARD_MIN_H,
  GRID_STEP,
} from "../types";
import { cardColorsFromId } from "../utils/cardColors";

interface BrowserCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onDragStart?: (nodeId: string, layout: SessionLayout) => void;
  scale?: number;
}

function snap(v: number) {
  return Math.round(v / GRID_STEP) * GRID_STEP;
}

function parseBrowserPayload(payload?: string): {
  parentAgentId?: string;
  browserPort?: number;
} {
  if (!payload) return {};
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

// Map DOM key values to Playwright-compatible key names
const KEY_MAP: Record<string, string> = {
  " ": "Space",
  "ArrowUp": "ArrowUp",
  "ArrowDown": "ArrowDown",
  "ArrowLeft": "ArrowLeft",
  "ArrowRight": "ArrowRight",
  "Backspace": "Backspace",
  "Delete": "Delete",
  "Enter": "Enter",
  "Escape": "Escape",
  "Tab": "Tab",
  "Home": "Home",
  "End": "End",
  "PageUp": "PageUp",
  "PageDown": "PageDown",
};

function toPlaywrightKey(e: KeyboardEvent): string {
  if (KEY_MAP[e.key]) return KEY_MAP[e.key];
  if (e.key.length === 1) return e.key;
  return e.key;
}

export function BrowserCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  scale = 1,
}: BrowserCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [liveLayout, setLiveLayout] = useState<SessionLayout | null>(null);
  const [frameUrl, setFrameUrl] = useState("about:blank");
  const [frameTitle, setFrameTitle] = useState("");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [addressValue, setAddressValue] = useState("");
  const [, setIsFocused] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const lastEmittedLayout = useRef<SessionLayout>(layout);
  const cardColors = useMemo(() => cardColorsFromId(layout.session_id), [layout.session_id]);
  const dragStart = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, edge: "" as string });
  const captureTargetRef = useRef<{ el: HTMLElement; pointerId: number } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  /** Server viewport size; must match what we send via set-viewport so click/hover coords are correct. */
  const viewportSizeRef = useRef({ w: 1280, h: 720 });
  const layoutRef = useRef(layout);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const onLayoutCommitRef = useRef(onLayoutCommit);
  const setLiveLayoutRef = useRef(setLiveLayout);
  layoutRef.current = layout;
  onLayoutChangeRef.current = onLayoutChange;
  onLayoutCommitRef.current = onLayoutCommit;
  setLiveLayoutRef.current = setLiveLayout;
  const displayLayout = liveLayout ?? layout;

  const { browserPort } = parseBrowserPayload(layout.payload);

  // --- Screencast SSE ---
  useEffect(() => {
    if (!browserPort || layout.collapsed) return;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const url = `http://127.0.0.1:${browserPort}/session/${layout.session_id}/screencast`;
      es = new EventSource(url);
      eventSourceRef.current = es;

      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { data?: string; url?: string; title?: string };
          if (msg.data) setFrameSrc(`data:image/jpeg;base64,${msg.data}`);
          if (msg.url) setFrameUrl(msg.url);
          if (msg.title !== undefined) setFrameTitle(msg.title);
        } catch { /* ignore */ }
      };

      es.onerror = () => {
        es?.close();
        eventSourceRef.current = null;
        if (!cancelled) retryTimer = setTimeout(connect, 1000);
      };
    }

    connect();
    return () => {
      cancelled = true;
      es?.close();
      eventSourceRef.current = null;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [browserPort, layout.session_id, layout.collapsed]);

  // Sync server viewport once per session so coordinate mapping matches card size (e.g. restored layout)
  const syncedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!browserPort || layout.collapsed || syncedSessionRef.current === layout.session_id) return;
    syncedSessionRef.current = layout.session_id;
    const contentH = Math.round(Math.max(200, layout.h - 68));
    const width = Math.min(1920, Math.max(320, Math.round(layout.w)));
    const height = Math.min(1080, contentH);
    viewportSizeRef.current = { w: width, h: height };
    fetch(
      `http://127.0.0.1:${browserPort}/session/${layout.session_id}/set-viewport`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width, height }),
      }
    ).catch((err) => console.warn("[BrowserCard] set-viewport sync failed:", err));
  }, [browserPort, layout.session_id, layout.w, layout.h, layout.collapsed]);

  // Keep address bar in sync when not being edited
  useEffect(() => {
    if (document.activeElement !== addressInputRef.current) {
      setAddressValue(frameUrl);
    }
  }, [frameUrl]);

  // --- Drag ---
  const handlePointerDownDrag = useCallback(
    (e: React.PointerEvent) => {
      if (
        e.button !== 0 ||
        (e.target as HTMLElement).closest("[data-resize-handle]") ||
        (e.target as HTMLElement).closest("[data-no-drag]")
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      captureTargetRef.current = { el, pointerId: e.pointerId };
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
    [layout, onDragStart],
  );

  // --- Resize ---
  const handlePointerDownResize = useCallback(
    (e: React.PointerEvent, edge: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return;
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      captureTargetRef.current = { el, pointerId: e.pointerId };
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
    [layout.w, layout.h],
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
        if (edge.includes("e")) w = Math.max(BROWSER_CARD_MIN_W, w + dx);
        if (edge.includes("w")) w = Math.max(BROWSER_CARD_MIN_W, w - dx);
        if (edge.includes("s")) h = Math.max(BROWSER_CARD_MIN_H, h + dy);
        if (edge.includes("n")) h = Math.max(BROWSER_CARD_MIN_H, h - dy);
        const next = { ...currentLayout, w: snap(w), h: snap(h) };
        lastEmittedLayout.current = next;
        setLiveLayoutRef.current(next);
        onLayoutChangeRef.current(next);
      }
    };

    const onUp = () => {
      const cap = captureTargetRef.current;
      if (cap) {
        try { cap.el.releasePointerCapture(cap.pointerId); } catch { /* already released */ }
        captureTargetRef.current = null;
      }
      const wasResizing = isResizing;
      const committed = lastEmittedLayout.current;
      setLiveLayoutRef.current(null);
      setIsDragging(false);
      setIsResizing(false);
      onLayoutCommitRef.current(committed);
      if (wasResizing && browserPortRef.current) {
        const contentH = Math.round(Math.max(200, committed.h - 68));
        const width = Math.min(1920, Math.max(320, Math.round(committed.w)));
        const height = Math.min(1080, contentH);
        viewportSizeRef.current = { w: width, h: height };
        fetch(`http://127.0.0.1:${browserPortRef.current}/session/${sessionIdRef.current}/set-viewport`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ width, height }),
        }).catch((err) => console.warn("[BrowserCard] set-viewport failed:", err));
      }
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

  // --- Viewport coord mapping ---
  const imgRef = useRef<HTMLImageElement>(null);
  const [frameOverlayNode, setFrameOverlayNode] = useState<HTMLDivElement | null>(null);
  const handleOverlayRef = useCallback((node: HTMLDivElement | null) => {
    setFrameOverlayNode(node);
  }, []);

  function toViewportCoords(clientX: number, clientY: number): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    const imgW = rect.width;
    const imgH = rect.height;
    if (imgW === 0 || imgH === 0) return null;
    const { w: vpW, h: vpH } = viewportSizeRef.current;
    const scaleX = imgW / vpW;
    const scaleY = imgH / vpH;
    const s = Math.min(scaleX, scaleY);
    const renderedW = vpW * s;
    const renderedH = vpH * s;
    const offsetX = (imgW - renderedW) / 2;
    const offsetY = (imgH - renderedH) / 2;
    const relX = clientX - rect.left - offsetX;
    const relY = clientY - rect.top - offsetY;
    if (relX < 0 || relY < 0 || relX > renderedW || relY > renderedH) return null;
    return { x: Math.round(relX / s), y: Math.round(relY / s) };
  }

  // --- Server helpers (use refs for stable closures) ---
  const browserPortRef = useRef(browserPort);
  browserPortRef.current = browserPort;
  const sessionIdRef = useRef(layout.session_id);
  sessionIdRef.current = layout.session_id;

  function serverUrl(action: string) {
    return `http://127.0.0.1:${browserPortRef.current}/session/${sessionIdRef.current}/${action}`;
  }

  function postMouseEvent(payload: Record<string, unknown>) {
    const port = browserPortRef.current;
    if (!port) return;
    fetch(serverUrl("mouse-event"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => console.warn("[BrowserCard] mouse-event failed:", err));
  }

  function postKeyEvent(payload: Record<string, unknown>) {
    const port = browserPortRef.current;
    if (!port) return;
    fetch(serverUrl("key-event"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => console.warn("[BrowserCard] key-event failed:", err));
  }

  // --- Native DOM listeners for pointer, wheel, keyboard ---
  useEffect(() => {
    const overlay = frameOverlayNode;
    if (!overlay) return;
    const overlayEl = overlay;

    let downPos: { x: number; y: number; button: number } | null = null;
    let lastMoveTs = 0;

    function onPointerDown(e: PointerEvent) {
      e.stopPropagation();
      overlayEl.setPointerCapture(e.pointerId);
      overlayEl.focus({ preventScroll: true });
      downPos = { x: e.clientX, y: e.clientY, button: e.button };
    }

    function onPointerUp(e: PointerEvent) {
      e.stopPropagation();
      const d = downPos;
      downPos = null;
      if (!d) return;
      const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (dist > 5) return;
      const coords = toViewportCoords(e.clientX, e.clientY);
      if (!coords) return;
      const btn = d.button === 2 ? 2 : d.button === 1 ? 1 : 0;
      postMouseEvent({ type: "click", x: coords.x, y: coords.y, button: btn });
    }

    function onPointerMove(e: PointerEvent) {
      const now = Date.now();
      if (now - lastMoveTs < 50) return;
      lastMoveTs = now;
      const coords = toViewportCoords(e.clientX, e.clientY);
      if (coords) {
        postMouseEvent({ type: "mousemove", x: coords.x, y: coords.y, button: 0 });
      }
    }

    function onWheel(e: WheelEvent) {
      e.stopPropagation();
      e.preventDefault();
      const coords = toViewportCoords(e.clientX, e.clientY);
      if (coords) {
        postMouseEvent({
          type: "wheel",
          x: coords.x,
          y: coords.y,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
        });
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      e.stopPropagation();
      e.preventDefault();
      const key = toPlaywrightKey(e);
      if (e.metaKey || e.ctrlKey) {
        // Pass modifier combos as a press (e.g. Ctrl+A)
        const mod = e.metaKey ? "Meta+" : "Control+";
        postKeyEvent({ type: "keypress", key: `${mod}${key}` });
      } else {
        postKeyEvent({ type: "keydown", key });
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      e.stopPropagation();
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) return;
      postKeyEvent({ type: "keyup", key: toPlaywrightKey(e) });
    }

    overlayEl.addEventListener("pointerdown", onPointerDown);
    overlayEl.addEventListener("pointerup", onPointerUp);
    overlayEl.addEventListener("pointermove", onPointerMove);
    overlayEl.addEventListener("wheel", onWheel, { passive: false });
    overlayEl.addEventListener("keydown", onKeyDown);
    overlayEl.addEventListener("keyup", onKeyUp);

    return () => {
      overlayEl.removeEventListener("pointerdown", onPointerDown);
      overlayEl.removeEventListener("pointerup", onPointerUp);
      overlayEl.removeEventListener("pointermove", onPointerMove);
      overlayEl.removeEventListener("wheel", onWheel);
      overlayEl.removeEventListener("keydown", onKeyDown);
      overlayEl.removeEventListener("keyup", onKeyUp);
    };
  }, [frameOverlayNode]);

  // --- Nav actions ---
  function navAction(action: string) {
    if (!browserPort) return;
    fetch(serverUrl(action), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json())
      .then((d: { url?: string; title?: string }) => {
        if (d.url) setFrameUrl(d.url);
        if (d.title) setFrameTitle(d.title);
      })
      .catch((err) => console.warn(`[BrowserCard] ${action} failed:`, err));
  }

  function handleAddressSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!browserPort) return;
    let url = addressValue.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    fetch(serverUrl("navigate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
      .then((r) => r.json())
      .then((d: { url?: string; title?: string }) => {
        if (d.url) setFrameUrl(d.url);
        if (d.title) setFrameTitle(d.title);
        addressInputRef.current?.blur();
      })
      .catch((err) => console.warn("[BrowserCard] navigate failed:", err));
  }

  return (
    <div
      ref={cardRef}
      className="browser-card"
      style={{
        position: "absolute",
        left: displayLayout.x,
        top: displayLayout.y,
        width: displayLayout.w,
        height: displayLayout.collapsed ? 32 : displayLayout.h,
        cursor: "default",
        ["--card-accent" as string]: cardColors.primary,
        ["--card-accent-muted" as string]: cardColors.secondary,
      }}
    >
      {/* Title bar (draggable) */}
      <div
        className="browser-card-header"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onPointerDown={handlePointerDownDrag}
      >
        <span className="browser-card-title">
          {frameTitle || "Browser"}
        </span>
        <span className="browser-card-url-hint" title={frameUrl}>
          {frameUrl !== "about:blank" ? new URL(frameUrl).hostname : ""}
        </span>
        <button
          type="button"
          className="browser-card-collapse"
          onClick={handleToggleCollapse}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={layout.collapsed ? "Expand" : "Collapse"}
        >
          {layout.collapsed ? "\u25B6" : "\u25BC"}
        </button>
      </div>

      {!layout.collapsed && (
        <>
          {/* Navigation bar */}
          <div
            className="browser-card-navbar"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="browser-card-nav-btn"
              onClick={() => navAction("go-back")}
              title="Back"
              data-no-drag
            >
              &#x276E;
            </button>
            <button
              type="button"
              className="browser-card-nav-btn"
              onClick={() => navAction("go-forward")}
              title="Forward"
              data-no-drag
            >
              &#x276F;
            </button>
            <button
              type="button"
              className="browser-card-nav-btn"
              onClick={() => navAction("reload")}
              title="Reload"
              data-no-drag
            >
              &#x21BB;
            </button>
            <form
              className="browser-card-address-form"
              onSubmit={handleAddressSubmit}
            >
              <input
                ref={addressInputRef}
                className="browser-card-address"
                type="text"
                value={addressValue}
                onChange={(e) => setAddressValue(e.target.value)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => {
                  setIsFocused(false);
                  setAddressValue(frameUrl);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                spellCheck={false}
                data-no-drag
              />
            </form>
          </div>

          {/* Body */}
          <div
            className="browser-card-body"
            onPointerDown={(e) => {
              if (!(e.target as HTMLElement).closest("[data-resize-handle]"))
                e.stopPropagation();
            }}
            onPointerUp={(e) => {
              if ((e.target as HTMLElement).closest("[data-resize-handle]"))
                return;
              e.stopPropagation();
            }}
          >
            {frameSrc ? (
              <div style={{ position: "relative", width: "100%", height: "100%" }}>
                <img
                  ref={imgRef}
                  className="browser-card-frame"
                  src={frameSrc}
                  alt="Browser view"
                  draggable={false}
                  style={{ pointerEvents: "none" }}
                />
                <div
                  ref={handleOverlayRef}
                  className="browser-card-overlay"
                  tabIndex={0}
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => setIsFocused(false)}
                />
              </div>
            ) : (
              <div
                className="browser-card-placeholder"
                onWheel={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                Waiting for browser...
              </div>
            )}
          </div>
          {/* Resize handle: direct child of card so overlay never covers it */}
          <div
            className="browser-card-resize-handle browser-card-resize-handle-se"
            data-resize-handle
            onPointerDown={(e) => handlePointerDownResize(e, "se")}
            title="Drag to resize"
            aria-label="Resize card"
          />
        </>
      )}
    </div>
  );
}
