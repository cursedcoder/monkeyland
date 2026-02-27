import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Canvas } from "./components/Canvas";
import "./App.css";
import type { SessionLayout, CanvasLayoutPayload } from "./types";
import { PROMPT_CARD_DEFAULT_W, PROMPT_CARD_DEFAULT_H, GRID_STEP } from "./types";

function generateNodeId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const LAYOUT_DEBOUNCE_MS = 250;
const PROMPT_DEBOUNCE_MS = 500;

export default function App() {
  const [layouts, setLayouts] = useState<SessionLayout[]>([]);
  const loaded = useRef(false);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await invoke<CanvasLayoutPayload>("load_canvas_layout");
        if (cancelled) return;
        if (payload.layouts.length > 0) {
          setLayouts(
            payload.layouts.map((l) => ({
              ...l,
              node_type: (l.node_type ?? "agent") as "prompt" | "agent",
              payload: l.payload ?? "{}",
            }))
          );
        }
      } catch (_) {
        // First run or no saved layout
      }
      loaded.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistLayouts = useCallback((next: SessionLayout[]) => {
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(async () => {
      saveTimeout.current = null;
      try {
        await invoke("save_canvas_layout", {
          payload: {
            layouts: next.map((l) => ({
              ...l,
              node_type: l.node_type ?? "agent",
              payload: l.payload ?? "{}",
            })),
          },
        });
      } catch (e) {
        console.warn("Failed to save canvas layout", e);
      }
    }, LAYOUT_DEBOUNCE_MS);
  }, []);

  const handleLayoutChange = useCallback((nodeId: string, layout: SessionLayout) => {
    setLayouts((prev) =>
      prev.map((l) => (l.session_id === nodeId ? layout : l))
    );
  }, []);

  const handleLayoutCommit = useCallback(
    (nodeId: string, layout: SessionLayout) => {
      setLayouts((prev) => {
        const next = prev.map((l) => (l.session_id === nodeId ? layout : l));
        if (loaded.current) persistLayouts(next);
        return next;
      });
    },
    [persistLayouts]
  );

  const handlePromptChange = useCallback((nodeId: string, text: string) => {
    setLayouts((prev) => {
      const next = prev.map((l) =>
        l.session_id === nodeId
          ? { ...l, payload: JSON.stringify({ promptText: text }) }
          : l
      );
      if (loaded.current) {
        if (promptSaveTimeout.current) clearTimeout(promptSaveTimeout.current);
        promptSaveTimeout.current = setTimeout(() => {
          promptSaveTimeout.current = null;
          persistLayouts(next);
        }, PROMPT_DEBOUNCE_MS);
      }
      return next;
    });
  }, [persistLayouts]);

  const handleLaunch = useCallback((_nodeId: string) => {
    // MVP: no LLM call yet. id-2 will add Anthropic.
    // eslint-disable-next-line no-console
    console.log("Launch (Anthropic integration in id-2)");
  }, []);

  const handleAddPrompt = useCallback(() => {
    const newLayout: SessionLayout = {
      session_id: generateNodeId(),
      x: 80 + (layouts.length * GRID_STEP) % 400,
      y: 80 + Math.floor(layouts.length / 4) * (PROMPT_CARD_DEFAULT_H + GRID_STEP),
      w: PROMPT_CARD_DEFAULT_W,
      h: PROMPT_CARD_DEFAULT_H,
      collapsed: false,
      node_type: "prompt",
      payload: JSON.stringify({ promptText: "" }),
    };
    setLayouts((prev) => {
      const next = [...prev, newLayout];
      if (loaded.current) persistLayouts(next);
      return next;
    });
  }, [layouts.length, persistLayouts]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Monkeyland</h1>
        <span className="app-subtitle">Agent Canvas</span>
        <button
          type="button"
          className="app-add-prompt"
          onClick={handleAddPrompt}
        >
          Add prompt
        </button>
      </header>
      <Canvas
        layouts={layouts}
        onLayoutChange={handleLayoutChange}
        onLayoutCommit={handleLayoutCommit}
        onPromptChange={handlePromptChange}
        onLaunch={handleLaunch}
      />
    </div>
  );
}
