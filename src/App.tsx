import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Plugin } from "./plugins/Plugin";
import { Canvas } from "./components/Canvas";
import { LlmSettings } from "./components/LlmSettings";
import { WorkforceOverlay } from "./components/WorkforceOverlay";
import { DebugPanel } from "./components/DebugPanel";
import { TerminalToolPlugin } from "./plugins/TerminalToolPlugin";
import { BrowserToolPlugin } from "./plugins/BrowserToolPlugin";
import { BeadsToolPlugin } from "./plugins/BeadsToolPlugin";
import { CreateBeadsTaskPlugin } from "./plugins/CreateBeadsTaskPlugin";
import { UpdateBeadsTaskPlugin } from "./plugins/UpdateBeadsTaskPlugin";
import { ListBeadsTasksPlugin } from "./plugins/ListBeadsTasksPlugin";
import { SanitizeProjectPlugin } from "./plugins/SanitizeProjectPlugin";
import { YieldForReviewPlugin } from "./plugins/YieldForReviewPlugin";
import { CompleteTaskPlugin } from "./plugins/CompleteTaskPlugin";
import { WriteFileToolPlugin } from "./plugins/WriteFileToolPlugin";
import { ReadFileToolPlugin } from "./plugins/ReadFileToolPlugin";
import { DispatchAgentPlugin } from "./plugins/DispatchAgentPlugin";
import {
  PauseOrchestrationPlugin,
  ResumeOrchestrationPlugin,
  CancelTaskPlugin,
  MessageAgentPlugin,
  GetOrchestrationStatusPlugin,
  ReprioritizeTaskPlugin,
} from "./plugins/OrchestrationControlPlugins";
import { runAgent, type Attachment, type ModelMessage } from "./agentRunner";
import { runBeadsPreflight } from "./beadsPreflight";
import { getPromptForRole, ROLE_TOOLS } from "./agentPrompts";
import type { ToolName } from "./agentPrompts";
import { createCostStore, CostStoreContext } from "./costStore";
import { getValidatorSpawnFailureSubmissions, normalizeValidatorOutput } from "./validatorSafety";
import {
  validateDAG,
  buildSequencingValidatorPrompt,
  parseSequencingValidatorResponse,
  formatPMValidationFeedback,
  runPMValidation,
  SEQUENCING_VALIDATOR_PROMPT,
} from "./pmValidation";
import type { BeadsTask } from "./types";
import "./App.css";
import type { SessionLayout, CanvasLayoutPayload, CanvasNodeType, AgentRole } from "./types";
import {
  PROMPT_CARD_DEFAULT_W,
  PROMPT_CARD_DEFAULT_H,
  BROWSER_CARD_DEFAULT_W,
  BROWSER_CARD_DEFAULT_H,
  TERMINAL_LOG_DEFAULT_W,
  TERMINAL_LOG_DEFAULT_H,
  BEADS_CARD_DEFAULT_W,
  BEADS_CARD_DEFAULT_H,
  BEADS_TASK_CARD_DEFAULT_W,
  BEADS_TASK_CARD_DEFAULT_H,
  WM_CHAT_CARD_DEFAULT_W,
  WM_CHAT_CARD_DEFAULT_H,
  getDefaultSize,
} from "./types";
import type { WMChatMessage, WMPhase } from "./components/WMChatCard";
import { repositionLayouts, getTerminalDiagnostics, buildDiagnosticNudge } from "./utils/layoutHelpers";
const STREAM_PAYLOAD_FLUSH_MS = 60;
const DEBUG_HISTORY_INTERVAL_MS = 15_000;
const DEBUG_HISTORY_MAX_SAMPLES = 120;
const DEBUG_HISTORY_COPY_SAMPLES = 40;

/** Maximum wall-clock time for a single agent turn (per role). */
const MAX_TURN_MS: Record<string, number> = {
  developer: 4 * 60_000,
  validator: 2 * 60_000,
  worker: 3 * 60_000,
  merge_agent: 2 * 60_000,
  project_manager: 2 * 60_000,
  workforce_manager: 2 * 60_000,
  operator: 3 * 60_000,
};
const DEFAULT_MAX_TURN_MS = 3 * 60_000;

/** Heartbeat interval — check backend state while agent runs. */
const HEARTBEAT_INTERVAL_MS = 20_000;

