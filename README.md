# Monkeyland — Agent Canvas

Desktop application for coordinating many concurrent AI agents with terminal, browser, validation, and merge orchestration. Built with Tauri 2 (Rust backend) + React + TypeScript frontend.

## Current Status

- Multi-agent canvas with hierarchical cards (prompt, agent/worker/validator, browser, beads, terminal, terminal-log).
- Orchestration loop with task claiming, developer validation flow, merge train retries, and safety nets.
- Rust-backed tool gating and path sandbox checks for agent calls.
- Visual validator support with managed browser sessions and explicit dev-server cleanup.

## Prerequisites

- Node.js 18+
- Rust stable toolchain
- `bd` CLI installed and available in `PATH` for Beads integrations

Install Beads CLI (optional but recommended for orchestration flow):

```bash
npm run beads:install
```

## Local Development

```bash
npm install
npm run tauri dev
```

## Quality Checks

```bash
npm run lint
npm run test
npm run build
npm run validate:no-errors
cargo test --manifest-path src-tauri/Cargo.toml
```

## Build Release

```bash
npm run tauri build
```

## Configuration and Data

- App settings and databases are under the OS-specific app config directory.
- Key persisted data includes:
  - canvas layouts
  - orchestration metadata
  - per-session event/snapshot logs

## Operational Docs

- Architecture and runbooks: `docs/CONTEXT.md`
