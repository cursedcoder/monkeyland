# Monkeyland — Agent Canvas

Desktop app for managing **20 concurrent AI agents** with terminals and browsers. Built with Tauri 2 (Rust) + React + TypeScript.

## Architecture

- **PTYs in Rust** (portable-pty), never Node. One PTY pool (20 slots), 64 KB ring buffer per session.
- **One Chromium instance** via shared Playwright server; browser context pool (max 20).
- **Per-session SQLite** files under `~/.config/monkeyland/sessions/{session-id}.db`; meta DB at `~/.config/monkeyland/meta.db`.
- **DOM canvas** with CSS transforms (no WebGL/PixiJS). Viewport culling; only visible session cards are mounted.
- **Coalesced IPC**: one batched message per frame (16 ms) to the WebView; batched SQLite writes every 100 ms.

## Prerequisites

- **Node.js** 18+
- **Rust** (stable)
- **macOS** (primary target; Linux/WebKitGTK should work)

## Install and run

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

## Implemented

- **Stage 1**: Tauri 2 + React shell, DOM infinite canvas (pan/zoom), 20 draggable/resizable session cards, viewport culling, layout persistence (meta DB).
- **Stage 2**: Per-session SQLite schema (events + snapshots), meta DB with canvas layout; `SessionDb` and `MetaDb` in Rust; log compaction API. Coalescing bus and write batcher to be wired in Stage 3.

## Pending

- Stage 3: PTY pool (portable-pty), ring buffers, coalesced IPC, xterm.js pool, JSON-RPC over Unix socket.
- Stage 4: Playwright server, browser context pool, CDP, JSON-RPC browser commands.
- Stage 5: Replay (snapshot-based seek, play/pause, speed).
- Stage 6: 20-agent stress test, session list UI, error handling.

## Config / data

- **Config dir**: `~/.config/monkeyland/` (or app equivalent on macOS).
- **Meta DB**: `meta.db` — session index, canvas layout.
- **Session DBs**: `sessions/{session-id}.db` — events and snapshots per session.
