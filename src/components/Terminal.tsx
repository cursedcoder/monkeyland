import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  sessionId: string;
}

interface SessionBatch {
  terminal_chunk?: string;
}

interface BatchedPayload {
  sessions: Record<string, SessionBatch>;
}

export function Terminal({ sessionId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const spawnTerminal = useCallback(async (cols: number, rows: number) => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;
    try {
      await invoke("terminal_spawn", {
        payload: { session_id: sessionId, cols, rows },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("already exists")) {
        console.warn("terminal_spawn failed:", msg);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#364a82",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(el);

    // Small delay to let DOM settle before first fit
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        // container may not have dimensions yet
      }
      spawnTerminal(xterm.cols, xterm.rows);
    });

    xtermRef.current = xterm;
    fitRef.current = fit;

    // Send user input to PTY
    const inputDisposable = xterm.onData((data) => {
      invoke("terminal_write", {
        payload: { session_id: sessionId, data },
      }).catch(() => {});
    });

    // Listen for batched terminal output from Rust
    let unlisten: UnlistenFn | null = null;
    const sid = sessionId;
    listen<BatchedPayload>("terminal_batch", (event) => {
      const batch = event.payload?.sessions?.[sid];
      if (batch?.terminal_chunk) {
        xterm.write(batch.terminal_chunk);
      }
    }).then((fn_) => {
      unlisten = fn_;
    });

    // ResizeObserver to auto-fit terminal when card resizes
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fit.fit();
          invoke("terminal_resize", {
            payload: { session_id: sessionId, cols: xterm.cols, rows: xterm.rows },
          }).catch(() => {});
        } catch {
          // ignore if container has zero size
        }
      });
    });
    ro.observe(el);
    resizeObserverRef.current = ro;

    return () => {
      inputDisposable.dispose();
      if (unlisten) unlisten();
      ro.disconnect();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      resizeObserverRef.current = null;
    };
  }, [sessionId, spawnTerminal]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ width: "100%", height: "100%", overflow: "hidden" }}
    />
  );
}
