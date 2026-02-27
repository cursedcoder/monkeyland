# Context for Monkeyland (Agent Canvas)

**Purpose:** Entry point for **LLM agents** working on this repo. Scope is defined in `monkeyland.md`; agents run in a **loop**: execute task → create next task from the spec → continue.

---

## 1. Where scope is defined

- **Full scope:** `monkeyland.md` — architecture, critical rules, and **Section 7 (Development Stages)** with deliverables for Stages 1–6.
- **Current work:** One task file in `docs/tasks/in-progress/*.md`. That task is the single source of truth for **this** run.

Agents must not implement outside the current task. When a task is done, the **next** task is derived from `monkeyland.md` §7 (or from `docs/tasks/backlog/` if a task was already created there).

---

## 2. Agent loop

1. **Resolve current task**
  - If `docs/tasks/in-progress/` has a task: that is the current task. Read it and implement it.
  - If `docs/tasks/in-progress/` is **empty**: derive the next task from `monkeyland.md` §7 (see §3 below), create a new task file, put it in `in-progress/`, then implement it.
2. **Execute**
  - Implement only what the current task’s Goal, Requirements, and Done criteria specify. Respect Out of scope.
  - While working: check off requirements/done criteria and add a short Progress/Notes line with date.
3. **On completion**
  - Set Status to `Done`, move the task file to `docs/tasks/done/`.
  - **Create next task:** Derive from `monkeyland.md` §7 (next unchecked deliverable or stage), or take from `backlog/` if a suitable task exists. Create the new task file with a **Source** line pointing to the spec (e.g. `Source: monkeyland.md §7 Stage 2`). Put it in `in-progress/` (or in `backlog/` and move to `in-progress/`).
  - **Sequential runs:** One task per run is the default. The **next** task is started by the operator after they have tested; do not assume the next run will begin immediately.
4. **Before you finish — commit (required)**
  - You must run `git add` and `git commit` before ending your run. A completed task without a commit is incomplete.
  - Commit all changes: implementation, task file moved to `done/`, new task file in `in-progress/` (if created). Message format: `id-N: Short task title` (e.g. `id-1: Canvas prompt element`).
  - If you did not complete the task but made progress, you may commit with `WIP: id-N: Short title` so the next run has a checkpoint.

---

## 3. Deriving the next task from monkeyland.md

- **Reference:** `monkeyland.md` **Section 7 — Development Stages** (Stages 1–6, each with Goal, Key rules, Deliverables, Validate).
- **How:** Look at `docs/tasks/done/` (and current in-progress). Each task should have a **Source** line (e.g. `Source: monkeyland.md §7 Stage 1`, or `Stage 2, deliverables 1–3`). Find the **next** Stage (or next group of deliverables within a stage) that is not yet covered by a done or in-progress task.
- **Create one task** for that Stage or that group of deliverables. Use `docs/tasks/_template.md`. Set **Source** to the exact stage (and optionally deliverable numbers). Fill Goal, Requirements, Out of scope, and Done criteria from the spec. Save as `docs/tasks/in-progress/id-<N>-<slug>.md` (or backlog then move to in-progress). Use the next free id (max id in in-progress, done, backlog + 1).
- **Refinements:** A task with `Source: … Stage N (refinement)` does **not** mark the base Stage N deliverables as done. When deriving the next task, consider §7 base deliverables and refinements separately; base deliverables are "covered" only by tasks that cite the stage (or specific deliverables) without "(refinement)".

---

## 4. Where things live


| What                           | Where                                      |
| ------------------------------ | ------------------------------------------ |
| **Scope and stages**           | `monkeyland.md` (Section 7 = deliverables) |
| **Current task**               | `docs/tasks/in-progress/*.md`              |
| **Task system and derivation** | `docs/tasks/README.md`                     |
| **This context**               | `docs/CONTEXT.md`                          |
| **Done tasks**                 | `docs/tasks/done/`                         |
| **Future / refinements**       | `docs/tasks/backlog/`                      |


---

## 5. Validating no frontend errors

**Agents must be able to validate there are no console/runtime errors** without connecting to a live app’s devtools. Run:

```bash
npm run validate:no-errors
```

This script builds the frontend, serves it with Tauri IPC mocked (`window.__TAURI_VALIDATE__`), loads the app in headless Chromium via Playwright, and collects **console errors**, **console warnings**, and **uncaught page errors**. If any are found, it exits with code 1 and prints them. Run it after frontend changes (or as part of the completion checklist) to confirm no regressions.

---

## 6. Critical rules (summary)

When implementing, comply with the rules in `monkeyland.md` (e.g. DOM canvas only; PTYs in Rust; one Chromium; per-session SQLite). Use the **Key rules** in the relevant Stage when creating or executing a task.

---

## 7. Keeping context in markdown

- **Task files** carry context: Status, checkboxes, Progress/Notes, and **Source** (link to monkeyland.md).
- **Done folder** is the record of what’s done; **Source** lines allow the next agent to derive the next task from `monkeyland.md` without human input.

Agents can run in a loop: complete task → move to done → derive and create next task from spec → work on it (or leave for next run).

---

## 8. Git (agent runs)

- **Required:** After finishing work on a task, you **must** run `git add` (for all changed files) and `git commit`. Do not end your run with uncommitted changes. If you skip the commit, the run is incomplete.
- **When to commit:** After completing a task: commit all changes (code, task file moved to `done/`, new task file in `in-progress/`) in one commit. If you made progress but did not complete the task, you may commit with message `WIP: id-N: Short title` so the next run has a checkpoint.
- **Message format:** `id-N: Short task title` (e.g. `id-1: Canvas prompt element`). Keeps history aligned with tasks and makes it easy to see what each run did.
- **Why:** The operator tests after each run. The next task is started only after they invoke the next run. Each run must leave the repo in a clean, committed state so the next agent (or human) sees a consistent repo and correct `in-progress/` state.

