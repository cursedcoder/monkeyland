import { describe, expect, it, vi, beforeEach } from "vitest";
import { WriteFileToolPlugin } from "./WriteFileToolPlugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

describe("WriteFileToolPlugin", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("writes file with path, content, and agentId", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const plugin = new WriteFileToolPlugin("agent-1");
    const result = await plugin.execute({}, {
      path: "/tmp/project/src/main.rs",
      content: 'fn main() { println!("hello"); }',
    });

    expect(mockInvoke).toHaveBeenCalledWith("write_file", {
      path: "/tmp/project/src/main.rs",
      content: 'fn main() { println!("hello"); }',
      agentId: "agent-1",
    });
    expect(result.result).toBe("File written: /tmp/project/src/main.rs");
  });

  it("returns error message when invoke fails", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Path traversal blocked"));

    const plugin = new WriteFileToolPlugin("agent-1");
    const result = await plugin.execute({}, {
      path: "/etc/passwd",
      content: "evil",
    });

    expect(result.result).toContain("Error writing file");
    expect(result.result).toContain("Path traversal blocked");
  });

  it("rejects empty path", async () => {
    const plugin = new WriteFileToolPlugin("agent-1");
    const result = await plugin.execute({}, {
      path: "   ",
      content: "data",
    });

    expect(result.result).toBe("Error: path is required.");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("passes null agentId when not provided", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const plugin = new WriteFileToolPlugin();
    await plugin.execute({}, { path: "/tmp/file.txt", content: "data" });

    expect(mockInvoke).toHaveBeenCalledWith("write_file", {
      path: "/tmp/file.txt",
      content: "data",
      agentId: null,
    });
  });
});