function safeUnlisten(unlistenPromise: Promise<() => void>) {
  void unlistenPromise
    .then((fn) => fn())
    .catch(() => {
      // Listener may already be removed during teardown/race conditions.
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
  const [layoutsHydrated, setLayoutsHydrated] = useState(false);
  const loaded = useRef(false);
  const recoveryAttemptedRef = useRef(false);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const layoutsRef = useRef<SessionLayout[]>([]);
  layoutsRef.current = layouts;

  const abortControllers = useRef(new Map<string, AbortController>());
  const activeWmNodeId = useRef<string | null>(null);
  const wmCardSessionId = useRef<string | null>(null);

  // WM Conversation state
  const [wmConversation, setWmConversation] = useState<WMChatMessage[]>([]);
  const [wmNodeId, setWmNodeId] = useState<string | null>(null);
  const [wmPhase, setWmPhase] = useState<WMPhase>("initial");
  const [wmIsProcessing, setWmIsProcessing] = useState(false);
  const [wmStreamingContent, setWmStreamingContent] = useState<string>("");
  const [wmStreamingToolCalls, setWmStreamingToolCalls] = useState<Array<{ name: string; status: string }>>([]);
  const [wmTaskProgress, _setWmTaskProgress] = useState({ done: 0, total: 0 });
  const [wmOrchStatus, setWmOrchStatus] = useState<"running" | "paused" | "idle">("idle");

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

        // Find the wm_chat card's session_id from loaded layouts
        const wmChatCard = filtered.find((l) => l.node_type === "wm_chat");
        if (wmChatCard) {
          wmCardSessionId.current = wmChatCard.session_id;
        }
      } catch (_) {
        // First run or no saved layout
      }
      loaded.current = true;
      setLayoutsHydrated(true);

      // Load WM conversation
      try {
        const wmPayload = await invoke<{
          messages: WMChatMessage[];
          wm_node_id: string | null;
          wm_phase: string | null;
        }>("load_wm_conversation");
        if (!cancelled && wmPayload.messages.length > 0) {
          setWmConversation(wmPayload.messages);
          if (wmPayload.wm_node_id) {
            setWmNodeId(wmPayload.wm_node_id);
            activeWmNodeId.current = wmPayload.wm_node_id;
          }
          if (wmPayload.wm_phase) {
            setWmPhase(wmPayload.wm_phase as WMPhase);
          }
        }
      } catch (_) {
        // No saved conversation
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Save WM conversation when it changes
  useEffect(() => {
    if (!loaded.current || wmConversation.length === 0) return;
    
    const saveConversation = async () => {
      try {
        await invoke("save_wm_conversation", {
          payload: {
            messages: wmConversation,
            wm_node_id: wmNodeId,
            wm_phase: wmPhase,
          },
        });
      } catch (e) {
        console.warn("Failed to save WM conversation:", e);
      }
    };
    
    const timeout = setTimeout(saveConversation, 500);
    return () => clearTimeout(timeout);
  }, [wmConversation, wmNodeId, wmPhase]);

  const handleLayoutChange = useCallback((nodeId: string, layout: SessionLayout) => {
    setLayouts((prev) => {
      const next = prev.map((l) => (l.session_id === nodeId ? layout : l));
      return next;
    });
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

  const handleRemoveLayout = useCallback((nodeId: string) => {
    setLayouts((prev) => {
      const next = prev.filter((l) => l.session_id !== nodeId);
      if (loaded.current && next.length < prev.length) persistLayouts(next);
      return next;
    });
  }, [persistLayouts]);

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
    // Reuse existing terminal log card for this agent (nudge retries create new plugin instances)
    const existing = layoutsRef.current.find((l) => {
      if (l.node_type !== "terminal_log") return false;
      try {
        const p = JSON.parse(l.payload ?? "{}") as { parentAgentId?: string };
        return p.parentAgentId === agentNodeId;
      } catch { return false; }
    });
    if (existing) return existing.session_id;

    const logId = generateNodeId();
    setLayouts((prev) => {
      const logLayout: SessionLayout = {
        session_id: logId,
        x: 0,
        y: 0,
        w: TERMINAL_LOG_DEFAULT_W,
        h: TERMINAL_LOG_DEFAULT_H,
        collapsed: false,
        node_type: "terminal_log",
        payload: JSON.stringify({ parentAgentId: agentNodeId, entries: [] }),
      };
      const next = repositionLayouts([...prev, logLayout]);
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
      const beadsLayout: SessionLayout = {
        session_id: beadsId,
        x: 0,
        y: 0,
        w: BEADS_CARD_DEFAULT_W,
        h: BEADS_CARD_DEFAULT_H,
        collapsed: false,
        node_type: "beads",
        payload: JSON.stringify({ parentAgentId: agentNodeId, beadsStatus: null }),
      };
      const next = repositionLayouts([...prev, beadsLayout]);
      if (loaded.current) persistLayoutsRef.current(next);
      return next;
    });
    return beadsId;
  }, []);

  const handleAddTaskCard = useCallback((parentBeadsId: string, task: import("./types").BeadsTask) => {
    setLayouts((prev) => {
      // Check if task card already exists
      const existing = prev.find(l => {
        if (l.node_type !== "beads_task") return false;
        try {
          const p = JSON.parse(l.payload ?? "{}");
          return p.id === task.id && p.parentBeadsId === parentBeadsId;
        } catch { return false; }
      });
      if (existing) {
        const next = prev.map((l) => {
          if (l.session_id !== existing.session_id) return l;
          let prevPayload: Record<string, unknown> = {};
          try {
            prevPayload = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
          } catch {
            /* ignore */
          }
          return {
            ...l,
            payload: JSON.stringify({ ...prevPayload, ...task, parentBeadsId }),
          };
        });
        if (loaded.current) persistLayoutsRef.current(next);
        return next;
      }

      const taskId = generateNodeId();
      const taskLayout: SessionLayout = {
        session_id: taskId,
        x: 0,
        y: 0,
        w: BEADS_TASK_CARD_DEFAULT_W,
        h: BEADS_TASK_CARD_DEFAULT_H,
        collapsed: false,
        node_type: "beads_task",
        payload: JSON.stringify({ ...task, parentBeadsId }),
      };
      const next = repositionLayouts([...prev, taskLayout]);
      if (loaded.current) persistLayoutsRef.current(next);
      return next;
    });
  }, []);

  const updateBeadsStatus = useCallback((nodeId: string, status: import("./components/BeadsCard").BeadsStatus) => {
    setLayouts((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        if (l.session_id !== nodeId) return l;
        try {
          const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
          const nextPayload = JSON.stringify({ ...p, beadsStatus: status });
          if (nextPayload === (l.payload ?? "")) return l;
          changed = true;
          return { ...l, payload: nextPayload };
        } catch {
          return l;
        }
      });
      return changed ? next : prev;
    });
  }, []);

  const addBrowserNode = useCallback(
    (agentNodeId: string, port: number, sessionId?: string): string => {
      // Reuse existing browser card for this agent (self-heal retries create new plugin instances).
      const existing = layoutsRef.current.find((l) => {
        if (l.node_type !== "browser") return false;
        try {
          const p = JSON.parse(l.payload ?? "{}") as { parentAgentId?: string };
          return p.parentAgentId === agentNodeId;
        } catch {
          return false;
        }
      });
      if (existing) return existing.session_id;

      const browserId = sessionId ?? generateNodeId();
      setLayouts((prev) => {
        const browserLayout: SessionLayout = {
          session_id: browserId,
          x: 0,
          y: 0,
          w: BROWSER_CARD_DEFAULT_W,
          h: BROWSER_CARD_DEFAULT_H,
          collapsed: false,
          node_type: "browser",
          payload: JSON.stringify({ parentAgentId: agentNodeId, browserPort: port }),
        };
        const next = repositionLayouts([...prev, browserLayout]);
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
  const dispatchAgentRef = useRef<(p: { role: "operator" | "developer" | "worker"; taskDescription: string; parentAgentId: string }) => Promise<string>>(
    async () => { throw new Error("dispatchAgent not ready"); },
  );

  /**
   * Build the plugin array for a given agent role.
   * Only includes tools the role is permitted to use (per ROLE_TOOLS).
   */
  const buildPlugins = useCallback(
    (role: AgentRole, canvasNodeId: string, backendAgentId: string, taskId: string | null, projectPath?: string | null): Plugin[] => {
      const allowed = new Set<ToolName>(ROLE_TOOLS[role] ?? []);
      const plugins: Plugin[] = [];

      if (allowed.has("open_project_with_beads")) {
        plugins.push(new BeadsToolPlugin(canvasNodeId, backendAgentId, addBeadsNode, updateBeadsStatus));
      }
      if (allowed.has("create_beads_task")) {
        plugins.push(new CreateBeadsTaskPlugin(backendAgentId));
      }
      if (allowed.has("update_beads_task")) {
        plugins.push(new UpdateBeadsTaskPlugin(backendAgentId, role));
      }
      if (allowed.has("list_beads_tasks")) {
        plugins.push(new ListBeadsTasksPlugin(backendAgentId));
      }
      if (allowed.has("sanitize_project")) {
        plugins.push(new SanitizeProjectPlugin(backendAgentId));
      }
      if (allowed.has("dispatch_agent")) {
        plugins.push(new DispatchAgentPlugin(backendAgentId, (p) => dispatchAgentRef.current(p)));
      }
      if (allowed.has("run_terminal_command")) {
        plugins.push(new TerminalToolPlugin(canvasNodeId, addTerminalLogNode, updateTerminalLog, projectPath));
      }
      if (allowed.has("browser_action")) {
        plugins.push(new BrowserToolPlugin(canvasNodeId, addBrowserNode));
      }
      if (allowed.has("write_file")) {
        plugins.push(new WriteFileToolPlugin(backendAgentId));
      }
      if (allowed.has("read_file")) {
        plugins.push(new ReadFileToolPlugin(backendAgentId));
      }
      if (allowed.has("yield_for_review") && taskId) {
        plugins.push(new YieldForReviewPlugin(backendAgentId, taskId));
      }
      if (allowed.has("complete_task") && taskId) {
        // merge_agents must NOT mark the Beads task "done" — the orchestration
        // loop does that after a successful git merge.  Passing null skips the
        // Beads update while still allowing the agent state transition.
        plugins.push(new CompleteTaskPlugin(backendAgentId, role === "merge_agent" ? null : taskId));
      }

      // Orchestration control plugins (WM only)
      if (allowed.has("pause_orchestration")) {
        plugins.push(new PauseOrchestrationPlugin());
      }
      if (allowed.has("resume_orchestration")) {
        plugins.push(new ResumeOrchestrationPlugin());
      }
      if (allowed.has("cancel_task")) {
        plugins.push(new CancelTaskPlugin());
      }
      if (allowed.has("message_agent")) {
        plugins.push(new MessageAgentPlugin());
      }
      if (allowed.has("get_orchestration_status")) {
        plugins.push(new GetOrchestrationStatusPlugin(() => {
          return layoutsRef.current
            .filter(l => l.node_type === "beads" || l.node_type === "agent" || l.node_type === "worker")
            .map(l => {
              try {
                const p = JSON.parse(l.payload ?? "{}");
                return {
                  type: l.node_type ?? "unknown",
                  project_path: p.project_path || (p.beadsStatus ? p.beadsStatus.projectPath : undefined),
                  task_id: p.task_id,
                };
              } catch {
                return { type: l.node_type ?? "unknown" };
              }
            });
        }));
      }
      if (allowed.has("reprioritize_task")) {
        plugins.push(new ReprioritizeTaskPlugin());
      }

      return plugins;
    },
    [addBeadsNode, updateBeadsStatus, addTerminalLogNode, updateTerminalLog, addBrowserNode],
  );

  /**
   * Self-heal loop for stuck developers. Diagnoses the failure from terminal
   * output, sends up to 2 targeted nudge attempts, then force-yields immediately.
   */
  const developerSelfHeal = useCallback(
    async (
      agentNodeId: string,
      role: AgentRole,
      userMessage: string,
      taskId: string | null,
      taskMeta: { title?: string; type?: string; priority?: number; description?: string } | undefined,
      projectPath: string | null | undefined,
      mi: { modelName: string; inputPricePerM: number; outputPricePerM: number },
      initialText: string,
      updatePayload: (update: Record<string, unknown>, persist?: boolean) => void,
      setAccumulated: (text: string) => void,
      getAccumulated: () => string,
    ) => {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const result = await invoke<string>("agent_turn_ended", { agentId: agentNodeId, role });
        if (result === "already_done") {
          updatePayload({ status: "in_review", answer: initialText, toolActivity: "Awaiting validation..." }, true);
          return;
        }
        if (result !== "needs_nudge") return;

        // Gather terminal diagnostics from the agent's terminal log card
        const terminalDiag = getTerminalDiagnostics(layoutsRef.current, agentNodeId);

        const MAX_NUDGES = 2;
        for (let attempt = 1; attempt <= MAX_NUDGES; attempt++) {
          updatePayload({ status: "loading", toolActivity: `Self-healing (attempt ${attempt}/${MAX_NUDGES})...` });

          const nudgeMsg = buildDiagnosticNudge(
            attempt, MAX_NUDGES, userMessage, taskId, taskMeta, projectPath, terminalDiag,
          );

          const nudgeController = new AbortController();
          abortControllers.current.set(agentNodeId, nudgeController);

          const NUDGE_TIMEOUT_MS = 2 * 60_000;
          const nudgeTimer = setTimeout(() => nudgeController.abort(), NUDGE_TIMEOUT_MS);

          let stopped = false;
          await runAgent({
            systemPrompt: getPromptForRole(role),
            userMessage: nudgeMsg,
            plugins: buildPlugins(role, agentNodeId, agentNodeId, taskId, projectPath),
            signal: nudgeController.signal,
            layouts: layoutsRef.current,
            callbacks: {
              onChunk: (c) => {
                if (c.type === "content" && c.text) {
                  setAccumulated(getAccumulated() + c.text);
                  updatePayload({ status: "loading", answer: getAccumulated(), toolActivity: "Generating…" });
                }
                if (c.type === "reasoning" && c.text) {
                  setAccumulated(getAccumulated() + c.text);
                  updatePayload({ status: "loading", answer: getAccumulated(), toolActivity: "Reasoning…" });
                }
                if (c.type === "tool") {
                  const statusText =
                    c.state === "running" ? (c.status || `Running ${c.name}...`) :
                    c.state === "preparing" ? `Calling ${c.name}...` :
                    (c.state === "done" || c.state === "completed") && c.name ? `Finished: ${c.name}` : "";
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
              onDone: () => { /* state check happens below */ },
              onError: () => { /* state check happens below */ },
              onStopped: () => { stopped = true; },
            },
          });
          clearTimeout(nudgeTimer);
          abortControllers.current.delete(agentNodeId);

          if (stopped) {
            updatePayload({ status: "stopped", answer: getAccumulated(), toolActivity: "" }, true);
            return;
          }

          // Check agent state AFTER runAgent returns (onDone is not awaited by runAgent)
          await new Promise((r) => setTimeout(r, 500));
          try {
            const postNudge = await invoke<string>("agent_turn_ended", { agentId: agentNodeId, role });
            if (postNudge === "already_done") {
              updatePayload({ status: "in_review", answer: getAccumulated(), toolActivity: "Awaiting validation..." }, true);
              return;
            }
          } catch { /* continue to next attempt */ }
        }

        // All nudge attempts exhausted -- force-yield immediately instead of
        // waiting for the 5-min safety net. Include terminal diagnostics so
        // the validator has context about what went wrong.
        updatePayload({ status: "loading", toolActivity: "Force-submitting for review..." });
        await invoke("agent_force_yield", { agentId: agentNodeId }).catch(() => {});
        const summary = terminalDiag.length > 0
          ? `Auto-submitted after ${MAX_NUDGES} failed nudge attempts.\n\nTerminal diagnostics:\n${terminalDiag}`
          : `Auto-submitted after ${MAX_NUDGES} failed nudge attempts. No terminal output captured.`;
        await invoke("agent_set_yield_summary", { agentId: agentNodeId, diffSummary: summary }).catch(() => {});
        updatePayload({ status: "in_review", answer: getAccumulated(), toolActivity: "Force-submitted for validation..." }, true);
      } catch { /* best effort */ }
    },
    [buildPlugins, costStore],
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
      taskMeta?: { title?: string; type?: string; priority?: number; description?: string };
      projectPath?: string | null;
    }) => {
      const { agentNodeId, role, userMessage, taskId, sourcePromptId, parentAgentId, taskMeta, projectPath } = params;
      const size = getDefaultSize(role === "worker" ? "worker" : role.includes("validator") ? "validator" : "agent");

      setLayouts((prev) => {
        const existing = prev.find((l) => l.session_id === agentNodeId);
        if (existing) {
          // Card already exists (validation retry) — reset status, keep metadata
          const next = prev.map((l) => {
            if (l.session_id !== agentNodeId) return l;
            try {
              const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
              return { ...l, payload: JSON.stringify({ ...p, status: "loading", answer: "", toolActivity: "Connecting…" }) };
            } catch {
              return l;
            }
          });
          if (loaded.current) persistLayouts(next);
          return next;
        }
        const newAgentLayout: SessionLayout = {
          session_id: agentNodeId,
          x: 0,
          y: 0,
          w: size.w,
          h: size.h,
          collapsed: false,
          node_type: role === "worker" ? "worker" : role.includes("validator") ? "validator" : "agent",
          payload: JSON.stringify({
            role,
            sourcePromptId: sourcePromptId ?? undefined,
            parent_agent_id: parentAgentId ?? undefined,
            task_id: taskId ?? undefined,
            project_path: projectPath ?? undefined,
            worktree_path:
              role === "developer" && projectPath && taskId
                ? `${projectPath.replace(/\/$/, "")}/.worktrees/${agentNodeId}`
                : undefined,
            taskTitle: taskMeta?.title ?? undefined,
            taskType: taskMeta?.type ?? undefined,
            taskPriority: taskMeta?.priority ?? undefined,
            taskDescription: taskMeta?.description ?? undefined,
            status: "loading",
            answer: "",
            toolActivity: "Connecting…",
            turnStartedAt: Date.now(),
          }),
        };
        const next = repositionLayouts([...prev, newAgentLayout]);
        if (loaded.current) persistLayouts(next);
        return next;
      });

      let queuedPayloadPatch: Record<string, unknown> | null = null;
      let queuedPersist = false;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const applyPayloadUpdate = (update: Record<string, unknown>, persist?: boolean) => {
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

      const flushQueuedPayload = () => {
        if (!queuedPayloadPatch) return;
        const patch = queuedPayloadPatch;
        const persist = queuedPersist;
        queuedPayloadPatch = null;
        queuedPersist = false;
        applyPayloadUpdate(patch, persist);
      };

      const updatePayload = (
        update: Record<string, unknown>,
        persist?: boolean,
        immediate?: boolean,
      ) => {
        queuedPayloadPatch = { ...(queuedPayloadPatch ?? {}), ...update };
        queuedPersist = queuedPersist || !!persist;

        if (immediate) {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          flushQueuedPayload();
          return;
        }

        if (flushTimer) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flushQueuedPayload();
        }, STREAM_PAYLOAD_FLUSH_MS);
      };

      const controller = new AbortController();
      abortControllers.current.set(agentNodeId, controller);

      const plugins = buildPlugins(role, agentNodeId, agentNodeId, taskId, projectPath);
      let accumulatedText = "";
      const toolCalls: Array<{ name: string; status: string }> = [];
      const mi = { modelName: "unknown", inputPricePerM: 0, outputPricePerM: 0 };

      // --- Turn watchdog: abort if the turn exceeds max duration ---
      let turnTimedOut = false;
      const maxTurnMs = MAX_TURN_MS[role] ?? DEFAULT_MAX_TURN_MS;
      const turnTimer = setTimeout(() => {
        turnTimedOut = true;
        console.warn(`[Agent ${agentNodeId}] Turn exceeded ${maxTurnMs / 1000}s — aborting`);
        controller.abort();
      }, maxTurnMs);

      // --- Heartbeat: detect if backend force-changed agent state ---
      let backendRevoked = false;
      const heartbeat = setInterval(async () => {
        try {
          const state = await invoke<string>("agent_check_state", { agentId: agentNodeId });
          // Only abort for forceful/terminal states (Stopped, Blocked).
          // Yielded/InReview/Done are expected lifecycle transitions — let the
          // stream finish naturally so onDone fires with the full answer text.
          if (state === "Stopped" || state === "Blocked") {
            backendRevoked = true;
            console.warn(`[Agent ${agentNodeId}] Backend state changed to "${state}" — aborting frontend`);
            controller.abort();
          }
          // Poll for execution phase during heartbeat
          if (role === "developer") {
            const devPhase = await invoke<string | null>("agent_get_phase", { agentId: agentNodeId });
            if (devPhase) updatePayload({ executionPhase: devPhase });
          } else if (role === "project_manager") {
            const pmPhase = await invoke<string | null>("agent_get_pm_phase", { agentId: agentNodeId });
            if (pmPhase) updatePayload({ pmExecutionPhase: pmPhase });
          }
        } catch { /* best effort */ }
      }, HEARTBEAT_INTERVAL_MS);

      const turnStartedAt = Date.now();

      await runAgent({
        systemPrompt: getPromptForRole(role),
        userMessage: userMessage || "Hello, respond briefly.",
        plugins,
        signal: controller.signal,
        layouts: layoutsRef.current,
        callbacks: {
          onModelLoaded: (info) => {
            mi.modelName = info.modelName;
            mi.inputPricePerM = info.inputPricePerM;
            mi.outputPricePerM = info.outputPricePerM;
          },
          onChunk: (c) => {
            if (c.type === "content" && c.text) {
              accumulatedText += c.text;
              updatePayload({ status: "loading", answer: accumulatedText, toolActivity: "Generating…" });
            }
            if (c.type === "reasoning" && c.text) {
              accumulatedText += c.text;
              updatePayload({ status: "loading", answer: accumulatedText, toolActivity: "Reasoning…" });
            }
            if (c.type === "tool") {
              const elapsed = ((Date.now() - turnStartedAt) / 1000).toFixed(0);
              const statusText =
                c.state === "running" ? (c.status || `Running ${c.name}… (${elapsed}s)`) :
                c.state === "preparing" ? `Calling ${c.name}…` :
                (c.state === "done" || c.state === "completed") && c.name ? `Finished: ${c.name}` : "";
              
              // Track tool calls for display
              if (c.state === "running" || c.state === "preparing") {
                toolCalls.push({ name: c.name ?? "unknown", status: "running" });
              } else if ((c.state === "done" || c.state === "completed") && c.name) {
                const tc = toolCalls.find((t) => t.name === c.name && t.status === "running");
                if (tc) tc.status = "done";
              }
              
              if (statusText) updatePayload({ status: "loading", toolActivity: statusText, toolCalls: [...toolCalls] });
              
              // Poll for execution phase when tool activity happens
              if (role === "developer") {
                invoke<string | null>("agent_get_phase", { agentId: agentNodeId })
                  .then((devPhase) => {
                    if (devPhase) updatePayload({ executionPhase: devPhase });
                  })
                  .catch(() => {});
              } else if (role === "project_manager") {
                invoke<string | null>("agent_get_pm_phase", { agentId: agentNodeId })
                  .then((pmPhase) => {
                    if (pmPhase) updatePayload({ pmExecutionPhase: pmPhase });
                  })
                  .catch(() => {});
              }
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
          onDone: async (fullText) => {
            if (role === "developer") {
              await developerSelfHeal(
                agentNodeId, role, userMessage, taskId, taskMeta, projectPath,
                mi, accumulatedText, updatePayload,
                (text) => { accumulatedText = text; },
                () => accumulatedText,
              );
            } else if (role === "project_manager" || role === "validator") {
              // PM/Validator cannot self-complete - they must yield for review
              // We retry nudges up to 3 times, then force-yield as a fallback
              const MAX_PM_NUDGE_RETRIES = 3;
              let nudgeRetry = 0;
              let lastResult = await invoke<string>("agent_turn_ended", { agentId: agentNodeId, role }).catch(() => "error");
              console.log(`[agent_turn_ended] ${role} ${agentNodeId} returned: ${lastResult}`);

              while (lastResult === "needs_yield" && nudgeRetry < MAX_PM_NUDGE_RETRIES) {
                nudgeRetry++;
                console.log(`[pm-nudge] ${role} ${agentNodeId} nudge attempt ${nudgeRetry}/${MAX_PM_NUDGE_RETRIES}`);
                updatePayload({ status: "loading", toolActivity: `Completing task (attempt ${nudgeRetry})...`, toolCalls: [] }, false, true);

                // Get PM phase and task info to create context-aware nudge
                let pmPhase: string | null = null;
                let hasSubtasks = false;
                if (role === "project_manager") {
                  pmPhase = await invoke<string | null>("agent_get_pm_phase", { agentId: agentNodeId }).catch(() => null);
                  // Check if subtasks exist under the epic
                  if (taskId && projectPath) {
                    try {
                      const tasksJson = await invoke<string>("beads_run", { projectPath, args: ["list", "--json", "--parent", taskId] });
                      const tasks = JSON.parse(tasksJson);
                      hasSubtasks = Array.isArray(tasks) && tasks.length > 0;
                    } catch { /* ignore - may not have subtasks yet */ }
                  }
                }

                // Build context-aware nudge message
                let nudgeMsg: string;
                if (role === "project_manager") {
                  if (pmPhase === "exploration" || !hasSubtasks) {
                    nudgeMsg = `You are still in the ${pmPhase || "exploration"} phase and haven't created any subtasks yet.

**You MUST complete these steps before yielding:**
1. Use \`create_beads_task\` to create subtasks for this epic (with deferred: true and parent_id: "${taskId || "the epic ID"}")
2. Review dependencies between tasks
3. Call \`yield_for_review\` to submit your task breakdown for validation

Do NOT call yield_for_review until you have created at least one subtask.`;
                  } else if (pmPhase === "task_drafting") {
                    nudgeMsg = `You have created some tasks but haven't finished the task breakdown.

Please either:
- Create more subtasks if needed using \`create_beads_task\`
- Or call \`yield_for_review\` to submit your task breakdown for validation`;
                  } else {
                    nudgeMsg = `You haven't submitted your task breakdown for validation yet.
Please call \`yield_for_review\` now to submit your work for validation.`;
                  }
                } else {
                  // Validator nudge
                  nudgeMsg = `You haven't completed your validation yet. Please finish your review and call \`yield_for_review\`.`;
                }

                let nudgeCompleted = false;
                const currentAttempt = nudgeRetry; // Capture attempt number for callback closure
                await runAgent({
                  systemPrompt: getPromptForRole(role),
                  userMessage: nudgeMsg,
                  plugins: buildPlugins(role, agentNodeId, agentNodeId, taskId, projectPath),
                  signal: controller.signal,
                  layouts: layoutsRef.current,
                  callbacks: {
                    onChunk: (c) => {
                      if (c.type === "content" && c.text) {
                        accumulatedText += c.text;
                        updatePayload({ status: "loading", answer: accumulatedText, streamingContent: accumulatedText, toolActivity: "Generating…", toolCalls: [] }, false, true);
                      }
                      if (c.type === "tool") {
                        const statusText =
                          c.state === "running" ? (c.status || `Running ${c.name}...`) :
                          c.state === "preparing" ? `Calling ${c.name}...` :
                          (c.state === "done" || c.state === "completed") && c.name ? `Finished: ${c.name}` : "";
                        if (statusText) updatePayload({ status: "loading", toolActivity: statusText, toolCalls: [] }, false, true);
                      }
                    },
                    onUsage: (usage) => {
                      costStore.reportUsage(
                        agentNodeId, role, mi.modelName,
                        usage.prompt_tokens, usage.completion_tokens,
                        mi.inputPricePerM, mi.outputPricePerM,
                      );
                    },
                    onDone: async () => {
                      nudgeCompleted = true;
                      lastResult = await invoke<string>("agent_turn_ended", { agentId: agentNodeId, role }).catch(() => "error");
                      console.log(`[pm-nudge-done] ${role} ${agentNodeId} attempt ${currentAttempt} returned: ${lastResult}`);
                    },
                    onError: (msg) => {
                      console.error(`[pm-nudge-error] ${role} ${agentNodeId} attempt ${currentAttempt}: ${msg}`);
                      nudgeCompleted = true;
                      lastResult = "error";
                    },
                    onStopped: () => {
                      nudgeCompleted = true;
                    },
                  },
                });

                // If nudge was aborted, break out
                if (!nudgeCompleted || controller.signal.aborted) {
                  break;
                }
              }

              // After max retries, force-yield if still stuck
              if (lastResult === "needs_yield") {
                console.log(`[pm-force-yield] ${role} ${agentNodeId} force-yielding after ${nudgeRetry} nudge attempts`);
                try {
                  await invoke("agent_force_yield", { agentId: agentNodeId });
                  const summary = `Auto-submitted: PM did not yield after ${nudgeRetry} nudge attempts.`;
                  await invoke("agent_set_yield_summary", { agentId: agentNodeId, diffSummary: summary });
                  updatePayload({ status: "in_review", answer: accumulatedText, toolActivity: "Auto-submitted for review", toolCalls: [] }, true, true);
                } catch (e) {
                  console.error(`[pm-force-yield-error] ${role} ${agentNodeId}: ${e}`);
                  updatePayload({ status: "error", errorMessage: `PM stuck: could not force-yield`, answer: accumulatedText, toolCalls: [] }, true, true);
                }
              } else if (lastResult === "completed" || lastResult === "already_done") {
                // PM/validator properly completed
                updatePayload({ status: "done", answer: accumulatedText, toolActivity: "", toolCalls: [] }, true, true);
              } else if (lastResult === "error") {
                updatePayload({ status: "error", errorMessage: "Agent ended with error", answer: accumulatedText, toolCalls: [] }, true, true);
              } else {
                // Unknown result - treat as done
                updatePayload({ status: "done", answer: accumulatedText, toolActivity: "", toolCalls: [] }, true, true);
              }
            } else {
              // Non-developer, non-PM roles (operator, worker, etc.) - can self-complete
              const result = await invoke<string>("agent_turn_ended", { agentId: agentNodeId, role }).catch(() => "error");
              console.log(`[agent_turn_ended] ${role} ${agentNodeId} returned: ${result}`);
              updatePayload({ status: "done", answer: fullText, toolActivity: "", toolCalls: [] }, true, true);
            }
          },
          onError: (msg) => {
            updatePayload({ status: "error", errorMessage: msg, toolCalls: [] }, true, true);
          },
          onStopped: async (fullText) => {
            if (turnTimedOut || backendRevoked) {
              const reason = turnTimedOut ? `turn timed out after ${maxTurnMs / 1000}s` : "backend revoked running state";
              if (role === "developer") {
                updatePayload({ status: "loading", toolActivity: `Recovering (${reason})…`, toolCalls: [] }, false, true);
                try {
                  await invoke("agent_force_yield", { agentId: agentNodeId });
                  const summary = `Auto-submitted: ${reason}. Accumulated text length: ${fullText.length} chars.`;
                  await invoke("agent_set_yield_summary", { agentId: agentNodeId, diffSummary: summary });
                  updatePayload({ status: "in_review", answer: fullText, toolActivity: `Auto-submitted (${reason})`, toolCalls: [] }, true, true);
                } catch {
                  updatePayload({ status: "error", errorMessage: `Agent stuck: ${reason}`, answer: fullText, toolCalls: [] }, true, true);
                }
              } else {
                // For PM/Validator: check if agent already yielded — if so, treat
                // as "in_review" rather than error so the answer stays visible.
                const agentState = await invoke<string>("agent_check_state", { agentId: agentNodeId }).catch(() => "unknown");
                const alreadyYielded = agentState === "Yielded" || agentState === "InReview" || agentState === "Done";
                if (alreadyYielded) {
                  updatePayload({ status: "in_review", answer: fullText, toolActivity: "Awaiting validation…", toolCalls: [] }, true, true);
                } else {
                  updatePayload({ status: "error", errorMessage: `Agent aborted: ${reason}`, answer: fullText, toolCalls: [] }, true, true);
                }
                invoke("agent_turn_ended", { agentId: agentNodeId, role }).catch(() => {});
              }
            } else {
              updatePayload({ status: "stopped", answer: fullText, toolActivity: "", toolCalls: [] }, true, true);
            }
          },
        },
      });

      clearTimeout(turnTimer);
      clearInterval(heartbeat);
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flushQueuedPayload();
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

      if (!promptText) return;

      // Spawn WM agent in the backend
      let newWmNodeId: string;
      try {
        const result = await invoke<{ agent_id: string }>("agent_spawn", {
          payload: {
            role: "workforce_manager",
            task_id: null,
            parent_agent_id: null,
          },
        });
        newWmNodeId = result.agent_id;
      } catch (e) {
        console.error("Failed to spawn workforce manager:", e);
        return;
      }
      
      activeWmNodeId.current = newWmNodeId;
      wmCardSessionId.current = nodeId;
      setWmNodeId(newWmNodeId);
      setWmPhase("project_setup");

      // Transform the prompt card into a wm_chat card
      setLayouts((prev) => {
        const next = prev.map((l) => {
          if (l.session_id !== nodeId) return l;
          return {
            ...l,
            node_type: "wm_chat" as CanvasNodeType,
            w: Math.max(l.w, WM_CHAT_CARD_DEFAULT_W),
            h: Math.max(l.h, WM_CHAT_CARD_DEFAULT_H),
            payload: JSON.stringify({ promptText, role: "workforce_manager" }),
          };
        });
        if (loaded.current) persistLayouts(next);
        return next;
      });

      // Add user's prompt as first message
      const userMsg: WMChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        role: "user",
        content: promptText,
        timestamp: Date.now(),
      };
      setWmConversation([userMsg]);
      setWmIsProcessing(true);

      // Build plugins for WM - use nodeId (canvas session_id) for parent references, newWmNodeId (backend) for backend calls
      const plugins = buildPlugins("workforce_manager", nodeId, newWmNodeId, null, null);

      // Run the agent turn
      const controller = new AbortController();
      abortControllers.current.set(newWmNodeId, controller);

      let accumulatedText = "";
      const toolCalls: Array<{ name: string; status: string }> = [];

      try {
        // Pre-flight: auto-sanitize zombies and build state context BEFORE the LLM turn
        const preflight = await runBeadsPreflight(layoutsRef.current);
        const systemPrompt = getPromptForRole("workforce_manager") + preflight.stateContext;

        const messages: ModelMessage[] = [userMsg].map((m) => ({
          role: m.role,
          content: m.content,
        }));

        await runAgent({
          systemPrompt,
          messages,
          plugins,
          signal: controller.signal,
          layouts: layoutsRef.current,
          callbacks: {
            onChunk: (c) => {
              if (c.type === "content" && c.text) {
                accumulatedText += c.text;
                setWmStreamingContent(accumulatedText);
              }
              if (c.type === "reasoning" && c.text) {
                accumulatedText += c.text;
                setWmStreamingContent(accumulatedText);
              }
              if (c.type === "tool") {
                if (c.state === "running" || c.state === "preparing") {
                  toolCalls.push({ name: c.name ?? "unknown", status: "running" });
                  setWmStreamingToolCalls([...toolCalls]);
                } else if ((c.state === "done" || c.state === "completed") && c.name) {
                  const tc = toolCalls.find((t) => t.name === c.name && t.status === "running");
                  if (tc) tc.status = "done";
                  setWmStreamingToolCalls([...toolCalls]);
                }
              }
            },
            onUsage: (usage) => {
              costStore.reportUsage(
                newWmNodeId, "workforce_manager", "unknown",
                usage.prompt_tokens, usage.completion_tokens, 0, 0,
              );
            },
            onDone: () => {},
            onError: () => {},
            onStopped: () => {},
          },
        });

        // Add assistant response
        const assistantMsg: WMChatMessage = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          role: "assistant",
          content: accumulatedText,
          timestamp: Date.now(),
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };
        setWmConversation((prev) => [...prev, assistantMsg]);
      } catch (e) {
        console.error("WM agent error:", e);
        const errorMsg: WMChatMessage = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          role: "assistant",
          content: `Error: ${e instanceof Error ? e.message : String(e)}`,
          timestamp: Date.now(),
        };
        setWmConversation((prev) => [...prev, errorMsg]);
      } finally {
        setWmIsProcessing(false);
        setWmStreamingContent("");
        setWmStreamingToolCalls([]);
        setWmOrchStatus("running");
        abortControllers.current.delete(newWmNodeId);
      }

      // Start orchestration
      try {
        await invoke("orch_start");
      } catch {
        /* already running or not available */
      }
    },
    [buildPlugins, persistLayouts],
  );

  /**
   * Handle sending a message to the WM in the new chat-based interface.
   * Supports multi-turn conversation - spawns WM if needed, otherwise continues conversation.
   */
  const handleWMMessage = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      // Create user message
      const userMsg: WMChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        role: "user",
        content: text.trim(),
        timestamp: Date.now(),
      };

      setWmConversation((prev) => [...prev, userMsg]);
      setWmIsProcessing(true);

      let currentWmNodeId = wmNodeId;

      // Spawn WM if not already spawned
      if (!currentWmNodeId) {
        try {
          const result = await invoke<{ agent_id: string }>("agent_spawn", {
            payload: {
              role: "workforce_manager",
              task_id: null,
              parent_agent_id: null,
            },
          });
          currentWmNodeId = result.agent_id;
          setWmNodeId(currentWmNodeId);
          activeWmNodeId.current = currentWmNodeId;
          wmCardSessionId.current = currentWmNodeId;
          setWmPhase("project_setup");

          // Create the WM agent layout for tracking
          const size = getDefaultSize("agent");
          setLayouts((prev) => {
            const newAgentLayout: SessionLayout = {
              session_id: currentWmNodeId!,
              x: 0,
              y: 0,
              w: size.w,
              h: size.h,
              collapsed: false,
              node_type: "agent",
              payload: JSON.stringify({
                role: "workforce_manager",
                status: "loading",
                answer: "",
                toolActivity: "Connecting…",
                turnStartedAt: Date.now(),
              }),
            };
            const next = repositionLayouts([...prev, newAgentLayout]);
            if (loaded.current) persistLayouts(next);
            return next;
          });

          // Start orchestration
          try {
            await invoke("orch_start");
            setWmOrchStatus("running");
          } catch {
            /* already running or not available */
          }
        } catch (e) {
          console.error("Failed to spawn workforce manager:", e);
          setWmIsProcessing(false);
          return;
        }
      }

      // Build plugins for WM - use canvas session_id for parent references, currentWmNodeId (backend) for backend calls
      const canvasCardId = wmCardSessionId.current ?? currentWmNodeId;
      const plugins = buildPlugins("workforce_manager", canvasCardId, currentWmNodeId, null, null);

      // Run the agent turn
      const controller = new AbortController();
      abortControllers.current.set(currentWmNodeId, controller);

      let accumulatedText = "";
      const toolCalls: Array<{ name: string; status: string }> = [];

      const updateAgentPayload = (update: Record<string, unknown>) => {
        setLayouts((prev) =>
          prev.map((l) => {
            if (l.session_id !== currentWmNodeId) return l;
            try {
              const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
              return { ...l, payload: JSON.stringify({ ...p, ...update }) };
            } catch {
              return l;
            }
          })
        );
      };

      try {
        // Pre-flight: auto-sanitize zombies and build state context BEFORE the LLM turn
        const preflight = await runBeadsPreflight(layoutsRef.current);
        const systemPrompt = getPromptForRole("workforce_manager") + preflight.stateContext;

        const messages: ModelMessage[] = wmConversation.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        await runAgent({
          systemPrompt,
          messages,
          plugins,
          signal: controller.signal,
          layouts: layoutsRef.current,
          callbacks: {
            onChunk: (c) => {
              if (c.type === "content" && c.text) {
                accumulatedText += c.text;
                updateAgentPayload({ status: "loading", answer: accumulatedText, toolActivity: "Generating…" });
                setWmStreamingContent(accumulatedText);
              }
              if (c.type === "reasoning" && c.text) {
                accumulatedText += c.text;
                updateAgentPayload({ status: "loading", answer: accumulatedText, toolActivity: "Reasoning…" });
                setWmStreamingContent(accumulatedText);
              }
              if (c.type === "tool") {
                const statusText =
                  c.state === "running" ? (c.status || `Running ${c.name}...`) :
                  c.state === "preparing" ? `Calling ${c.name}...` :
                  (c.state === "done" || c.state === "completed") && c.name ? `Finished: ${c.name}` : "";
                if (statusText) {
                  updateAgentPayload({ status: "loading", toolActivity: statusText });
                }
                if (c.state === "running" || c.state === "preparing") {
                  toolCalls.push({ name: c.name ?? "unknown", status: "running" });
                  setWmStreamingToolCalls([...toolCalls]);
                } else if ((c.state === "done" || c.state === "completed") && c.name) {
                  const tc = toolCalls.find((t) => t.name === c.name && t.status === "running");
                  if (tc) tc.status = "done";
                  setWmStreamingToolCalls([...toolCalls]);
                }
              }
            },
            onUsage: (usage) => {
              costStore.reportUsage(
                currentWmNodeId!, "workforce_manager", "unknown",
                usage.prompt_tokens, usage.completion_tokens, 0, 0,
              );
              invoke("agent_report_tokens", {
                agentId: currentWmNodeId,
                delta: usage.prompt_tokens + usage.completion_tokens,
              }).catch(() => {});
            },
            onDone: (fullText) => {
              updateAgentPayload({ status: "done", answer: fullText, toolActivity: "" });

              // Add assistant message to conversation
              const assistantMsg: WMChatMessage = {
                id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                role: "assistant",
                content: fullText,
                timestamp: Date.now(),
                toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
              };
              setWmConversation((prev) => [...prev, assistantMsg]);
              setWmIsProcessing(false);
              setWmStreamingContent("");
              setWmStreamingToolCalls([]);
              setWmPhase("monitoring");

              invoke("agent_turn_ended", { agentId: currentWmNodeId, role: "workforce_manager" }).catch(() => {});
            },
            onError: (msg) => {
              updateAgentPayload({ status: "error", errorMessage: msg });
              setWmIsProcessing(false);
              setWmStreamingContent("");
              setWmStreamingToolCalls([]);
            },
            onStopped: () => {
              updateAgentPayload({ status: "stopped", answer: accumulatedText, toolActivity: "" });
              setWmIsProcessing(false);
              setWmStreamingContent("");
              setWmStreamingToolCalls([]);
            },
          },
        });
      } catch (e) {
        console.error("WM conversation error:", e);
        setWmIsProcessing(false);
      }

      abortControllers.current.delete(currentWmNodeId);
    },
    [wmNodeId, buildPlugins, costStore, persistLayouts],
  );

  /**
   * Pause orchestration - called from WM chat quick actions
   */
  const handleWMPause = useCallback(async () => {
    try {
      await invoke("orch_pause");
      setWmOrchStatus("paused");
    } catch (e) {
      console.error("Failed to pause orchestration:", e);
    }
  }, []);

  /**
   * Resume orchestration - called from WM chat quick actions
   */
  const handleWMResume = useCallback(async () => {
    try {
      await invoke("orch_resume");
      setWmOrchStatus("running");
    } catch (e) {
      console.error("Failed to resume orchestration:", e);
    }
  }, []);

  /**
   * Cancel all agents - called from WM chat quick actions
   */
  const handleWMCancelAll = useCallback(async () => {
    for (const [id, controller] of abortControllers.current) {
      controller.abort();
      invoke("agent_kill", { agentId: id }).catch(() => {});
    }
    abortControllers.current.clear();
    setWmOrchStatus("idle");
    setLayouts((prev) =>
      prev.map((l) => {
        if (!["agent", "worker", "validator"].includes(l.node_type ?? "")) return l;
        try {
          const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
          if (p.status === "loading") {
            return { ...l, payload: JSON.stringify({ ...p, status: "stopped", toolActivity: "Cancelled by user" }) };
          }
        } catch { /* */ }
        return l;
      }),
    );
  }, []);

  // Auto-remove completed tasks and their children
  const completionTimesRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const interval = setInterval(() => {
      if (!loaded.current) return;
      
      const now = Date.now();
      const toRemove = new Set<string>();
      
      for (const [id, time] of completionTimesRef.current.entries()) {
        // Validators stay longer so the user can read results
        const layout = layoutsRef.current.find((l) => l.session_id === id);
        const isValidator = layout?.node_type === "validator";
        const delay = isValidator ? 120_000 : 30_000;
        if (now - time >= delay) {
          toRemove.add(id);
        }
      }
      
      if (toRemove.size > 0) {
        setLayouts((prev) => {
          // Find all children
          let added = true;
          const removeSet = new Set(toRemove);
          while (added) {
            added = false;
            for (const layout of prev) {
              if (removeSet.has(layout.session_id)) continue;
              try {
                const p = JSON.parse(layout.payload ?? "{}") as { parentAgentId?: string; parent_agent_id?: string; role?: string };
                if (layout.node_type === "beads" || p.role === "workforce_manager" || p.role === "project_manager") continue;
                const parentId = p.parentAgentId ?? p.parent_agent_id;
                if (parentId && removeSet.has(parentId)) {
                  removeSet.add(layout.session_id);
                  added = true;
                }
              } catch { /* ignore */ }
            }
          }
          
          const next = prev.filter((l) => !removeSet.has(l.session_id));
          if (next.length !== prev.length) {
            if (loaded.current) persistLayoutsRef.current(next);
            for (const id of removeSet) {
              completionTimesRef.current.delete(id);
            }
            return next;
          }
          return prev;
        });
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Update completion times when layouts change
  useEffect(() => {
    const now = Date.now();
    for (const layout of layouts) {
      try {
        const p = JSON.parse(layout.payload ?? "{}") as { status?: string; role?: string };
        if (layout.node_type === "beads" || p.role === "workforce_manager" || p.role === "project_manager") {
          completionTimesRef.current.delete(layout.session_id);
          continue;
        }
        const isFailed = p.status === "stopped" || p.status === "error";
        if (isFailed) {
          completionTimesRef.current.delete(layout.session_id);
          continue;
        }
        if (p.status === "done") {
          if (!completionTimesRef.current.has(layout.session_id)) {
            completionTimesRef.current.set(layout.session_id, now);
          }
        } else {
          completionTimesRef.current.delete(layout.session_id);
        }
      } catch { /* ignore */ }
    }
  }, [layouts]);

  // Reactive layout: watch for size changes and auto-reposition to prevent overlaps
  const prevSizesRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  
  useEffect(() => {
    if (!loaded.current) return;
    
    let needsReposition = false;
    const currentSizes = new Map<string, { w: number; h: number }>();
    
    for (const layout of layouts) {
      const h = layout.collapsed ? 48 : layout.h;
      currentSizes.set(layout.session_id, { w: layout.w, h });
      
      const prevSize = prevSizesRef.current.get(layout.session_id);
      if (prevSize && (prevSize.w !== layout.w || prevSize.h !== h)) {
        needsReposition = true;
      }
    }
    
    // Also reposition if cards were added or removed
    if (prevSizesRef.current.size !== currentSizes.size) {
      needsReposition = true;
    }
    
    prevSizesRef.current = currentSizes;
    
    if (needsReposition) {
      // Debounce the auto-reposition to avoid jitter during rapid LLM streaming
      const timer = setTimeout(() => {
        setLayouts((prev) => {
          const next = repositionLayouts(prev);
          if (loaded.current) persistLayoutsRef.current(next);
          return next;
        });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [layouts]);

  // Listen for agent_spawned events from the Rust orchestration loop
  const startAgentConversationRef = useRef(startAgentConversation);
  startAgentConversationRef.current = startAgentConversation;

  // Crash/restart recovery:
  // if the backend registry is empty but canvas has active agent cards,
  // restore those agent IDs in Rust and resume their turns from saved payload.
  useEffect(() => {
    if (!layoutsHydrated || recoveryAttemptedRef.current) return;
    recoveryAttemptedRef.current = true;

    type RecoverableLayoutPayload = {
      role?: string;
      status?: string;
      task_id?: string;
      project_path?: string;
      worktree_path?: string;
      taskDescription?: string;
      taskTitle?: string;
      sourcePromptId?: string;
      parent_agent_id?: string;
      parentAgentId?: string;
    };

    type RestoreAgentItem = {
      agent_id: string;
      role: string;
      task_id: string | null;
      parent_agent_id: string | null;
      state: string;
      project_path: string | null;
      worktree_path: string | null;
    };

    const ACTIVE_STATUSES = new Set(["loading", "running"]);
    const RECOVERABLE_ROLES = new Set([
      "workforce_manager",
      "project_manager",
      "developer",
      "operator",
      "worker",
      "validator",
      "merge_agent",
    ]);

    void (async () => {
      let usedSlots = 0;
      try {
        const status = await invoke<{ used_slots: number }>("agent_status");
        usedSlots = status.used_slots ?? 0;
      } catch {
        return;
      }
      if (usedSlots > 0) return;

      const promptById = new Map<string, string>();
      for (const l of layoutsRef.current) {
        if (l.node_type !== "prompt" || !l.payload) continue;
        try {
          const p = JSON.parse(l.payload) as { promptText?: string };
          if (p.promptText?.trim()) promptById.set(l.session_id, p.promptText.trim());
        } catch {
          // ignore malformed payload
        }
      }

      let projectPath: string | null = null;
      try {
        projectPath = await invoke<string | null>("get_beads_project_path");
      } catch {
        projectPath = null;
      }

      const candidates: Array<{
        layout: SessionLayout;
        payload: RecoverableLayoutPayload;
        restore: RestoreAgentItem;
      }> = [];
      const worktreePathFor = (basePath: string, agentId: string) => {
        const normalized = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
        return `${normalized}/.worktrees/${agentId}`;
      };
      for (const layout of layoutsRef.current) {
        if (
          layout.node_type !== "agent" &&
          layout.node_type !== "worker" &&
          layout.node_type !== "validator"
        ) {
          continue;
        }
        let payload: RecoverableLayoutPayload = {};
        try {
          payload = JSON.parse(layout.payload ?? "{}") as RecoverableLayoutPayload;
        } catch {
          continue;
        }
        const role = payload.role;
        const status = payload.status;
        if (!role || !RECOVERABLE_ROLES.has(role) || !status || !ACTIVE_STATUSES.has(status)) {
          continue;
        }
        candidates.push({
          layout,
          payload,
          restore: {
            agent_id: layout.session_id,
            role,
            task_id: payload.task_id ?? null,
            parent_agent_id: payload.parent_agent_id ?? payload.parentAgentId ?? null,
            state: "running",
            project_path: payload.project_path ?? projectPath,
            worktree_path:
              payload.worktree_path ??
              ((role === "developer" || role === "merge_agent") && (payload.project_path ?? projectPath)
                ? worktreePathFor(payload.project_path ?? projectPath ?? "", layout.session_id)
                : null),
          },
        });
      }
      if (candidates.length === 0) return;

      let restoredAgentIds = new Set<string>();
      try {
        const out = await invoke<{ restored_agent_ids?: string[] }>("agent_restore_batch", {
          payload: { agents: candidates.map((c) => c.restore) },
        });
        restoredAgentIds = new Set(out.restored_agent_ids ?? []);
      } catch {
        return;
      }
      if (restoredAgentIds.size === 0) return;

      for (const c of candidates) {
        if (!restoredAgentIds.has(c.layout.session_id)) continue;
        const role = c.restore.role as AgentRole;
        const sourcePrompt = c.payload.sourcePromptId
          ? promptById.get(c.payload.sourcePromptId)
          : "";
        const taskLabel = c.payload.taskTitle || c.payload.task_id || "unknown task";
        const resumeMessage = sourcePrompt
          ? [
              "App restarted while this agent was active.",
              "Resume from the previous objective:",
              "",
              sourcePrompt,
            ].join("\n")
          : [
              `App restarted while you were working on ${taskLabel}.`,
              "Continue implementation from current repository state, then proceed normally.",
              "",
              c.payload.taskDescription || "",
            ]
              .filter(Boolean)
              .join("\n");

        void startAgentConversationRef.current({
          agentNodeId: c.layout.session_id,
          role,
          userMessage: resumeMessage,
          taskId: c.restore.task_id,
          parentAgentId: c.restore.parent_agent_id ?? undefined,
          projectPath,
        });
      }

      try {
        await invoke("orch_start");
      } catch {
        // non-fatal; user can start orchestration manually.
      }
    })();
  }, [layoutsHydrated]);

  // Wire up dispatchAgentRef so WM's dispatch_agent tool can spawn agents.
  dispatchAgentRef.current = async (p) => {
    const result = await invoke<{ agent_id: string }>("agent_spawn", {
      payload: {
        role: p.role,
        task_id: null,
        parent_agent_id: p.parentAgentId,
      },
    });
    const agentId = result.agent_id;
    startAgentConversationRef.current({
      agentNodeId: agentId,
      role: p.role as AgentRole,
      userMessage: p.taskDescription,
      taskId: null,
      parentAgentId: p.parentAgentId,
    });
    return agentId;
  };

  useEffect(() => {
    const unlisten = listen<{
      agent_id: string;
      role: string;
      task_id: string | null;
      parent_agent_id: string | null;
      worktree_path?: string | null;
      merge_context?: {
        base_branch: string;
        task_branch: string;
        conflict_diff: string;
        task_description: string;
      } | null;
    }>("agent_spawned", async (event) => {
      const { agent_id, role, task_id, parent_agent_id, worktree_path, merge_context } = event.payload;

      let taskDescription = `Execute task ${task_id ?? "unknown"}.`;
      let taskMeta: { title?: string; type?: string; priority?: number; description?: string } | undefined;
      let resolvedProjectPath: string | null = null;
      try {
        resolvedProjectPath = await invoke<string | null>("get_beads_project_path");
      } catch { /* */ }

      // Merge agents get a specialized prompt with conflict context
      if (role === "merge_agent" && merge_context) {
        const worktreeInfo = worktree_path ? `\n\n**Your worktree path:** \`${worktree_path}\`\nAll file operations MUST use this path as the base directory.` : "";
        taskDescription = [
          `Resolve merge conflicts for task ${task_id}.`,
          ``,
          `Base branch: ${merge_context.base_branch}`,
          `Task branch: ${merge_context.task_branch}`,
          worktreeInfo,
          ``,
          `## Original task description`,
          merge_context.task_description || "(not available)",
          ``,
          `## Conflict diff`,
          merge_context.conflict_diff || "(not available)",
        ].join("\n");
      } else if (task_id && resolvedProjectPath) {
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
              const bodyText = taskMeta.description || taskMeta.title || "";
              // Include worktree path prominently for developers
              const worktreeInfo = worktree_path
                ? `\n\n**IMPORTANT - Your isolated worktree path:** \`${worktree_path}\`\nAll file operations (read, write, terminal commands) MUST use this directory as the base. Do NOT use ${resolvedProjectPath} directly.`
                : "";
              taskDescription = task_id
                ? `Task ID: ${task_id}${worktreeInfo}\n\n${bodyText}`.trim()
                : bodyText || taskDescription;
            }
          } catch {
            taskDescription = jsonOut.trim() || taskDescription;
          }
        } catch {
          /* use default description */
        }
      }

      // Use wmCardSessionId for connection lines (card session_id, not backend agent ID)
      const wmCardId = wmCardSessionId.current;
      const parentRef = parent_agent_id ?? wmCardId ?? undefined;

      startAgentConversationRef.current({
        agentNodeId: agent_id,
        role: role as AgentRole,
        userMessage: taskDescription,
        taskId: task_id,
        taskMeta,
        parentAgentId: parentRef,
        projectPath: resolvedProjectPath,
      });
    });

    return () => {
      safeUnlisten(unlisten);
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
      safeUnlisten(unlisten);
    };
  }, []);

  // Listen for validation_requested: single unified validator with smart context gathering
  useEffect(() => {
    const unlisten = listen<{
      developer_agent_id: string;
      task_id: string | null;
      git_branch: string | null;
      diff_summary: string | null;
      worktree_path: string | null;
    }>("validation_requested", async (event) => {
      const { developer_agent_id, task_id, diff_summary, worktree_path } = event.payload;

      let resolvedProjectPath: string | null = null;
      try {
        resolvedProjectPath = await invoke<string | null>("get_beads_project_path");
      } catch { /* */ }

      // Use the developer's worktree path so the validator sees the actual changes
      const validatorCwd = worktree_path || resolvedProjectPath;
      console.log(`[Validation] Spawning validator for ${developer_agent_id} in ${validatorCwd}`);

      // ── 1. Spawn 1 unified validator agent in the backend ──
      let validatorId: string;
      try {
        const result = await invoke<{ agent_id: string }>("agent_spawn", {
          payload: {
            role: "validator",
            task_id,
            parent_agent_id: developer_agent_id,
            cwd: validatorCwd,
          },
        });
        validatorId = result.agent_id;
      } catch (e) {
        console.error("Failed to spawn validator:", e);
        const submissions = getValidatorSpawnFailureSubmissions(developer_agent_id);
        type ValidationOutcome = { all_passed: boolean; retry_count: number; max_retries: number; failures: Array<{ role: string; reasons: string[] }> } | null;
        let lastOutcome: ValidationOutcome = null;
        for (const payload of submissions) {
          try {
            const outcome = await invoke<ValidationOutcome>("validation_submit", { payload });
            if (outcome) lastOutcome = outcome;
          } catch { /* best effort */ }
        }

        if (lastOutcome && !lastOutcome.all_passed && lastOutcome.retry_count < lastOutcome.max_retries) {
          startAgentConversationRef.current({
            agentNodeId: developer_agent_id,
            role: "developer",
            userMessage: [
              `## Validation Failed (attempt ${lastOutcome.retry_count}/${lastOutcome.max_retries})`,
              "",
              "Validator could not be spawned. Review your work and fix any issues.",
              "Then call yield_for_review again.",
            ].join("\n"),
            taskId: task_id,
            projectPath: validatorCwd,
          });
        }
        return;
      }

      // ── 2. Create the ValidatorCard layout ──
      const vSize = getDefaultSize("validator");
      const pendingCheck = { status: "pending" as const, reasons: [] };
      const initialResults = {
        code_review: { ...pendingCheck },
        business_logic: { ...pendingCheck },
        scope: { ...pendingCheck },
      };

      setLayouts((prev) => {
        const newLayout: SessionLayout = {
          session_id: validatorId,
          x: 0, y: 0,
          w: vSize.w, h: vSize.h,
          collapsed: false,
          node_type: "validator",
          payload: JSON.stringify({
            role: "validator",
            status: "loading",
            parent_agent_id: developer_agent_id,
            validationResults: initialResults,
          }),
        };
        const next = repositionLayouts([...prev, newLayout]);
        if (loaded.current) persistLayouts(next);
        return next;
      });

      const updateValidatorPayload = (update: Record<string, unknown>) => {
        setLayouts((prev) => {
          const next = prev.map((l) => {
            if (l.session_id !== validatorId) return l;
            try {
              const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
              return { ...l, payload: JSON.stringify({ ...p, ...update }) };
            } catch { return l; }
          });
          if (loaded.current) persistLayouts(next);
          return next;
        });
      };

      // ── 3. Gather smart context ──
      const SKIP_PATTERNS = [
        /lock\.json$/i, /lock\.yaml$/i, /yarn\.lock$/i, /pnpm-lock/i,
        /^dist\//i, /^build\//i, /^\.next\//i, /^out\//i,
        /^node_modules\//i,
        /\.min\.(js|css)$/i, /\.map$/i, /\.chunk\./i,
        /^\.beads\//i, /^\.git\//i,
        /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)$/i,
      ];
      const SOURCE_EXT = /\.(jsx?|tsx?|css|html|json|md|py|rs|go|rb|vue|svelte|toml|yaml|yml|sh|sql)$/i;

      let sourceFiles: string[] = [];
      const fileContents: Record<string, string> = {};
      let gitDiff = "";

      // Use the worktree path for context gathering so we see the developer's actual changes
      if (validatorCwd) {
        try {
          // Try git first; fall back to find if not a git repo or empty result
          let fileListOut = "";
          try {
            fileListOut = await invoke<string>("terminal_exec", {
              payload: {
                session_id: "ctx-gather",
                  command: "{ git ls-files -co --exclude-standard 2>/dev/null || true; } | awk 'NF' | sort -u | while IFS= read -r f; do git check-ignore -q --no-index \"$f\" && continue; printf '%s\\n' \"$f\"; done",
                cwd: validatorCwd,
              },
            });
          } catch { /* */ }

          if (!fileListOut.trim()) {
            try {
              fileListOut = await invoke<string>("terminal_exec", {
                payload: {
                  session_id: "ctx-gather",
                  command: "find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.next/*' | sed 's|^\\./||' | head -500",
                  cwd: validatorCwd,
                },
              });
            } catch { /* */ }
          }

          sourceFiles = fileListOut.split("\n")
            .filter((f) => f.trim() !== "")
            .filter((f) => SOURCE_EXT.test(f))
            .filter((f) => !SKIP_PATTERNS.some((p) => p.test(f)))
            .slice(0, 50);
        } catch { /* no files */ }

        for (const f of sourceFiles) {
          try {
            fileContents[f] = await invoke<string>("read_file", {
              path: `${validatorCwd}/${f}`,
            });
          } catch { /* skip unreadable */ }
        }

        // Use worktree-scoped diff when a task_id is available (agent has its own branch),
        // falling back to plain git diff for non-worktree scenarios.
        if (task_id && resolvedProjectPath) {
          try {
            gitDiff = await invoke<string>("worktree_diff", {
              projectPath: resolvedProjectPath,
              taskId: task_id,
            });
          } catch {
            try {
              gitDiff = await invoke<string>("terminal_exec", {
                payload: {
                  session_id: "ctx-gather",
                  command: "git diff HEAD 2>/dev/null || git diff 2>/dev/null || echo ''",
                  cwd: validatorCwd,
                },
              });
            } catch { /* no commits yet */ }
          }
        } else {
          try {
            gitDiff = await invoke<string>("terminal_exec", {
              payload: {
                session_id: "ctx-gather",
                command: "git diff HEAD 2>/dev/null || git diff 2>/dev/null || echo ''",
                cwd: validatorCwd,
              },
            });
          } catch { /* no commits yet */ }
        }
      }

      // ── 4. Detect frontend project and capture screenshot ──
      const hasFrontendFiles = sourceFiles.some((f) =>
        /\.(jsx|tsx|vue|svelte|html|css)$/i.test(f),
      );
      let hasDevScript = false;
      if (hasFrontendFiles) {
        try {
          const pkg = JSON.parse(fileContents["package.json"] || "{}") as {
            scripts?: Record<string, string>;
          };
          hasDevScript = !!(pkg.scripts?.dev || pkg.scripts?.start);
        } catch { /* not a node project */ }
      }
      const isFrontendProject = hasFrontendFiles && hasDevScript;

      let screenshotAttachment: Attachment | undefined;
      if (isFrontendProject && validatorCwd) {
        const ssAbort = AbortSignal.timeout(20_000);
        let devServerPid: string | null = null;
        try {
          const devCmd = fileContents["package.json"]?.includes('"dev"') ? "npm run dev" : "npm start";
          const spawnOut = await invoke<string>("terminal_exec", {
            payload: {
              session_id: `validator-dev-${validatorId}`,
              command: `cd "${validatorCwd}" && ((setsid nohup ${devCmd} > /tmp/validator-dev-${validatorId}.log 2>&1 < /dev/null & echo $!) || (nohup ${devCmd} > /tmp/validator-dev-${validatorId}.log 2>&1 < /dev/null & echo $!))`,
              cwd: validatorCwd,
              timeout_ms: 10_000,
            },
          });
          const pidMatch = spawnOut.match(/\b(\d+)\b/);
          devServerPid = pidMatch ? pidMatch[1] : null;
          await new Promise((r) => setTimeout(r, 3000));

          const ports = [5173, 3000, 4321, 8080, 8000];
          let devServerUrl = "";
          for (const port of ports) {
            try {
              const check = await invoke<string>("terminal_exec", {
                payload: {
                  session_id: "ctx-gather",
                  command: `curl -s --connect-timeout 2 --max-time 3 -o /dev/null -w "%{http_code}" http://localhost:${port} 2>/dev/null || echo "0"`,
                  cwd: "/tmp",
                  timeout_ms: 5_000,
                },
              });
              if (check.trim().startsWith("2") || check.trim().startsWith("3")) {
                devServerUrl = `http://localhost:${port}`;
                break;
              }
            } catch { /* port not responding */ }
          }

          if (devServerUrl) {
            // Run browser setup under the validator agent to avoid depending on
            // developer state transitions (developer may already be in_review).
            const browserPort = await invoke<number>("browser_ensure_started", { agentId: validatorId });
            const sessionResp = await fetch(`http://127.0.0.1:${browserPort}/session`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: `validator-${validatorId}` }),
              signal: ssAbort,
            });
            if (!sessionResp.ok) {
              console.warn(`[Validator] Failed to create browser session: ${sessionResp.status}`);
            } else {
              const navResp = await fetch(`http://127.0.0.1:${browserPort}/session/validator-${validatorId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "navigate", params: { url: devServerUrl } }),
                signal: ssAbort,
              });
              if (!navResp.ok) {
                console.warn(`[Validator] Failed to navigate browser: ${navResp.status}`);
              } else {
                await new Promise((r) => setTimeout(r, 2000));
                const ssResp = await fetch(`http://127.0.0.1:${browserPort}/session/validator-${validatorId}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "screenshot", params: {} }),
                  signal: ssAbort,
                });
                if (ssResp.ok) {
                  const ssData = await ssResp.json() as { data?: string };
                  if (ssData.data) {
                    screenshotAttachment = { data: ssData.data, mimeType: "image/jpeg" };
                    updateValidatorPayload({
                      validationResults: { ...initialResults, visual: { status: "pending", reasons: [] } },
                    });
                  }
                } else {
                  console.warn(`[Validator] Failed to take screenshot: ${ssResp.status}`);
                }
              }
            }
          }
        } catch (e) {
          console.warn("Visual validator screenshot failed:", e);
        } finally {
          if (devServerPid) {
            invoke("validator_cleanup_process_tree", {
              payload: {
                session_id: `validator-dev-${validatorId}`,
                pid: Number(devServerPid),
                cwd: resolvedProjectPath,
              },
            }).catch(() => {});
          }
        }
      }

      // ── 5. Build comprehensive message ──
      const devLayout = layoutsRef.current.find((l) => l.session_id === developer_agent_id);
      let taskDesc = "";
      if (devLayout?.payload) {
        try {
          const dp = JSON.parse(devLayout.payload) as { taskDescription?: string };
          taskDesc = dp.taskDescription ?? "";
        } catch { /* */ }
      }

      const msgParts = [
        `## Task`,
        `Task ID: ${task_id ?? "unknown"}`,
        taskDesc ? `Description: ${taskDesc}` : "",
        "",
        `## Developer Summary`,
        diff_summary ?? "No summary provided.",
        "",
        `## File Listing (${sourceFiles.length} files)`,
        sourceFiles.join("\n"),
        "",
      ];

      const fileEntries = Object.entries(fileContents);
      if (fileEntries.length > 0) {
        msgParts.push("## File Contents");
        for (const [path, content] of fileEntries) {
          const truncated = content.length > 5000 ? content.slice(0, 5000) + "\n... (truncated)" : content;
          msgParts.push(`### ${path}\n\`\`\`\n${truncated}\n\`\`\`\n`);
        }
      }

      if (gitDiff.trim()) {
        const diffTruncated = gitDiff.length > 10000 ? gitDiff.slice(0, 10000) + "\n... (truncated)" : gitDiff;
        msgParts.push(`## Git Diff\n\`\`\`diff\n${diffTruncated}\n\`\`\`\n`);
      }

      const userMessage = msgParts.filter(Boolean).join("\n");

      // ── 6. Run single LLM call (no tools) ──
      const controller = new AbortController();
      abortControllers.current.set(validatorId, controller);

      let accumulatedText = "";
      let validatorError: string | null = null;
      try {
        await runAgent({
          systemPrompt: getPromptForRole("validator"),
          userMessage,
          plugins: [],
          signal: controller.signal,
          attachment: screenshotAttachment,
          callbacks: {
            onChunk: (c) => {
              if ((c.type === "content" || c.type === "reasoning") && c.text) {
                accumulatedText += c.text;
              }
            },
            onUsage: (usage) => {
              costStore.reportUsage(
                validatorId, "validator", "unknown",
                usage.prompt_tokens, usage.completion_tokens, 0, 0,
              );
              invoke("agent_report_tokens", {
                agentId: validatorId,
                delta: usage.prompt_tokens + usage.completion_tokens,
              }).catch(() => {});
            },
            onDone: () => { /* handled below */ },
            onError: (msg) => { validatorError = msg; },
            onStopped: () => { validatorError = "Validator was stopped"; },
          },
        });
      } catch (e) {
        validatorError = e instanceof Error ? e.message : String(e);
        console.error(`[Validator] LLM error for ${validatorId}:`, validatorError);
      }

      abortControllers.current.delete(validatorId);

      // ── 7. Parse LLM JSON output → submit validation results ──
      type CheckResult = { status: "pass" | "fail"; reasons: string[]; out_of_scope_files?: string[] };
      
      // If there was an error and no output, create a clear failure message
      let parsed;
      if (validatorError && !accumulatedText.trim()) {
        const errorReason = `Validator LLM failed: ${validatorError}`;
        console.error(`[Validator] ${validatorId} failed with no output:`, validatorError);
        parsed = {
          code_review: { status: "fail" as const, reasons: [errorReason] },
          business_logic: { status: "fail" as const, reasons: [errorReason] },
          scope: { status: "fail" as const, reasons: [errorReason] },
        };
      } else {
        parsed = normalizeValidatorOutput(accumulatedText);
      }
      const checkKeys = ["code_review", "business_logic", "scope"] as const;

      // Update the card with final results
      const finalResults: Record<string, CheckResult> = {
        code_review: parsed.code_review,
        business_logic: parsed.business_logic,
        scope: parsed.scope,
      };
      if (parsed.visual) finalResults.visual = parsed.visual;

      updateValidatorPayload({
        status: "done",
        validationResults: finalResults,
      });

      // Complete the validator agent
      invoke("agent_turn_ended", { agentId: validatorId, role: "validator" }).catch(() => {});

      // ── 8. Submit 3 validation_submit calls to the backend ──
      type ValidationOutcome = {
        all_passed: boolean;
        retry_count: number;
        max_retries: number;
        failures: { role: string; reasons: string[] }[];
      } | null;
      let lastOutcome: ValidationOutcome = null;

      for (const k of checkKeys) {
        const check = parsed[k];
        let pass = check.status === "pass";
        if (k === "scope" && parsed.visual && parsed.visual.status === "fail") {
          pass = false;
        }
        try {
          const outcome = await invoke<ValidationOutcome>("validation_submit", {
            payload: {
              developer_agent_id,
              validator_role: k,
              pass,
              reasons: check.status === "fail" ? check.reasons : (
                k === "scope" && parsed.visual?.status === "fail" ? parsed.visual.reasons : []
              ),
            },
          });
          if (outcome) lastOutcome = outcome;
        } catch { /* best effort */ }
      }

      // ── 9. Update developer card status based on validation outcome ──
      if (lastOutcome?.all_passed) {
        setLayouts((prev) => {
          const next = prev.map((l) => {
            if (l.session_id !== developer_agent_id) return l;
            try {
              const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
              return { ...l, payload: JSON.stringify({ ...p, status: "done", toolActivity: "Validation passed" }) };
            } catch { return l; }
          });
          if (loaded.current) persistLayoutsRef.current(next);
          return next;
        });
      } else if (lastOutcome && !lastOutcome.all_passed && lastOutcome.retry_count >= lastOutcome.max_retries) {
        setLayouts((prev) => {
          const next = prev.map((l) => {
            if (l.session_id !== developer_agent_id) return l;
            try {
              const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
              return { ...l, payload: JSON.stringify({ ...p, status: "stopped", toolActivity: "Validation failed — max retries reached" }) };
            } catch { return l; }
          });
          if (loaded.current) persistLayoutsRef.current(next);
          return next;
        });
      }

      // ── 10. Handle retry flow (if validation failed but retries remain) ──
      if (lastOutcome && !lastOutcome.all_passed && lastOutcome.retry_count < lastOutcome.max_retries) {
        const feedbackParts = [
          `## Validation Failed (attempt ${lastOutcome.retry_count}/${lastOutcome.max_retries})`,
          "",
        ];
        for (const f of lastOutcome.failures) {
          feedbackParts.push(`### ${f.role}`);
          for (const r of f.reasons) feedbackParts.push(`- ${r}`);
          feedbackParts.push("");
        }
        if (parsed.visual?.status === "fail") {
          feedbackParts.push("### Visual");
          for (const r of parsed.visual.reasons) feedbackParts.push(`- ${r}`);
          feedbackParts.push("");
        }
        feedbackParts.push("Fix ONLY the issues listed above. Stay within task scope. Then call yield_for_review again.");

        const retryMessage = taskDesc
          ? `## Original Task\n${taskDesc}\n\n${feedbackParts.join("\n")}`
          : feedbackParts.join("\n");

        startAgentConversationRef.current({
          agentNodeId: developer_agent_id,
          role: "developer",
          userMessage: retryMessage,
          taskId: task_id,
          projectPath: resolvedProjectPath,
        });
      }
    });

    return () => {
      safeUnlisten(unlisten);
    };
  }, []);

  // Listen for pm_validation_requested: validate PM's task breakdown
  useEffect(() => {
    const unlisten = listen<{
      pm_agent_id: string;
      epic_id: string | null;
    }>("pm_validation_requested", async (event) => {
      const { pm_agent_id, epic_id } = event.payload;

      console.log(`[PM Validation] Processing validation request for PM ${pm_agent_id}, epic ${epic_id}`);

      let resolvedProjectPath: string | null = null;
      try {
        resolvedProjectPath = await invoke<string | null>("get_beads_project_path");
      } catch { /* */ }

      if (!resolvedProjectPath || !epic_id) {
        console.error("[PM Validation] Missing project path or epic ID");
        try {
          await invoke<boolean>("pm_validation_submit", {
            payload: {
              pm_agent_id,
              dag_passed: false,
              sequencing_passed: false,
              errors: ["Missing project path or epic ID for validation"],
            },
          });
        } catch { /* best effort */ }
        return;
      }

      // ── 1. Fetch all tasks that are children of this epic ──
      let tasks: BeadsTask[] = [];
      try {
        const stdout = await invoke<string>("beads_run", {
          projectPath: resolvedProjectPath,
          args: ["list", "--parent", epic_id, "--json"],
        });
        const parsed = JSON.parse(stdout);
        tasks = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
      } catch (e) {
        console.error("[PM Validation] Failed to fetch tasks:", e);
        try {
          await invoke<boolean>("pm_validation_submit", {
            payload: {
              pm_agent_id,
              dag_passed: false,
              sequencing_passed: false,
              errors: [`Failed to fetch tasks: ${e instanceof Error ? e.message : String(e)}`],
            },
          });
        } catch { /* best effort */ }
        return;
      }

      if (tasks.length === 0) {
        console.warn("[PM Validation] No tasks found for epic");
        try {
          await invoke<boolean>("pm_validation_submit", {
            payload: {
              pm_agent_id,
              dag_passed: false,
              sequencing_passed: false,
              errors: ["No tasks were created for this epic. PM must create at least one task."],
            },
          });
        } catch { /* best effort */ }
        return;
      }

      console.log(`[PM Validation] Found ${tasks.length} tasks for epic ${epic_id}`);

      // ── 2. Run DAG validator (deterministic, code-based) ──
      const dagResult = validateDAG(tasks, epic_id);
      console.log(`[PM Validation] DAG validation: ${dagResult.valid ? "PASS" : "FAIL"}`, dagResult.errors);

      // ── 3. Run Sequencing validator (LLM-based) ──
      let sequencingPassed = true;
      const sequencingErrors: string[] = [];

      if (dagResult.valid) {
        try {
          const userMessage = buildSequencingValidatorPrompt(tasks);
          let accumulatedText = "";
          const abortController = new AbortController();

          await runAgent({
            systemPrompt: SEQUENCING_VALIDATOR_PROMPT,
            userMessage,
            plugins: [],
            signal: abortController.signal,
            callbacks: {
              onChunk: (c) => {
                if ((c.type === "content" || c.type === "reasoning") && c.text) {
                  accumulatedText += c.text;
                }
              },
              onUsage: (usage) => {
                costStore.reportUsage(
                  `pm-validator-${pm_agent_id}`, "validator", "unknown",
                  usage.prompt_tokens, usage.completion_tokens, 0, 0,
                );
              },
              onDone: () => {},
              onError: () => {},
              onStopped: () => {},
            },
          });

          const seqResult = parseSequencingValidatorResponse(accumulatedText);
          sequencingPassed = seqResult.valid;
          sequencingErrors.push(...seqResult.reasons);
          console.log(`[PM Validation] Sequencing validation: ${seqResult.valid ? "PASS" : "FAIL"}`, seqResult.reasons);
        } catch (e) {
          console.error("[PM Validation] Sequencing validator failed:", e);
          sequencingPassed = false;
          sequencingErrors.push(`Sequencing validator failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        // Skip sequencing validation if DAG failed
        sequencingPassed = false;
      }

      // ── 4. Combine results and submit ──
      const allErrors = [...dagResult.errors, ...sequencingErrors];

      try {
        const passed = await invoke<boolean>("pm_validation_submit", {
          payload: {
            pm_agent_id,
            dag_passed: dagResult.valid,
            sequencing_passed: sequencingPassed,
            errors: allErrors,
          },
        });

        console.log(`[PM Validation] Submitted results: ${passed ? "PASSED" : "FAILED"}`);

        // ── 5. If passed, promote all deferred tasks ──
        // Tasks are created with status "open" but defer_until set to 100 years in the future.
        // We need to clear defer_until for all tasks that have it set.
        if (passed) {
          console.log(`[PM Validation] Promoting deferred tasks for epic ${epic_id}`);
          let promotedCount = 0;
          for (const task of tasks) {
            // Check if task has a defer_until date set (tasks are "open" status but deferred via this field)
            if (task.defer_until) {
              try {
                await invoke<string>("beads_run", {
                  projectPath: resolvedProjectPath,
                  args: ["update", task.id, "--defer", ""],
                });
                promotedCount++;
                console.log(`[PM Validation] Promoted task ${task.id} (cleared defer_until)`);
              } catch (e) {
                console.error(`[PM Validation] Failed to promote task ${task.id}:`, e);
              }
            }
          }
          console.log(`[PM Validation] Promoted ${promotedCount}/${tasks.length} tasks`);

          // Update the PM card UI to show "done" status and clear pmExecutionPhase
          setLayouts((prev) => {
            const next = prev.map((layout) => {
              if (layout.session_id === pm_agent_id && layout.node_type === "agent") {
                try {
                  const payload = JSON.parse(layout.payload || "{}");
                  // Clear pmExecutionPhase so the phase footer doesn't show
                  const { pmExecutionPhase: _, ...rest } = payload;
                  return {
                    ...layout,
                    payload: JSON.stringify({ ...rest, status: "done" }),
                  };
                } catch {
                  return layout;
                }
              }
              return layout;
            });
            if (loaded.current) persistLayouts(next);
            return next;
          });
          console.log(`[PM Validation] Updated PM ${pm_agent_id} card status to done`);
        }

        // ── 6. If failed, send feedback to PM agent ──
        if (!passed) {
          const pmResult = runPMValidation(
            tasks,
            epic_id,
            sequencingPassed ? undefined : { valid: false, missingSequences: [], reasons: sequencingErrors }
          );
          // Include full task list and epic ID so PM has context
          const feedback = formatPMValidationFeedback(pmResult, tasks, epic_id);

          startAgentConversationRef.current({
            agentNodeId: pm_agent_id,
            role: "project_manager",
            userMessage: feedback,
            taskId: epic_id,
            projectPath: resolvedProjectPath,
          });
        }
      } catch (e) {
        console.error("[PM Validation] Failed to submit results:", e);
      }
    });

    return () => {
      safeUnlisten(unlisten);
    };
  }, []);

  const handleAddPrompt = useCallback(() => {
    setLayouts((prev) => {
      const newLayout: SessionLayout = {
        session_id: generateNodeId(),
        x: 0,
        y: 0,
        w: PROMPT_CARD_DEFAULT_W,
        h: PROMPT_CARD_DEFAULT_H,
        collapsed: false,
        node_type: "prompt",
        payload: JSON.stringify({ promptText: "" }),
      };
      const next = repositionLayouts([...prev, newLayout]);
      if (loaded.current) persistLayouts(next);
      return next;
    });
  }, [persistLayouts]);

  const handleClearCanvas = useCallback(async () => {
    // 1. Abort all running LLM streams
    for (const [, controller] of abortControllers.current) {
      controller.abort();
    }
    abortControllers.current.clear();
    activeWmNodeId.current = null;
    wmCardSessionId.current = null;

    // 2. Clear frontend layouts + persist
    setLayouts([]);
    try {
      await invoke("save_canvas_layout", { payload: { layouts: [] } });
    } catch { /* ignore */ }

    // 3. Clear WM conversation state
    setWmConversation([]);
    setWmNodeId(null);
    setWmPhase("initial");
    setWmIsProcessing(false);
    setWmOrchStatus("idle");
    try {
      await invoke("clear_wm_conversation");
    } catch { /* ignore */ }

    // 4. Full backend reset: pause orchestration, kill all agents/PTYs, clear beads path
    try {
      await invoke("full_reset");
    } catch (e) {
      console.warn("full_reset failed", e);
    }

    // 5. Clear cost/usage tracking (including localStorage)
    costStore.reset();
  }, [costStore]);

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

  type DebugHistorySample = {
    capturedAt: string;
    reason: string;
    payload: Record<string, unknown>;
  };

  const [debugCopied, setDebugCopied] = useState(false);
  const debugHistoryRef = useRef<DebugHistorySample[]>([]);
  const debugHistoryCaptureInFlightRef = useRef(false);

  const buildDebugPayload = useCallback(async () => {
    const snap = layoutsRef.current.map((l) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(l.payload ?? "{}"); } catch { /* */ }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const validationResults = (parsed as any).validationResults as Record<string, { status: string; reasons: string[] }> | undefined;
      return {
        id: l.session_id,
        type: l.node_type ?? "agent",
        pos: { x: l.x, y: l.y, w: l.w, h: l.h },
        collapsed: l.collapsed,
        ...(parsed.role ? { role: parsed.role } : {}),
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.taskTitle ? { taskTitle: parsed.taskTitle } : {}),
        ...(parsed.taskDescription ? { taskDescription: String(parsed.taskDescription).slice(0, 500) } : {}),
        ...(parsed.task_id ? { task_id: parsed.task_id } : {}),
        ...(parsed.parent_agent_id ? { parent_agent_id: parsed.parent_agent_id } : {}),
        ...(parsed.answer ? { content: String(parsed.answer).slice(-1200) } : {}),
        ...(parsed.promptText ? { promptText: String(parsed.promptText).slice(0, 500) } : {}),
        ...(parsed.beadsStatus ? { beads: parsed.beadsStatus } : {}),
        ...(parsed.toolActivity ? { toolActivity: parsed.toolActivity } : {}),
        ...(parsed.errorMessage ? { errorMessage: parsed.errorMessage } : {}),
        ...(validationResults ? { validationResults } : {}),
        ...(parsed.terminalLog ? { terminalLog: (parsed.terminalLog as Array<{command: string; output: string}>).slice(-5).map(e => ({ cmd: e.command, out: e.output?.slice(-500) })) } : {}),
      };
    });

    let beadsProject = "";
    try { beadsProject = await invoke<string>("get_beads_project_path") ?? ""; } catch { /* */ }

    let backendState: unknown = null;
    try { backendState = await invoke("debug_snapshot"); } catch { /* */ }

    let orchState: unknown = null;
    try { orchState = await invoke("orch_get_state"); } catch { /* */ }
    let orchMetrics: unknown = null;
    try { orchMetrics = await invoke("orch_get_metrics"); } catch { /* */ }
    let safetyMode: boolean | null = null;
    try { safetyMode = await invoke<boolean>("get_safety_mode"); } catch { /* */ }

    return {
      ts: new Date().toISOString(),
      beadsProject,
      orchState,
      orchMetrics,
      safetyMode,
      totalCostUsd: costStore.getState().totalCostUsd,
      costLimitUsd: costStore.getState().costLimitUsd,
      nodeCount: snap.length,
      nodes: snap,
      backend: backendState,
    };
  }, [costStore]);

  const appendDebugHistory = useCallback(async (reason: string) => {
    if (debugHistoryCaptureInFlightRef.current) return;
    debugHistoryCaptureInFlightRef.current = true;
    try {
      const payload = await buildDebugPayload();
      debugHistoryRef.current.push({
        capturedAt: new Date().toISOString(),
        reason,
        payload,
      });
      if (debugHistoryRef.current.length > DEBUG_HISTORY_MAX_SAMPLES) {
        debugHistoryRef.current = debugHistoryRef.current.slice(-DEBUG_HISTORY_MAX_SAMPLES);
      }
    } finally {
      debugHistoryCaptureInFlightRef.current = false;
    }
  }, [buildDebugPayload]);

  useEffect(() => {
    appendDebugHistory("startup").catch(() => {});
    const intervalId = window.setInterval(() => {
      appendDebugHistory("interval").catch(() => {});
    }, DEBUG_HISTORY_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [appendDebugHistory]);

  const handleCopyDebug = useCallback(async () => {
    const current = await buildDebugPayload();
    const history = debugHistoryRef.current.slice(-DEBUG_HISTORY_COPY_SAMPLES);
    const debug = {
      ...current,
      backgroundHistory: {
        intervalMs: DEBUG_HISTORY_INTERVAL_MS,
        sampleCount: debugHistoryRef.current.length,
        includedSamples: history.length,
        samples: history,
      },
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
    appendDebugHistory("copy_debug").catch(() => {});
    setDebugCopied(true);
    setTimeout(() => setDebugCopied(false), 2000);
  }, [appendDebugHistory, buildDebugPayload]);

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
          onRemoveLayout={handleRemoveLayout}
          onPromptChange={handlePromptChange}
          onLaunch={handleLaunch}
          onStopAgent={handleStopAgent}
          onAddTaskCard={handleAddTaskCard}
          onBeadsStatusChange={updateBeadsStatus}
          wmChatMessages={wmConversation}
          wmPhase={wmPhase}
          wmIsProcessing={wmIsProcessing}
          wmStreamingContent={wmStreamingContent}
          wmStreamingToolCalls={wmStreamingToolCalls}
          wmTaskProgress={wmTaskProgress}
          wmOrchStatus={wmOrchStatus}
          onWMSendMessage={handleWMMessage}
          onWMPause={handleWMPause}
          onWMResume={handleWMResume}
          onWMCancelAll={handleWMCancelAll}
        />
        <WorkforceOverlay wmPhase={wmPhase} orchStatus={wmOrchStatus} />
        <DebugPanel
          onCopyDebug={handleCopyDebug}
          debugCopied={debugCopied}
          onStopAll={handleStopAll}
        />
      </div>
    </CostStoreContext.Provider>
  );
}
