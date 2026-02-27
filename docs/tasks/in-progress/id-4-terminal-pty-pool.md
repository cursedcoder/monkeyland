# id-4: Terminal — PTY pool and coalescing (Stage 3)

**Status:** In progress  
**Source:** monkeyland.md §7 Stage 3  
**Created:** 2025-02-27

## Goal

Rust-native PTY pool with ring buffers and coalesced IPC. PTYs in Rust (portable-pty) only; 64 KB ring buffer per session; coalescing bus drains all ring buffers every 16 ms into one batched Tauri event.

## Requirements

- [ ] PTY pool using `portable-pty` crate — 20 slots
- [ ] 20 async PTY read tasks on tokio, each writing to its session's 64 KB ring buffer
- [ ] Coalescing bus: drain all ring buffers every 16 ms, build one batched JSON payload, send via Tauri event
- [ ] Terminal events stored via write batcher: `terminal_chunk` and `terminal_block_end`
- [ ] Wire coalescing bus output to both UI (Tauri event) and storage (write batcher)

## Out of scope for this task

- xterm.js pool in frontend (separate task)
- JSON-RPC server on Unix domain socket (separate task)

## Technical notes

- Rule 1: PTYs in Rust only. Rule 5: coalesce before sending; one IPC per frame.
- Ring buffer: 64 KB fixed, old data overwritten on overflow.
- Coalescing bus skeleton exists in coalescing.rs; extend with ring buffers and real drain.

## Done criteria

- [ ] PTY pool (20 slots) and per-session 64 KB ring buffer in Rust
- [ ] Coalescing bus drains ring buffers every 16 ms and emits one Tauri event
- [ ] Terminal output written via write batcher to session DB

## Progress / Notes

<!-- 2025-02-27: Next task after id-3; to be implemented when operator invokes. -->
