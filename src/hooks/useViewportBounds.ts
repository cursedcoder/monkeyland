import { useCallback, useEffect, useState } from "react";

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Given container rect, viewport (x, y, scale), compute the visible world bounds
 * in canvas (untransformed) coordinates.
 */
export function useViewportBounds(
  containerRef: React.RefObject<HTMLElement | null>,
  viewport: { x: number; y: number; scale: number }
): Bounds | null {
  const [bounds, setBounds] = useState<Bounds | null>(null);

  const update = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { x, y, scale } = viewport;
    const left = (-x - rect.width / 2) / scale;
    const top = (-y - rect.height / 2) / scale;
    const width = rect.width / scale;
    const height = rect.height / scale;
    setBounds({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    });
  }, [containerRef, viewport.x, viewport.y, viewport.scale]);

  useEffect(() => {
    update();
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef, update]);

  return bounds;
}

export function rectIntersects(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
  margin: number
): boolean {
  return (
    a.left - margin < b.right &&
    a.right + margin > b.left &&
    a.top - margin < b.bottom &&
    a.bottom + margin > b.top
  );
}
