import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TerminalToolPlugin } from "./TerminalToolPlugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

describe("TerminalToolPlugin", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const addLogNode = vi.fn(() => "log-node-1");
  const updateLog = vi.fn();

  function createPlugin(cwd?: string) {
    addLogNode.mockClear();
    updateLog.mockClear();
    return new TerminalToolPlugin("agent-1", addLogNode, updateLog, cwd);
  }

  it("executes command via terminal_exec", async () => {
    mockInvoke.mockResolvedValueOnce("Hello, world!\n");

    const plugin = createPlugin("/tmp/project");
    const promise = plugin.execute({}, { command: "echo Hello, world!" });
    // Advance past the live timer
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(mockInvoke).toHaveBeenCalledWith("terminal_exec", {
      payload: expect.objectContaining({
        command: "echo Hello, world!",
        agent_id: "agent-1",
        cwd: "/tmp/project",
        timeout_ms: 120_000,
      }),
    });
    expect(result.output).toBe("Hello, world!\n");
  });

  it("creates a log node on first execution", async () => {
    mockInvoke.mockResolvedValueOnce("ok");

    const plugin = createPlugin();
    const promise = plugin.execute({}, { command: "ls" });
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(addLogNode).toHaveBeenCalledWith("agent-1");
    expect(updateLog).toHaveBeenCalled();
    const lastCall = updateLog.mock.calls[updateLog.mock.calls.length - 1];
    expect(lastCall[0]).toBe("log-node-1");
    expect(lastCall[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "ls", output: "ok" }),
      ]),
    );
  });

  it("uses explicit cwd parameter over default", async () => {
    mockInvoke.mockResolvedValueOnce("output");

    const plugin = createPlugin("/default/cwd");
    const promise = plugin.execute({}, {
      command: "pwd",
      cwd: "/override/cwd",
    });
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const invoked = mockInvoke.mock.calls[0][1] as {
      payload: { cwd: string };
    };
    expect(invoked.payload.cwd).toBe("/override/cwd");
  });

  it("re-throws errors from invoke and logs failure", async () => {
    vi.useRealTimers();
    mockInvoke.mockRejectedValueOnce(new Error("Command timed out"));

    const plugin = createPlugin();

    await expect(
      plugin.execute({}, { command: "sleep 999" }),
    ).rejects.toThrow("Command timed out");

    const lastCall = updateLog.mock.calls[updateLog.mock.calls.length - 1];
    expect(lastCall[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ output: expect.stringContaining("Command failed") }),
      ]),
    );
    vi.useFakeTimers();
  });
});
