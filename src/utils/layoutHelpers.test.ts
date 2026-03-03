import { describe, expect, it } from "vitest";
import { repositionLayouts, getTerminalDiagnostics, buildDiagnosticNudge, REPOSITION_ORIGIN } from "./layoutHelpers";
import { GRID_STEP } from "../types";
import type { SessionLayout } from "../types";

function makeLayout(overrides: Partial<SessionLayout> & { session_id: string }): SessionLayout {
  return {
    x: 0, y: 0, w: 200, h: 300, collapsed: false,
    ...overrides,
  };
}

describe("repositionLayouts", () => {
  it("positions a single root prompt at REPOSITION_ORIGIN", () => {
    const layouts = [makeLayout({ session_id: "p1", node_type: "prompt" })];
    const result = repositionLayouts(layouts);
    expect(result[0].x).toBe(REPOSITION_ORIGIN.x);
    expect(result[0].y).toBe(REPOSITION_ORIGIN.y);
  });

  it("positions agent child to the right of its prompt parent", () => {
    const prompt = makeLayout({
      session_id: "p1", node_type: "prompt", w: 480,
    });
    const agent = makeLayout({
      session_id: "a1", node_type: "agent",
      payload: JSON.stringify({ sourcePromptId: "p1", role: "workforce_manager" }),
    });
    const result = repositionLayouts([prompt, agent]);
    const rPrompt = result.find(l => l.session_id === "p1")!;
    const rAgent = result.find(l => l.session_id === "a1")!;
    expect(rAgent.x).toBe(rPrompt.x + rPrompt.w + GRID_STEP);
    expect(rAgent.y).toBe(rPrompt.y);
  });

  it("stacks children vertically for workforce_manager", () => {
    const wm = makeLayout({
      session_id: "wm", node_type: "agent", w: 300, h: 200,
      payload: JSON.stringify({ role: "workforce_manager" }),
    });
    const c1 = makeLayout({
      session_id: "c1", node_type: "agent", h: 100,
      payload: JSON.stringify({ parent_agent_id: "wm", role: "developer" }),
    });
    const c2 = makeLayout({
      session_id: "c2", node_type: "agent", h: 100,
      payload: JSON.stringify({ parent_agent_id: "wm", role: "developer" }),
    });
    const result = repositionLayouts([wm, c1, c2]);
    const rc1 = result.find(l => l.session_id === "c1")!;
    const rc2 = result.find(l => l.session_id === "c2")!;
    expect(rc1.x).toBe(rc2.x);
    expect(rc2.y).toBe(rc1.y + rc1.h + GRID_STEP);
  });

  it("stacks children vertically for wm_chat node", () => {
    const wmChat = makeLayout({
      session_id: "wm-chat", node_type: "wm_chat" as SessionLayout["node_type"], w: 300, h: 200,
      payload: JSON.stringify({ promptText: "hello" }),
    });
    const dev1 = makeLayout({
      session_id: "d1", node_type: "agent", h: 100,
      payload: JSON.stringify({ parent_agent_id: "wm-chat", role: "developer" }),
    });
    const dev2 = makeLayout({
      session_id: "d2", node_type: "agent", h: 100,
      payload: JSON.stringify({ parent_agent_id: "wm-chat", role: "developer" }),
    });
    const result = repositionLayouts([wmChat, dev1, dev2]);
    const rd1 = result.find(l => l.session_id === "d1")!;
    const rd2 = result.find(l => l.session_id === "d2")!;
    // Both developers have same X (stacked vertically)
    expect(rd1.x).toBe(rd2.x);
    // Second developer is below the first
    expect(rd2.y).toBe(rd1.y + rd1.h + GRID_STEP);
  });

  it("lays out children horizontally for developer", () => {
    const dev = makeLayout({
      session_id: "d1", node_type: "agent", w: 300,
      payload: JSON.stringify({ role: "developer" }),
    });
    // "b1" < "t1" lexicographically, so browser sorts first
    const term = makeLayout({
      session_id: "t1", node_type: "terminal", w: 200,
      payload: JSON.stringify({ parentAgentId: "d1" }),
    });
    const browser = makeLayout({
      session_id: "b1", node_type: "browser", w: 400,
      payload: JSON.stringify({ parentAgentId: "d1" }),
    });
    const result = repositionLayouts([dev, term, browser]);
    const rDev = result.find(l => l.session_id === "d1")!;
    const rTerm = result.find(l => l.session_id === "t1")!;
    const rBrowser = result.find(l => l.session_id === "b1")!;
    // Children are on the same row (horizontal layout)
    expect(rTerm.y).toBe(rBrowser.y);
    // Browser sorts first (b1 < t1), then terminal follows
    expect(rBrowser.x).toBe(rDev.x + rDev.w + GRID_STEP);
    expect(rTerm.x).toBe(rBrowser.x + rBrowser.w + GRID_STEP);
  });

  it("places two root trees with a double GRID_STEP gap", () => {
    const p1 = makeLayout({ session_id: "p1", node_type: "prompt", h: 100 });
    const p2 = makeLayout({ session_id: "p2", node_type: "prompt", h: 100 });
    const result = repositionLayouts([p1, p2]);
    const rp1 = result.find(l => l.session_id === "p1")!;
    const rp2 = result.find(l => l.session_id === "p2")!;
    expect(rp2.y).toBe(rp1.y + rp1.h + GRID_STEP * 2);
  });

  it("treats orphan node as root when parent_id references missing node", () => {
    const orphan = makeLayout({
      session_id: "o1", node_type: "agent",
      payload: JSON.stringify({ parent_agent_id: "nonexistent" }),
    });
    const result = repositionLayouts([orphan]);
    expect(result[0].x).toBe(REPOSITION_ORIGIN.x);
    expect(result[0].y).toBe(REPOSITION_ORIGIN.y);
  });

  it("uses height 48 for collapsed nodes", () => {
    const parent = makeLayout({
      session_id: "p1", node_type: "prompt", h: 220,
    });
    const child = makeLayout({
      session_id: "c1", node_type: "agent", h: 400, collapsed: true,
      payload: JSON.stringify({ sourcePromptId: "p1", role: "developer" }),
    });
    const result = repositionLayouts([parent, child]);
    const rParent = result.find(l => l.session_id === "p1")!;
    const rChild = result.find(l => l.session_id === "c1")!;
    expect(rChild.y).toBe(rParent.y);
    const bbox = { h: 48 };
    expect(bbox.h).toBe(48);
  });

  it("sorts roots: prompts before agents", () => {
    const agent = makeLayout({ session_id: "a1", node_type: "agent" });
    const prompt = makeLayout({ session_id: "p1", node_type: "prompt" });
    const result = repositionLayouts([agent, prompt]);
    const rPrompt = result.find(l => l.session_id === "p1")!;
    const rAgent = result.find(l => l.session_id === "a1")!;
    expect(rPrompt.y).toBeLessThan(rAgent.y);
  });

  it("sorts children: PM before Beads before others", () => {
    const parent = makeLayout({
      session_id: "p", node_type: "prompt", w: 100,
    });
    const devChild = makeLayout({
      session_id: "dev", node_type: "agent",
      payload: JSON.stringify({ sourcePromptId: "p", role: "developer" }),
    });
    const pmChild = makeLayout({
      session_id: "pm", node_type: "agent",
      payload: JSON.stringify({ sourcePromptId: "p", role: "project_manager" }),
    });
    const beadsChild = makeLayout({
      session_id: "bd", node_type: "beads",
      payload: JSON.stringify({ sourcePromptId: "p" }),
    });
    const result = repositionLayouts([parent, devChild, pmChild, beadsChild]);
    const rPm = result.find(l => l.session_id === "pm")!;
    const rBeads = result.find(l => l.session_id === "bd")!;
    const rDev = result.find(l => l.session_id === "dev")!;
    expect(rPm.y).toBeLessThan(rBeads.y);
    expect(rBeads.y).toBeLessThan(rDev.y);
  });

  it("handles malformed payload JSON without crashing", () => {
    const layouts = [
      makeLayout({ session_id: "x", node_type: "agent", payload: "not json{" }),
    ];
    const result = repositionLayouts(layouts);
    expect(result[0].x).toBe(REPOSITION_ORIGIN.x);
  });

  it("returns empty array for empty input", () => {
    expect(repositionLayouts([])).toEqual([]);
  });
});

