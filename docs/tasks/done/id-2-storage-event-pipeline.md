# id-2: Storage and event pipeline (Stage 2)

**Status:** Done  
**Source:** monkeyland.md §7 Stage 2  
**Created:** 2025-02-27

## Goal

Per-session SQLite storage with event schema, write batching, and snapshot infrastructure. Rule 3: per-session files only. Rule 6: snapshots from day 1. Write batcher flushes every 100 ms as a single transaction.

## Requirements

- [x] Per-session SQLite files at `~/.config/monkeyland/sessions/{session-id}.db` (path convention; SessionDb already exists).
- [x] Meta DB at `~/.config/monkeyland/meta.db` with session index (sessions table exists; create_session_if_missing, list_sessions).
- [x] Event schema: `events` table with id (ULID), seq, ts_us (integer microseconds), type, payload (JSON) — already in storage.rs; confirm and use.
- [x] Write batcher: accumulate events in memory, flush every 100 ms as single transaction.
- [x] Snapshot table in session DB, indexed by `seq_at` — already present; snapshot manager writes to it.
- [x] Snapshot manager: capture every 30 s or 500 events (whichever first).
- [x] Coalescing event bus skeleton in Rust (ready to be wired to PTY in Stage 3).
- [x] Log compaction: delete events before oldest retained snapshot on session close.

## Out of scope for this task

- PTY or terminal events (Stage 3).
- Browser or Playwright (Stage 4).
- Replay UI or playback (Stage 5).
- Frontend changes beyond any minimal wiring to show storage is alive.

## Technical notes

- Key rules: per-session SQLite only; snapshots in this stage; write batcher 100 ms; coalescing bus is a skeleton (e.g. struct + 16 ms tick, no PTY yet).
- storage.rs: SessionDb, MetaDb, EventRow, SnapshotRow already exist. Add write batcher (per-session queue + tokio interval 100 ms), snapshot manager (30 s or 500 events), coalescing bus module (skeleton).
- Session "create" / "close": create session = create row in meta sessions + open SessionDb path; close = call compact(), drop SessionDb (or keep handle in a pool). MVP: at least one session can receive events, batcher flushes, snapshot manager runs, compact on close.

## Done criteria

- [x] Session DB path is `~/.config/monkeyland/sessions/{session-id}.db`; meta DB references it.
- [x] Write batcher flushes accumulated events every 100 ms in one transaction per session.
- [x] Snapshot manager runs every 30 s or every 500 events (whichever first) per session.
- [x] Coalescing bus skeleton exists (e.g. `CoalescingBus` type, 16 ms tick, no PTY yet).
- [x] Compaction runs on session close (events before oldest retained snapshot deleted).

## Progress / Notes

<!-- 2025-02-27: Task created; starting implementation. -->
<!-- 2025-02-27: Implemented: MetaDb create_session_if_missing, list_sessions; WriteBatcher with 100ms flush, snapshot manager (30s/500 events), close_session compact; coalescing.rs skeleton with 16ms tick. -->
