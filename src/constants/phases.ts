import type { AgentRole } from "../types";

/** WM conversation phases — matches Rust WmPhase enum */
export type WMPhase =
  | "idle"
  | "inspecting"
  | "completed"
  | "setting_up"
  | "monitoring"
  | "error"
  // Legacy phases kept for backward compat with saved state
  | "initial"
  | "project_setup"
  | "planning"
  | "executing"
  | "intervening"
  | "concluding";

export const WM_PHASE_LABELS: Record<WMPhase, string> = {
  idle: "Ready",
  inspecting: "Inspecting",
  completed: "Complete",
  setting_up: "Setting Up",
  monitoring: "Monitoring",
  error: "Error",
  initial: "Ready",
  project_setup: "Setting Up",
  planning: "Planning",
  executing: "Executing",
  intervening: "Intervening",
  concluding: "Wrapping Up",
};

export const WM_PHASE_COLORS: Record<WMPhase, string> = {
  idle: "#6b7280",
  inspecting: "#f97316",
  completed: "#10b981",
  setting_up: "#3b82f6",
  monitoring: "#8b5cf6",
  error: "#ef4444",
  initial: "#6b7280",
  project_setup: "#3b82f6",
  planning: "#f59e0b",
  executing: "#10b981",
  intervening: "#ef4444",
  concluding: "#06b6d4",
};

export const ROLE_LABELS: Record<AgentRole, string> = {
  workforce_manager: "Workforce",
  project_manager: "PM",
  developer: "Developer",
  operator: "Operator",
  worker: "Worker",
  validator: "Validator",
  merge_agent: "Merge",
};

export const AGENT_STATUS_LABELS: Record<string, string> = {
  loading: "Working",
  done: "Done",
  error: "Error",
  stopped: "Stopped",
  in_review: "In Review",
};

/** Developer execution phase labels. */
export const DEV_PHASE_LABELS: Record<string, string> = {
  planning: "Planning",
  implementing: "Implementing",
  testing: "Testing",
  finalizing: "Finalizing",
  revising: "Revising",
};

/** Developer phase badge colors. */
export const DEV_PHASE_COLORS: Record<string, string> = {
  planning: "#6366f1",
  implementing: "#f59e0b",
  testing: "#10b981",
  finalizing: "#8b5cf6",
  revising: "#ef4444",
};

/** PM execution phase labels. */
export const PM_PHASE_LABELS: Record<string, string> = {
  exploration: "Exploring",
  task_drafting: "Drafting Tasks",
  dependency_review: "Reviewing Deps",
  finalization: "Finalizing",
  revising: "Revising",
};

/** PM phase badge colors. */
export const PM_PHASE_COLORS: Record<string, string> = {
  exploration: "#3b82f6",
  task_drafting: "#f59e0b",
  dependency_review: "#8b5cf6",
  finalization: "#10b981",
  revising: "#ef4444",
};
