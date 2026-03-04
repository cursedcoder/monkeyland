import { describe, it, expect, vi, beforeEach } from "vitest";
import { inspectProject, ProjectState } from "./projectInspection";
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

describe("inspectProject", () => {
  it("returns NEW when no beads cards on canvas", async () => {
    const result = await inspectProject([]);
    expect(result.state).toBe(ProjectState.NEW);
    expect(result.projectPath).toBeNull();
  });

  it("returns NEW when beads card exists but no tasks", async () => {
    mockInvoke.mockResolvedValueOnce(undefined); // beads_dolt_start
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
    mockInvoke.mockResolvedValueOnce(undefined);
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
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks)); // beads_run list
    // Archive calls for epic-2, task-2, epic-3
    mockInvoke.mockResolvedValue("ok");

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
    mockInvoke.mockResolvedValueOnce(undefined);
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
    mockInvoke.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));
    mockInvoke.mockResolvedValue("ok"); // archive call

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
    mockInvoke.mockResolvedValueOnce(undefined);
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
    mockInvoke.mockResolvedValueOnce(undefined);
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
    mockInvoke.mockResolvedValueOnce(undefined);
    mockInvoke.mockResolvedValueOnce(JSON.stringify(tasks));

    const result = await inspectProject([beadsLayout("/tmp/myapp")]);
    expect(result.stateContext).toContain("/tmp/myapp");
    expect(result.stateContext).toContain("epic-1");
  });
});
