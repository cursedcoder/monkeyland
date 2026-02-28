//! Agent state machine: enforces legal lifecycle transitions and tool permissions per role.
//!
//! Every state change and every tool call must go through this module.
//! If a transition or tool call is not explicitly listed here, it is rejected.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// Agent lifecycle states. Transitions are enforced by `try_transition`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
pub enum State {
    /// Just registered, not yet executing.
    Spawned,
    /// Actively executing (processing LLM chunks, calling tools).
    Running,
    /// Developer submitted work for validation; waiting for review to start.
    Yielded,
    /// Validators are analyzing the developer's work.
    InReview,
    /// Task completed successfully (terminal state).
    Done,
    /// Failed validation 3 times (terminal state).
    Blocked,
    /// Killed by TTL, quota, or user abort (terminal state).
    Stopped,
}

impl State {
    pub fn is_terminal(self) -> bool {
        matches!(self, State::Done | State::Blocked | State::Stopped)
    }
}

impl std::fmt::Display for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            State::Spawned => write!(f, "spawned"),
            State::Running => write!(f, "running"),
            State::Yielded => write!(f, "yielded"),
            State::InReview => write!(f, "in_review"),
            State::Done => write!(f, "done"),
            State::Blocked => write!(f, "blocked"),
            State::Stopped => write!(f, "stopped"),
        }
    }
}

/// Events that trigger state transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// Agent starts executing (Spawned → Running).
    Start,
    /// Developer submits work for review (Running → Yielded).
    Yield,
    /// Orchestration loop starts validation (Yielded → InReview).
    StartReview,
    /// All 3 validators passed (InReview → Done).
    ValidationPass,
    /// At least one validator failed, retries remaining (InReview → Running).
    ValidationFail,
    /// 3rd validation failure (InReview → Blocked).
    ValidationBlock,
    /// Non-developer agent completes (Running → Done). Developers CANNOT use this.
    Complete,
    /// Killed by TTL, quota, or user abort (* → Stopped).
    Kill,
}

/// Attempt a state transition. Returns the new state or an error explaining why it's illegal.
pub fn try_transition(current: State, event: Event, role: &str) -> Result<State, String> {
    // Kill is always allowed from any non-terminal state.
    if event == Event::Kill {
        return if current.is_terminal() {
            Err(format!("Agent already in terminal state {current}"))
        } else {
            Ok(State::Stopped)
        };
    }

    match (current, event) {
        (State::Spawned, Event::Start) => Ok(State::Running),

        // Developer must yield; cannot self-complete.
        (State::Running, Event::Yield) if role == "developer" => Ok(State::Yielded),
        (State::Running, Event::Complete) if role == "developer" => {
            Err("Developers cannot self-complete. Use yield_for_review.".into())
        }

        // Non-developers can complete directly.
        (State::Running, Event::Complete) => Ok(State::Done),

        (State::Yielded, Event::StartReview) => Ok(State::InReview),
        (State::InReview, Event::ValidationPass) => Ok(State::Done),
        (State::InReview, Event::ValidationFail) => Ok(State::Running),
        (State::InReview, Event::ValidationBlock) => Ok(State::Blocked),

        _ => Err(format!(
            "Illegal transition: {current} + {event:?} for role {role}"
        )),
    }
}

/// Roles that MUST have a task_id to be spawned.
const TASK_REQUIRED_ROLES: &[&str] = &["developer", "worker", "project_manager"];

/// Validate whether a new agent is allowed to spawn.
/// Called by `AgentRegistry::spawn()` before creating the entry.
///
/// Enforces:
/// 1. Developers, workers, and PMs require a `task_id`.
/// 2. NOTE: We no longer require active managers for developers/workers when spawned
///    via the orchestration loop (with a task_id). If a task exists in Beads, a manager
///    already created it - the manager completing its planning phase shouldn't block work.
pub fn validate_spawn(
    role: &str,
    task_id: &Option<String>,
    _active_role_counts: &HashMap<String, usize>,
) -> Result<(), String> {
    if TASK_REQUIRED_ROLES.contains(&role) && task_id.is_none() {
        return Err(format!("Role {role} requires a task_id to spawn"));
    }

    Ok(())
}

/// Rust-side tool names that can be gated. These correspond to Tauri command names.
/// Frontend plugin names map onto these (e.g. "run_terminal_command" → "terminal_exec").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tool {
    TerminalExec,
    WriteFile,
    ReadFile,
    BrowserEnsureStarted,
    BeadsInit,
    BeadsRun,
    SetBeadsProjectPath,
    BeadsDoltStart,
}

impl Tool {
    pub fn from_command_name(name: &str) -> Option<Self> {
        match name {
            "terminal_exec" => Some(Tool::TerminalExec),
            "write_file" => Some(Tool::WriteFile),
            "read_file" => Some(Tool::ReadFile),
            "browser_ensure_started" => Some(Tool::BrowserEnsureStarted),
            "beads_init" => Some(Tool::BeadsInit),
            "beads_run" => Some(Tool::BeadsRun),
            "set_beads_project_path" => Some(Tool::SetBeadsProjectPath),
            "beads_dolt_start" => Some(Tool::BeadsDoltStart),
            _ => None,
        }
    }
}

