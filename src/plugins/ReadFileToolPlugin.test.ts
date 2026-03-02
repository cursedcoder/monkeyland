import { describe, expect, it, vi, beforeEach } from "vitest";
import { ReadFileToolPlugin } from "./ReadFileToolPlugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

describe("ReadFileToolPlugin", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("reads file content via invoke", async () => {
    mockInvoke.mockResolvedValueOnce("fn main() {}");

    const plugin = new ReadFileToolPlugin("agent-1");
    const result = await plugin.execute({}, { path: "/tmp/project/main.rs" });

    expect(mockInvoke).toHaveBeenCalledWith("read_file", {
      path: "/tmp/project/main.rs",
      agentId: "agent-1",
    });
    expect(result.content).toBe("fn main() {}");
  });

  it("returns error message when invoke fails", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("File not found"));

    const plugin = new ReadFileToolPlugin("agent-1");
    const result = await plugin.execute({}, { path: "/nonexistent" });

    expect(result.content).toContain("Error:");
    expect(result.content).toContain("File not found");
  });

  it("rejects empty path", async () => {
    const plugin = new ReadFileToolPlugin("agent-1");
    const result = await plugin.execute({}, { path: "" });

    expect(result.content).toBe("Error: path is required.");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
