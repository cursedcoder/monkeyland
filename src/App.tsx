import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Canvas } from "./components/Canvas";
import { LlmSettings } from "./components/LlmSettings";
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

  const persistLayoutsRef = useRef<(next: SessionLayout[]) => void>(() => {});
  persistLayoutsRef.current = persistLayouts;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await invoke<CanvasLayoutPayload>("load_canvas_layout");
        if (cancelled) return;
        const raw = (payload.layouts || []).map((l) => ({
          ...l,
          node_type: (l.node_type ?? "agent") as "prompt" | "agent",
          payload: l.payload ?? "{}",
        }));

        // Legacy: 20 placeholder agents → empty canvas, persist so next load is clean
        const nodeType = (l: (typeof raw)[0]) =>
          String(l.node_type ?? "agent").toLowerCase();
        const allAgents =
          raw.length >= 19 &&
          raw.length <= 21 &&
          raw.every((l) => nodeType(l) === "agent");
        if (allAgents) {
          setLayouts([]);
          loaded.current = true;
          try {
            await invoke("save_canvas_layout", { payload: { layouts: [] } });
          } catch (_) {
            /* ignore */
          }
          return;
        }

        // Cap empty prompts: keep all prompts with content + at most 1 empty
        const withPromptText = raw.map((l) => {
          let promptText = "";
          if (l.node_type === "prompt" && l.payload) {
            try {
              const o = JSON.parse(l.payload) as { promptText?: string };
              promptText = o.promptText ?? "";
            } catch (_) {
              /* ignore */
            }
          }
          return { layout: l, promptText } as const;
        });
        const withContent = withPromptText.filter(
          (x) => x.layout.node_type === "prompt" && x.promptText.trim() !== ""
        );
        const emptyPrompts = withPromptText.filter(
          (x) => x.layout.node_type === "prompt" && x.promptText.trim() === ""
        );
        const keptEmpty = emptyPrompts.slice(0, 1).map((x) => x.layout);
        const agents = withPromptText.filter((x) => x.layout.node_type === "agent").map((x) => x.layout);
        const filtered: SessionLayout[] = [
          ...withContent.map((x) => x.layout),
          ...keptEmpty,
          ...agents,
        ];
        if (filtered.length > 0) {
          setLayouts(filtered);
          if (filtered.length < raw.length && !cancelled) {
            persistLayoutsRef.current(filtered);
          }
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

  const handleClearCanvas = useCallback(async () => {
    setLayouts([]);
    try {
      await invoke("save_canvas_layout", { payload: { layouts: [] } });
    } catch (e) {
      console.warn("Failed to clear canvas layout", e);
    }
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Monkeyland</h1>
        <span className="app-subtitle">Agent Canvas</span>
        <LlmSettings />
        <button
          type="button"
          className="app-add-prompt"
          onClick={handleAddPrompt}
        >
          Add prompt
        </button>
        <button
          type="button"
          className="app-clear-canvas"
          onClick={handleClearCanvas}
          title="Remove all cards and reset canvas"
        >
          Clear canvas
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
