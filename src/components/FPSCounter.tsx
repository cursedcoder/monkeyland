import { useEffect, useRef, useState } from "react";
import "./FPSCounter.css";

const SAMPLE_MS = 500;
const MAX_SAMPLES = 30;

export function FPSCounter() {
  const [fps, setFps] = useState<number | null>(null);
  const frameTimes = useRef<number[]>([]);
  const lastTime = useRef<number>(0);
  const rafId = useRef<number>(0);

  useEffect(() => {
    let running = true;

    const tick = (now: number) => {
      if (!running) return;
      if (lastTime.current > 0) {
        const delta = now - lastTime.current;
        frameTimes.current.push(delta);
        if (frameTimes.current.length > MAX_SAMPLES) frameTimes.current.shift();
      }
      lastTime.current = now;
      rafId.current = requestAnimationFrame(tick);
    };

    const intervalId = setInterval(() => {
      if (frameTimes.current.length === 0) return;
      const sum = frameTimes.current.reduce((a, b) => a + b, 0);
      const avg = sum / frameTimes.current.length;
      const fpsValue = avg > 0 ? Math.round(1000 / avg) : 0;
      setFps(Math.min(fpsValue, 120));
    }, SAMPLE_MS);

    rafId.current = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(rafId.current);
      clearInterval(intervalId);
    };
  }, []);

  if (fps === null) return null;

  return (
    <div className="fps-counter" title="Frames per second">
      <span className="fps-counter__label">FPS</span>
      <span className="fps-counter__value">{fps}</span>
    </div>
  );
}
