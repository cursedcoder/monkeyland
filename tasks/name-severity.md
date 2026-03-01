# Monkeyland Product Readiness Tasks (By Severity)

## Critical

- [ ] **Fail closed on validator spawn failure**  
  Replace auto-pass fallback when validator cannot spawn with `blocked` or `manual_review_required`.
  - Files: `src/App.tsx`, `src-tauri/src/agent_registry.rs`
  - Done when: no validator failure path can transition a developer to pass/done automatically.

- [ ] **Fail closed on invalid validator output**  
  Remove "parse failure => pass" behavior; require explicit valid checks or mark as failed/retry/manual review.
  - Files: `src/App.tsx`
  - Done when: malformed validator JSON never maps to pass.

- [ ] **Remove force-complete pass from InReview timeout**  
  Replace `InReview -> ValidationPass` timeout fallback with safe terminal state (`blocked`/`stopped`) plus user-visible reason.
  - Files: `src-tauri/src/agent_registry.rs`, `src-tauri/src/orchestration.rs`
  - Done when: watchdog timeout cannot mark incomplete validation as done.


## High

- [ ] **Fix agentRunner error/done race**  
  Ensure stream errors do not also call `onDone`; enforce single terminal callback path.
  - Files: `src/agentRunner.ts`
  - Done when: one run cannot emit both error and done outcomes.

- [ ] **Harden tool/path gating to fail closed for unknown agents**  
  Reject unknown `agent_id` in `gate_tool`, `validate_path`, and terminal cwd validation.
  - Files: `src-tauri/src/agent_registry.rs`
  - Done when: unknown agent IDs always return explicit errors.

- [ ] **Delete render/effect debug ingestion calls in BeadsCard**  
  Remove localhost debug `fetch(...)` side effects from UI runtime and render path.
  - Files: `src/components/BeadsCard.tsx`
  - Done when: no runtime network side effects remain in render or refresh effects.

- [ ] **Remove destructive layout-load heuristic**  
  Replace the `19-21 all-agent cards => wipe layout` logic with explicit migration/version handling.
  - Files: `src/App.tsx`
  - Done when: valid canvases are never auto-cleared by count/type heuristics.


## Medium

- [ ] **Persist Beads task list in canonical app state**  
  Move refreshed tasks out of local card-only state so viewport culling/unmount does not lose task data.
  - Files: `src/components/BeadsCard.tsx`, `src/components/Canvas.tsx`, `src/App.tsx`
  - Done when: panning/culling/remount preserves latest task data.

- [ ] **Reduce layout update churn under streaming**  
  Avoid full `layouts.map + JSON.parse/stringify` on each chunk; normalize payload state and throttle writes.
  - Files: `src/App.tsx`, `src/components/Canvas.tsx`
  - Done when: many concurrent agents stream without visible UI jank.

- [ ] **Improve merge train throughput strategy**  
  Keep correctness lock, but optimize queue processing cadence and conflict handling latency.
  - Files: `src-tauri/src/orchestration.rs`
  - Done when: merge backlog drains predictably under multi-agent load.

- [ ] **Bound terminal log memory growth**  
  Add entry/output caps (ring buffer semantics) and render virtualization for long sessions.
  - Files: `src/plugins/TerminalToolPlugin.ts`, `src/components/TerminalLogCard.tsx`
  - Done when: long runs do not grow memory/UI unboundedly.

- [ ] **Stabilize BrowserCard event listener lifecycle**  
  Avoid rebinding native listeners on high-frequency frame updates.
  - Files: `src/components/BrowserCard.tsx`
  - Done when: listeners mount once per card lifecycle with stable handlers.

- [ ] **Manage validator dev server lifecycle explicitly**  
  Track and clean up server processes launched during visual validation.
  - Files: `src/App.tsx`
  - Done when: repeated validations do not leave orphan server processes.


## Operational Readiness

- [ ] **Add CI required checks**  
  Minimum: frontend build, Rust tests, validation script, and lint checks.
  - Files: `.github/workflows/*`, `package.json`
  - Done when: merges/releases are gated by automated checks.

- [ ] **Add frontend test suite baseline**  
  Introduce component and orchestration-flow tests for high-risk state transitions.
  - Files: `src/**` (new test files)
  - Done when: key flows have deterministic regression coverage.

- [ ] **Improve docs and launch runbooks**  
  Update stale `README.md` stage status and populate `docs/CONTEXT.md` with architecture + operations.
  - Files: `README.md`, `docs/CONTEXT.md`
  - Done when: new contributors/operators can run, debug, and recover from failures.
