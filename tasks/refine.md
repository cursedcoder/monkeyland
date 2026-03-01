# Monkeyland Refinement Tasks

## P0 (Immediate)

- [x] **Fix validator dev-server cleanup bypass**
  - Problem: validator cleanup sends `kill/pkill` through `terminal_exec`, but kill-like commands are globally short-circuited.
  - Files: `src-tauri/src/commands.rs`, `src/App.tsx`
  - Target:
    - Add a safe internal cleanup path (e.g. dedicated backend command or allowlisted cleanup session mode).
    - Keep LLM-facing kill protections intact.
  - Done when:
    - validator cleanup actually terminates spawned process tree.
    - no regression in kill-command safety for normal agent tool calls.


## P1 (Stability + Performance)

- [x] **Stress test merge train under burst completions**
  - Files: `src-tauri/src/orchestration.rs`
  - Target:
    - Validate queue dedupe and `MAX_MERGES_PER_TICK` behavior under high task completion rates.
    - Confirm no starvation/retry-loop edge cases.
  - Done when:
    - merge backlog drains predictably and no duplicate task merges occur.

- [x] **Tune streamed payload batching thresholds**
  - Files: `src/App.tsx`
  - Target:
    - Validate `STREAM_PAYLOAD_FLUSH_MS` tradeoff for responsiveness vs CPU churn.
    - Measure with 10-20 active agents.
  - Done when:
    - reduced rerender pressure without delayed status UX.

- [x] **Add bounded history UX controls for terminal logs**
  - Files: `src/components/TerminalLogCard.tsx`, `src/plugins/TerminalToolPlugin.ts`
  - Target:
    - Add explicit “clear logs” / “export logs” affordances.
    - Ensure full-history expansion remains responsive for long sessions.
  - Done when:
    - long sessions remain smooth and user can manage history intentionally.


## P2 (Quality + Ops Hardening)

- [x] **Extend CI to include Rust lint/format checks**
  - Files: `.github/workflows/ci.yml`, `src-tauri/Cargo.toml` (if toolchain config needed)
  - Target:
    - Add `cargo fmt --check` and `cargo clippy -- -D warnings` (or an agreed warning baseline).
  - Done when:
    - Rust style/lint regressions fail CI.

- [x] **Add targeted tests for validator cleanup and safety gates**
  - Files: new tests in frontend and/or Tauri command layer
  - Target:
    - Cover: validator spawn failure path, malformed validator output path, unknown-agent gate failure, cleanup execution.
  - Done when:
    - these critical safety paths are regression-tested.

- [x] **Create launch checklist doc for beta readiness**
  - Files: `docs/CONTEXT.md` or `docs/LAUNCH_CHECKLIST.md`
  - Target:
    - One-page go/no-go checklist: validation health, merge queue health, orchestration paused/resume, recovery steps.
  - Done when:
    - operators can consistently verify release readiness pre-ship.


## Nice-to-Have

- [x] **Instrument key orchestration metrics**
  - Files: `src-tauri/src/orchestration.rs`, related UI debug surfaces
  - Target:
    - Track queue depth, merge retries, validation timeouts, blocked transitions.
  - Done when:
    - bottlenecks are visible without deep log digging.

- [x] **Add “safety mode” runtime toggle**
  - Files: settings + orchestration paths
  - Target:
    - Conservative mode for demos/prod-like runs (stricter limits, reduced concurrency, explicit approvals).
  - Done when:
    - high-risk automation can be throttled instantly without code changes.
