import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Plugin } from "multi-llm-ts";
import { Canvas } from "./components/Canvas";
import { LlmSettings } from "./components/LlmSettings";
import { TerminalToolPlugin } from "./plugins/TerminalToolPlugin";
import { BrowserToolPlugin } from "./plugins/BrowserToolPlugin";
import { BeadsToolPlugin } from "./plugins/BeadsToolPlugin";
import { CreateBeadsTaskPlugin } from "./plugins/CreateBeadsTaskPlugin";
import { MarkTaskDonePlugin } from "./plugins/MarkTaskDonePlugin";
import { WriteFileToolPlugin } from "./plugins/WriteFileToolPlugin";
import { ReadFileToolPlugin } from "./plugins/ReadFileToolPlugin";
import { runAgent } from "./agentRunner";
import { getPromptForRole, ROLE_TOOLS } from "./agentPrompts";
import type { ToolName } from "./agentPrompts";
import "./App.css";
import type { SessionLayout, CanvasLayoutPayload, CanvasNodeType, AgentRole } from "./types";
import {
  PROMPT_CARD_DEFAULT_W,
  PROMPT_CARD_DEFAULT_H,
  GRID_STEP,
  BROWSER_CARD_DEFAULT_W,
  BROWSER_CARD_DEFAULT_H,
  TERMINAL_LOG_DEFAULT_W,
  TERMINAL_LOG_DEFAULT_H,
  BEADS_CARD_DEFAULT_W,
  BEADS_CARD_DEFAULT_H,
  getDefaultSize,
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
  const typeOrder: CanvasNodeType[] = ["prompt", "agent", "terminal", "terminal_log", "browser", "beads"];
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

  const abortControllers = useRef(new Map<string, AbortController>());
  const activeWmNodeId = useRef<string | null>(null);

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

  const addTerminalLogNode = useCallback((agentNodeId: string): string => {
    const logId = generateNodeId();
    setLayouts((prev) => {
      const agent = prev.find((l) => l.session_id === agentNodeId);
      const preferredX = agent ? agent.x + agent.w + GRID_STEP : REPOSITION_ORIGIN.x;
      const preferredY = agent ? agent.y : REPOSITION_ORIGIN.y;
      const { x, y } = findNonOverlappingPosition(
        prev,
        preferredX,
        preferredY,
        TERMINAL_LOG_DEFAULT_W,
        TERMINAL_LOG_DEFAULT_H
      );
      const logLayout: SessionLayout = {
        session_id: logId,
        x,
        y,
        w: TERMINAL_LOG_DEFAULT_W,
        h: TERMINAL_LOG_DEFAULT_H,
        collapsed: false,
        node_type: "terminal_log",
        payload: JSON.stringify({ parentAgentId: agentNodeId, entries: [] }),
      };
      const next = [...prev, logLayout];
      if (loaded.current) persistLayoutsRef.current(next);
      return next;
    });
    return logId;
  }, []);

  const updateTerminalLog = useCallback((nodeId: string, entries: import("./components/TerminalLogCard").TerminalLogEntry[]) => {
    setLayouts((prev) => {
      const next = prev.map((l) => {
        if (l.session_id !== nodeId) return l;
        try {
          const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
          return { ...l, payload: JSON.stringify({ ...p, entries }) };
        } catch {
          return l;
        }
      });
      return next;
    });
  }, []);

  const addBeadsNode = useCallback((agentNodeId: string): string => {
    const beadsId = generateNodeId();
    setLayouts((prev) => {
      const agent = prev.find((l) => l.session_id === agentNodeId);
      const preferredX = agent ? agent.x + agent.w + GRID_STEP : REPOSITION_ORIGIN.x;
      const preferredY = agent ? agent.y + (agent.h / 2) : REPOSITION_ORIGIN.y;
      const { x, y } = findNonOverlappingPosition(
        prev,
        preferredX,
        preferredY,
        BEADS_CARD_DEFAULT_W,
        BEADS_CARD_DEFAULT_H
      );
      const beadsLayout: SessionLayout = {
        session_id: beadsId,
        x,
        y,
        w: BEADS_CARD_DEFAULT_W,
        h: BEADS_CARD_DEFAULT_H,
        collapsed: false,
        node_type: "beads",
        payload: JSON.stringify({ parentAgentId: agentNodeId, beadsStatus: null }),
      };
      const next = [...prev, beadsLayout];
      if (loaded.current) persistLayoutsRef.current(next);
      return next;
    });
    return beadsId;
  }, []);

  const updateBeadsStatus = useCallback((nodeId: string, status: import("./components/BeadsCard").BeadsStatus) => {
    setLayouts((prev) => {
      const next = prev.map((l) => {
        if (l.session_id !== nodeId) return l;
        try {
          const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
          return { ...l, payload: JSON.stringify({ ...p, beadsStatus: status }) };
        } catch {
          return l;
        }
      });
      return next;
    });
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

  /**
   * Build the plugin array for a given agent role.
   * Only includes tools the role is permitted to use (per ROLE_TOOLS).
   */
  const buildPlugins = useCallback(
    (role: AgentRole, agentNodeId: string, taskId: string | null): Plugin[] => {
      const allowed = new Set<ToolName>(ROLE_TOOLS[role] ?? []);
      const plugins: Plugin[] = [];

      if (allowed.has("open_project_with_beads")) {
        plugins.push(new BeadsToolPlugin(agentNodeId, addBeadsNode, updateBeadsStatus));
      }
      if (allowed.has("create_beads_task")) {
        plugins.push(new CreateBeadsTaskPlugin());
      }
      if (allowed.has("run_terminal_command")) {
        plugins.push(new TerminalToolPlugin(agentNodeId, addTerminalLogNode, updateTerminalLog));
      }
      if (allowed.has("browser_action")) {
        plugins.push(new BrowserToolPlugin(agentNodeId, addBrowserNode));
      }
      if (allowed.has("write_file")) {
        plugins.push(new WriteFileToolPlugin());
      }
      if (allowed.has("read_file")) {
        plugins.push(new ReadFileToolPlugin());
      }
      if (allowed.has("mark_task_done")) {
        plugins.push(new MarkTaskDonePlugin(taskId));
      }

      return plugins;
    },
    [addBeadsNode, updateBeadsStatus, addTerminalLogNode, updateTerminalLog, addBrowserNode],
  );

  /**
   * Create an agent card on the canvas and start an LLM conversation.
   * Used both by handleLaunch (WM) and the agent_spawned listener (Developers, Workers, etc).
   */
  const startAgentConversation = useCallback(
    async (params: {
      agentNodeId: string;
      role: AgentRole;
      userMessage: string;
      taskId: string | null;
      sourcePromptId?: string;
      parentAgentId?: string;
      preferredX: number;
      preferredY: number;
    }) => {
      const { agentNodeId, role, userMessage, taskId, sourcePromptId, parentAgentId, preferredX, preferredY } = params;
      const size = getDefaultSize(role === "worker" ? "worker" : role.includes("validator") ? "validator" : "agent");

      setLayouts((prev) => {
        const { x, y } = findNonOverlappingPosition(prev, preferredX, preferredY, size.w, size.h);
        const newAgentLayout: SessionLayout = {
          session_id: agentNodeId,
          x,
          y,
          w: size.w,
          h: size.h,
          collapsed: false,
          node_type: role === "worker" ? "worker" : role.includes("validator") ? "validator" : "agent",
          payload: JSON.stringify({
            role,
            sourcePromptId: sourcePromptId ?? undefined,
            parent_agent_id: parentAgentId ?? undefined,
            task_id: taskId ?? undefined,
            status: "loading",
            answer: "",
          }),
        };
        const next = [...prev, newAgentLayout];
        if (loaded.current) persistLayouts(next);
        return next;
      });

      const updatePayload = (update: Record<string, unknown>, persist?: boolean) => {
        setLayouts((prev) => {
          const next = prev.map((l) => {
            if (l.session_id !== agentNodeId) return l;
            try {
              const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
              return { ...l, payload: JSON.stringify({ ...p, ...update }) };
            } catch {
              return l;
            }
          });
          if (persist && loaded.current) persistLayouts(next);
          return next;
        });
      };

      const controller = new AbortController();
      abortControllers.current.set(agentNodeId, controller);

      const plugins = buildPlugins(role, agentNodeId, taskId);
      let accumulatedText = "";

      await runAgent({
        systemPrompt: getPromptForRole(role),
        userMessage: userMessage || "Hello, respond briefly.",
        plugins,
        signal: controller.signal,
        callbacks: {
          onChunk: (c) => {
            if ((c.type === "content" || c.type === "reasoning") && c.text) {
              accumulatedText += c.text;
              updatePayload({ status: "loading", answer: accumulatedText, toolActivity: "" });
            }
            if (c.type === "tool") {
              const statusText =
                c.state === "running" ? (c.status || `Running ${c.name}...`) :
                c.state === "preparing" ? `Calling ${c.name}...` :
                c.state === "completed" ? "" : "";
              if (statusText) updatePayload({ status: "loading", toolActivity: statusText });
            }
          },
          onDone: (fullText) => {
            updatePayload({ status: "done", answer: fullText, toolActivity: "" }, true);
          },
          onError: (msg) => {
            updatePayload({ status: "error", errorMessage: msg }, true);
          },
          onStopped: (fullText) => {
            updatePayload({ status: "stopped", answer: fullText, toolActivity: "" }, true);
          },
        },
      });

      abortControllers.current.delete(agentNodeId);
    },
    [persistLayouts, buildPlugins],
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

      const wmNodeId = generateNodeId();
      activeWmNodeId.current = wmNodeId;

      await startAgentConversation({
        agentNodeId: wmNodeId,
        role: "workforce_manager",
        userMessage: promptText,
        taskId: null,
        sourcePromptId: nodeId,
        preferredX: promptLayout.x,
        preferredY: promptLayout.y + promptLayout.h + GRID_STEP,
      });
    },
    [startAgentConversation],
  );

  // Listen for agent_spawned events from the Rust orchestration loop
  const startAgentConversationRef = useRef(startAgentConversation);
  startAgentConversationRef.current = startAgentConversation;

  useEffect(() => {
    const unlisten = listen<{
      agent_id: string;
      role: string;
      task_id: string | null;
      parent_agent_id: string | null;
    }>("agent_spawned", async (event) => {
      const { agent_id, role, task_id, parent_agent_id } = event.payload;

      let taskDescription = `Execute task ${task_id ?? "unknown"}.`;
      if (task_id) {
        try {
          const projectPath = await invoke<string | null>("get_beads_project_path");
          if (projectPath) {
            const stdout = await invoke<string>("beads_run", {
              project_path: projectPath,
              args: ["show", task_id],
            });
            taskDescription = stdout.trim() || taskDescription;
          }
        } catch {
          /* use default description */
        }
      }

      const wmId = activeWmNodeId.current;
      const parentRef = parent_agent_id ?? wmId ?? undefined;
      let preferredX = REPOSITION_ORIGIN.x;
      let preferredY = REPOSITION_ORIGIN.y;

      if (parentRef) {
        const parentLayout = layoutsRef.current.find((l) => l.session_id === parentRef);
        if (parentLayout) {
          preferredX = parentLayout.x;
          preferredY = parentLayout.y + parentLayout.h + GRID_STEP;
        }
      }

      startAgentConversationRef.current({
        agentNodeId: agent_id,
        role: role as AgentRole,
        userMessage: taskDescription,
        taskId: task_id,
        parentAgentId: parentRef,
        preferredX,
        preferredY,
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for agent_killed events to mark cards as stopped
  useEffect(() => {
    const unlisten = listen<{ agent_id: string; reason: string }>("agent_killed", (event) => {
      const { agent_id } = event.payload;
      const controller = abortControllers.current.get(agent_id);
      if (controller) {
        controller.abort();
      }
      setLayouts((prev) =>
        prev.map((l) => {
          if (l.session_id !== agent_id) return l;
          try {
            const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
            return { ...l, payload: JSON.stringify({ ...p, status: "stopped", toolActivity: "TTL expired" }) };
          } catch {
            return l;
          }
        }),
      );
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

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

  const handleStopAgent = useCallback((nodeId: string) => {
    const controller = abortControllers.current.get(nodeId);
    if (controller) {
      controller.abort();
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
        onStopAgent={handleStopAgent}
      />
    </div>
  );
}
