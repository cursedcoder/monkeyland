import { describe, expect, it, vi, beforeEach } from "vitest";
import { YieldForReviewPlugin } from "./YieldForReviewPlugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

describe("YieldForReviewPlugin", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("submits yield with diff_summary and git_branch", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

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
    mockInvoke.mockRejectedValueOnce(new Error("Max validation retries exceeded"));

    const plugin = new YieldForReviewPlugin("dev-1", "bd-42");
    const result = await plugin.execute({}, {
      diff_summary: "fix attempt",
    });

    expect(result.result).toContain("Error submitting for review");
    expect(result.result).toContain("Max validation retries");
  });

  it("defaults diff_summary to 'No summary provided' when nullish", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    const plugin = new YieldForReviewPlugin("dev-1");
    // The ?? operator only fires for null/undefined, not empty string
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
    mockInvoke.mockResolvedValueOnce(undefined);

    const plugin = new YieldForReviewPlugin("dev-1");
    await plugin.execute({}, {
      diff_summary: "some changes",
    });

    const call = mockInvoke.mock.calls[0];
    expect(call[0]).toBe("agent_yield");
    const payload = (call[1] as { payload: { git_branch: string | null } }).payload;
    expect(payload.git_branch).toBeNull();
  });
});
