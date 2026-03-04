/**
 * WM Reducer — the frontend's "dumb" state machine for WM events.
 *
 * The backend (Rust) owns all decision logic and emits WmEvents.
 * This reducer applies those events to produce the next UI state.
 * Zero business logic here — just state transitions driven by events.
 */

// ---------------------------------------------------------------------------
// Types matching the Rust WmEvent enum (serde tag = "type")
// ---------------------------------------------------------------------------

export type WmPhase =
  | "idle"
  | "inspecting"
  | "completed"
  | "setting_up"
  | "monitoring"
  | "error";

export interface Diagnostics {
  path_source: string;
  project_path: string | null;
  total_tasks: number;
  closed_epics: string[];
  open_epics: string[];
  active_agent_task_ids: string[];
  close_attempts: number;
  close_succeeded: number;
  close_failed: { id: string; error: string }[];
  final_state: string;
  remaining_count: number;
  remaining_ids: string[];
}

export interface WmChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type WmEvent =
  | { type: "PhaseChanged"; phase: WmPhase }
  | { type: "ShortCircuit"; message: string; diagnostics: Diagnostics }
  | {
      type: "RunLlm";
      system_prompt: string;
      state_context: string;
      remove_tools: string[];
      prompt_variant: string;
      diagnostics: Diagnostics;
      messages: WmChatMessage[];
    }
  | { type: "LlmDone" }
  | { type: "ShowError"; message: string; diagnostics: Diagnostics | null }
  | { type: "OrchStatusChanged"; status: string }
  | { type: "MessageAdded"; role: string; content: string };

// ---------------------------------------------------------------------------
// UI State
// ---------------------------------------------------------------------------

export interface LlmConfig {
  systemPrompt: string;
  stateContext: string;
  removeTools: string[];
  promptVariant: string;
}

export interface WmUiState {
  phase: WmPhase;
  conversation: WmChatMessage[];
  isProcessing: boolean;
  orchStatus: "running" | "paused" | "idle";
  diagnostics: Diagnostics | null;
  llmConfig: LlmConfig | null;
}

export const initialWmUiState: WmUiState = {
  phase: "idle",
  conversation: [],
  isProcessing: false,
  orchStatus: "idle",
  diagnostics: null,
  llmConfig: null,
};

// ---------------------------------------------------------------------------
// Hydration action (from wm_get_state on reload)
// ---------------------------------------------------------------------------

export type WmReducerAction =
  | WmEvent
  | { type: "HYDRATE"; state: { phase: WmPhase; conversation: WmChatMessage[] } };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function wmReducer(state: WmUiState, action: WmReducerAction): WmUiState {
  switch (action.type) {
    case "PhaseChanged":
      return { ...state, phase: action.phase };

    case "ShortCircuit": {
      const lastSc = state.conversation[state.conversation.length - 1];
      const alreadyHas = lastSc && lastSc.role === "assistant" && lastSc.content === action.message;
      return {
        ...state,
        phase: "completed",
        isProcessing: false,
        conversation: alreadyHas
          ? state.conversation
          : [...state.conversation, { role: "assistant", content: action.message }],
        diagnostics: action.diagnostics,
        llmConfig: null,
      };
    }

    case "RunLlm":
      return {
        ...state,
        phase: "setting_up",
        isProcessing: true,
        llmConfig: {
          systemPrompt: action.system_prompt,
          stateContext: action.state_context,
          removeTools: action.remove_tools,
          promptVariant: action.prompt_variant,
        },
        diagnostics: action.diagnostics,
      };

    case "LlmDone":
      return {
        ...state,
        phase: "monitoring",
        isProcessing: false,
        llmConfig: null,
      };

    case "ShowError":
      return {
        ...state,
        phase: "error",
        isProcessing: false,
        conversation: [
          ...state.conversation,
          { role: "assistant", content: action.message },
        ],
        diagnostics: action.diagnostics,
        llmConfig: null,
      };

    case "OrchStatusChanged":
      return {
        ...state,
        orchStatus: action.status as WmUiState["orchStatus"],
      };

    case "MessageAdded": {
      const last = state.conversation[state.conversation.length - 1];
      if (last && last.role === action.role && last.content === action.content) {
        return state;
      }
      return {
        ...state,
        conversation: [
          ...state.conversation,
          { role: action.role as "user" | "assistant", content: action.content },
        ],
      };
    }

    case "HYDRATE":
      return {
        ...state,
        phase: action.state.phase,
        conversation: action.state.conversation,
        isProcessing: false,
      };

    default:
      return state;
  }
}
