import { describe, expect, it } from "vitest";
import {
  getPromptForRole,
  ROLE_TOOLS,
  WORKFORCE_MANAGER_PROMPT,
  PROJECT_MANAGER_PROMPT,
  DEVELOPER_PROMPT,
  WORKER_PROMPT,
  OPERATOR_PROMPT,
  UNIFIED_VALIDATOR_PROMPT,
  MERGE_AGENT_PROMPT,
} from "./agentPrompts";
import type { ToolName } from "./agentPrompts";
import type { AgentRole } from "./types";

const ALL_ROLES: AgentRole[] = [
  "workforce_manager",
  "project_manager",
  "developer",
  "operator",
  "worker",
  "validator",
  "merge_agent",
];

const ALL_TOOL_NAMES: ToolName[] = [
  "write_file", "read_file", "run_terminal_command", "browser_action",
  "open_project_with_beads", "create_beads_task", "update_beads_task",
  "dispatch_agent", "yield_for_review", "complete_task",
];

describe("getPromptForRole", () => {
  it.each(ALL_ROLES)("returns a non-empty string for %s", (role) => {
    const prompt = getPromptForRole(role);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("orchestrator alias returns same prompt as workforce_manager", () => {
    expect(getPromptForRole("orchestrator")).toBe(getPromptForRole("workforce_manager"));
  });

  it("unknown role falls back to DEVELOPER_PROMPT", () => {
    expect(getPromptForRole("unknown" as AgentRole)).toBe(DEVELOPER_PROMPT);
  });

  it("each role returns a distinct prompt (except orchestrator/WM)", () => {
    const prompts = ALL_ROLES.map(r => getPromptForRole(r));
    const unique = new Set(prompts);
    expect(unique.size).toBe(ALL_ROLES.length);
  });

  it("maps roles to the correct prompt constants", () => {
    expect(getPromptForRole("workforce_manager")).toBe(WORKFORCE_MANAGER_PROMPT);
    expect(getPromptForRole("project_manager")).toBe(PROJECT_MANAGER_PROMPT);
    expect(getPromptForRole("developer")).toBe(DEVELOPER_PROMPT);
    expect(getPromptForRole("operator")).toBe(OPERATOR_PROMPT);
    expect(getPromptForRole("worker")).toBe(WORKER_PROMPT);
    expect(getPromptForRole("validator")).toBe(UNIFIED_VALIDATOR_PROMPT);
    expect(getPromptForRole("merge_agent")).toBe(MERGE_AGENT_PROMPT);
  });
});

describe("ROLE_TOOLS", () => {
  it("has entries for all roles plus orchestrator", () => {
    const keys = Object.keys(ROLE_TOOLS);
    for (const role of ALL_ROLES) {
      expect(keys).toContain(role);
    }
    expect(keys).toContain("orchestrator");
  });

  it("validator has no tools", () => {
    expect(ROLE_TOOLS.validator).toEqual([]);
  });

  it("workforce_manager and orchestrator have identical tools", () => {
    expect(ROLE_TOOLS.workforce_manager).toEqual(ROLE_TOOLS.orchestrator);
  });

  it("developer includes yield_for_review", () => {
    expect(ROLE_TOOLS.developer).toContain("yield_for_review");
  });

  it("developer does NOT include complete_task", () => {
    expect(ROLE_TOOLS.developer).not.toContain("complete_task");
  });

  it("worker includes complete_task", () => {
    expect(ROLE_TOOLS.worker).toContain("complete_task");
  });

  it("project_manager has task management but no code tools", () => {
    expect(ROLE_TOOLS.project_manager).toContain("create_beads_task");
    expect(ROLE_TOOLS.project_manager).toContain("update_beads_task");
    expect(ROLE_TOOLS.project_manager).not.toContain("write_file");
    expect(ROLE_TOOLS.project_manager).not.toContain("run_terminal_command");
  });

  it("every tool name in every role is a valid ToolName", () => {
    for (const [_role, tools] of Object.entries(ROLE_TOOLS)) {
      for (const tool of tools) {
        expect(ALL_TOOL_NAMES).toContain(tool);
      }
    }
  });
});
