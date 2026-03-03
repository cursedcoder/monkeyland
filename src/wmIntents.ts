/**
 * WM Intent Types
 * 
 * These types categorize user requests to the Workforce Manager,
 * enabling intelligent routing and tool selection based on intent.
 */

/** Informational requests - read-only queries about system state */
export type InformationalIntent = {
  type: "informational";
  subtype: "status" | "cost" | "explanation" | "timeline" | "progress";
};

/** Pivot requests - change of direction requiring work stoppage and reorganization */
export type PivotIntent = {
  type: "pivot";
  subtype: "tech" | "scope" | "target" | "architecture";
  /** Brief description of the requested change */
  description?: string;
};

/** Feature request - add new functionality to the current project */
export type FeatureRequestIntent = {
  type: "feature_request";
  /** Brief description of the feature */
  description?: string;
  /** Priority level if specified */
  priority?: "high" | "medium" | "low";
};

/** Bug report - issue discovered that needs fixing */
export type BugReportIntent = {
  type: "bug_report";
  /** Brief description of the bug */
  description?: string;
  /** Severity level if specified */
  severity?: "critical" | "major" | "minor";
};

/** Priority change - adjust task priorities */
export type PriorityIntent = {
  type: "priority";
  subtype: "prioritize" | "deprioritize" | "parallelize";
  /** Task IDs affected */
  taskIds?: string[];
};

/** Constraint change - modify technical or quality constraints */
export type ConstraintIntent = {
  type: "constraint";
  subtype: "tech" | "quality" | "resource" | "deadline";
  /** Description of the constraint */
  description?: string;
};

/** Control flow - pause/resume/cancel operations */
export type ControlFlowIntent = {
  type: "control_flow";
  subtype: "pause" | "resume" | "cancel" | "skip" | "retry";
  /** Specific agent or task to target (optional - affects all if not specified) */
  targetId?: string;
};

/** Micromanagement - direct instructions to a specific running agent */
export type MicromanagementIntent = {
  type: "micromanagement";
  /** ID of the agent to send instructions to */
  targetAgentId: string;
  /** Instructions to send */
  instructions?: string;
};

/** Approval - respond to WM's request for confirmation */
export type ApprovalIntent = {
  type: "approval";
  decision: "approve" | "reject" | "clarify";
  /** Additional context for the decision */
  reason?: string;
};

/** Human takeover - user wants to take manual control */
export type HumanTakeoverIntent = {
  type: "human_takeover";
  /** What the user wants to do manually */
  scope?: "full" | "specific_task" | "debugging";
};

/** Clarification - user is asking for clarification or providing more context */
export type ClarificationIntent = {
  type: "clarification";
  /** What needs clarification */
  topic?: string;
};

/** Feedback - user providing feedback on completed work */
export type FeedbackIntent = {
  type: "feedback";
  sentiment: "positive" | "negative" | "neutral";
  /** Specific feedback content */
  content?: string;
};

/**
 * Union type representing all possible WM intents.
 * The WM should classify user messages into one of these categories
 * to determine the appropriate response and tool usage.
 */
export type WMIntent =
  | InformationalIntent
  | PivotIntent
  | FeatureRequestIntent
  | BugReportIntent
  | PriorityIntent
  | ConstraintIntent
  | ControlFlowIntent
  | MicromanagementIntent
  | ApprovalIntent
  | HumanTakeoverIntent
  | ClarificationIntent
  | FeedbackIntent;

/**
 * Maps intent types to their allowed tools.
 * This helps the WM determine which tools to use based on the classified intent.
 */
export const INTENT_ALLOWED_TOOLS: Record<WMIntent["type"], string[]> = {
  informational: ["get_orchestration_status"],
  pivot: [
    "pause_orchestration",
    "cancel_task",
    "create_beads_task",
    "update_beads_task",
    "resume_orchestration",
  ],
  feature_request: ["create_beads_task", "update_beads_task", "dispatch_agent"],
  bug_report: ["create_beads_task", "dispatch_agent"],
  priority: ["reprioritize_task", "update_beads_task"],
  constraint: ["update_beads_task"],
  control_flow: [
    "pause_orchestration",
    "resume_orchestration",
    "cancel_task",
  ],
  micromanagement: ["message_agent"],
  approval: [],
  human_takeover: ["pause_orchestration"],
  clarification: [],
  feedback: [],
};

/**
 * Intent classification result from the WM.
 */
export interface IntentClassification {
  intent: WMIntent;
  confidence: number;
  requiresConfirmation: boolean;
  suggestedAction?: string;
}
