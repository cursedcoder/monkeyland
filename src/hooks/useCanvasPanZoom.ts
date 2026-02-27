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
    if (e.button === 0) {
      isPanning.current = false;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const mouseX = e.clientX - cx;
      const mouseY = e.clientY - cy;

      const delta = -e.deltaY * SCALE_SENSITIVITY;
      setViewport((v) => {
        const newScale = clampScale(v.scale + delta);
        const scaleFactor = newScale / v.scale;
        return {
          scale: newScale,
          x: v.x + mouseX * (1 - scaleFactor),
          y: v.y + mouseY * (1 - scaleFactor),
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
