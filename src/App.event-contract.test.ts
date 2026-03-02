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
});
