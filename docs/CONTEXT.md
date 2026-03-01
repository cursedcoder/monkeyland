# Monkeyland Context and Runbook

## System Overview

Monkeyland is a Tauri desktop app that runs a multi-agent workflow on a canvas UI.

- Frontend: React + TypeScript
- Backend: Rust (Tauri commands, orchestration loop, agent registry)
- Agents: workforce manager, project manager, developer, worker, validator, merge agent
- Tools: terminal, browser, Beads, file operations, review/complete flow

## Main Runtime Flows

### 1. Task intake and agent spawn

1. Orchestration polls Beads for ready tasks.
2. It spawns role-specific agents and PTY sessions.
3. Frontend receives `agent_spawned` and renders cards.

### 2. Developer review cycle

1. Developer yields for review.
2. Registry transitions to in-review and frontend receives `validation_requested`.
3. Validator agent runs checks and submits structured results.
4. Failed checks retry developer until retry budget is exhausted.
5. Timeout safety net force-blocks stuck in-review developers.

### 3. Merge train

1. Done developer work is enqueued for merge.
2. Merge queue serializes git operations with a lock.
3. Rebase/merge conflicts spawn merge agents with conflict context.
4. Queue retries are bounded; permanently failing tasks are blocked.

## Safety Guarantees

- Unknown agent IDs are rejected by tool/path gates.
- Validator failures and malformed validator output fail closed.
- Merge retries are bounded and cannot silently pass conflict states.
- Validator-launched dev servers are explicitly terminated after visual checks.

## Operations Runbook

### Start application

```bash
npm install
npm run tauri dev
```

### Core health checks

```bash
npm run lint
npm run test
npm run build
npm run validate:no-errors
cargo test --manifest-path src-tauri/Cargo.toml
```

### If UI appears stale or cards look inconsistent

1. Restart the app.
2. Use "Clear canvas" in UI if layout state is corrupted.
3. Re-run health checks above.

### If merges back up

1. Inspect merge status cards/events.
2. Check for repeated conflict retries on the same task.
3. Resolve via merge agent path or mark task blocked for manual intervention.

### If validator/browser sessions leak

1. Stop active runs from UI.
2. Restart app to reset browser/PTY pool state.
3. Confirm no lingering local dev server process from validator runs.

## Important Files

- Frontend entry/orchestration glue: `src/App.tsx`
- Canvas rendering and culling: `src/components/Canvas.tsx`
- Browser UI card: `src/components/BrowserCard.tsx`
- Terminal log UI card: `src/components/TerminalLogCard.tsx`
- Terminal tool plugin: `src/plugins/TerminalToolPlugin.ts`
- Rust orchestration loop: `src-tauri/src/orchestration.rs`
- Rust registry/state controls: `src-tauri/src/agent_registry.rs`
