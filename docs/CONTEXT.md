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
   - **Git:** Commit all changes (implementation, task file move to `done/`, new task file in `in-progress/`). Message format: `id-N: Short task title` (e.g. `id-1: Canvas prompt element`). This gives each sequential run a clear checkpoint; the next run starts from a clean state.
   - **Sequential runs:** One task per run is the default. After creating the next task in `in-progress/`, you can stop; the next run will pick it up. Optionally continue in the same run if you want to do more in one go.

---

## 3. Deriving the next task from monkeyland.md

- **Reference:** `monkeyland.md` **Section 7 — Development Stages** (Stages 1–6, each with Goal, Key rules, Deliverables, Validate).
- **How:** Look at `docs/tasks/done/` (and current in-progress). Each task should have a **Source** line (e.g. `Source: monkeyland.md §7 Stage 1`, or `Stage 2, deliverables 1–3`). Find the **next** Stage (or next group of deliverables within a stage) that is not yet covered by a done or in-progress task.
- **Create one task** for that Stage or that group of deliverables. Use `docs/tasks/_template.md`. Set **Source** to the exact stage (and optionally deliverable numbers). Fill Goal, Requirements, Out of scope, and Done criteria from the spec. Save as `docs/tasks/in-progress/id-<N>-<slug>.md` (or backlog then move to in-progress). Use the next free id (max id in in-progress, done, backlog + 1).
- **Refinements:** A task with `Source: … Stage N (refinement)` does **not** mark the base Stage N deliverables as done. When deriving the next task, consider §7 base deliverables and refinements separately; base deliverables are "covered" only by tasks that cite the stage (or specific deliverables) without "(refinement)".

---

## 4. Where things live

| What | Where |
|------|--------|
| **Scope and stages** | `monkeyland.md` (Section 7 = deliverables) |
| **Current task** | `docs/tasks/in-progress/*.md` |
| **Task system and derivation** | `docs/tasks/README.md` |
| **This context** | `docs/CONTEXT.md` |
| **Done tasks** | `docs/tasks/done/` |
| **Future / refinements** | `docs/tasks/backlog/` |

---

## 5. Critical rules (summary)

When implementing, comply with the rules in `monkeyland.md` (e.g. DOM canvas only; PTYs in Rust; one Chromium; per-session SQLite). Use the **Key rules** in the relevant Stage when creating or executing a task.

---

## 6. Keeping context in markdown

- **Task files** carry context: Status, checkboxes, Progress/Notes, and **Source** (link to monkeyland.md).
- **Done folder** is the record of what’s done; **Source** lines allow the next agent to derive the next task from `monkeyland.md` without human input.

Agents can run in a loop: complete task → move to done → derive and create next task from spec → work on it (or leave for next run).

---

## 7. Git (agent runs)

- **When to commit:** After completing a task: commit all changes (code, task file moved to `done/`, new task file in `in-progress/`) in one commit. If you made progress but did not complete the task, you may commit with message `WIP: id-N: Short title` so the next run has a checkpoint.
- **Message format:** `id-N: Short task title` (e.g. `id-1: Canvas prompt element`). Keeps history aligned with tasks and makes it easy to see what each run did.
- **Why:** Each sequential run starts from a clean, committed state. No uncommitted task-file moves or code from the previous run; the next agent sees a consistent repo and `in-progress/` with exactly one task.
