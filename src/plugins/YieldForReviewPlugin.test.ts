import { describe, expect, it, vi, beforeEach } from "vitest";
import { YieldForReviewPlugin } from "./YieldForReviewPlugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

/**
 * Helper: set up mockInvoke to handle the auto-commit flow (no worktree)
 * then the agent_yield call.
 */
function mockNoWorktreeThenYield() {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_agent_worktree_path") return null;
    if (cmd === "agent_yield") return undefined;
    return undefined;
  });
}

describe("YieldForReviewPlugin", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("submits yield with diff_summary and git_branch", async () => {
    mockNoWorktreeThenYield();

    const plugin = new YieldForReviewPlugin("dev-1", "bd-42");
    const result = await plugin.execute({}, {
      diff_summary: "Added auth module",
      git_branch: "task/bd-42",
    });

    expect(mockInvoke).toHaveBeenCalledWith("agent_yield", {
      agentId: "dev-1",
      payload: {
        status: "yielded",
        git_branch: "task/bd-42",
        diff_summary: "Added auth module",
      },
    });
    expect(result.result).toContain("submitted for review");
    expect(result.result).toContain("3 validators");
  });

  it("returns error message when agent_yield throws", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_agent_worktree_path") return null;
      if (cmd === "agent_yield") throw new Error("Max validation retries exceeded");
      return undefined;
    });

    const plugin = new YieldForReviewPlugin("dev-1", "bd-42");
    const result = await plugin.execute({}, {
      diff_summary: "fix attempt",
    });

    expect(result.result).toContain("Error submitting for review");
    expect(result.result).toContain("Max validation retries");
  });

  it("defaults diff_summary to 'No summary provided' when nullish", async () => {
    mockNoWorktreeThenYield();

    const plugin = new YieldForReviewPlugin("dev-1");
    await plugin.execute({}, {
      diff_summary: undefined as unknown as string,
    });

    expect(mockInvoke).toHaveBeenCalledWith("agent_yield", {
      agentId: "dev-1",
      payload: {
        status: "yielded",
        git_branch: null,
        diff_summary: "No summary provided",
      },
    });
  });

  it("passes null for missing git_branch", async () => {
    mockNoWorktreeThenYield();

    const plugin = new YieldForReviewPlugin("dev-1");
    await plugin.execute({}, {
      diff_summary: "some changes",
    });

    const yieldCall = mockInvoke.mock.calls.find((c) => c[0] === "agent_yield");
    expect(yieldCall).toBeDefined();
    const payload = (yieldCall![1] as { payload: { git_branch: string | null } }).payload;
    expect(payload.git_branch).toBeNull();
  });

  // --- Auto-commit safety net tests ---

  it("auto-commits uncommitted changes before yielding", async () => {
    const terminalCalls: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_agent_worktree_path") return "/tmp/project/.worktrees/dev-1";
      if (cmd === "terminal_exec") {
        const payload = (args as { payload: { command: string } }).payload;
        terminalCalls.push(payload.command);
        if (payload.command.includes("diff --cached")) return "DIRTY";
        return "";
      }
      if (cmd === "agent_yield") return undefined;
      return undefined;
    });

    const plugin = new YieldForReviewPlugin("dev-1", "bd-42");
    await plugin.execute({}, { diff_summary: "Added new feature" });

    expect(terminalCalls).toContain("git add -A");
    expect(terminalCalls.some((c) => c.includes("git diff --cached"))).toBe(true);
    expect(terminalCalls.some((c) => c.includes("git commit"))).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_agent_worktree_path",
      expect.objectContaining({ agentId: "dev-1" }),
    );
  });

  it("skips git commit when worktree is clean", async () => {
    const terminalCalls: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_agent_worktree_path") return "/tmp/project/.worktrees/dev-1";
      if (cmd === "terminal_exec") {
        const payload = (args as { payload: { command: string } }).payload;
        terminalCalls.push(payload.command);
        if (payload.command.includes("diff --cached")) return "CLEAN";
        return "";
      }
      if (cmd === "agent_yield") return undefined;
      return undefined;
    });

    const plugin = new YieldForReviewPlugin("dev-1", "bd-42");
    await plugin.execute({}, { diff_summary: "No new files" });

    expect(terminalCalls).toContain("git add -A");
    expect(terminalCalls.some((c) => c.includes("git commit"))).toBe(false);
  });

  it("skips auto-commit when agent has no worktree", async () => {
    mockNoWorktreeThenYield();

    const plugin = new YieldForReviewPlugin("dev-1", "bd-42");
    await plugin.execute({}, { diff_summary: "changes" });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "terminal_exec",
      expect.anything(),
    );
    expect(mockInvoke).toHaveBeenCalledWith("agent_yield", expect.anything());
  });

  it("still yields even if auto-commit fails", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_agent_worktree_path") return "/tmp/project/.worktrees/dev-1";
      if (cmd === "terminal_exec") throw new Error("git not found");
      if (cmd === "agent_yield") return undefined;
      return undefined;
    });

    const plugin = new YieldForReviewPlugin("dev-1", "bd-42");
    const result = await plugin.execute({}, { diff_summary: "changes" });

    expect(mockInvoke).toHaveBeenCalledWith("agent_yield", expect.anything());
    expect(result.result).toContain("submitted for review");
  });

  it("uses diff_summary in auto-commit message", async () => {
    let commitCommand = "";
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_agent_worktree_path") return "/tmp/project/.worktrees/dev-1";
      if (cmd === "terminal_exec") {
        const payload = (args as { payload: { command: string } }).payload;
        if (payload.command.includes("diff --cached")) return "DIRTY";
        if (payload.command.includes("git commit")) commitCommand = payload.command;
        return "";
      }
      if (cmd === "agent_yield") return undefined;
      return undefined;
    });

    const plugin = new YieldForReviewPlugin("dev-1", "bd-42");
    await plugin.execute({}, { diff_summary: "Added dark theme CSS" });

    expect(commitCommand).toContain("Added dark theme CSS");
  });
});
