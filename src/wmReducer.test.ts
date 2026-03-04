import { describe, it, expect } from "vitest";
import {
  wmReducer,
  initialWmUiState,
  type WmUiState,
  type WmEvent,
  type Diagnostics,
} from "./wmReducer";

function makeDiagnostics(overrides: Partial<Diagnostics> = {}): Diagnostics {
  return {
    path_source: "metadb",
    project_path: "/tmp/proj",
    total_tasks: 2,
    closed_epics: [],
    open_epics: [],
    active_agent_task_ids: [],
    close_attempts: 0,
    close_succeeded: 0,
    close_failed: [],
    final_state: "NEW",
    remaining_count: 0,
    remaining_ids: [],
    ...overrides,
  };
}

function applyEvents(state: WmUiState, events: WmEvent[]): WmUiState {
  return events.reduce((s, e) => wmReducer(s, e), state);
}

describe("wmReducer", () => {
  it("starts in idle state", () => {
    expect(initialWmUiState.phase).toBe("idle");
    expect(initialWmUiState.isProcessing).toBe(false);
    expect(initialWmUiState.conversation).toEqual([]);
  });

  describe("short_circuit_flow", () => {
    it("transitions through inspecting to completed with message", () => {
      const events: WmEvent[] = [
        { type: "PhaseChanged", phase: "inspecting" },
        { type: "MessageAdded", role: "user", content: "Build me an app" },
        {
          type: "ShortCircuit",
          message: "Project is already complete.",
          diagnostics: makeDiagnostics({ final_state: "COMPLETED" }),
        },
      ];

      const final = applyEvents(initialWmUiState, events);

      expect(final.phase).toBe("completed");
      expect(final.isProcessing).toBe(false);
      expect(final.conversation).toHaveLength(2);
      expect(final.conversation[0]).toEqual({ role: "user", content: "Build me an app" });
      expect(final.conversation[1]).toEqual({
        role: "assistant",
        content: "Project is already complete.",
      });
      expect(final.diagnostics?.final_state).toBe("COMPLETED");
      expect(final.llmConfig).toBeNull();
    });
  });

  describe("run_llm_flow", () => {
    it("transitions through inspecting to setting_up then monitoring", () => {
      const events: WmEvent[] = [
        { type: "PhaseChanged", phase: "inspecting" },
        {
          type: "RunLlm",
          system_prompt: "You are the WM",
          state_context: "Project path: /tmp/proj",
          remove_tools: [],
          prompt_variant: "standard",
          diagnostics: makeDiagnostics({ final_state: "NEW" }),
          messages: [],
        },
        { type: "LlmDone" },
      ];

      const afterRunLlm = applyEvents(initialWmUiState, events.slice(0, 2));
      expect(afterRunLlm.phase).toBe("setting_up");
      expect(afterRunLlm.isProcessing).toBe(true);
      expect(afterRunLlm.llmConfig).toEqual({
        systemPrompt: "You are the WM",
        stateContext: "Project path: /tmp/proj",
        removeTools: [],
        promptVariant: "standard",
      });

      const final = applyEvents(initialWmUiState, events);
      expect(final.phase).toBe("monitoring");
      expect(final.isProcessing).toBe(false);
      expect(final.llmConfig).toBeNull();
    });
  });

  describe("in_progress_keeps_all_tools", () => {
    it("does not remove open_project_with_beads for in-progress projects", () => {
      const events: WmEvent[] = [
        {
          type: "RunLlm",
          system_prompt: "",
          state_context: "",
          remove_tools: [],
          prompt_variant: "standard",
          diagnostics: makeDiagnostics({ final_state: "IN_PROGRESS" }),
          messages: [],
        },
      ];

      const final = applyEvents(initialWmUiState, events);
      expect(final.llmConfig?.removeTools).toEqual([]);
    });
  });

  describe("error_flow", () => {
    it("transitions to error with message", () => {
      const events: WmEvent[] = [
        { type: "PhaseChanged", phase: "inspecting" },
        {
          type: "ShowError",
          message: "bd crashed",
          diagnostics: makeDiagnostics({ final_state: "ERROR" }),
        },
      ];

      const final = applyEvents(initialWmUiState, events);

      expect(final.phase).toBe("error");
      expect(final.isProcessing).toBe(false);
      expect(final.conversation).toHaveLength(1);
      expect(final.conversation[0].content).toBe("bd crashed");
      expect(final.llmConfig).toBeNull();
    });
  });

  describe("followup_after_complete", () => {
    it("handles user follow-up after short-circuit", () => {
      const events: WmEvent[] = [
        // Initial flow — short circuit
        { type: "PhaseChanged", phase: "inspecting" },
        { type: "MessageAdded", role: "user", content: "Build an app" },
        {
          type: "ShortCircuit",
          message: "Already complete.",
          diagnostics: makeDiagnostics({ final_state: "COMPLETED" }),
        },
        // Follow-up
        { type: "MessageAdded", role: "user", content: "Add a dark mode" },
        { type: "PhaseChanged", phase: "inspecting" },
        {
          type: "RunLlm",
          system_prompt: "",
          state_context: "",
          remove_tools: [],
          prompt_variant: "completed",
          diagnostics: makeDiagnostics({ final_state: "COMPLETED" }),
          messages: [],
        },
      ];

      const final = applyEvents(initialWmUiState, events);
      expect(final.phase).toBe("setting_up");
      expect(final.isProcessing).toBe(true);
      expect(final.conversation).toHaveLength(3);
      expect(final.conversation[0].role).toBe("user");
      expect(final.conversation[1].role).toBe("assistant");
      expect(final.conversation[2].role).toBe("user");
    });
  });

  describe("orch_status", () => {
    it("tracks orchestration status changes", () => {
      const events: WmEvent[] = [
        { type: "OrchStatusChanged", status: "paused" },
        { type: "OrchStatusChanged", status: "running" },
      ];

      const afterPause = wmReducer(initialWmUiState, events[0]);
      expect(afterPause.orchStatus).toBe("paused");

      const afterRun = wmReducer(afterPause, events[1]);
      expect(afterRun.orchStatus).toBe("running");
    });
  });

  describe("HYDRATE", () => {
    it("restores state from backend on reload", () => {
      const final = wmReducer(initialWmUiState, {
        type: "HYDRATE",
        state: {
          phase: "monitoring",
          conversation: [
            { role: "user", content: "Build app" },
            { role: "assistant", content: "Setting up..." },
          ],
        },
      });

      expect(final.phase).toBe("monitoring");
      expect(final.conversation).toHaveLength(2);
      expect(final.isProcessing).toBe(false);
    });
  });

  describe("unknown event", () => {
    it("returns state unchanged for unrecognized event", () => {
      const state = { ...initialWmUiState, phase: "monitoring" as const };
      const result = wmReducer(state, { type: "SomeFutureEvent" } as any);
      expect(result).toEqual(state);
    });
  });
});
