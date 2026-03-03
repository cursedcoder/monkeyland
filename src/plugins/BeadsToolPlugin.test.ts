import { describe, expect, it, vi, beforeEach } from "vitest";
import { BeadsToolPlugin } from "./BeadsToolPlugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

describe("BeadsToolPlugin", () => {
  const addBeadsNode = vi.fn(() => "beads-node-1");
  const updateStatus = vi.fn();

  beforeEach(() => {
    mockInvoke.mockReset();
    addBeadsNode.mockClear();
    updateStatus.mockClear();
  });

  it("returns error for empty project_path", async () => {
    const plugin = new BeadsToolPlugin("agent-1", "agent-1", addBeadsNode, updateStatus);
    const result = await plugin.execute({}, { project_path: "  " });
    expect(result.result).toBe("Error: project_path is required.");
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(addBeadsNode).not.toHaveBeenCalled();
  });

  it("uses canvasNodeId for card parent and backendAgentId for backend commands", async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Beads initialized.");
    
    // WM scenario: canvas ID differs from backend ID
    const canvasNodeId = "node-12345-abc";
    const backendAgentId = "01KJTE-backend-id";
    const plugin = new BeadsToolPlugin(canvasNodeId, backendAgentId, addBeadsNode, updateStatus);
    await plugin.execute({}, { project_path: "/tmp/proj" });

    // Backend commands should use backendAgentId
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "beads_dolt_start", { projectPath: "/tmp/proj", agentId: backendAgentId });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "set_beads_project_path", { projectPath: "/tmp/proj", agentId: backendAgentId });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "beads_init", { projectPath: "/tmp/proj", agentId: backendAgentId });
    
    // Card parent reference should use canvasNodeId (for connection lines)
    expect(addBeadsNode).toHaveBeenCalledWith(canvasNodeId);
  });

  it("calls all three invokes in order with init=true (default)", async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Beads initialized.");
    const plugin = new BeadsToolPlugin("agent-1", "agent-1", addBeadsNode, updateStatus);
    const result = await plugin.execute({}, { project_path: "/tmp/proj" });

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "beads_dolt_start", { projectPath: "/tmp/proj", agentId: "agent-1" });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "set_beads_project_path", { projectPath: "/tmp/proj", agentId: "agent-1" });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "beads_init", { projectPath: "/tmp/proj", agentId: "agent-1" });
    expect(addBeadsNode).toHaveBeenCalledWith("agent-1");
    expect(updateStatus).toHaveBeenCalledWith("beads-node-1", expect.objectContaining({ projectPath: "/tmp/proj" }));
    expect(result.result).toContain("Dolt server ready.");
    expect(result.result).toContain("Project path set.");
    expect(result.result).toContain("Beads initialized.");
  });

  it("skips beads_init when init=false", async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const plugin = new BeadsToolPlugin("agent-1", "agent-1", addBeadsNode, updateStatus);
    const result = await plugin.execute({}, { project_path: "/tmp/proj", init: false });

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).not.toHaveBeenCalledWith("beads_init", expect.anything());
    expect(result.result).toBe("Dolt server ready. Project path set.");
  });

  it("treats init=undefined as true", async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("OK");
    const plugin = new BeadsToolPlugin("agent-1", "agent-1", addBeadsNode, updateStatus);
    await plugin.execute({}, { project_path: "/tmp/proj" });
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });

  it("returns error and updates status when beads_dolt_start throws", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("dolt not found"));
    const plugin = new BeadsToolPlugin("agent-1", "agent-1", addBeadsNode, updateStatus);
    const result = await plugin.execute({}, { project_path: "/tmp/proj" });

    expect(result.result).toBe("Error: dolt not found");
    expect(updateStatus).toHaveBeenCalledWith(
      "beads-node-1",
      expect.objectContaining({ initResult: "Error: dolt not found" }),
    );
  });

  it("returns error when set_beads_project_path throws", async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("permission denied"));
    const plugin = new BeadsToolPlugin("agent-1", "agent-1", addBeadsNode, updateStatus);
    const result = await plugin.execute({}, { project_path: "/tmp/proj" });
    expect(result.result).toBe("Error: permission denied");
  });

  it("returns error when beads_init throws", async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("init failed"));
    const plugin = new BeadsToolPlugin("agent-1", "agent-1", addBeadsNode, updateStatus);
    const result = await plugin.execute({}, { project_path: "/tmp/proj" });
    expect(result.result).toBe("Error: init failed");
  });

  it("calls addBeadsNode only once across two executions", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const plugin = new BeadsToolPlugin("agent-1", "agent-1", addBeadsNode, updateStatus);

    await plugin.execute({}, { project_path: "/tmp/proj", init: false });
    await plugin.execute({}, { project_path: "/tmp/proj2", init: false });

    expect(addBeadsNode).toHaveBeenCalledTimes(1);
  });

  it("ignores start_dolt parameter", async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const plugin = new BeadsToolPlugin("agent-1", "agent-1", addBeadsNode, updateStatus);
    const result = await plugin.execute({}, { project_path: "/tmp/proj", init: false, start_dolt: true });
    expect(result.result).toBe("Dolt server ready. Project path set.");
  });
});
