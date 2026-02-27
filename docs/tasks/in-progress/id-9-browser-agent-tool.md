# id-9: Browser as LLM agent tool with visible node

**Status:** In progress  
**Source:** monkeyland.md §7 Stage 4 (refinement — agent tool-use)  
**Created:** 2026-02-28

## Goal

Make browser a **tool** the LLM agent can invoke via tool-use. When the agent decides to browse a URL, click, type, or read a page, it calls the `browser_action` tool. This spawns a **browser node** on the canvas (visible, connected to the agent), executes the action in a real Chromium browser via Playwright, streams live CDP screencast frames to the card, and returns results to the agent. The user sees browser activity live.

## Requirements

- [ ] Playwright sidecar (`scripts/browser-server.mjs`) — HTTP server managing one Chromium instance with session-scoped browser contexts
- [ ] Rust `BrowserPool` module — spawns sidecar, reads port, manages lifecycle
- [ ] Tauri command `browser_ensure_started` — lazily starts sidecar, returns port
- [ ] `BrowserToolPlugin` extending multi-llm-ts `Plugin` with tool `browser_action(action, url?, selector?, text?, javascript?)`
- [ ] Actions: navigate, click, type, screenshot, get_content, evaluate
- [ ] When tool is first invoked: spawn a browser canvas node connected to the agent node
- [ ] Browser node renders live CDP screencast frames (JPEG via SSE from sidecar)
- [ ] Action results captured and returned to the LLM as tool result
- [ ] New `"browser"` node type on canvas with its own `BrowserCard` component
- [ ] Connection lines from agent → browser node

## Out of scope for this task

- User input forwarding (click/type in the card → browser) — follow-up
- Browser context pool scaling to 20 (optimization for later)
- JSON-RPC Unix socket browser methods for external agents
- Per-session SQLite browser events storage

## Technical notes

- Sidecar: Node.js HTTP server using Playwright. Launched by Rust, communicates over HTTP. Port printed to stdout on startup.
- CDP screencast: `Page.startScreencast` streams JPEG frames. Sidecar forwards via SSE. BrowserCard displays as `<img>`.
- CSP updated to allow `http://localhost:*` and `img-src data:` for screencast frames.
- Plugin calls sidecar HTTP endpoints directly from frontend via `fetch()`.

## Done criteria

- [ ] LLM agent can call `browser_action` tool during generation
- [ ] Browser node appears on canvas when tool is invoked
- [ ] User sees live browser screencast in the browser node
- [ ] Action results flow back to the LLM and it continues reasoning
- [ ] `npm run validate:no-errors` passes

## Progress / Notes

<!-- 2026-02-28: Created. Implementing Playwright sidecar + BrowserToolPlugin + BrowserCard. -->
