import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TerminalLogCard } from "./TerminalLogCard";
import type { SessionLayout } from "../types";

function makeLayout(entries: Array<{ command: string; output: string }>): SessionLayout {
  return {
    session_id: "log-1",
    x: 0,
    y: 0,
    w: 480,
    h: 360,
    collapsed: false,
    node_type: "terminal_log",
    payload: JSON.stringify({
      entries: entries.map((e, i) => ({
        command: e.command,
        output: e.output,
        ts: Date.now() + i,
      })),
    }),
  };
}

describe("TerminalLogCard", () => {
  it("renders command entries from payload", () => {
    const layout = makeLayout([
      { command: "npm run build", output: "ok" },
      { command: "cargo check", output: "done" },
    ]);

    render(
      <TerminalLogCard
        layout={layout}
        onLayoutChange={() => {}}
        onLayoutCommit={() => {}}
      />,
    );

    expect(screen.getByText("npm run build")).toBeTruthy();
    expect(screen.getByText("cargo check")).toBeTruthy();
    expect(screen.getByText("2 cmds")).toBeTruthy();
  });
});
