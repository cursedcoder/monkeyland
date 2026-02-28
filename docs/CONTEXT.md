# Context for Monkeyland (Agent Canvas)

**Purpose:** Single entry point for agents. Scope = `monkeyland.md` §7. Work = one task from `docs/tasks/in-progress/`. Loop: execute → done → create next from spec → commit.

---

## 1. Scope and current work

| What | Where |
|------|--------|
| Full scope & stages | `monkeyland.md` §7 (Stages 1–6, deliverables) |
| Current task | `docs/tasks/in-progress/*.md` (one file) |
| Task format & derivation | `docs/tasks/README.md` |
| Done / backlog | `docs/tasks/done/`, `docs/tasks/backlog/` |

Implement only what the current task specifies. Do not add scope from other stages.

---

## 2. Agent loop

1. **Resolve:** If `in-progress/` has a task → that’s the current task. If empty → derive next from `monkeyland.md` §7 (see `docs/tasks/README.md`), create task from `_template.md`, put in `in-progress/`.
2. **Execute:** Implement Goal/Requirements/Done; respect Out of scope. Update checkboxes and Progress/Notes in the task file.
3. **On done:** Set Status to Done, move task to `done/`. Create next task (from §7 or backlog), put in `in-progress/`. Run `npm run validate:no-errors`. Then **commit**: `git add` + `git commit` with message `id-N: Short title` (or `WIP: id-N: …` if incomplete).

Commit is required before ending a run. One task per run is default; next run picks up the new task.

---

## 3. Deriving the next task

See **docs/tasks/README.md** (“Deriving the next task”). Short version: read §7 and `done/` Source lines; pick next uncovered stage/deliverable; create one task with Source set; use next free id. Refinement tasks don’t mark the base stage done.

---

## 4. Validation

Run `npm run validate:no-errors` after frontend changes. It builds, serves with mocked Tauri IPC, runs in headless Chromium via Playwright, and fails if there are console/page errors.

---

## 5. Critical rules (from monkeyland.md)

When implementing: DOM canvas only (no WebGL/PixiJS); PTYs in Rust (portable-pty); one Chromium + context pool; per-session SQLite; agents are lightweight (JSON-RPC to core). Use the Key rules in the relevant Stage when creating/executing a task.
