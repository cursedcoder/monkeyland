# id-6: Prompt card creates connected node on launch (with answer)

**Status:** Done  
**Source:** monkeyland.md §7 Stage 1 (refinement — prompt → agent node)  
**Created:** 2025-02-27

## Goal

Bare minimum: when the user launches a prompt card (with the prompt text as the “answer” for now), create a **connected** agent node on the canvas — positioned relative to the prompt and linked so the connection is stored and visible.

## Requirements

- [x] On Launch from a prompt card: create a new **agent** node on the canvas.
- [x] New agent node is **connected** to the prompt: placed next to/below the prompt card and stores the source prompt id (e.g. in payload) so the link is persisted.
- [x] No LLM call required for this task; “answer” is the prompt text (or placeholder). Real LLM integration remains separate.

## Out of scope for this task

- Calling an LLM from Launch (see id-2 / LLM integration).
- Drawing visual edges/lines between prompt and agent (optional later).
- PTY pool, terminal, or browser (Stage 3/4).

## Technical notes

- Use existing `node_type: "agent"` and `SessionCard`; add a new layout with position derived from the prompt layout (e.g. `y = prompt.y + prompt.h + GRID_STEP`).
- Store connection in agent node payload: e.g. `{ sourcePromptId: string }` so the node is “connected” and can be used for replay/UI later.
- Reuse `generateNodeId()`, `SESSION_CARD_DEFAULT_*`, and layout persistence.

## Done criteria

- [x] Clicking Launch on a prompt card creates one agent node.
- [x] New agent node is positioned relative to the prompt (e.g. below it) and persists on reload.
- [x] Connection is stored (e.g. `sourcePromptId` in agent payload) so the node is clearly linked to the prompt.

## Progress / Notes

<!-- 2025-02-27: Implemented handleLaunch: create agent node below prompt with payload.sourcePromptId; layout persisted. -->
