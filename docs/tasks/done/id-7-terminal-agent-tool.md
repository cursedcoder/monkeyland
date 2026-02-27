# id-7: Terminal as LLM agent tool with visible node

**Status:** Done  
**Source:** monkeyland.md §7 Stage 3 (refinement — agent tool-use)  
**Created:** 2026-02-28

## Goal

Make terminal a **tool** the LLM agent can invoke via tool-use. When the agent decides to run a command, it calls the `run_terminal_command` tool. This spawns a **terminal node** on the canvas (visible, connected to the agent), executes the command in a real PTY, and returns output to the agent. The user sees terminal activity live.

## Requirements

- [x] `TerminalToolPlugin` extending multi-llm-ts `Plugin` with tool `run_terminal_command(command: string)`
- [x] When tool is invoked: spawn a terminal canvas node connected to the agent node
- [x] Terminal node renders live xterm.js (reuses PTY pool + coalescing from id-4)
- [x] Command output captured and returned to the LLM as tool result
- [x] Agent node shows thinking/response text (not an auto-embedded terminal)
- [x] New `"terminal"` node type on canvas with its own `TerminalCard` component
- [x] Connection lines from agent → terminal node

## Out of scope for this task

- JSON-RPC Unix socket server for external agents (separate task)
- xterm.js instance pooling / max 8 (optimization for later)
- Browser tool (Stage 4)

## Technical notes

- multi-llm-ts Plugin API: extend `Plugin`, implement `getName()`, `getDescription()`, `getParameters()`, `execute()`.
- Pass `{ tools: true }` to `model.generate()`.
- Tool chunks arrive as `{ type: 'tool', state, call }` in the stream.
- The `execute()` method spawns PTY via Tauri command, writes command via `terminal_exec`, waits for output (silence detection), returns it.
- PTY pool (id-4) and coalescing bus handle the backend.
- `terminal_exec` in Rust: clears accumulator, writes command+newline, polls for 1.5s silence, returns output.

## Done criteria

- [x] LLM agent can call `run_terminal_command` tool during generation
- [x] Terminal node appears on canvas when tool is invoked
- [x] User sees live terminal output in the terminal node
- [x] Command output flows back to the LLM and it continues reasoning
- [x] `npm run validate:no-errors` passes

## Progress / Notes

<!-- 2026-02-28: Rewritten from original id-7 (JSON-RPC + xterm pool) to correct architecture: terminal as LLM tool. -->
<!-- 2026-02-28: Implemented TerminalToolPlugin, TerminalCard, terminal_exec Rust command with silence detection, rewired handleLaunch for tool-use. SessionCard reverted to show agent text. -->
