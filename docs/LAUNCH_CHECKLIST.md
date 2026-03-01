# Monkeyland Beta Launch Checklist

Use this checklist as a go/no-go gate before demos or beta releases.

## 1) Build and Test Health

- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `npm run validate:no-errors`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings -A dead_code -A unused_imports -A unused_mut -A dropping_references`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`

## 2) Validation Pipeline Health

- [ ] Validator spawn failure path fails closed.
- [ ] Malformed validator output fails closed.
- [ ] In-review timeout path force-blocks (does not auto-pass).
- [ ] Validator visual cleanup confirms no leaked dev servers.

## 3) Merge Queue Health

- [ ] Merge queue depth stays bounded under burst completions.
- [ ] No duplicate merges for the same task id.
- [ ] Retry counts increase only on conflict/error paths.
- [ ] Permanently failing merges end in blocked status.

## 4) Orchestration Controls

- [ ] Orchestration start/pause/resume work from control panel.
- [ ] Safety mode toggle works and throttles throughput.
- [ ] Stop-all path reliably halts running agents.

## 5) Recovery Drills

- [ ] Full reset clears active agents and Beads path.
- [ ] Canvas reload restores persisted layout safely.
- [ ] Debug snapshot copy includes orchestration metrics.

## 6) Release Decision

- [ ] Any known high-risk issues are documented with mitigation.
- [ ] On-call operator has runbook links (`docs/CONTEXT.md` + this checklist).
- [ ] Go / no-go decision recorded with timestamp and owner.
