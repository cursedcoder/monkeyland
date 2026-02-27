export type CanvasNodeType = "prompt" | "agent";

export interface SessionLayout {
  session_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
  node_type?: CanvasNodeType;
  payload?: string; // JSON: e.g. { "promptText": "..." }
}

export interface CanvasLayoutPayload {
  layouts: SessionLayout[];
}

export const PROMPT_CARD_MIN_W = 320;
export const PROMPT_CARD_MIN_H = 180;
export const SESSION_CARD_MIN_W = 280;
export const SESSION_CARD_MIN_H = 200;
export const SESSION_CARD_DEFAULT_W = 400;
export const SESSION_CARD_DEFAULT_H = 300;
export const PROMPT_CARD_DEFAULT_W = 480;
export const PROMPT_CARD_DEFAULT_H = 220;
export const GRID_STEP = 40;
export const CULL_MARGIN = 100;

export function getDefaultSize(nodeType: CanvasNodeType): { w: number; h: number } {
  return nodeType === "prompt"
    ? { w: PROMPT_CARD_DEFAULT_W, h: PROMPT_CARD_DEFAULT_H }
    : { w: SESSION_CARD_DEFAULT_W, h: SESSION_CARD_DEFAULT_H };
}

export function getMinSize(nodeType: CanvasNodeType): { w: number; h: number } {
  return nodeType === "prompt"
    ? { w: PROMPT_CARD_MIN_W, h: PROMPT_CARD_MIN_H }
    : { w: SESSION_CARD_MIN_W, h: SESSION_CARD_MIN_H };
}

export interface LlmSettings {
  provider: string;
  model: string;
}

/** Known providers and their models (for dropdowns). */
export const LLM_PROVIDERS = ["anthropic", "openai"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const LLM_MODELS: Record<LlmProvider, readonly string[]> = {
  anthropic: [
    "claude-sonnet-4-20250514",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
  ],
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
  ],
};
