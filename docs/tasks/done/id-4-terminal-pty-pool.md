# id-4: Terminal — PTY pool, coalescing, and visible terminal node (Stage 3)

**Status:** Done  
**Source:** monkeyland.md §7 Stage 3  
**Created:** 2025-02-27

## Goal

Rust-native PTY pool with ring buffers, coalesced IPC, and xterm.js rendering in agent nodes. PTYs in Rust (portable-pty) only; 64 KB ring buffer per session; coalescing bus drains all ring buffers every 16 ms into one batched Tauri event. Agent nodes display a live terminal.

## Requirements

- [x] PTY pool using `portable-pty` crate — 20 slots
- [x] Per-session 64 KB ring buffer with PTY reader thread
- [x] Coalescing bus: drain all ring buffers every 16 ms, build one batched JSON payload, send via Tauri event
- [x] Terminal events stored via write batcher: `terminal_chunk`
- [x] Wire coalescing bus output to both UI (Tauri event) and storage (write batcher)
- [x] xterm.js in frontend: Terminal component with auto-fit
- [x] Tauri commands: `terminal_spawn`, `terminal_write`, `terminal_resize`
- [x] Agent nodes on canvas embed live terminal (auto-spawns PTY on mount)

## Out of scope for this task

- JSON-RPC server on Unix domain socket (separate task)
- xterm.js instance pooling / max 8 (optimization for later)
- `terminal_block_end` event type (shell integration)

## Technical notes

- Rule 1: PTYs in Rust only. Rule 5: coalesce before sending; one IPC per frame.
- Ring buffer: Vec<u8> with 64 KB cap; old data truncated on overflow.
- Theme: Tokyo Night (matches app palette).
- FitAddon + ResizeObserver for auto-resizing terminal to card dimensions.

## Done criteria

- [x] PTY pool (20 slots) and per-session 64 KB ring buffer in Rust
- [x] Coalescing bus drains ring buffers every 16 ms and emits one Tauri event
- [x] Terminal output written via write batcher to session DB
- [x] Agent nodes render live xterm.js terminal
- [x] User can type in terminal; input sent to PTY
- [x] `npm run validate:no-errors` passes

## Progress / Notes

<!-- 2025-02-27: Next task after id-3; to be implemented when operator invokes. -->
<!-- 2026-02-28: Implemented full stack: pty_pool.rs (Rust PTY pool with ring buffers), coalescing.rs (wired to drain + emit Tauri event + storage), terminal commands (spawn/write/resize), Terminal.tsx (xterm.js + FitAddon + auto-spawn), SessionCard updated to embed terminal. -->
