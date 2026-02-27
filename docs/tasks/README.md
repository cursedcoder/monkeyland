# Task system (docs/tasks)

Tasks are markdown files that define **what to build** and **what is out of scope**. Scope comes from **monkeyland.md** Section 7 (Development Stages). **Agents** create the next task by deriving it from the spec and can run in a loop: execute → done → create next → continue.

---

## Folder structure

```
docs/tasks/
  README.md           ← you are here
  _template.md        ← copy for new tasks
  in-progress/        ← current work (one task; agent works on this)
  backlog/            ← future tasks (refinements or pre-created next)
  done/               ← completed tasks (used to derive “what’s next”)
```

- **in-progress:** The single task the agent is currently executing. If empty, the agent must derive the next task from monkeyland.md §7 and create it here.
- **backlog:** Optional pre-created or refinement tasks. Agent can move one to in-progress when it fits (e.g. after finishing a stage).
- **done:** Finished tasks. **Source** lines in done tasks are used to derive the next task from the spec.

---

## Task file format

Use `_template.md` as a base. Each task must have:

| Section | Purpose |
|--------|----------|
| **Title** | `# id-N: Short name` |
| **Status** | Backlog / In progress / Done |
| **Source** | **Required.** `Source: monkeyland.md §7 Stage N` or `Stage N, deliverables 1–3` or `Stage N (refinement)`. Used to derive “next task.” |
| **Created** | Date (YYYY-MM-DD) |
| **Goal** | One paragraph from or aligned with the spec |
| **Requirements** | Checklist (from spec deliverables or refinement) |
| **Out of scope** | What this task does *not* do |
| **Technical notes** | Optional: models, components, key rules for the stage |
| **Done criteria** | Checklist that must be satisfied to move to done |
| **Progress / Notes** | Dated notes; update as you complete items |

---

## Deriving the next task from monkeyland.md

1. **Read** `monkeyland.md` **Section 7 — Development Stages** (Stages 1–6). Each stage has Deliverables (numbered list).
2. **Inspect** `docs/tasks/done/` (and any task in `in-progress/`). Read each task’s **Source** line to see which stage (and optionally which deliverables) are already covered. **Refinement tasks** (`Source: … Stage N (refinement)`) do **not** mark the base Stage N as done — only tasks that cite the stage or specific deliverables without “(refinement)” do.
3. **Choose next:** The next task is the **next unchecked deliverable or group of deliverables** in stage order. For example: if Stage 1 deliverables 1–3 are done, create a task for Stage 1 deliverable 4 (or 4–5). If Stage 1 is fully done, create a task for Stage 2.
4. **Create the task file:** Copy `_template.md`, set **Source** (e.g. `Source: monkeyland.md §7 Stage 2` or `Stage 2, deliverables 1–4`), fill Goal/Requirements/Done criteria from the spec, add Key rules from that stage into Technical notes or Out of scope. Save to `docs/tasks/in-progress/id-<N>-<slug>.md` (use next id). If you already have a candidate in backlog, you can move that to in-progress instead.
5. **Naming:** File `id-<N>-<short-slug>.md`; title `# id-N: Human-readable name`. Keep ids consistent so backlog/done can reference “see id-N.”

---

## Agent loop (summary)

1. **If in-progress is empty:** Derive next task from monkeyland.md §7 (see above), create task file in `in-progress/`.
2. **Execute** the task in `in-progress/`: implement, update checkboxes and Progress/Notes.
3. **When done:** Move task to `done/`, set Status to Done. Then derive the **next** task from the spec, create it, and put it in `in-progress/` (or move from backlog). **Commit** all changes with message `id-N: Short title` (see docs/CONTEXT.md §7). For **sequential runs**, one task per run is enough — next run will see the new task and continue. Optionally continue in the same run to do more.
4. Repeat. No human needed to “pick” the next task — it comes from the spec and the contents of `done/`.

---

## Reference

- **Context and loop:** `docs/CONTEXT.md`
- **Architecture and stages:** `monkeyland.md` (Section 7 = deliverables)