/// Tools permitted for each role. If a role is not listed, it gets nothing.
pub fn allowed_tools(role: &str) -> HashSet<Tool> {
    match role {
        "workforce_manager" => [
            Tool::BeadsInit,
            Tool::BeadsRun,
            Tool::SetBeadsProjectPath,
            Tool::BeadsDoltStart,
        ]
        .into_iter()
        .collect(),

        "project_manager" => [Tool::ReadFile, Tool::BeadsRun].into_iter().collect(),

        "developer" => [
            Tool::WriteFile,
            Tool::ReadFile,
            Tool::TerminalExec,
            Tool::BrowserEnsureStarted,
        ]
        .into_iter()
        .collect(),

        "worker" => [Tool::WriteFile, Tool::ReadFile, Tool::TerminalExec]
            .into_iter()
            .collect(),

        "code_review_validator" | "scope_validator" => {
            [Tool::ReadFile].into_iter().collect()
        }

        "business_logic_validator" => {
            [Tool::ReadFile, Tool::TerminalExec].into_iter().collect()
        }

        _ => HashSet::new(),
    }
}

/// Check whether an agent is allowed to call a tool right now.
/// Returns Ok(()) if allowed, Err with reason if not.
pub fn gate_tool_call(
    role: &str,
    state: State,
    tool: Tool,
    token_used: u64,
    token_quota: u64,
    spawned_at: Instant,
    ttl: Duration,
) -> Result<(), String> {
    // 1. Must be in Running state to use tools.
    if state != State::Running {
        return Err(format!(
            "Agent in state {state}, must be Running to use tools"
        ));
    }

    // 2. Role permission check.
    if !allowed_tools(role).contains(&tool) {
        return Err(format!(
            "Role {role} is not permitted to use {tool:?}"
        ));
    }

    // 3. Token quota hard limit.
    if token_used >= token_quota {
        return Err(format!(
            "Token quota exceeded ({token_used}/{token_quota})"
        ));
    }

    // 4. TTL hard limit.
    if spawned_at.elapsed() >= ttl {
        return Err(format!(
            "TTL expired ({}s elapsed, limit {}s)",
            spawned_at.elapsed().as_secs(),
            ttl.as_secs()
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn developer_cannot_self_complete() {
        let result = try_transition(State::Running, Event::Complete, "developer");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("yield_for_review"));
    }

    #[test]
    fn developer_can_yield() {
        let result = try_transition(State::Running, Event::Yield, "developer");
        assert_eq!(result.unwrap(), State::Yielded);
    }

    #[test]
    fn worker_can_complete() {
        let result = try_transition(State::Running, Event::Complete, "worker");
        assert_eq!(result.unwrap(), State::Done);
    }

    #[test]
    fn validation_pass_completes() {
        let result = try_transition(State::InReview, Event::ValidationPass, "developer");
        assert_eq!(result.unwrap(), State::Done);
    }

    #[test]
    fn validation_fail_returns_to_running() {
        let result = try_transition(State::InReview, Event::ValidationFail, "developer");
        assert_eq!(result.unwrap(), State::Running);
    }

    #[test]
    fn kill_from_any_non_terminal() {
        for state in [State::Spawned, State::Running, State::Yielded, State::InReview] {
            assert_eq!(try_transition(state, Event::Kill, "developer").unwrap(), State::Stopped);
        }
    }

    #[test]
    fn kill_from_terminal_fails() {
        for state in [State::Done, State::Blocked, State::Stopped] {
            assert!(try_transition(state, Event::Kill, "developer").is_err());
        }
    }

    #[test]
    fn developer_cannot_use_beads_run() {
        assert!(!allowed_tools("developer").contains(&Tool::BeadsRun));
    }

    #[test]
    fn worker_cannot_use_browser() {
        assert!(!allowed_tools("worker").contains(&Tool::BrowserEnsureStarted));
    }

    #[test]
    fn gate_rejects_non_running() {
        let result = gate_tool_call(
            "developer",
            State::Yielded,
            Tool::WriteFile,
            0,
            200_000,
            Instant::now(),
            Duration::from_secs(900),
        );
        assert!(result.is_err());
    }

    #[test]
    fn gate_rejects_wrong_role() {
        let result = gate_tool_call(
            "workforce_manager",
            State::Running,
            Tool::WriteFile,
            0,
            500_000,
            Instant::now(),
            Duration::from_secs(3600),
        );
        assert!(result.is_err());
    }

    #[test]
    fn gate_rejects_quota_exceeded() {
        let result = gate_tool_call(
            "developer",
            State::Running,
            Tool::WriteFile,
            200_001,
            200_000,
            Instant::now(),
            Duration::from_secs(900),
        );
        assert!(result.is_err());
    }

    #[test]
    fn developer_spawn_without_task_rejected() {
        let active = HashMap::from([("workforce_manager".to_string(), 1usize)]);
        let result = validate_spawn("developer", &None, &active);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("requires a task_id"));
    }

    #[test]
    fn developer_spawn_with_task_ok() {
        let active = HashMap::new();
        let result = validate_spawn("developer", &Some("bd-1".to_string()), &active);
        assert!(result.is_ok());
    }

    #[test]
    fn workforce_manager_spawn_without_task_ok() {
        let active = HashMap::new();
        let result = validate_spawn("workforce_manager", &None, &active);
        assert!(result.is_ok());
    }

    #[test]
    fn worker_spawn_requires_task() {
        let active = HashMap::new();
        assert!(validate_spawn("worker", &None, &active).is_err());
        assert!(validate_spawn("worker", &Some("bd-2".to_string()), &active).is_ok());
    }

    #[test]
    fn project_manager_spawn_requires_task() {
        let active = HashMap::new();
        assert!(validate_spawn("project_manager", &None, &active).is_err());
        assert!(validate_spawn("project_manager", &Some("bd-3".to_string()), &active).is_ok());
    }
}
