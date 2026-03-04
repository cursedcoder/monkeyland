import { describe, it, expect, vi, beforeEach } from "vitest";
import { inspectProject, inspectExistingProject, getActiveTaskIds, ProjectState } from "./projectInspection";
import type { SessionLayout } from "./types";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

function beadsLayout(projectPath: string): SessionLayout {
  return {
    session_id: "beads-1",
    x: 0, y: 0, w: 400, h: 300,
    collapsed: false,
    node_type: "beads",
    payload: JSON.stringify({ beadsStatus: { projectPath } }),
  };
}

function agentLayout(taskId: string, status: string): SessionLayout {
  return {
    session_id: `agent-${taskId}`,
    x: 0, y: 0, w: 400, h: 300,
    collapsed: false,
    node_type: "agent",
    payload: JSON.stringify({ task_id: taskId, status }),
  };
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("getActiveTaskIds", () => {
  it("returns task IDs from layouts with loading status", () => {
    const layouts = [
      agentLayout("task-1", "loading"),
      agentLayout("task-2", "done"),
      agentLayout("task-3", "loading"),
    ];
    const ids = getActiveTaskIds(layouts);
    expect(ids.has("task-1")).toBe(true);
    expect(ids.has("task-2")).toBe(false);
    expect(ids.has("task-3")).toBe(true);
  });

  it("returns empty set for empty layouts", () => {
    expect(getActiveTaskIds([]).size).toBe(0);
  });
});

describe("inspectProject", () => {
  it("returns NEW when no beads cards on canvas and no MetaDb path", async () => {
    mockInvoke.mockResolvedValueOnce(null); // get_beads_project_path
    const result = await inspectProject([]);
    expect(result.state).toBe(ProjectState.NEW);
    expect(result.projectPath).toBeNull();
  });

  it("uses MetaDb fallback when no canvas card but stored path exists", async () => {
    const tasks = [
      { id: "epic-1", title: "Build app", type: "epic", status: "closed" },
      { id: "task-1", title: "index.html", type: "task", status: "done", parent: "epic-1" },
    ];
    mockInvoke.mockResolvedValueOnce("/tmp/stored-proj"); // get_beads_project_path
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause (inside inspectExistingProject)
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks)); // beads_run list

    const result = await inspectProject([]);
    expect(result.state).toBe(ProjectState.COMPLETED);
    expect(result.projectPath).toBe("/tmp/stored-proj");
  });

  it("falls back to NEW when MetaDb path exists but Dolt fails", async () => {
    mockInvoke.mockResolvedValueOnce("/tmp/stale-proj"); // get_beads_project_path
    mockInvoke.mockRejectedValueOnce(new Error("dolt failed")); // beads_dolt_start

    const result = await inspectProject([]);
    expect(result.state).toBe(ProjectState.NEW);
    expect(result.projectPath).toBeNull();
  });

  it("returns NEW when beads card exists but no tasks", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce("[]"); // beads_run list
    const result = await inspectProject([beadsLayout("/tmp/proj")]);
    expect(result.state).toBe(ProjectState.NEW);
    expect(result.projectPath).toBe("/tmp/proj");
  });

  it("returns ERROR when Dolt fails to start", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("dolt not found"));
    const result = await inspectProject([beadsLayout("/tmp/proj")]);
    expect(result.state).toBe(ProjectState.ERROR);
    expect(result.errorMessage).toContain("dolt not found");
  });

  it("returns ERROR when beads_run fails", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockRejectedValueOnce(new Error("bd not found"));
    const result = await inspectProject([beadsLayout("/tmp/proj")]);
    expect(result.state).toBe(ProjectState.ERROR);
    expect(result.errorMessage).toContain("bd not found");
  });

  it("returns COMPLETED when only closed epics exist", async () => {
    const tasks = [
      { id: "epic-1", title: "Build app", type: "epic", status: "closed" },
      { id: "task-1", title: "Create index.html", type: "task", status: "done", parent: "epic-1" },
      { id: "task-2", title: "Create style.css", type: "task", status: "done", parent: "epic-1" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks)); // beads_run list

    const result = await inspectProject([beadsLayout("/tmp/proj")]);
    expect(result.state).toBe(ProjectState.COMPLETED);
    expect(result.completedEpics).toHaveLength(1);
    expect(result.completedEpics[0].id).toBe("epic-1");
    expect(result.completionSummary).toContain("already complete");
    expect(result.completionSummary).toContain("Build app");
    expect(result.zombiesArchived).toHaveLength(0);
  });

  it("returns IN_PROGRESS when an open epic exists", async () => {
    const tasks = [
      { id: "epic-1", title: "Build app", type: "epic", status: "in_progress" },
      { id: "task-1", title: "Create index.html", type: "task", status: "open", parent: "epic-1" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));

    const result = await inspectProject([beadsLayout("/tmp/proj")]);
    expect(result.state).toBe(ProjectState.IN_PROGRESS);
    expect(result.activeEpics).toHaveLength(1);
    expect(result.stateContext).toContain("EPIC ALREADY IN PROGRESS");
  });

  it("archives zombie epics when completed epic exists", async () => {
    const tasks = [
      { id: "epic-1", title: "Build app v1", type: "epic", status: "closed" },
      { id: "task-1", title: "Create index.html", type: "task", status: "done", parent: "epic-1" },
      { id: "epic-2", title: "Build app v2", type: "epic", status: "in_progress" },
      { id: "task-2", title: "Create index.html", type: "task", status: "open", parent: "epic-2" },
      { id: "epic-3", title: "Build app v3", type: "epic", status: "in_progress" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks)); // beads_run list
    mockInvoke.mockResolvedValue("ok"); // close calls

    const result = await inspectProject([beadsLayout("/tmp/proj")]);
    expect(result.state).toBe(ProjectState.COMPLETED);
    expect(result.zombiesArchived).toContain("epic-2");
    expect(result.zombiesArchived).toContain("task-2");
    expect(result.zombiesArchived).toContain("epic-3");
    expect(result.remainingTasks).toHaveLength(2);
  });

  it("does not archive active epics even when completed epic exists", async () => {
    const tasks = [
      { id: "epic-1", title: "Build app", type: "epic", status: "closed" },
      { id: "epic-2", title: "Build app again", type: "epic", status: "in_progress" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));

    const layouts = [
      beadsLayout("/tmp/proj"),
      agentLayout("epic-2", "loading"),
    ];
    const result = await inspectProject(layouts);
    expect(result.zombiesArchived).not.toContain("epic-2");
  });

  it("keeps most recent epic when multiple open epics and no closed one", async () => {
    const tasks = [
      { id: "epic-old", title: "Old epic", type: "epic", status: "in_progress", updated_at: "2024-01-01T00:00:00Z" },
      { id: "epic-new", title: "New epic", type: "epic", status: "in_progress", updated_at: "2025-12-01T00:00:00Z" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));
    mockInvoke.mockResolvedValue("ok"); // close call

    const result = await inspectProject([beadsLayout("/tmp/proj")]);
    expect(result.state).toBe(ProjectState.IN_PROGRESS);
    expect(result.zombiesArchived).toContain("epic-old");
    expect(result.zombiesArchived).not.toContain("epic-new");
  });

  it("cascades: archives children of archived epics", async () => {
    const tasks = [
      { id: "epic-1", title: "Done", type: "epic", status: "closed" },
      { id: "epic-2", title: "Zombie", type: "epic", status: "in_progress" },
      { id: "child-1", title: "Child task", type: "task", status: "open", parent: "epic-2" },
      { id: "grandchild", title: "Grandchild", type: "task", status: "open", parent: "child-1" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));
    mockInvoke.mockResolvedValue("ok");

    const result = await inspectProject([beadsLayout("/tmp/proj")]);
    expect(result.zombiesArchived).toContain("epic-2");
    expect(result.zombiesArchived).toContain("child-1");
    expect(result.zombiesArchived).toContain("grandchild");
  });

  it("deduplicates non-epic tasks with same title", async () => {
    const tasks = [
      { id: "epic-1", title: "App", type: "epic", status: "in_progress" },
      { id: "task-a", title: "Create index.html", type: "task", status: "done", parent: "epic-1" },
      { id: "task-b", title: "Create index.html", type: "task", status: "open", parent: "epic-1" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));
    mockInvoke.mockResolvedValue("ok");

    const result = await inspectProject([beadsLayout("/tmp/proj")]);
    expect(result.zombiesArchived).toContain("task-b");
    expect(result.zombiesArchived).not.toContain("task-a");
  });

  it("stateContext includes project path and task list", async () => {
    const tasks = [
      { id: "epic-1", title: "App", type: "epic", status: "in_progress" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));

    const result = await inspectProject([beadsLayout("/tmp/myapp")]);
    expect(result.stateContext).toContain("/tmp/myapp");
    expect(result.stateContext).toContain("epic-1");
  });
});

