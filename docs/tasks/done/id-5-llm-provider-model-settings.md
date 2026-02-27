# id-5: LLM provider and model selection

**Status:** Done  
**Source:** User request; monkeyland.md §6 MVP (settings for future LLM integration)  
**Created:** 2025-02-27

## Goal

Allow the user to set the LLM provider (e.g. OpenAI, Anthropic) and pick a model from the UI. Settings are persisted so they can be used when Launch/LLM integration is implemented.

## Requirements

- [x] Backend: store LLM provider and model (e.g. in meta.db app_settings or key-value)
- [x] Tauri commands: load and save LLM settings
- [x] Frontend: UI to select provider and model (dropdowns or equivalent)
- [x] Settings persisted and restored on app load

## Out of scope for this task

- Actually calling any LLM API from Launch (see future task).
- API keys / auth (provider/model only).

## Technical notes

- Meta DB already has canvas_layout; add app_settings table or single-row config. Provider + model as columns or JSON.
- Frontend: header or small settings panel; model list can be per-provider (hardcoded list for now).

## Done criteria

- [x] User can choose provider (e.g. OpenAI, Anthropic) and a model in the UI
- [x] Selection is saved and restored on next load

## Progress / Notes

<!-- 2025-02-27: Task created; implementing. -->
<!-- 2025-02-27: Implemented: app_settings table, load/save_llm_settings commands, LlmSettings component in header; provider + model dropdowns, persist to meta.db. -->
