import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BrowserToolPlugin } from "./BrowserToolPlugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("BrowserToolPlugin", () => {
  let addBrowserNode: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockInvoke.mockReset();
    mockFetch.mockReset();
    addBrowserNode = vi.fn().mockReturnValue("browser-node-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getTimeoutMs is 90s (higher than default)", () => {
    const plugin = new BrowserToolPlugin("agent-1", addBrowserNode);
    expect(plugin.getTimeoutMs()).toBe(90_000);
  });

  it("getName returns browser_action", () => {
    const plugin = new BrowserToolPlugin("agent-1", addBrowserNode);
    expect(plugin.getName()).toBe("browser_action");
  });

  it("creates session on server BEFORE calling addBrowserNode (race fix)", async () => {
    mockInvoke.mockResolvedValueOnce(9999);

    const callOrder: string[] = [];
    mockFetch
      .mockImplementationOnce(async () => {
        callOrder.push("fetch:create-session");
        return { ok: true, json: async () => ({ session_id: "s1", ok: true }) };
      })
      .mockImplementationOnce(async () => {
        callOrder.push("fetch:navigate");
        return {
          ok: true,
          json: async () => ({ url: "http://example.com", title: "Example", content: "Hello" }),
        };
      });

    addBrowserNode.mockImplementation((...args: any[]) => {
      callOrder.push("addBrowserNode");
      return args[2] ?? "fallback-id";
    });

    const plugin = new BrowserToolPlugin("agent-1", addBrowserNode);
    await plugin.execute({}, { action: "navigate", url: "http://example.com" });

    expect(callOrder[0]).toBe("fetch:create-session");
    expect(callOrder[1]).toBe("addBrowserNode");
    expect(callOrder[2]).toBe("fetch:navigate");
  });

  it("passes pre-generated sessionId to addBrowserNode", async () => {
    mockInvoke.mockResolvedValueOnce(9999);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "http://x.com", title: "X", content: "" }),
      });

    addBrowserNode.mockImplementation((_agentId: string, _port: number, sessionId?: string) => {
      return sessionId ?? "no-id";
    });

    const plugin = new BrowserToolPlugin("agent-1", addBrowserNode);
    await plugin.execute({}, { action: "navigate", url: "http://x.com" });

    expect(addBrowserNode).toHaveBeenCalledTimes(1);
    const passedSessionId = addBrowserNode.mock.calls[0][2];
    expect(passedSessionId).toBeDefined();
    expect(passedSessionId).toMatch(/^browser-/);
  });

  it("returns unknown action for invalid action", async () => {
    mockInvoke.mockResolvedValueOnce(9999);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const plugin = new BrowserToolPlugin("agent-1", addBrowserNode);
    const result = await plugin.execute({}, { action: "destroy" });
    expect(result.result).toContain("Unknown action");
  });

  it("returns timeout error when fetch times out", async () => {
    mockInvoke.mockResolvedValueOnce(9999);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockImplementationOnce(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });

    const plugin = new BrowserToolPlugin("agent-1", addBrowserNode);
    const result = await plugin.execute({}, { action: "navigate", url: "http://slow.example.com" });
    expect(result.result).toMatch(/timed out/i);
    expect(result.result).toContain("navigate");
  });

  it("returns error when server responds with non-ok status", async () => {
    mockInvoke.mockResolvedValueOnce(9999);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: false,
        text: async () => "Session not found",
      });

    const plugin = new BrowserToolPlugin("agent-1", addBrowserNode);
    const result = await plugin.execute({}, { action: "screenshot" });
    expect(result.result).toContain("Error:");
    expect(result.result).toContain("Session not found");
  });

  it("reuses session on subsequent calls (no duplicate session creation)", async () => {
    mockInvoke.mockResolvedValueOnce(9999);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "http://a.com", title: "A", content: "a" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "http://b.com", title: "B", content: "b" }),
      });

    const plugin = new BrowserToolPlugin("agent-1", addBrowserNode);
    await plugin.execute({}, { action: "navigate", url: "http://a.com" });
    await plugin.execute({}, { action: "navigate", url: "http://b.com" });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(addBrowserNode).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("maps get_content action to content server action", async () => {
    mockInvoke.mockResolvedValueOnce(9999);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "http://x.com", title: "T", content: "body text" }),
      });

    const plugin = new BrowserToolPlugin("agent-1", addBrowserNode);
    const result = await plugin.execute({}, { action: "get_content" });

    const fetchUrl = mockFetch.mock.calls[1][0] as string;
    expect(fetchUrl).toContain("/content");
    expect(fetchUrl).not.toContain("/get_content");
    expect(result.result).toContain("body text");
  });
});
