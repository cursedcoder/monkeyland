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
