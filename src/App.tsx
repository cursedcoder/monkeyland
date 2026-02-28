import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadModels, igniteModel, Message } from "multi-llm-ts";
import type { LlmChunk } from "multi-llm-ts";
import { Canvas } from "./components/Canvas";
import { LlmSettings } from "./components/LlmSettings";
import { TerminalToolPlugin } from "./plugins/TerminalToolPlugin";
import { BrowserToolPlugin } from "./plugins/BrowserToolPlugin";
import "./App.css";
import type { SessionLayout, CanvasLayoutPayload } from "./types";
import type { LlmProviderId } from "./types";
import {
  PROMPT_CARD_DEFAULT_W,
  PROMPT_CARD_DEFAULT_H,
  GRID_STEP,
  SESSION_CARD_DEFAULT_W,
  SESSION_CARD_DEFAULT_H,
  TERMINAL_CARD_DEFAULT_W,
  TERMINAL_CARD_DEFAULT_H,
  BROWSER_CARD_DEFAULT_W,
  BROWSER_CARD_DEFAULT_H,
} from "./types";

function generateNodeId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const LAYOUT_DEBOUNCE_MS = 250;
const PROMPT_DEBOUNCE_MS = 500;
const THEME_STORAGE_KEY = "monkeyland-theme";
type Theme = "light" | "dark";

function getStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "light";
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "dark" || stored === "light" ? stored : "light";
}

