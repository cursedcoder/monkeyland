import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./GlobalControls.css";

type OrchState = "idle" | "running" | "paused";

function fromRaw(raw: number): OrchState {
  if (raw === 1) return "running";
  if (raw === 2) return "paused";
  return "idle";
}

interface GlobalControlsProps {
  onStopAll: () => void;
}

export function GlobalControls({ onStopAll }: GlobalControlsProps) {
  const [state, setState] = useState<OrchState>("idle");

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const raw = await invoke<number>("orch_get_state");
        if (!cancelled) setState(fromRaw(raw));
      } catch { /* not ready */ }
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  const handleStart = useCallback(async () => {
    try {
      await invoke("orch_start");
      setState("running");
    } catch (e) {
      console.warn("orch_start failed:", e);
    }
  }, []);

  const handlePause = useCallback(async () => {
    try {
      await invoke("orch_pause");
      setState("paused");
    } catch (e) {
      console.warn("orch_pause failed:", e);
    }
  }, []);

  const handleContinue = useCallback(async () => {
    try {
      await invoke("orch_start");
      setState("running");
    } catch (e) {
      console.warn("orch_start failed:", e);
    }
  }, []);

  const handleStop = useCallback(async () => {
    try {
      await invoke("orch_pause");
      setState("paused");
    } catch (e) { /* */ }
    onStopAll();
  }, [onStopAll]);

  return (
    <div className="global-controls">
      {state === "idle" && (
        <button
          type="button"
          className="global-controls__btn global-controls__btn--start"
          onClick={handleStart}
          title="Start the orchestration loop"
        >
          <span className="global-controls__icon">&#9654;</span>
          Start
        </button>
      )}
      {state === "running" && (
        <>
          <button
            type="button"
            className="global-controls__btn global-controls__btn--pause"
            onClick={handlePause}
            title="Pause orchestration (no new agents spawned)"
          >
            <span className="global-controls__icon">&#10074;&#10074;</span>
            Pause
          </button>
          <button
            type="button"
            className="global-controls__btn global-controls__btn--stop"
            onClick={handleStop}
            title="Pause orchestration and stop all running agents"
          >
            <span className="global-controls__icon">&#9632;</span>
            Stop all
          </button>
        </>
      )}
      {state === "paused" && (
        <>
          <button
            type="button"
            className="global-controls__btn global-controls__btn--continue"
            onClick={handleContinue}
            title="Resume the orchestration loop"
          >
            <span className="global-controls__icon">&#9654;</span>
            Continue
          </button>
          <button
            type="button"
            className="global-controls__btn global-controls__btn--stop"
            onClick={handleStop}
            title="Stop all running agents"
          >
            <span className="global-controls__icon">&#9632;</span>
            Stop all
          </button>
        </>
      )}
      <span className="global-controls__state">{state}</span>
    </div>
  );
}
