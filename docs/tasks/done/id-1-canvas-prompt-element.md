# id-1: Canvas prompt element (Cursor-like)

**Status:** Done  
**Source:** monkeyland.md §7 Stage 1 (refinement — prompt element)
**Created:** 2025-02-27

## Goal

Replace the fixed 20 "Agent" cards with a canvas where the user can **add** elements. MVP: add a **prompt** element similar to Cursor's prompt/compose input. When the user launches the prompt, it will later drive agent creation (follow-up task).

## Requirements

- [x] Canvas starts **empty** (no pre-placed agent cards).
- [x] User can **add a new prompt** via a header action (e.g. "Add prompt").
- [x] Prompt element is **Cursor-like**: multiline text input, clear primary action (e.g. "Launch").
- [x] Prompt nodes are **draggable and resizable** like other canvas nodes.
- [x] Layout (and node types) **persisted** so prompt positions survive reload.
- [x] "Launch" on prompt does not need to call LLM yet; can be a no-op or toast (Anthropic integration is a separate task).

## Out of scope for this task

- Actually calling Anthropic API from Launch (see id-2).
- Populating "agent" nodes from a launched prompt (later task).
- Multiple node types beyond prompt (agent cards can come in a follow-up).

## Technical notes

- Introduce **canvas node** model: `id`, `type` ('prompt' | 'agent'), `x`, `y`, `w`, `h`, `collapsed`, and type-specific data (e.g. `promptText` for prompt).
- Backend: extend layout payload to include `node_type` (and optional payload) so we persist prompt vs agent and prompt text.
- One component: `PromptCard` for type `prompt`; reuse or simplify `SessionCard` for future `agent` type.

## Done criteria

- [x] Add prompt button adds a new prompt card on the canvas.
- [x] Prompt card has a Cursor-like text area and a Launch button.
- [x] Prompt cards can be dragged and resized; layout persists on reload.
- [x] No more default 20 agent cards.

## Progress / Notes

<!-- 2025-02-27: Implemented in prior run. Moved to done when deriving id-2. -->
