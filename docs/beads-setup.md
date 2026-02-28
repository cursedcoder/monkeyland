# Beads integration setup

This document describes how to install and run [Beads](https://github.com/steveyegge/beads) (bd) so that Monkeyland's agent orchestration can use it as the task graph backend.

## Install Beads CLI

Install the `bd` CLI system-wide (one of the following):

```bash
# npm (recommended for cross-platform)
npm install -g @beads/bd

# Or Homebrew (macOS/Linux)
brew install beads

# Or Go
go install github.com/steveyegge/beads/cmd/bd@latest
```

Verify:

```bash
bd version
```

## Initialize in the project

From the Monkeyland project root (or the repo where agents will run):

```bash
cd /path/to/monkeyland
bd init --quiet
```

This creates `.beads/` with the Dolt-backed database. Use `--quiet` for non-interactive (e.g. scripted) setup.

## Dolt server mode (multi-agent)

For 50–100 agents writing to the same task graph, run the Dolt server so all agents share one database:

```bash
bd dolt start
```

Run this in a separate terminal or as a background process; it keeps running. The app can also start it via the `beads_dolt_start` Tauri command (which spawns it in the background).

## Agent working directories and redirects

Each agent can use its own working directory (e.g. a git worktree) but share the same Beads database via a redirect file:

1. **Main repo** holds the real `.beads/` (after `bd init`).
2. **Agent worktrees** (e.g. `monkeyland-agents/agent-dev-1/`) each have:
   - `.beads/redirect` — a file containing the path to the main `.beads` (e.g. `../../monkeyland/.beads`).

Example layout:

```
monkeyland/                 # main repo
  .beads/                   # actual Dolt database

monkeyland-agents/
  agent-dev-1/
    .beads/
      redirect              # contents: ../../monkeyland/.beads
  agent-dev-2/
    .beads/
      redirect
```

When an agent’s PTY is spawned with `cwd` set to an agent worktree that has a redirect, `bd` commands run in that directory will use the shared database.

## Wiring bd into agent PTYs

- Agents run inside PTYs. The PTY is spawned with an optional **working directory** (`cwd`). Set `cwd` to the project root (where `.beads/` exists) or to an agent worktree that has `.beads/redirect`.
- The agent (or the orchestrator) runs `bd` via the PTY, e.g.:
  - `bd ready --json`
  - `bd update <id> --claim --json`
- No separate “beads RPC” is required: the CLI is used from the shell in the PTY.

## Optional: project script to install Beads

From the project root you can run:

```bash
npm run beads:install
```

This installs `@beads/bd` globally so `bd` is on PATH for all agent shells.

## Tauri commands (from the frontend)

The app exposes these commands for Beads setup and for the orchestrator:

- **`beads_init(projectPath)`** — Run `bd init --quiet` in the given directory. Call once per project.
- **`beads_run(projectPath, args)`** — Run `bd` with the given args (e.g. `["ready", "--json"]`) and return stdout. Used by the scheduler loop.
- **`beads_dolt_start(projectPath)`** — Start `bd dolt start` in the background for multi-agent Dolt server mode.
