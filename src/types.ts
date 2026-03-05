export interface BeadsDependency {
  issue_id: string;
  depends_on_id: string;
  type: "blocks" | "parent-child" | string;
}

export interface BeadsTask {
  id: string;
  title: string;
  type: string;
  status: string;
  description?: string;
  body?: string;
  issue_type?: string;
  priority?: number;
  deps?: string[] | string;
  blocked_by?: string[] | string;
  dependencies?: BeadsDependency[];
  dependency_count?: number;
  parent?: string;
  parent_id?: string;
  parentId?: string;
  epic_id?: string;
  epic_name?: string;
  labels?: string[];
  assignee?: string;
  reporter?: string;
  created_at?: string;
  updated_at?: string;
  defer_until?: string;
}

export type CanvasNodeType = "prompt" | "agent" | "terminal" | "terminal_log" | "browser" | "worker" | "validator" | "beads" | "beads_task" | "wm_chat";


/** Agent roles from orchestration (plan §1.2). Used in layout payload for hierarchy and sizing. */
export type AgentRole =
  | "workforce_manager"
  | "project_manager"
  | "developer"
  | "operator"
  | "worker"
  | "validator"
  | "merge_agent";

export interface SessionLayout {
  session_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
  node_type?: CanvasNodeType;
  /** JSON: e.g. { "promptText": "..." } or { "role": "developer", "parent_agent_id": "…", "task_id": "bd-xxx" } */
  payload?: string;
}

export interface CanvasLayoutPayload {
  layouts: SessionLayout[];
}

export const PROMPT_CARD_MIN_W = 320;
export const PROMPT_CARD_MIN_H = 180;
export const SESSION_CARD_MIN_W = 280;
export const SESSION_CARD_MIN_H = 200;
export const SESSION_CARD_DEFAULT_W = 520;
export const SESSION_CARD_DEFAULT_H = 420;
/** Max height for agent cards when auto-growing with content */
export const SESSION_CARD_MAX_H = 720;
export const PROMPT_CARD_DEFAULT_W = 480;
export const PROMPT_CARD_DEFAULT_H = 220;
export const TERMINAL_CARD_DEFAULT_W = 560;
export const TERMINAL_CARD_DEFAULT_H = 360;
export const TERMINAL_CARD_MIN_W = 360;
export const TERMINAL_CARD_MIN_H = 240;
export const TERMINAL_LOG_DEFAULT_W = 480;
export const TERMINAL_LOG_DEFAULT_H = 360;
export const TERMINAL_LOG_MIN_W = 320;
export const TERMINAL_LOG_MIN_H = 200;
export const BROWSER_CARD_DEFAULT_W = 680;
export const BROWSER_CARD_DEFAULT_H = 480;
export const BROWSER_CARD_MIN_W = 400;
export const BROWSER_CARD_MIN_H = 300;
/** Mini cards for worker / validator nodes (plan §6). */
export const WORKER_CARD_DEFAULT_W = 200;
export const WORKER_CARD_DEFAULT_H = 80;
export const WORKER_CARD_MIN_W = 120;
export const WORKER_CARD_MIN_H = 48;
export const VALIDATOR_CARD_DEFAULT_W = 300;
export const VALIDATOR_CARD_DEFAULT_H = 200;
/** Beads project/task-graph card. */
export const BEADS_CARD_DEFAULT_W = 520;
export const BEADS_CARD_DEFAULT_H = 360;
export const BEADS_CARD_MIN_W = 360;
export const BEADS_CARD_MIN_H = 200;
export const BEADS_CARD_MAX_H = 720;
export const BEADS_TASK_CARD_DEFAULT_W = 380;
export const BEADS_TASK_CARD_DEFAULT_H = 280;
export const BEADS_TASK_CARD_MIN_W = 320;
export const BEADS_TASK_CARD_MIN_H = 220;
export const WM_CHAT_CARD_DEFAULT_W = 480;
export const WM_CHAT_CARD_DEFAULT_H = 480;
export const WM_CHAT_CARD_MIN_W = 400;
export const WM_CHAT_CARD_MIN_H = 360;
export const GRID_STEP = 40;
export const CULL_MARGIN = 100;

export function getDefaultSize(nodeType: CanvasNodeType): { w: number; h: number } {
  switch (nodeType) {
    case "prompt":
      return { w: PROMPT_CARD_DEFAULT_W, h: PROMPT_CARD_DEFAULT_H };
    case "worker":
      return { w: WORKER_CARD_DEFAULT_W, h: WORKER_CARD_DEFAULT_H };
    case "validator":
      return { w: VALIDATOR_CARD_DEFAULT_W, h: VALIDATOR_CARD_DEFAULT_H };
    case "beads":
      return { w: BEADS_CARD_DEFAULT_W, h: BEADS_CARD_DEFAULT_H };
    case "beads_task":
      return { w: BEADS_TASK_CARD_DEFAULT_W, h: BEADS_TASK_CARD_DEFAULT_H };
    case "terminal_log":
      return { w: TERMINAL_LOG_DEFAULT_W, h: TERMINAL_LOG_DEFAULT_H };
    case "wm_chat":
      return { w: WM_CHAT_CARD_DEFAULT_W, h: WM_CHAT_CARD_DEFAULT_H };
    default:
      return { w: SESSION_CARD_DEFAULT_W, h: SESSION_CARD_DEFAULT_H };
  }
}

export function getMinSize(nodeType: CanvasNodeType): { w: number; h: number } {
  switch (nodeType) {
    case "prompt":
      return { w: PROMPT_CARD_MIN_W, h: PROMPT_CARD_MIN_H };
    case "worker":
      return { w: WORKER_CARD_MIN_W, h: WORKER_CARD_MIN_H };
    case "validator":
      return { w: WORKER_CARD_MIN_W, h: WORKER_CARD_MIN_H };
    case "beads":
      return { w: BEADS_CARD_MIN_W, h: BEADS_CARD_MIN_H };
    case "beads_task":
      return { w: BEADS_TASK_CARD_MIN_W, h: BEADS_TASK_CARD_MIN_H };
    case "terminal_log":
      return { w: TERMINAL_LOG_MIN_W, h: TERMINAL_LOG_MIN_H };
    case "wm_chat":
      return { w: WM_CHAT_CARD_MIN_W, h: WM_CHAT_CARD_MIN_H };
    default:
      return { w: SESSION_CARD_MIN_W, h: SESSION_CARD_MIN_H };
  }
}

export interface LlmSettings {
  provider: string;
  model: string;
}

/** Provider IDs supported by multi-llm-ts (loadModels). */
export const LLM_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "kilo",
  "azure",
  "cerebras",
  "deepseek",
  "google",
  "groq",
  "lmstudio",
  "meta",
  "mistralai",
  "ollama",
  "openrouter",
  "xai",
] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

/** Display names for provider dropdown. */
export const LLM_PROVIDER_LABELS: Record<LlmProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  kilo: "Kilo AI",
  azure: "Azure AI",
  cerebras: "Cerebras",
  deepseek: "DeepSeek",
  google: "Google",
  groq: "Groq",
  lmstudio: "LM Studio",
  meta: "Meta / Llama",
  mistralai: "Mistral AI",
  ollama: "Ollama",
  openrouter: "OpenRouter",
  xai: "xAI",
};
