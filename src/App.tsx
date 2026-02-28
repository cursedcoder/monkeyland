import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Plugin } from "multi-llm-ts";
import { Canvas } from "./components/Canvas";
import { LlmSettings } from "./components/LlmSettings";
import { WorkforceOverlay } from "./components/WorkforceOverlay";
import { DebugPanel } from "./components/DebugPanel";
import { TerminalToolPlugin } from "./plugins/TerminalToolPlugin";
import { BrowserToolPlugin } from "./plugins/BrowserToolPlugin";
import { BeadsToolPlugin } from "./plugins/BeadsToolPlugin";
import { CreateBeadsTaskPlugin } from "./plugins/CreateBeadsTaskPlugin";
import { YieldForReviewPlugin } from "./plugins/YieldForReviewPlugin";
import { CompleteTaskPlugin } from "./plugins/CompleteTaskPlugin";
import { WriteFileToolPlugin } from "./plugins/WriteFileToolPlugin";
import { ReadFileToolPlugin } from "./plugins/ReadFileToolPlugin";
import { DispatchAgentPlugin } from "./plugins/DispatchAgentPlugin";
import { runAgent } from "./agentRunner";
import { getPromptForRole, ROLE_TOOLS } from "./agentPrompts";
import type { ToolName } from "./agentPrompts";
import { createCostStore, CostStoreContext } from "./costStore";
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
  const costStore = useMemo(() => createCostStore(), []);
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
   * Dispatch an agent directly from the WM (no Beads, no orchestration loop).
   * Uses a ref so it can call startAgentConversation which is defined later.
   */
  const dispatchAgentRef = useRef<(p: { role: "developer" | "worker"; taskDescription: string; parentAgentId: string }) => string>(
    () => { throw new Error("dispatchAgent not ready"); },
  );

  /**
   * Build the plugin array for a given agent role.
   * Only includes tools the role is permitted to use (per ROLE_TOOLS).
   */
  const buildPlugins = useCallback(
    (role: AgentRole, agentNodeId: string, taskId: string | null, projectPath?: string | null): Plugin[] => {
      const allowed = new Set<ToolName>(ROLE_TOOLS[role] ?? []);
      const plugins: Plugin[] = [];

      if (allowed.has("open_project_with_beads")) {
        plugins.push(new BeadsToolPlugin(agentNodeId, addBeadsNode, updateBeadsStatus));
      }
      if (allowed.has("create_beads_task")) {
        plugins.push(new CreateBeadsTaskPlugin(agentNodeId));
      }
      if (allowed.has("dispatch_agent")) {
        plugins.push(new DispatchAgentPlugin(agentNodeId, (p) => dispatchAgentRef.current(p)));
      }
      if (allowed.has("run_terminal_command")) {
        plugins.push(new TerminalToolPlugin(agentNodeId, addTerminalLogNode, updateTerminalLog, projectPath));
      }
      if (allowed.has("browser_action")) {
        plugins.push(new BrowserToolPlugin(agentNodeId, addBrowserNode));
      }
      if (allowed.has("write_file")) {
        plugins.push(new WriteFileToolPlugin(agentNodeId));
      }
      if (allowed.has("read_file")) {
        plugins.push(new ReadFileToolPlugin(agentNodeId));
      }
      if (allowed.has("yield_for_review")) {
        plugins.push(new YieldForReviewPlugin(agentNodeId, taskId));
      }
      if (allowed.has("complete_task")) {
        plugins.push(new CompleteTaskPlugin(agentNodeId, taskId));
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
      taskMeta?: { title?: string; type?: string; priority?: number; description?: string };
      projectPath?: string | null;
    }) => {
      const { agentNodeId, role, userMessage, taskId, sourcePromptId, parentAgentId, preferredX, preferredY, taskMeta, projectPath } = params;
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
            taskTitle: taskMeta?.title ?? undefined,
            taskType: taskMeta?.type ?? undefined,
            taskPriority: taskMeta?.priority ?? undefined,
            taskDescription: taskMeta?.description ?? undefined,
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

      const plugins = buildPlugins(role, agentNodeId, taskId, projectPath);
      let accumulatedText = "";
      const mi = { modelName: "unknown", inputPricePerM: 0, outputPricePerM: 0 };

      await runAgent({
        systemPrompt: getPromptForRole(role),
        userMessage: userMessage || "Hello, respond briefly.",
        plugins,
        signal: controller.signal,
        callbacks: {
          onModelLoaded: (info) => {
            mi.modelName = info.modelName;
            mi.inputPricePerM = info.inputPricePerM;
            mi.outputPricePerM = info.outputPricePerM;
          },
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
          onUsage: (usage) => {
            costStore.reportUsage(
              agentNodeId, role, mi.modelName,
              usage.prompt_tokens, usage.completion_tokens,
              mi.inputPricePerM, mi.outputPricePerM,
            );
            invoke("agent_report_tokens", {
              agentId: agentNodeId,
              delta: usage.prompt_tokens + usage.completion_tokens,
            }).catch(() => {});
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
    [persistLayouts, buildPlugins, costStore],
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
      // Start orchestration so the loop can pick up tasks from Beads and spawn developer agents.
      try {
        await invoke("orch_start");
      } catch {
        /* already running or not available */
      }
    },
    [startAgentConversation],
  );

  // Listen for agent_spawned events from the Rust orchestration loop
  const startAgentConversationRef = useRef(startAgentConversation);
  startAgentConversationRef.current = startAgentConversation;

  // Wire up dispatchAgentRef so WM's dispatch_agent tool can spawn agents.
  dispatchAgentRef.current = (p) => {
    const agentId = generateNodeId();
    const wmLayout = layoutsRef.current.find((l) => l.session_id === p.parentAgentId);
    const prefX = wmLayout ? wmLayout.x : REPOSITION_ORIGIN.x;
    const prefY = wmLayout ? wmLayout.y + wmLayout.h + GRID_STEP : REPOSITION_ORIGIN.y;
    startAgentConversationRef.current({
      agentNodeId: agentId,
      role: p.role as AgentRole,
      userMessage: p.taskDescription,
      taskId: null,
      parentAgentId: p.parentAgentId,
      preferredX: prefX,
      preferredY: prefY,
    });
    return agentId;
  };

  useEffect(() => {
    const unlisten = listen<{
      agent_id: string;
      role: string;
      task_id: string | null;
      parent_agent_id: string | null;
    }>("agent_spawned", async (event) => {
      const { agent_id, role, task_id, parent_agent_id } = event.payload;

      let taskDescription = `Execute task ${task_id ?? "unknown"}.`;
      let taskMeta: { title?: string; type?: string; priority?: number; description?: string } | undefined;
      let resolvedProjectPath: string | null = null;
      try {
        resolvedProjectPath = await invoke<string | null>("get_beads_project_path");
      } catch { /* */ }

      if (task_id && resolvedProjectPath) {
        try {
          const jsonOut = await invoke<string>("beads_run", {
            projectPath: resolvedProjectPath,
            args: ["show", task_id, "--json"],
          });
          try {
            const raw = JSON.parse(jsonOut.trim());
            const parsed = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
            if (parsed) {
              taskMeta = {
                title: (parsed.title as string) ?? undefined,
                type: ((parsed.issue_type ?? parsed.type) as string) ?? undefined,
                priority: typeof parsed.priority === "number" ? parsed.priority : undefined,
                description: ((parsed.description ?? parsed.body) as string) ?? undefined,
              };
              taskDescription = (taskMeta.description || taskMeta.title || taskDescription);
            }
          } catch {
            taskDescription = jsonOut.trim() || taskDescription;
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
        taskMeta,
        parentAgentId: parentRef,
        preferredX,
        preferredY,
        projectPath: resolvedProjectPath,
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

  // Listen for validation_requested: spawn 3 parallel validator agents
  useEffect(() => {
    const unlisten = listen<{
      developer_agent_id: string;
      task_id: string | null;
      git_branch: string | null;
      diff_summary: string | null;
    }>("validation_requested", async (event) => {
      const { developer_agent_id, task_id, diff_summary } = event.payload;
      const validatorRoles: AgentRole[] = [
        "code_review_validator",
        "business_logic_validator",
        "scope_validator",
      ];

      const devLayout = layoutsRef.current.find((l) => l.session_id === developer_agent_id);
      let baseX = devLayout ? devLayout.x : REPOSITION_ORIGIN.x;
      let baseY = devLayout ? devLayout.y + devLayout.h + GRID_STEP : REPOSITION_ORIGIN.y;

      for (const role of validatorRoles) {
        const validatorId = generateNodeId();
        const userMessage = [
          `Task ID: ${task_id ?? "unknown"}`,
          `Developer agent: ${developer_agent_id}`,
          "",
          "## Changes to review",
          diff_summary ?? "No diff summary provided.",
        ].join("\n");

        // Spawn validator -- it runs, produces verdict, then we submit it
        const validatorPromise = startAgentConversationRef.current({
          agentNodeId: validatorId,
          role,
          userMessage,
          taskId: task_id,
          parentAgentId: developer_agent_id,
          preferredX: baseX,
          preferredY: baseY,
        });

        // After the validator finishes, parse verdict and submit
        validatorPromise.then(async () => {
          const validatorLayout = layoutsRef.current.find((l) => l.session_id === validatorId);
          let pass = true;
          let reasons: string[] = [];
          if (validatorLayout?.payload) {
            try {
              const p = JSON.parse(validatorLayout.payload) as { answer?: string };
              const answer = p.answer ?? "";
              try {
                const verdict = JSON.parse(answer) as { status?: string; reasons?: string[] };
                pass = verdict.status === "pass";
                reasons = verdict.reasons ?? [];
              } catch {
                pass = !answer.toLowerCase().includes('"fail"');
                reasons = [answer.slice(0, 500)];
              }
            } catch {
              /* assume pass if unparseable */
            }
          }
          try {
            await invoke("validation_submit", {
              payload: {
                developer_agent_id,
                validator_role: role,
                pass,
                reasons,
              },
            });
          } catch {
            /* best effort */
          }
        });

        baseX += GRID_STEP * 7;
      }
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

  const handleStopAgent = useCallback(async (nodeId: string) => {
    const controller = abortControllers.current.get(nodeId);
    if (controller) {
      controller.abort();
    }
    try {
      await invoke("agent_kill", { agentId: nodeId });
    } catch {
      // Frontend-spawned agents (WM) aren't in the Rust registry -- ignore
    }
  }, []);

  const handleStopAll = useCallback(() => {
    for (const [id, controller] of abortControllers.current) {
      controller.abort();
      invoke("agent_kill", { agentId: id }).catch(() => {});
    }
    abortControllers.current.clear();
    setLayouts((prev) =>
      prev.map((l) => {
        if (!["agent", "worker", "validator"].includes(l.node_type ?? "")) return l;
        try {
          const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
          if (p.status === "loading") {
            return { ...l, payload: JSON.stringify({ ...p, status: "stopped", toolActivity: "" }) };
          }
        } catch { /* */ }
        return l;
      }),
    );
  }, []);

  const handleReposition = useCallback(() => {
    setLayouts((prev) => {
      if (prev.length === 0) return prev;
      const next = repositionLayouts(prev);
      if (loaded.current) persistLayouts(next);
      return next;
    });
  }, [persistLayouts]);

  const [debugCopied, setDebugCopied] = useState(false);
  const handleCopyDebug = useCallback(async () => {
    const snap = layoutsRef.current.map((l) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(l.payload ?? "{}"); } catch { /* */ }
      return {
        id: l.session_id,
        type: l.node_type ?? "agent",
        pos: { x: l.x, y: l.y, w: l.w, h: l.h },
        collapsed: l.collapsed,
        ...(parsed.role ? { role: parsed.role } : {}),
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.answer ? { content: String(parsed.answer).slice(-800) } : {}),
        ...(parsed.promptText ? { promptText: parsed.promptText } : {}),
        ...(parsed.beadsStatus ? { beads: parsed.beadsStatus } : {}),
        ...(parsed.toolActivity ? { toolActivity: parsed.toolActivity } : {}),
        ...(parsed.parentAgentId ? { parent: parsed.parentAgentId } : {}),
        ...(parsed.terminalLog ? { terminalLog: (parsed.terminalLog as Array<{command: string; output: string}>).slice(-3).map(e => ({ cmd: e.command, out: e.output?.slice(-300) })) } : {}),
      };
    });

    let beadsProject = "";
    try { beadsProject = await invoke<string>("get_beads_project_path") ?? ""; } catch { /* */ }

    const debug = {
      ts: new Date().toISOString(),
      beadsProject,
      nodeCount: snap.length,
      nodes: snap,
    };

    const text = JSON.stringify(debug, null, 2);
    try {
      // Prefer Tauri command so clipboard works in the webview (navigator.clipboard often restricted)
      await invoke("write_clipboard_text", { text });
    } catch {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const el = document.createElement("textarea");
        el.value = text;
        el.setAttribute("readonly", "");
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(el);
        }
      }
    }
    setDebugCopied(true);
    setTimeout(() => setDebugCopied(false), 2000);
  }, []);

  return (
    <CostStoreContext.Provider value={costStore}>
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
        <WorkforceOverlay />
        <DebugPanel
          onCopyDebug={handleCopyDebug}
          debugCopied={debugCopied}
          onStopAll={handleStopAll}
        />
      </div>
    </CostStoreContext.Provider>
  );
}