describe("inspectExistingProject", () => {
  it("calls orch_pause before listing tasks", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce("[]"); // beads_run list

    await inspectExistingProject("/tmp/proj", new Set());
    expect(mockInvoke).toHaveBeenCalledWith("orch_pause");
    const calls = mockInvoke.mock.calls.map((c: any[]) => c[0]);
    expect(calls.indexOf("orch_pause")).toBeLessThan(calls.indexOf("beads_run"));
  });

  it("returns ERROR when beads_run list fails", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockRejectedValueOnce(new Error("bd crashed"));
    const result = await inspectExistingProject("/tmp/proj", new Set());
    expect(result.state).toBe(ProjectState.ERROR);
    expect(result.errorMessage).toContain("bd crashed");
  });

  it("returns NEW when project has no tasks", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce("[]");
    const result = await inspectExistingProject("/tmp/proj", new Set());
    expect(result.state).toBe(ProjectState.NEW);
    expect(result.projectPath).toBe("/tmp/proj");
  });

  it("returns COMPLETED and builds summary for closed epics", async () => {
    const tasks = [
      { id: "epic-1", title: "Build site", type: "epic", status: "closed" },
      { id: "task-1", title: "Create index.html", type: "task", status: "done", parent: "epic-1" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));
    const result = await inspectExistingProject("/tmp/proj", new Set());
    expect(result.state).toBe(ProjectState.COMPLETED);
    expect(result.completionSummary).toContain("already complete");
    expect(result.completionSummary).toContain("Build site");
    expect(result.stateContext).toContain("WORK IS ALREADY COMPLETED");
  });

  it("archives zombies and returns COMPLETED when closed + open epics exist", async () => {
    const tasks = [
      { id: "epic-done", title: "Done", type: "epic", status: "closed" },
      { id: "epic-zombie", title: "Zombie", type: "epic", status: "in_progress" },
      { id: "child", title: "Zombie child", type: "task", status: "open", parent: "epic-zombie" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks)); // list
    mockInvoke.mockResolvedValue("ok"); // close calls

    const result = await inspectExistingProject("/tmp/proj", new Set());
    expect(result.state).toBe(ProjectState.COMPLETED);
    expect(result.zombiesArchived).toContain("epic-zombie");
    expect(result.zombiesArchived).toContain("child");
  });

  it("does not archive active epics (epic-level guard)", async () => {
    const tasks = [
      { id: "epic-done", title: "Done", type: "epic", status: "closed" },
      { id: "epic-active", title: "Active", type: "epic", status: "in_progress" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));

    const activeIds = new Set(["epic-active"]);
    const result = await inspectExistingProject("/tmp/proj", activeIds);
    expect(result.zombiesArchived).not.toContain("epic-active");
  });

  it("force-closes active children of zombie epics when completed epic exists", async () => {
    const tasks = [
      { id: "epic-done", title: "Done", type: "epic", status: "closed" },
      { id: "epic-zombie", title: "Zombie", type: "epic", status: "in_progress" },
      { id: "child-active", title: "Active child", type: "task", status: "open", parent: "epic-zombie" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks)); // list
    mockInvoke.mockResolvedValue("ok"); // close calls

    // child-active has an active agent, but should still be closed because
    // its parent epic is a zombie (completed epic exists)
    const activeIds = new Set(["child-active"]);
    const result = await inspectExistingProject("/tmp/proj", activeIds);
    expect(result.zombiesArchived).toContain("epic-zombie");
    expect(result.zombiesArchived).toContain("child-active");
    expect(result.state).toBe(ProjectState.COMPLETED);
  });

  it("respects activeTaskIds for cascade when no completed epic (open-epic dedup)", async () => {
    const tasks = [
      { id: "epic-new", title: "New", type: "epic", status: "in_progress", updated_at: "2025-12-01T00:00:00Z" },
      { id: "epic-old", title: "Old", type: "epic", status: "in_progress", updated_at: "2024-01-01T00:00:00Z" },
      { id: "child-active", title: "Active child", type: "task", status: "open", parent: "epic-old" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks)); // list
    mockInvoke.mockResolvedValue("ok"); // close calls

    // child-active is protected during open-epic dedup (no completed epic)
    const activeIds = new Set(["child-active"]);
    const result = await inspectExistingProject("/tmp/proj", activeIds);
    expect(result.zombiesArchived).toContain("epic-old");
    expect(result.zombiesArchived).not.toContain("child-active");
  });

  it("returns IN_PROGRESS for open epics", async () => {
    const tasks = [
      { id: "epic-1", title: "WIP", type: "epic", status: "in_progress" },
      { id: "task-1", title: "Do thing", type: "task", status: "open", parent: "epic-1" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));

    const result = await inspectExistingProject("/tmp/proj", new Set());
    expect(result.state).toBe(ProjectState.IN_PROGRESS);
    expect(result.stateContext).toContain("EPIC ALREADY IN PROGRESS");
    expect(result.stateContext).toContain("epic-1");
  });

  it("uses bd close (not archive) when cleaning up zombies", async () => {
    const tasks = [
      { id: "epic-done", title: "Done", type: "epic", status: "closed" },
      { id: "epic-zombie", title: "Zombie", type: "epic", status: "in_progress" },
    ];
    mockInvoke.mockResolvedValueOnce(undefined); // orch_pause
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks)); // list
    mockInvoke.mockResolvedValueOnce("ok"); // close

    await inspectExistingProject("/tmp/proj", new Set());
    expect(mockInvoke).toHaveBeenCalledWith(
      "beads_run",
      expect.objectContaining({
        args: expect.arrayContaining(["close", "epic-zombie"]),
      }),
    );
  });
});