describe("getTerminalDiagnostics", () => {
  it("returns formatted entries from agent's terminal_log child", () => {
    const layouts: SessionLayout[] = [
      makeLayout({ session_id: "agent-1", node_type: "agent" }),
      makeLayout({
        session_id: "log-1", node_type: "terminal_log",
        payload: JSON.stringify({
          parentAgentId: "agent-1",
          entries: [
            { command: "npm install", output: "added 200 packages" },
            { command: "npm run build", output: "Build succeeded" },
          ],
        }),
      }),
    ];
    const result = getTerminalDiagnostics(layouts, "agent-1");
    expect(result).toContain("$ npm install");
    expect(result).toContain("added 200 packages");
    expect(result).toContain("$ npm run build");
    expect(result).toContain("---");
  });

  it("returns empty string when agent has no terminal logs", () => {
    const layouts = [makeLayout({ session_id: "agent-1", node_type: "agent" })];
    expect(getTerminalDiagnostics(layouts, "agent-1")).toBe("");
  });

  it("returns empty string on malformed payload", () => {
    const layouts: SessionLayout[] = [
      makeLayout({
        session_id: "log-1", node_type: "terminal_log",
        payload: "broken json{",
      }),
    ];
    expect(getTerminalDiagnostics(layouts, "agent-1")).toBe("");
  });

  it("truncates each entry output to 500 chars", () => {
    const longOutput = "x".repeat(1000);
    const layouts: SessionLayout[] = [
      makeLayout({
        session_id: "log-1", node_type: "terminal_log",
        payload: JSON.stringify({
          parentAgentId: "a1",
          entries: [{ command: "cmd", output: longOutput }],
        }),
      }),
    ];
    const result = getTerminalDiagnostics(layouts, "a1");
    const outputPart = result.split("\n").slice(1).join("\n");
    expect(outputPart.length).toBeLessThanOrEqual(500);
  });

  it("takes only last 5 entries", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      command: `cmd-${i}`,
      output: `out-${i}`,
    }));
    const layouts: SessionLayout[] = [
      makeLayout({
        session_id: "log-1", node_type: "terminal_log",
        payload: JSON.stringify({ parentAgentId: "a1", entries }),
      }),
    ];
    const result = getTerminalDiagnostics(layouts, "a1");
    expect(result).not.toContain("cmd-4");
    expect(result).toContain("cmd-5");
    expect(result).toContain("cmd-9");
  });
});

