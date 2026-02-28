import { useCallback, useRef, useState } from "react";

export interface ViewportState {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 2;
const SCALE_SENSITIVITY = 0.001;

export function useCanvasPanZoom(containerRef: React.RefObject<HTMLElement | null>) {
  const [viewport, setViewport] = useState<ViewportState>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const isPanning = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // Don't start panning when click originates inside a card — allow
      // native text selection and card-internal interactions instead.
      const target = e.target as HTMLElement;
      if (target.closest(".session-card, .prompt-card, .terminal-card, .browser-card")) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      isPanning.current = true;
      lastPointer.current = { x: e.clientX, y: e.clientY };
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isPanning.current) return;
      const dx = e.clientX - lastPointer.current.x;
      const dy = e.clientY - lastPointer.current.y;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      setViewport((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    },
    []
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!isPanning.current) return;
    isPanning.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Pointer was not captured (e.g. event bubbled from a card)
    }
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // If the wheel happened over a scrollable element (e.g. Agent text area),
      // do not zoom the canvas — let the element scroll instead.
      let node: HTMLElement | null = e.target as HTMLElement;
      while (node && node !== container) {
        const style = getComputedStyle(node);
        const oy = style.overflowY;
        const ox = style.overflowX;
        const o = style.overflow;
        const scrollableY =
          (oy === "auto" || oy === "scroll" || o === "auto" || o === "scroll") &&
          node.scrollHeight > node.clientHeight;
        const scrollableX =
          (ox === "auto" || ox === "scroll" || o === "auto" || o === "scroll") &&
          node.scrollWidth > node.clientWidth;
        if (scrollableY || scrollableX) {
          return;
        }
        node = node.parentElement;
      }

      e.preventDefault();
      const rect = container.getBoundingClientRect();
      // Canvas-stage has left:50% top:50%, so its (0,0) is at container center. Use center-relative coords.
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const cursorX = e.clientX - rect.left - centerX;
      const cursorY = e.clientY - rect.top - centerY;

      const delta = -e.deltaY * SCALE_SENSITIVITY;
      setViewport((v) => {
        const newScale = clampScale(v.scale + delta);
        const scaleFactor = newScale / v.scale;
        // Keep the point under the cursor fixed in canvas space.
        return {
          scale: newScale,
          x: cursorX + (v.x - cursorX) * scaleFactor,
          y: cursorY + (v.y - cursorY) * scaleFactor,
        };
      });
    },
    [containerRef]
  );

  const transformStyle = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;

  return {
    viewport,
    setViewport,
    transformStyle,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleWheel,
  };
}
