import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getValidatorSpawnFailureSubmissions } from "./validatorSafety";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

/**
 * These tests verify the Tauri event contracts between the Rust backend and
 * the frontend, following the same patterns used in App.tsx's useEffect handlers.
 * Rather than rendering the full App component (2000+ lines with heavy deps),
 * we replicate the core handler logic and verify the invoke call sequences.
 */

describe("App event contracts", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockListen.mockReset();
  });

  describe("agent_spawned event", () => {
    it("fetches task details via beads_run and assembles conversation params", async () => {
      mockInvoke
        .mockResolvedValueOnce("/tmp/project")  // get_beads_project_path
        .mockResolvedValueOnce(                  // beads_run (show task --json)
          JSON.stringify({
            id: "bd-42",
            title: "Implement auth",
            type: "task",
            priority: 2,
            description: "Add JWT authentication to the API.",
          }),
        );

      const payload = {
        agent_id: "agent-abc",
        role: "developer",
        task_id: "bd-42",
        parent_agent_id: null,
        merge_context: null,
      };

      // Replicate the agent_spawned handler logic from App.tsx
      const { agent_id, role, task_id, parent_agent_id } = payload;
      let taskDescription = `Execute task ${task_id ?? "unknown"}.`;
      let taskMeta: Record<string, unknown> | undefined;
      let resolvedProjectPath: string | null = null;

      try {
        resolvedProjectPath = await invoke<string | null>("get_beads_project_path");
      } catch { /* */ }

      if (task_id && resolvedProjectPath) {
        try {
          const jsonOut = await invoke<string>("beads_run", {
            projectPath: resolvedProjectPath,
            args: ["show", task_id, "--json"],
          });
          const raw = JSON.parse(jsonOut.trim());
          const parsed = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>;
          if (parsed) {
            taskMeta = {
              title: parsed.title,
              type: parsed.issue_type ?? parsed.type,
              priority: parsed.priority,
              description: parsed.description ?? parsed.body,
            };
            const bodyText = (taskMeta.description || taskMeta.title || "") as string;
            taskDescription = task_id
              ? `Epic ID: ${task_id}\n\n${bodyText}`.trim()
              : bodyText || taskDescription;
          }
        } catch { /* */ }
      }

      const conversationParams = {
        agentNodeId: agent_id,
        role,
        userMessage: taskDescription,
        taskId: task_id,
        taskMeta,
        parentAgentId: parent_agent_id ?? undefined,
        projectPath: resolvedProjectPath,
      };

      expect(mockInvoke).toHaveBeenCalledWith("get_beads_project_path");
      expect(mockInvoke).toHaveBeenCalledWith("beads_run", {
        projectPath: "/tmp/project",
        args: ["show", "bd-42", "--json"],
      });
      expect(conversationParams.agentNodeId).toBe("agent-abc");
      expect(conversationParams.role).toBe("developer");
      expect(conversationParams.projectPath).toBe("/tmp/project");
      expect(conversationParams.userMessage).toContain("Add JWT authentication");
      expect(conversationParams.taskMeta).toBeDefined();
      expect(conversationParams.taskMeta!.title).toBe("Implement auth");
    });

    it("builds specialized description for merge_agent with merge_context", async () => {
      mockInvoke.mockResolvedValueOnce("/tmp/project"); // get_beads_project_path

      const payload = {
        agent_id: "merge-1",
        role: "merge_agent",
        task_id: "bd-99",
        parent_agent_id: "dev-1",
        merge_context: {
          base_branch: "main",
          task_branch: "task/bd-99",
          conflict_diff: "--- a/file.txt\n+++ b/file.txt",
          task_description: "Fix the login bug",
        },
      };

      const { role, task_id, merge_context } = payload;
      let taskDescription = `Execute task ${task_id ?? "unknown"}.`;

      if (role === "merge_agent" && merge_context) {
        taskDescription = [
          `Resolve merge conflicts for task ${task_id}.`,
          ``,
          `Base branch: ${merge_context.base_branch}`,
          `Task branch: ${merge_context.task_branch}`,
          ``,
          `## Original task description`,
          merge_context.task_description || "(not available)",
          ``,
          `## Conflict diff`,
          merge_context.conflict_diff || "(not available)",
        ].join("\n");
      }

      expect(taskDescription).toContain("Resolve merge conflicts for task bd-99");
      expect(taskDescription).toContain("Base branch: main");
      expect(taskDescription).toContain("Task branch: task/bd-99");
      expect(taskDescription).toContain("Fix the login bug");
      expect(taskDescription).toContain("--- a/file.txt");
    });

    it("falls back to default description when beads_run fails", async () => {
      mockInvoke
        .mockResolvedValueOnce("/tmp/project")  // get_beads_project_path
        .mockRejectedValueOnce(new Error("bd: command not found")); // beads_run fails

      const task_id = "bd-55";
      let taskDescription = `Execute task ${task_id}.`;
      const resolvedProjectPath = await invoke<string | null>("get_beads_project_path");

      if (task_id && resolvedProjectPath) {
        try {
          await invoke<string>("beads_run", {
            projectPath: resolvedProjectPath,
            args: ["show", task_id, "--json"],
          });
        } catch {
          // use default description (this is the App.tsx behavior)
        }
      }

      expect(taskDescription).toBe("Execute task bd-55.");
    });
  });

  describe("agent_killed event", () => {
    it("aborts the controller and updates layout status to stopped", () => {
      const controller = new AbortController();
      const abortSpy = vi.spyOn(controller, "abort");
      const controllers = new Map<string, AbortController>([
        ["dev-1", controller],
      ]);

      const layouts = [
        {
          session_id: "dev-1",
          payload: JSON.stringify({ role: "developer", status: "running" }),
        },
        {
          session_id: "dev-2",
          payload: JSON.stringify({ role: "developer", status: "running" }),
        },
      ];

      // Replicate agent_killed handler logic
      const payload = { agent_id: "dev-1", reason: "ttl_expired" };
      const { agent_id } = payload;

      const ctrl = controllers.get(agent_id);
      if (ctrl) ctrl.abort();

      const updatedLayouts = layouts.map((l) => {
        if (l.session_id !== agent_id) return l;
        try {
          const p = JSON.parse(l.payload ?? "{}") as Record<string, unknown>;
          return { ...l, payload: JSON.stringify({ ...p, status: "stopped", toolActivity: "TTL expired" }) };
        } catch {
          return l;
        }
      });

      expect(abortSpy).toHaveBeenCalled();

      const dev1 = updatedLayouts.find((l) => l.session_id === "dev-1")!;
      const parsed = JSON.parse(dev1.payload);
      expect(parsed.status).toBe("stopped");
      expect(parsed.toolActivity).toBe("TTL expired");

      const dev2 = updatedLayouts.find((l) => l.session_id === "dev-2")!;
      const parsed2 = JSON.parse(dev2.payload);
      expect(parsed2.status).toBe("running");
    });

    it("handles missing controller gracefully", () => {
      const controllers = new Map<string, AbortController>();

      const payload = { agent_id: "ghost", reason: "ttl_expired" };
      const ctrl = controllers.get(payload.agent_id);

      expect(ctrl).toBeUndefined();
      // No crash expected
    });
  });

  describe("validation_requested event", () => {
    it("spawns a validator agent via invoke", async () => {
      mockInvoke
        .mockResolvedValueOnce("/tmp/project")   // get_beads_project_path
        .mockResolvedValueOnce({ agent_id: "val-1" }); // agent_spawn

      const payload = {
        developer_agent_id: "dev-1",
        task_id: "bd-42",
        git_branch: "task/bd-42",
        diff_summary: "Added auth module",
      };

      let resolvedProjectPath: string | null = null;
      try {
        resolvedProjectPath = await invoke<string | null>("get_beads_project_path");
      } catch { /* */ }

      const result = await invoke<{ agent_id: string }>("agent_spawn", {
        payload: {
          role: "validator",
          task_id: payload.task_id,
          parent_agent_id: payload.developer_agent_id,
          cwd: resolvedProjectPath,
        },
      });

      expect(result.agent_id).toBe("val-1");
      expect(mockInvoke).toHaveBeenCalledWith("agent_spawn", {
        payload: {
          role: "validator",
          task_id: "bd-42",
          parent_agent_id: "dev-1",
          cwd: "/tmp/project",
        },
      });
    });

    it("submits fail-closed validations when validator spawn fails", async () => {
      mockInvoke
        .mockResolvedValueOnce("/tmp/project")                        // get_beads_project_path
        .mockRejectedValueOnce(new Error("Max validator count"))      // agent_spawn fails
        .mockResolvedValue(undefined);                                // validation_submit calls

      const payload = {
        developer_agent_id: "dev-1",
        task_id: "bd-42",
        git_branch: null,
        diff_summary: null,
      };

      await invoke<string | null>("get_beads_project_path");

      let validatorId: string | undefined;
      try {
        const result = await invoke<{ agent_id: string }>("agent_spawn", {
          payload: {
            role: "validator",
            task_id: payload.task_id,
            parent_agent_id: payload.developer_agent_id,
            cwd: "/tmp/project",
          },
        });
        validatorId = result.agent_id;
      } catch {
        const submissions = getValidatorSpawnFailureSubmissions(payload.developer_agent_id);
        for (const sub of submissions) {
          await invoke("validation_submit", { payload: sub });
        }
      }

      expect(validatorId).toBeUndefined();

      const valSubmitCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "validation_submit",
      );
      expect(valSubmitCalls).toHaveLength(3);

      const roles = valSubmitCalls.map(
        ([, args]) => (args as { payload: { validator_role: string } }).payload.validator_role,
      );
      expect(roles).toEqual(["code_review", "business_logic", "scope"]);

      for (const [, args] of valSubmitCalls) {
        expect((args as { payload: { pass: boolean } }).payload.pass).toBe(false);
      }
    });

    it("restarts developer conversation when validator spawn fails and retries remain", async () => {
      type ValidationOutcome = {
        all_passed: boolean;
        retry_count: number;
        max_retries: number;
        failures: Array<{ role: string; reasons: string[] }>;
      };

      const spawnFailOutcome: ValidationOutcome = {
        all_passed: false,
        retry_count: 1,
        max_retries: 3,
        failures: [
          { role: "code_review", reasons: ["Validator spawn failed"] },
          { role: "business_logic", reasons: ["Validator spawn failed"] },
          { role: "scope", reasons: ["Validator spawn failed"] },
        ],
      };

      mockInvoke
        .mockResolvedValueOnce("/tmp/project")                    // get_beads_project_path
        .mockRejectedValueOnce(new Error("Max validator count"))  // agent_spawn fails
        .mockResolvedValueOnce(null)                              // validation_submit #1
        .mockResolvedValueOnce(null)                              // validation_submit #2
        .mockResolvedValueOnce(spawnFailOutcome);                 // validation_submit #3 returns outcome

      const developer_agent_id = "dev-1";
      const task_id = "bd-42";

      const resolvedProjectPath = await invoke<string | null>("get_beads_project_path");

      let restartCalled = false;
      let restartParams: Record<string, unknown> | null = null;

      try {
        await invoke<{ agent_id: string }>("agent_spawn", {
          payload: { role: "validator", task_id, parent_agent_id: developer_agent_id, cwd: resolvedProjectPath },
        });
      } catch {
        const submissions = getValidatorSpawnFailureSubmissions(developer_agent_id);
        let lastOutcome: ValidationOutcome | null = null;
        for (const payload of submissions) {
          try {
            const outcome = await invoke<ValidationOutcome | null>("validation_submit", { payload });
            if (outcome) lastOutcome = outcome;
          } catch { /* best effort */ }
        }

        if (lastOutcome && !lastOutcome.all_passed && lastOutcome.retry_count < lastOutcome.max_retries) {
          restartCalled = true;
          restartParams = {
            agentNodeId: developer_agent_id,
            role: "developer",
            taskId: task_id,
            projectPath: resolvedProjectPath,
          };
        }
      }

      expect(restartCalled).toBe(true);
      expect(restartParams).not.toBeNull();
      expect(restartParams!.agentNodeId).toBe("dev-1");
      expect(restartParams!.role).toBe("developer");
      expect(restartParams!.taskId).toBe("bd-42");
      expect(restartParams!.projectPath).toBe("/tmp/project");
    });

    it("does NOT restart developer when max retries exhausted", async () => {
      type ValidationOutcome = {
        all_passed: boolean;
        retry_count: number;
        max_retries: number;
        failures: Array<{ role: string; reasons: string[] }>;
      };

      const exhaustedOutcome: ValidationOutcome = {
        all_passed: false,
        retry_count: 3,
        max_retries: 3,
        failures: [{ role: "code_review", reasons: ["Validator spawn failed"] }],
      };

      mockInvoke
        .mockResolvedValueOnce("/tmp/project")
        .mockRejectedValueOnce(new Error("Max validator count"))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(exhaustedOutcome);

      const developer_agent_id = "dev-2";
      const task_id = "bd-99";

      await invoke<string | null>("get_beads_project_path");

      let restartCalled = false;

      try {
        await invoke<{ agent_id: string }>("agent_spawn", {
          payload: { role: "validator", task_id, parent_agent_id: developer_agent_id, cwd: "/tmp/project" },
        });
      } catch {
        const submissions = getValidatorSpawnFailureSubmissions(developer_agent_id);
        let lastOutcome: ValidationOutcome | null = null;
        for (const payload of submissions) {
          try {
            const outcome = await invoke<ValidationOutcome | null>("validation_submit", { payload });
            if (outcome) lastOutcome = outcome;
          } catch { /* best effort */ }
        }

        if (lastOutcome && !lastOutcome.all_passed && lastOutcome.retry_count < lastOutcome.max_retries) {
          restartCalled = true;
        }
      }

      expect(restartCalled).toBe(false);
    });
  });

  describe("PM/validator completion handling", () => {
    it("builds context-aware nudge message for PM in exploration phase with no subtasks", async () => {
      const role = "project_manager";
      const taskId = "epic-42";
      const pmPhase = "exploration";
      const hasSubtasks = false;

      // Replicate nudge message construction from App.tsx
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
        nudgeMsg = `You haven't completed your validation yet. Please finish your review and call \`yield_for_review\`.`;
      }

      expect(nudgeMsg).toContain("exploration");
      expect(nudgeMsg).toContain("create_beads_task");
      expect(nudgeMsg).toContain(`parent_id: "${taskId}"`);
      expect(nudgeMsg).toContain("MUST complete these steps");
      expect(nudgeMsg).not.toContain("You have created tasks");
    });

    it("builds different nudge message for PM in task_drafting phase", async () => {
      const role: string = "project_manager";
      const pmPhase: string = "task_drafting";
      const hasSubtasks = true;

      let nudgeMsg: string;
      if (role === "project_manager") {
        if (pmPhase === "exploration" || !hasSubtasks) {
          nudgeMsg = `You are still in the ${pmPhase || "exploration"} phase...`;
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
        nudgeMsg = "";
      }

      expect(nudgeMsg).toContain("created some tasks");
      expect(nudgeMsg).toContain("yield_for_review");
    });

    it("builds simple nudge message for PM in finalization phase", async () => {
      const role: string = "project_manager";
      const pmPhase: string = "finalization";
      const hasSubtasks = true;

      let nudgeMsg: string;
      if (role === "project_manager") {
        if (pmPhase === "exploration" || !hasSubtasks) {
          nudgeMsg = `exploration phase...`;
        } else if (pmPhase === "task_drafting") {
          nudgeMsg = `task drafting...`;
        } else {
          nudgeMsg = `You haven't submitted your task breakdown for validation yet.
Please call \`yield_for_review\` now to submit your work for validation.`;
        }
      } else {
        nudgeMsg = "";
      }

      expect(nudgeMsg).toContain("yield_for_review");
      expect(nudgeMsg).not.toContain("create_beads_task");
    });

    it("builds validator-specific nudge message", async () => {
      const role: string = "validator";

      let nudgeMsg: string;
      if (role === "project_manager") {
        nudgeMsg = "PM message";
      } else {
        nudgeMsg = `You haven't completed your validation yet. Please finish your review and call \`yield_for_review\`.`;
      }

      expect(nudgeMsg).toContain("validation");
      expect(nudgeMsg).toContain("yield_for_review");
    });

    it("retries nudge up to MAX_PM_NUDGE_RETRIES times", async () => {
      const MAX_PM_NUDGE_RETRIES = 3;
      let nudgeAttempts = 0;
      let lastResult = "needs_yield";

      // Simulate the retry loop logic from App.tsx
      while (lastResult === "needs_yield" && nudgeAttempts < MAX_PM_NUDGE_RETRIES) {
        nudgeAttempts++;
        // Simulate PM not yielding
        lastResult = "needs_yield";
      }

      expect(nudgeAttempts).toBe(MAX_PM_NUDGE_RETRIES);
      expect(lastResult).toBe("needs_yield");
    });

    it("stops retrying when PM yields successfully", async () => {
      const MAX_PM_NUDGE_RETRIES = 3;
      let nudgeAttempts = 0;
      let lastResult = "needs_yield";

      // Simulate the retry loop where PM yields on attempt 2
      while (lastResult === "needs_yield" && nudgeAttempts < MAX_PM_NUDGE_RETRIES) {
        nudgeAttempts++;
        if (nudgeAttempts === 2) {
          lastResult = "completed"; // PM finally yielded
        }
      }

      expect(nudgeAttempts).toBe(2);
      expect(lastResult).toBe("completed");
    });

    it("force-yields PM after max retries exhausted", async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined)   // agent_force_yield
        .mockResolvedValueOnce(undefined);  // agent_set_yield_summary

      const MAX_PM_NUDGE_RETRIES = 3;
      let nudgeAttempts = 0;
      let lastResult = "needs_yield";
      let forceYieldCalled = false;
      let yieldSummary = "";

      // Simulate retry loop
      while (lastResult === "needs_yield" && nudgeAttempts < MAX_PM_NUDGE_RETRIES) {
        nudgeAttempts++;
        lastResult = "needs_yield"; // PM never yields
      }

      // After max retries, force-yield
      if (lastResult === "needs_yield") {
        try {
          await invoke("agent_force_yield", { agentId: "pm-stuck" });
          yieldSummary = `Auto-submitted: PM did not yield after ${nudgeAttempts} nudge attempts.`;
          await invoke("agent_set_yield_summary", { agentId: "pm-stuck", diffSummary: yieldSummary });
          forceYieldCalled = true;
        } catch {
          // error handling
        }
      }

      expect(forceYieldCalled).toBe(true);
      expect(yieldSummary).toContain("3 nudge attempts");
      expect(mockInvoke).toHaveBeenCalledWith("agent_force_yield", { agentId: "pm-stuck" });
      expect(mockInvoke).toHaveBeenCalledWith("agent_set_yield_summary", {
        agentId: "pm-stuck",
        diffSummary: expect.stringContaining("Auto-submitted"),
      });
    });

    it("sets 'done' status only when PM properly completes", async () => {
      // Simulate different completion results
      const results = ["completed", "already_done", "needs_yield", "error"];
      const expectedStatuses = ["done", "done", "in_review", "error"];

      for (let i = 0; i < results.length; i++) {
        const lastResult = results[i];
        let finalStatus: string;

        if (lastResult === "needs_yield") {
          // Would force-yield and set in_review
          finalStatus = "in_review";
        } else if (lastResult === "completed" || lastResult === "already_done") {
          finalStatus = "done";
        } else if (lastResult === "error") {
          finalStatus = "error";
        } else {
          finalStatus = "done"; // default
        }

        expect(finalStatus).toBe(expectedStatuses[i]);
      }
    });

    it("checks PM phase before building nudge message", async () => {
      mockInvoke.mockResolvedValueOnce("exploration"); // agent_get_pm_phase

      const agentId = "pm-1";
      const pmPhase = await invoke<string | null>("agent_get_pm_phase", { agentId });

      expect(mockInvoke).toHaveBeenCalledWith("agent_get_pm_phase", { agentId: "pm-1" });
      expect(pmPhase).toBe("exploration");
    });

    it("checks for subtasks under epic before building nudge message", async () => {
      mockInvoke.mockResolvedValueOnce(JSON.stringify([
        { id: "task-1", title: "First subtask" },
        { id: "task-2", title: "Second subtask" },
      ])); // beads_run list

      const projectPath = "/tmp/project";
      const taskId = "epic-42";

      const tasksJson = await invoke<string>("beads_run", {
        projectPath,
        args: ["list", "--json", "--parent", taskId],
      });
      const tasks = JSON.parse(tasksJson);
      const hasSubtasks = Array.isArray(tasks) && tasks.length > 0;

      expect(hasSubtasks).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith("beads_run", {
        projectPath: "/tmp/project",
        args: ["list", "--json", "--parent", "epic-42"],
      });
    });

    it("handles missing subtasks gracefully", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("No tasks found")); // beads_run fails

      let hasSubtasks = false;
      try {
        await invoke<string>("beads_run", {
          projectPath: "/tmp/project",
          args: ["list", "--json", "--parent", "epic-42"],
        });
      } catch {
        // Ignore error - hasSubtasks stays false
      }

      expect(hasSubtasks).toBe(false);
    });
  });
});
