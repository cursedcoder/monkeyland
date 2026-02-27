# id-3: Canvas UX fixes (testing feedback)

**Status:** Done  
**Source:** Testing feedback after id-1/id-2; monkeyland.md §7 Stage 1 (refinement)  
**Created:** 2025-02-27

## Goal

Address testing feedback: (1) Canvas must not show 20 blank agents or many empty prompt cards on load. (2) Dragging a card must move the card, not the canvas; no text selection while dragging.

## Requirements

- [x] On load: treat legacy "20 agent" layout as empty — if saved layout has 20 entries all with node_type `agent`, load empty and persist empty so next run is clean.
- [x] On load: cap empty prompt cards — if saved layout has many prompt cards with empty `promptText`, keep at most one empty prompt plus all prompts with content; persist the trimmed layout.
- [x] Card drag must not move the canvas: pointer down on a card (or its drag handle) must not start canvas pan (use stopPropagation so only the card moves).
- [x] Dragging a card must not select text: prevent text selection during drag (e.g. user-select: none while dragging, or restrict drag to header handle only).

## Out of scope

- Stage 2+ (storage, PTY, browser).
- New node types or new canvas features beyond this UX fix.

## Technical notes

- App.tsx: after loading layout, if layouts.length === 20 and every l.node_type === 'agent', set layouts to [] and call save to overwrite legacy. When loading prompts, filter to keep prompts with non-empty promptText plus at most 1 empty; then persist if trimmed.
- Canvas pan: ensure pointer down on .prompt-card / .session-card does not start pan (card handlers must stopPropagation).
- PromptCard/SessionCard: stopPropagation on pointer down for drag; consider drag handle only on header; add user-select: none while isDragging (or on card).

## Done criteria

- [x] `npm run tauri dev` shows empty canvas when stored layout was legacy 20 agents (or after migration).
- [x] Stored layout with many empty prompts loads with at most one empty prompt plus prompts with content; no 15 empty windows.
- [x] Dragging a card moves the card only; canvas does not pan.
- [x] No text selection when dragging a card.

## Progress / Notes

<!-- 2025-02-27: Task created from operator testing feedback. -->
<!-- 2025-02-27: Implemented: load migration (20 agents → empty + save); cap empty prompts (keep content + 1 empty); stopPropagation on card drag; drag from header only; userSelect:none when dragging. -->