export default function App() {
  const [layouts, setLayouts] = useState<SessionLayout[]>([]);
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const loaded = useRef(false);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const layoutsRef = useRef<SessionLayout[]>([]);
  layoutsRef.current = layouts;

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
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (_) {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await invoke<CanvasLayoutPayload>("load_canvas_layout");
        if (cancelled) return;
        const raw = (payload.layouts || []).map((l) => ({
          ...l,
          node_type: (l.node_type ?? "agent") as "prompt" | "agent" | "terminal" | "browser",
          payload: l.payload ?? "{}",
        }));

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
        const others = withPromptText
          .filter((x) => x.layout.node_type !== "prompt")
          .map((x) => x.layout);
        const filtered: SessionLayout[] = [
          ...withContent.map((x) => x.layout),
          ...keptEmpty,
          ...others,
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

  /**
   * Add a terminal node to the canvas, positioned to the right of the agent.
   * Returns the session_id of the new terminal node.
   */
  const addTerminalNode = useCallback((agentNodeId: string): string => {
    const terminalId = generateNodeId();
    setLayouts((prev) => {
      const agent = prev.find((l) => l.session_id === agentNodeId);
      const x = agent ? agent.x + agent.w + GRID_STEP : 400;
      const y = agent ? agent.y : 200;

      const terminalLayout: SessionLayout = {
        session_id: terminalId,
        x,
        y,
        w: TERMINAL_CARD_DEFAULT_W,
        h: TERMINAL_CARD_DEFAULT_H,
        collapsed: false,
        node_type: "terminal",
        payload: JSON.stringify({ parentAgentId: agentNodeId }),
      };
      const next = [...prev, terminalLayout];
      if (loaded.current) persistLayoutsRef.current(next);
      return next;
    });
    return terminalId;
  }, []);

  const addBrowserNode = useCallback(
    (agentNodeId: string, port: number): string => {
      const browserId = generateNodeId();
      setLayouts((prev) => {
        const agent = prev.find((l) => l.session_id === agentNodeId);
        const terminal = prev.find((l) => {
          if (l.node_type !== "terminal") return false;
          try {
            const p = JSON.parse(l.payload ?? "{}") as { parentAgentId?: string };
            return p.parentAgentId === agentNodeId;
          } catch {
            return false;
          }
        });

        let x: number, y: number;
        if (terminal) {
          x = terminal.x;
          y = terminal.y + terminal.h + GRID_STEP;
        } else if (agent) {
          x = agent.x + agent.w + GRID_STEP;
          y = agent.y;
        } else {
          x = 400;
          y = 400;
        }

        const browserLayout: SessionLayout = {
          session_id: browserId,
          x,
          y,
          w: BROWSER_CARD_DEFAULT_W,
          h: BROWSER_CARD_DEFAULT_H,
          collapsed: false,
          node_type: "browser",
          payload: JSON.stringify({ parentAgentId: agentNodeId, browserPort: port }),
        };
        const next = [...prev, browserLayout];
        if (loaded.current) persistLayoutsRef.current(next);
        return next;
      });
      return browserId;
    },
    [],
  );

  const handleLaunch = useCallback(
    async (nodeId: string) => {
      const promptLayout = layoutsRef.current.find(
        (l) => l.session_id === nodeId && (l.node_type ?? "agent") === "prompt"
      );
      if (!promptLayout) return;

      let promptText = "";
      try {
        const o = JSON.parse(promptLayout.payload ?? "{}") as { promptText?: string };
        promptText = o.promptText?.trim() ?? "";
      } catch {
        /* ignore */
      }

      const newAgentId = generateNodeId();
      const newAgentLayout: SessionLayout = {
        session_id: newAgentId,
        x: promptLayout.x,
        y: promptLayout.y + promptLayout.h + GRID_STEP,
        w: SESSION_CARD_DEFAULT_W,
        h: SESSION_CARD_DEFAULT_H,
        collapsed: false,
        node_type: "agent",
        payload: JSON.stringify({
          sourcePromptId: nodeId,
          status: "loading",
          answer: "",
        }),
      };

      setLayouts((prev) => {
        const next = [...prev, newAgentLayout];
        if (loaded.current) persistLayouts(next);
        return next;
      });

      const updateAgentPayload = (
        update: Record<string, unknown>,
        persistWhenFinal?: boolean
      ) => {
        setLayouts((prev) => {
          const next = prev.map((l) => {
            if (l.session_id !== newAgentId) return l;
            try {
              const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
              return { ...l, payload: JSON.stringify({ ...p, ...update }) };
            } catch {
              return l;
            }
          });
          if (persistWhenFinal && loaded.current) persistLayouts(next);
          return next;
        });
      };

      try {
        const settings = await invoke<{ provider: string; model: string }>("load_llm_settings");
        const apiKey = await invoke<string | null>("get_llm_api_key", {
          provider: settings.provider,
        });
        if (!apiKey?.trim()) {
          updateAgentPayload({ status: "error", errorMessage: "LLM not configured. Set up API key in settings." });
          return;
        }

        const modelsResult = await loadModels(settings.provider as LlmProviderId, {
          apiKey: apiKey.trim(),
        });
        const model = modelsResult?.chat?.find((m) => m.id === settings.model) ?? modelsResult?.chat?.[0];
        if (!model) {
          updateAgentPayload({ status: "error", errorMessage: "No model available." });
          return;
        }

        const llmModel = igniteModel(settings.provider, model, { apiKey: apiKey.trim() });

        const terminalPlugin = new TerminalToolPlugin(newAgentId, addTerminalNode);
        llmModel.addPlugin(terminalPlugin);
        const browserPlugin = new BrowserToolPlugin(newAgentId, addBrowserNode);
        llmModel.addPlugin(browserPlugin);

        const stream = llmModel.generate(
          [new Message("user", promptText || "Hello, respond briefly.")],
          { tools: true },
        );

        let fullText = "";
        for await (const chunk of stream as AsyncIterable<LlmChunk>) {
          if (!chunk || typeof chunk !== "object" || !("type" in chunk)) continue;
          const c = chunk as { type: string; text?: string; name?: string; state?: string; status?: string };

          if ((c.type === "content" || c.type === "reasoning") && c.text) {
            fullText += c.text;
            updateAgentPayload({ status: "loading", answer: fullText, toolActivity: "" });
          }

          if (c.type === "tool") {
            const statusText =
              c.state === "running" ? (c.status || `Running ${c.name}...`) :
              c.state === "preparing" ? `Calling ${c.name}...` :
              c.state === "completed" ? "" : "";
            if (statusText) {
              updateAgentPayload({ status: "loading", toolActivity: statusText });
            }
          }
        }

        updateAgentPayload({ status: "done", answer: fullText, toolActivity: "" }, true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        updateAgentPayload({ status: "error", errorMessage: msg }, true);
      }
    },
    [persistLayouts, addTerminalNode, addBrowserNode]
  );

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
        <h1><span className="app-logo" aria-hidden>🍌</span> Monkeyland</h1>
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
        <button
          type="button"
          className="app-theme-toggle"
          onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
          aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
        >
          {theme === "light" ? "🌙" : "☀️"}
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
