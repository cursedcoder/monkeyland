/**
 * WM E2E integration tests — verifies the full frontend chain:
 *   invoke("wm_launch") → wm_event listener → reducer → LLM callback → invoke("wm_llm_done")
 *
 * Mocks: Tauri invoke/listen and the agent runner. No real backend or LLM calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const { mockRunAgent } = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
}));
vi.mock("./agentRunner", () => ({
  runAgent: mockRunAgent,
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  wmReducer,
  initialWmUiState,
  type WmUiState,
  type WmEvent,
  type Diagnostics,
} from "./wmReducer";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

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

/**
 * Simulates the App.tsx WM event loop:
 *  - Registers a wm_event listener
 *  - Dispatches each event to the reducer
 *  - On RunLlm, calls runAgent; on success → invoke("wm_llm_done"), on error → invoke("wm_llm_error")
 *  - Returns the final UI state
 */
async function runWmLoop(events: WmEvent[]): Promise<WmUiState> {
  let state = { ...initialWmUiState };

  for (const event of events) {
    state = wmReducer(state, event);

    if (event.type === "RunLlm") {
      const config = event;
      const messages = state.conversation.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      try {
        const text: string = await mockRunAgent({
          systemPrompt: config.system_prompt + config.state_context,
          messages,
          removeTools: config.remove_tools,
        });
        await mockInvoke("wm_llm_done", { responseText: text });
        state = wmReducer(state, { type: "LlmDone" });
      } catch (e) {
        await mockInvoke("wm_llm_error", { error: String(e) });
        state = wmReducer(state, {
          type: "ShowError",
          message: String(e),
          diagnostics: null as unknown as Diagnostics,
        });
      }
    }
  }

  return state;
}

describe("WM E2E frontend integration", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockListen.mockReset();
    mockRunAgent.mockReset();
  });

  // #1 — Short-circuit flow: no LLM call
  it("short-circuit flow skips LLM entirely", async () => {
    mockInvoke.mockResolvedValue(undefined);

    const events: WmEvent[] = [
      { type: "OrchStatusChanged", status: "paused" },
      { type: "PhaseChanged", phase: "inspecting" },
      { type: "MessageAdded", role: "user", content: "Build me an app" },
      {
        type: "ShortCircuit",
        message: "This project is already complete.",
        diagnostics: makeDiagnostics({ final_state: "COMPLETED" }),
      },
    ];

    const finalState = await runWmLoop(events);

    expect(finalState.phase).toBe("completed");
    expect(finalState.conversation).toHaveLength(2);
    expect(finalState.conversation[0]).toEqual({
      role: "user",
      content: "Build me an app",
    });
    expect(finalState.conversation[1]).toEqual({
      role: "assistant",
      content: "This project is already complete.",
    });
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "wm_llm_done",
      expect.anything(),
    );
  });

  // #2 — LLM flow: RunLlm triggers runAgent, on success calls wm_llm_done
  it("LLM flow calls runAgent and wm_llm_done on success", async () => {
    mockInvoke.mockResolvedValue(undefined);
    mockRunAgent.mockResolvedValue("I've created the project structure.");

    const events: WmEvent[] = [
      { type: "OrchStatusChanged", status: "paused" },
      { type: "PhaseChanged", phase: "inspecting" },
      { type: "MessageAdded", role: "user", content: "Build me an app" },
      {
        type: "RunLlm",
        system_prompt: "You are the WM",
        state_context: "\nProject path: /tmp/proj",
        remove_tools: [],
        prompt_variant: "standard",
        diagnostics: makeDiagnostics({ final_state: "NEW" }),
      },
    ];

    const finalState = await runWmLoop(events);

    expect(finalState.phase).toBe("monitoring");
    expect(finalState.isProcessing).toBe(false);

    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "You are the WM\nProject path: /tmp/proj",
        messages: [{ role: "user", content: "Build me an app" }],
        removeTools: [],
      }),
    );
    expect(mockInvoke).toHaveBeenCalledWith("wm_llm_done", {
      responseText: "I've created the project structure.",
    });
  });

  // #3 — LLM error flow: runAgent throws, calls wm_llm_error
  it("LLM error flow calls wm_llm_error when runAgent rejects", async () => {
    mockInvoke.mockResolvedValue(undefined);
    mockRunAgent.mockRejectedValue(new Error("rate limit exceeded"));

    const events: WmEvent[] = [
      { type: "OrchStatusChanged", status: "paused" },
      { type: "PhaseChanged", phase: "inspecting" },
      { type: "MessageAdded", role: "user", content: "Build me an app" },
      {
        type: "RunLlm",
        system_prompt: "",
        state_context: "",
        remove_tools: [],
        prompt_variant: "standard",
        diagnostics: makeDiagnostics({ final_state: "NEW" }),
      },
    ];

    const finalState = await runWmLoop(events);

    expect(finalState.phase).toBe("error");
    expect(mockInvoke).toHaveBeenCalledWith("wm_llm_error", {
      error: "Error: rate limit exceeded",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "wm_llm_done",
      expect.anything(),
    );
  });

  // #4 — Follow-up: ShortCircuit → user sends message → RunLlm with full history
  it("follow-up after short-circuit sends full conversation to LLM", async () => {
    mockInvoke.mockResolvedValue(undefined);
    mockRunAgent.mockResolvedValue("Adding dark mode support.");

    const events: WmEvent[] = [
      // Initial short-circuit
      { type: "OrchStatusChanged", status: "paused" },
      { type: "PhaseChanged", phase: "inspecting" },
      { type: "MessageAdded", role: "user", content: "Build me an app" },
      {
        type: "ShortCircuit",
        message: "Already complete.",
        diagnostics: makeDiagnostics({ final_state: "COMPLETED" }),
      },
      // Follow-up message
      { type: "OrchStatusChanged", status: "paused" },
      { type: "MessageAdded", role: "user", content: "Add dark mode" },
      { type: "PhaseChanged", phase: "inspecting" },
      {
        type: "RunLlm",
        system_prompt: "",
        state_context: "",
        remove_tools: [],
        prompt_variant: "completed",
        diagnostics: makeDiagnostics({ final_state: "COMPLETED" }),
      },
    ];

    const finalState = await runWmLoop(events);

    expect(finalState.phase).toBe("monitoring");
    expect(finalState.conversation).toHaveLength(3);
    expect(finalState.conversation[0].content).toBe("Build me an app");
    expect(finalState.conversation[1].content).toBe("Already complete.");
    expect(finalState.conversation[2].content).toBe("Add dark mode");

    expect(mockRunAgent).toHaveBeenCalledOnce();
    const runAgentCall = mockRunAgent.mock.calls[0][0];
    expect(runAgentCall.messages).toHaveLength(3);
    expect(runAgentCall.messages[0].content).toBe("Build me an app");
    expect(runAgentCall.messages[1].content).toBe("Already complete.");
    expect(runAgentCall.messages[2].content).toBe("Add dark mode");

    expect(mockInvoke).toHaveBeenCalledWith("wm_llm_done", {
      responseText: "Adding dark mode support.",
    });
  });
});
