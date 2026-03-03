import { describe, expect, it, vi, beforeEach } from "vitest";
import { CreateBeadsTaskPlugin } from "./CreateBeadsTaskPlugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

describe("CreateBeadsTaskPlugin", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("rejects empty title", async () => {
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    const result = await plugin.execute({}, { title: "" });
    expect(result.result).toBe("Error: title is required.");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only title", async () => {
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    const result = await plugin.execute({}, { title: "   " });
    expect(result.result).toBe("Error: title is required.");
  });

  it("skips get_beads_project_path when projectPath is set", async () => {
    mockInvoke.mockResolvedValueOnce("  bd-task-99  ");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/tmp/proj");
    await plugin.execute({}, { title: "Setup" });
    expect(mockInvoke).not.toHaveBeenCalledWith("get_beads_project_path");
    expect(mockInvoke).toHaveBeenCalledWith("beads_run", expect.objectContaining({ projectPath: "/tmp/proj" }));
  });

  it("falls back to get_beads_project_path when projectPath is not set", async () => {
    mockInvoke
      .mockResolvedValueOnce("/fallback/path")
      .mockResolvedValueOnce("bd-1");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    await plugin.execute({}, { title: "Setup" });
    expect(mockInvoke).toHaveBeenCalledWith("get_beads_project_path");
    expect(mockInvoke).toHaveBeenCalledWith("beads_run", expect.objectContaining({ projectPath: "/fallback/path" }));
  });

  it("returns error when no project path available (returns null)", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const plugin = new CreateBeadsTaskPlugin();
    const result = await plugin.execute({}, { title: "Setup" });
    expect(result.result).toContain("No Beads project path set");
  });

  it("returns error when get_beads_project_path throws", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("backend down"));
    const plugin = new CreateBeadsTaskPlugin();
    const result = await plugin.execute({}, { title: "Setup" });
    expect(result.result).toContain("No Beads project path set");
  });

  it("builds full args array with all optional params", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, {
      title: "Build API",
      description: "REST endpoints",
      type: "feature",
      priority: 1,
      parent_id: "epic-1",
      deps: "bd-1,bd-2",
      labels: "api,backend",
      acceptance_criteria: "Tests pass",
      estimate_minutes: 30,
    });
    expect(mockInvoke).toHaveBeenCalledWith("beads_run", {
      projectPath: "/proj",
      args: [
        "create", "Build API", "--silent",
        "--type", "feature",
        "--priority", "1",
        "--parent", "epic-1",
        "--description", "REST endpoints",
        "--deps", "bd-1,bd-2",
        "--labels", "api,backend",
        "--acceptance", "Tests pass",
        "--estimate", "30",
      ],
      agentId: "agent-1",
    });
  });

  it("normalizes deps with extra whitespace and empties", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "X", deps: " a , , b " });
    const call = mockInvoke.mock.calls.find(c => c[0] === "beads_run")!;
    const args = (call[1] as { args: string[] }).args;
    expect(args).toContain("--deps");
    expect(args[args.indexOf("--deps") + 1]).toBe("a,b");
  });

  it("normalizes labels with extra whitespace and empties", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "X", labels: " x , , y " });
    const call = mockInvoke.mock.calls.find(c => c[0] === "beads_run")!;
    const args = (call[1] as { args: string[] }).args;
    expect(args[args.indexOf("--labels") + 1]).toBe("x,y");
  });

  it("excludes estimate_minutes when 0", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "X", estimate_minutes: 0 });
    const call = mockInvoke.mock.calls.find(c => c[0] === "beads_run")!;
    const args = (call[1] as { args: string[] }).args;
    expect(args).not.toContain("--estimate");
  });

  it("excludes estimate_minutes when negative", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "X", estimate_minutes: -5 });
    const call = mockInvoke.mock.calls.find(c => c[0] === "beads_run")!;
    const args = (call[1] as { args: string[] }).args;
    expect(args).not.toContain("--estimate");
  });

  it("defaults type to 'task'", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "X" });
    const call = mockInvoke.mock.calls.find(c => c[0] === "beads_run")!;
    const args = (call[1] as { args: string[] }).args;
    expect(args[args.indexOf("--type") + 1]).toBe("task");
  });

  it("defaults priority to 2", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "X" });
    const call = mockInvoke.mock.calls.find(c => c[0] === "beads_run")!;
    const args = (call[1] as { args: string[] }).args;
    expect(args[args.indexOf("--priority") + 1]).toBe("2");
  });

  it("returns error when beads_run throws", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("bd not installed"));
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    const result = await plugin.execute({}, { title: "X" });
    expect(result.result).toContain("Error creating task");
    expect(result.result).toContain("bd not installed");
  });

  it("trims stdout whitespace in result message", async () => {
    mockInvoke.mockResolvedValueOnce("  bd-42  \n");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    const result = await plugin.execute({}, { title: "Setup" });
    expect(result.result).toContain("ID: bd-42");
  });

  it("passes agentId through to beads_run invoke", async () => {
    mockInvoke.mockResolvedValueOnce("bd-1");
    const plugin = new CreateBeadsTaskPlugin("my-agent-id");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "X" });
    expect(mockInvoke).toHaveBeenCalledWith("beads_run", expect.objectContaining({ agentId: "my-agent-id" }));
  });

  it("passes null agentId when not provided", async () => {
    mockInvoke.mockResolvedValueOnce("bd-1");
    const plugin = new CreateBeadsTaskPlugin();
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "X" });
    expect(mockInvoke).toHaveBeenCalledWith("beads_run", expect.objectContaining({ agentId: null }));
  });

  it("adds --defer flag when deferred is true", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "Draft task", deferred: true });
    const call = mockInvoke.mock.calls.find(c => c[0] === "beads_run")!;
    const args = (call[1] as { args: string[] }).args;
    expect(args).toContain("--defer");
    expect(args[args.indexOf("--defer") + 1]).toBe("+100y");
  });

  it("does not add --defer flag when deferred is false", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "Normal task", deferred: false });
    const call = mockInvoke.mock.calls.find(c => c[0] === "beads_run")!;
    const args = (call[1] as { args: string[] }).args;
    expect(args).not.toContain("--defer");
  });

  it("does not add --defer flag when deferred is not provided", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    await plugin.execute({}, { title: "Normal task" });
    const call = mockInvoke.mock.calls.find(c => c[0] === "beads_run")!;
    const args = (call[1] as { args: string[] }).args;
    expect(args).not.toContain("--defer");
  });

  it("includes deferred status in result message", async () => {
    mockInvoke.mockResolvedValueOnce("bd-42");
    const plugin = new CreateBeadsTaskPlugin("agent-1");
    plugin.setProjectPath("/proj");
    const result = await plugin.execute({}, { title: "Draft task", deferred: true });
    expect(result.result).toContain("deferred");
  });
});