describe("buildDiagnosticNudge", () => {
  const base = {
    attempt: 1,
    maxAttempts: 3,
    userMessage: "Build a todo app",
    taskId: "bd-123",
    taskMeta: { title: "Setup project" },
    projectPath: "/tmp/todo",
    terminalDiag: "",
  };

  it("detects interactive prompt (y/n)", () => {
    const result = buildDiagnosticNudge(1, 3, base.userMessage, base.taskId, base.taskMeta, base.projectPath, "Do you want to continue? (y/n)");
    expect(result).toContain("Interactive prompt");
    expect(result).toContain("--yes");
  });

  it("detects port conflict (EADDRINUSE)", () => {
    const result = buildDiagnosticNudge(1, 3, base.userMessage, base.taskId, base.taskMeta, base.projectPath, "Error: listen EADDRINUSE: address already in use :::3000");
    expect(result).toContain("Port conflict");
  });

  it("detects timeout", () => {
    const result = buildDiagnosticNudge(1, 3, base.userMessage, base.taskId, base.taskMeta, base.projectPath, "command timed out after 120s");
    expect(result).toContain("timed out");
  });

  it("detects foreground server blocking", () => {
    const result = buildDiagnosticNudge(1, 3, base.userMessage, base.taskId, base.taskMeta, base.projectPath, "Server started, listening on port 3000");
    expect(result).toContain("foreground server");
  });

  it("detects errors (ENOENT)", () => {
    const result = buildDiagnosticNudge(1, 3, base.userMessage, base.taskId, base.taskMeta, base.projectPath, "Error: ENOENT: no such file or directory");
    expect(result).toContain("Command errors");
  });

  it("detects warnings only when no other patterns match", () => {
    const result = buildDiagnosticNudge(1, 3, base.userMessage, base.taskId, base.taskMeta, base.projectPath, "npm warn deprecated glob@7");
    expect(result).toContain("Warnings detected");
    expect(result).toContain("proceed");
  });

  it("omits diagnosis section when no patterns match", () => {
    const result = buildDiagnosticNudge(1, 3, base.userMessage, base.taskId, base.taskMeta, base.projectPath, "all good here");
    expect(result).not.toContain("Diagnosis from your terminal output");
  });

  it("shows FINAL ATTEMPT urgency when attempt >= maxAttempts", () => {
    const result = buildDiagnosticNudge(3, 3, base.userMessage, base.taskId, base.taskMeta, base.projectPath, "");
    expect(result).toContain("FINAL ATTEMPT");
  });

  it("shows attempt counter when not final", () => {
    const result = buildDiagnosticNudge(1, 3, base.userMessage, base.taskId, base.taskMeta, base.projectPath, "");
    expect(result).toContain("Attempt 1/3");
  });

  it("truncates terminal output to last 1500 chars", () => {
    const longDiag = "x".repeat(3000);
    const result = buildDiagnosticNudge(1, 3, base.userMessage, base.taskId, base.taskMeta, base.projectPath, longDiag);
    const fenceStart = result.indexOf("```\n") + 4;
    const fenceEnd = result.indexOf("\n```", fenceStart);
    const content = result.slice(fenceStart, fenceEnd);
    expect(content.length).toBeLessThanOrEqual(1500);
  });

  it("interpolates task metadata correctly", () => {
    const result = buildDiagnosticNudge(1, 3, "Build it", "bd-42", { title: "Init React" }, "/tmp/proj", "");
    expect(result).toContain("task_id: bd-42");
    expect(result).toContain("task_title: Init React");
    expect(result).toContain("project_path: /tmp/proj");
    expect(result).toContain("Build it");
  });

  it("uses 'unknown' for null task metadata", () => {
    const result = buildDiagnosticNudge(1, 3, "msg", null, undefined, null, "");
    expect(result).toContain("task_id: unknown");
    expect(result).toContain("task_title: unknown");
    expect(result).toContain("project_path: unknown");
  });

  it("omits terminal section when terminalDiag is empty", () => {
    const result = buildDiagnosticNudge(1, 3, "msg", null, undefined, null, "");
    expect(result).not.toContain("Recent terminal output");
  });
});
