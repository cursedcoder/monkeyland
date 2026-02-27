# id-7: Terminal — JSON-RPC server and xterm.js pool (Stage 3 remaining)

**Status:** In progress  
**Source:** monkeyland.md §7 Stage 3, deliverables 4–5  
**Created:** 2026-02-28

## Goal

Complete remaining Stage 3 deliverables: JSON-RPC server on Unix domain socket with terminal methods (`terminal.exec`, `terminal.write`, `terminal.resize`), and xterm.js pool in frontend (max 8 visible instances, recycled on viewport pan).

## Requirements

- [ ] JSON-RPC server on Unix domain socket with methods: `terminal.exec`, `terminal.write`, `terminal.resize`
- [ ] xterm.js pool in frontend: max 8 instances, recycled on viewport pan
- [ ] `terminal_block_end` event type (shell integration / prompt detection)

## Out of scope for this task

- Browser features (Stage 4)
- Replay (Stage 5)

## Technical notes

- Rule 7: Agents do NOT own PTYs. They send JSON-RPC commands to Rust core.
- Pool recycling: `xterm.reset()` + write last snapshot buffer on session switch.

## Done criteria

- [ ] External process can connect via Unix socket and run terminal commands
- [ ] Max 8 xterm.js instances mounted at once; off-viewport terminals unmounted
- [ ] `npm run validate:no-errors` passes

## Progress / Notes

<!-- 2026-02-28: Created after id-4 completion (PTY pool + coalescing + visible terminal). -->
