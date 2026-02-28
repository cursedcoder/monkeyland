import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadModels, igniteModel, Message } from "multi-llm-ts";
import type { LlmChunk } from "multi-llm-ts";
import { Canvas } from "./components/Canvas";
import { LlmSettings } from "./components/LlmSettings";
import { TerminalToolPlugin } from "./plugins/TerminalToolPlugin";
import { BrowserToolPlugin } from "./plugins/BrowserToolPlugin";
import "./App.css";
import type { SessionLayout, CanvasLayoutPayload, CanvasNodeType } from "./types";
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

const REPOSITION_ORIGIN = { x: 80, y: 80 };
const REPOSITION_ROW_WIDTH = 2400;

function layoutToRect(layout: SessionLayout): { left: number; top: number; right: number; bottom: number } {
  const h = layout.collapsed ? 48 : layout.h;
  return {
    left: layout.x,
    top: layout.y,
    right: layout.x + layout.w,
    bottom: layout.y + h,
  };
}

function rectsOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
  gap: number
): boolean {
  return (
    a.left - gap < b.right &&
    a.right + gap > b.left &&
    a.top - gap < b.bottom &&
    a.bottom + gap > b.top
  );
}

/**
 * Find (x, y) for a new card of size (w, h) that does not overlap existing layouts.
 * Tries preferred position first, then searches in a spiral around it.
 * @param existingLayouts - current layouts (can exclude one by id via excludeId)
 * @param excludeId - if set, layouts with this session_id are ignored (e.g. when placing relative to a card we're replacing or moving)
 */
function findNonOverlappingPosition(
  existingLayouts: SessionLayout[],
  preferredX: number,
  preferredY: number,
  w: number,
  h: number,
  excludeId?: string
): { x: number; y: number } {
  const gap = GRID_STEP;
  const existingRects = existingLayouts
    .filter((l) => l.session_id !== excludeId)
    .map(layoutToRect);

  const candidateRect = (x: number, y: number) => ({
    left: x,
    top: y,
    right: x + w,
    bottom: y + h,
  });

  const overlapsAny = (rect: { left: number; top: number; right: number; bottom: number }) =>
    existingRects.some((r) => rectsOverlap(rect, r, gap));

  if (!overlapsAny(candidateRect(preferredX, preferredY))) {
    return { x: preferredX, y: preferredY };
  }

  const step = GRID_STEP;
  let radius = 1;
  const maxRadius = 50;
  while (radius <= maxRadius) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const x = preferredX + dx * step;
        const y = preferredY + dy * step;
        if (!overlapsAny(candidateRect(x, y))) return { x, y };
      }
    }
    radius++;
  }
  return { x: preferredX, y: preferredY };
}

/** Returns new layouts with x,y reset to a clean grid: prompts → agents → terminals → browsers. */
function repositionLayouts(layouts: SessionLayout[]): SessionLayout[] {
  const typeOrder: CanvasNodeType[] = ["prompt", "agent", "terminal", "browser"];
  const sorted = [...layouts].sort((a, b) => {
    const ta = typeOrder.indexOf((a.node_type ?? "agent") as CanvasNodeType);
    const tb = typeOrder.indexOf((b.node_type ?? "agent") as CanvasNodeType);
    if (ta !== tb) return ta - tb;
    return a.session_id.localeCompare(b.session_id);
  });

  let x = REPOSITION_ORIGIN.x;
  let y = REPOSITION_ORIGIN.y;
  let rowMaxH = 0;

  return sorted.map((layout) => {
    const w = layout.w;
    const h = layout.collapsed ? 48 : layout.h;
    if (x > REPOSITION_ORIGIN.x && x + w > REPOSITION_ROW_WIDTH) {
      x = REPOSITION_ORIGIN.x;
      y += rowMaxH + GRID_STEP;
      rowMaxH = 0;
    }
    const next = { ...layout, x, y };
    rowMaxH = Math.max(rowMaxH, h);
    x += w + GRID_STEP;
    return next;
  });
}

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
          node_type: (l.node_type ?? "agent") as CanvasNodeType,
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
      const preferredX = agent ? agent.x + agent.w + GRID_STEP : REPOSITION_ORIGIN.x;
      const preferredY = agent ? agent.y : REPOSITION_ORIGIN.y;
      const { x, y } = findNonOverlappingPosition(
        prev,
        preferredX,
        preferredY,
        TERMINAL_CARD_DEFAULT_W,
        TERMINAL_CARD_DEFAULT_H
      );
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

        let preferredX: number, preferredY: number;
        if (terminal) {
          preferredX = terminal.x;
          preferredY = terminal.y + terminal.h + GRID_STEP;
        } else if (agent) {
          preferredX = agent.x + agent.w + GRID_STEP;
          preferredY = agent.y;
        } else {
          preferredX = REPOSITION_ORIGIN.x;
          preferredY = REPOSITION_ORIGIN.y;
        }
        const { x, y } = findNonOverlappingPosition(
          prev,
          preferredX,
          preferredY,
          BROWSER_CARD_DEFAULT_W,
          BROWSER_CARD_DEFAULT_H
        );

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
      const preferredY = promptLayout.y + promptLayout.h + GRID_STEP;

      setLayouts((prev) => {
        const { x, y } = findNonOverlappingPosition(
          prev,
          promptLayout.x,
          preferredY,
          SESSION_CARD_DEFAULT_W,
          SESSION_CARD_DEFAULT_H
        );
        const newAgentLayout: SessionLayout = {
          session_id: newAgentId,
          x,
          y,
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
    setLayouts((prev) => {
      const { x, y } = findNonOverlappingPosition(
        prev,
        REPOSITION_ORIGIN.x,
        REPOSITION_ORIGIN.y,
        PROMPT_CARD_DEFAULT_W,
        PROMPT_CARD_DEFAULT_H
      );
      const newLayout: SessionLayout = {
        session_id: generateNodeId(),
        x,
        y,
        w: PROMPT_CARD_DEFAULT_W,
        h: PROMPT_CARD_DEFAULT_H,
        collapsed: false,
        node_type: "prompt",
        payload: JSON.stringify({ promptText: "" }),
      };
      const next = [...prev, newLayout];
      if (loaded.current) persistLayouts(next);
      return next;
    });
  }, [persistLayouts]);

  const handleClearCanvas = useCallback(async () => {
    setLayouts([]);
    try {
      await invoke("save_canvas_layout", { payload: { layouts: [] } });
    } catch (e) {
      console.warn("Failed to clear canvas layout", e);
    }
  }, []);

  const handleReposition = useCallback(() => {
    setLayouts((prev) => {
      if (prev.length === 0) return prev;
      const next = repositionLayouts(prev);
      if (loaded.current) persistLayouts(next);
      return next;
    });
  }, [persistLayouts]);

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
          className="app-reposition-canvas"
          onClick={handleReposition}
          title="Arrange cards in a clean grid (prompts, agents, terminals, browsers)"
        >
          Reposition
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
