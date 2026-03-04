//! WM Brain: event-driven state machine for the Workforce Manager.
//!
//! All WM decision logic lives here — inspection, classification, zombie cleanup,
//! and the state machine transitions. The frontend is a dumb reducer that applies
//! events emitted by this module.

use crate::orchestration::OrchEnv;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WmPhase {
    Idle,
    Inspecting,
    Completed,
    SettingUp,
    Monitoring,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProjectState {
    New,
    InProgress,
    Completed,
    Error,
}

// ---------------------------------------------------------------------------
// Events (backend -> frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum WmEvent {
    PhaseChanged {
        phase: WmPhase,
    },
    ShortCircuit {
        message: String,
        diagnostics: Diagnostics,
    },
    RunLlm {
        system_prompt: String,
        state_context: String,
        remove_tools: Vec<String>,
        prompt_variant: String,
        diagnostics: Diagnostics,
    },
    LlmDone {},
    ShowError {
        message: String,
        diagnostics: Option<Diagnostics>,
    },
    OrchStatusChanged {
        status: String,
    },
    MessageAdded {
        role: String,
        content: String,
    },
}

// ---------------------------------------------------------------------------
// WM state persisted across turns
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WmMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WmState {
    pub phase: WmPhase,
    pub conversation: Vec<WmMessage>,
    pub project_path: Option<String>,
    pub last_inspection: Option<InspectionResult>,
}

impl Default for WmState {
    fn default() -> Self {
        Self {
            phase: WmPhase::Idle,
            conversation: Vec::new(),
            project_path: None,
            last_inspection: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Diagnostics — structured, always present
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseFail {
    pub id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostics {
    pub path_source: String,
    pub project_path: Option<String>,
    pub total_tasks: usize,
    pub closed_epics: Vec<String>,
    pub open_epics: Vec<String>,
    pub active_agent_task_ids: Vec<String>,
    pub close_attempts: usize,
    pub close_succeeded: usize,
    pub close_failed: Vec<CloseFail>,
    pub final_state: ProjectState,
    pub remaining_count: usize,
    pub remaining_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// Beads task representation (subset of what bd list --json returns)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeadsTask {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, rename = "type")]
    pub task_type: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub issue_type: Option<String>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default, rename = "parentId")]
    pub parent_id_alt: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl BeadsTask {
    fn is_closed(&self) -> bool {
        self.status == "done" || self.status == "closed"
    }

    fn is_epic(&self) -> bool {
        self.task_type == "epic" || self.issue_type.as_deref() == Some("epic")
    }

    fn effective_type(&self) -> &str {
        if !self.task_type.is_empty() {
            &self.task_type
        } else {
            self.issue_type.as_deref().unwrap_or("task")
        }
    }

    fn parent_effective(&self) -> Option<&str> {
        self.parent
            .as_deref()
            .or(self.parent_id.as_deref())
            .or(self.parent_id_alt.as_deref())
    }

    fn updated_timestamp(&self) -> i64 {
        self.updated_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Inspection result
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectionResult {
    pub state: ProjectState,
    pub project_path: Option<String>,
    pub completed_epics: Vec<BeadsTask>,
    pub active_epics: Vec<BeadsTask>,
    pub remaining_tasks: Vec<BeadsTask>,
    pub zombies_closed: Vec<String>,
    pub error_message: Option<String>,
    pub state_context: String,
    pub completion_summary: Option<String>,
    pub diagnostics: Diagnostics,
}

// ---------------------------------------------------------------------------
// inspect_and_decide — the core brain function
// ---------------------------------------------------------------------------

/// Inspect the project and decide what the WM should do.
///
/// This is a pure function of its inputs (env + data) — no Tauri state, no frontend.
/// Returns an InspectionResult that the caller converts into WmEvents.
pub fn inspect_and_decide(
    env: &dyn OrchEnv,
    project_path: Option<&str>,
    active_agent_task_ids: &HashSet<String>,
) -> InspectionResult {
    let path_source = if project_path.is_some() {
        "metadb"
    } else {
        "none"
    };

    let project_path_str = match project_path {
        Some(p) if !p.is_empty() => p,
        _ => {
            return InspectionResult {
                state: ProjectState::New,
                project_path: None,
                completed_epics: vec![],
                active_epics: vec![],
                remaining_tasks: vec![],
                zombies_closed: vec![],
                error_message: None,
                state_context: String::new(),
                completion_summary: None,
                diagnostics: Diagnostics {
                    path_source: path_source.to_string(),
                    project_path: None,
                    total_tasks: 0,
                    closed_epics: vec![],
                    open_epics: vec![],
                    active_agent_task_ids: active_agent_task_ids.iter().cloned().collect(),
                    close_attempts: 0,
                    close_succeeded: 0,
                    close_failed: vec![],
                    final_state: ProjectState::New,
                    remaining_count: 0,
                    remaining_ids: vec![],
                },
            };
        }
    };

    let path = Path::new(project_path_str);
    let list_args: Vec<String> = ["list", "--json", "--all"]
        .iter()
        .map(|s| s.to_string())
        .collect();

    let all_tasks: Vec<BeadsTask> = match env.run_bd(path, &list_args) {
        Ok(stdout) => {
            let trimmed = stdout.trim();
            if trimmed.is_empty() {
                vec![]
            } else {
                serde_json::from_str::<Vec<BeadsTask>>(trimmed).unwrap_or_default()
            }
        }
        Err(e) => {
            return InspectionResult {
                state: ProjectState::Error,
                project_path: Some(project_path_str.to_string()),
                completed_epics: vec![],
                active_epics: vec![],
                remaining_tasks: vec![],
                zombies_closed: vec![],
                error_message: Some(format!(
                    "Could not list tasks for {}: {}",
                    project_path_str, e
                )),
                state_context: String::new(),
                completion_summary: None,
                diagnostics: Diagnostics {
                    path_source: path_source.to_string(),
                    project_path: Some(project_path_str.to_string()),
                    total_tasks: 0,
                    closed_epics: vec![],
                    open_epics: vec![],
                    active_agent_task_ids: active_agent_task_ids.iter().cloned().collect(),
                    close_attempts: 0,
                    close_succeeded: 0,
                    close_failed: vec![],
                    final_state: ProjectState::Error,
                    remaining_count: 0,
                    remaining_ids: vec![],
                },
            };
        }
    };

    if all_tasks.is_empty() {
        return InspectionResult {
            state: ProjectState::New,
            project_path: Some(project_path_str.to_string()),
            completed_epics: vec![],
            active_epics: vec![],
            remaining_tasks: vec![],
            zombies_closed: vec![],
            error_message: None,
            state_context: String::new(),
            completion_summary: None,
            diagnostics: Diagnostics {
                path_source: path_source.to_string(),
                project_path: Some(project_path_str.to_string()),
                total_tasks: 0,
                closed_epics: vec![],
                open_epics: vec![],
                active_agent_task_ids: active_agent_task_ids.iter().cloned().collect(),
                close_attempts: 0,
                close_succeeded: 0,
                close_failed: vec![],
                final_state: ProjectState::New,
                remaining_count: 0,
                remaining_ids: vec![],
            },
        };
    }

    // --- Zombie detection and cleanup ---
    let mut to_close: HashSet<String> = HashSet::new();
    let mut cleanup_notes: Vec<String> = Vec::new();

    let epics: Vec<&BeadsTask> = all_tasks.iter().filter(|t| t.is_epic()).collect();
    let closed_epics: Vec<&BeadsTask> = epics.iter().filter(|t| t.is_closed()).copied().collect();
    let open_epics: Vec<&BeadsTask> = epics.iter().filter(|t| !t.is_closed()).copied().collect();

    let has_completed_epic = !closed_epics.is_empty();

    if has_completed_epic {
        for ep in &open_epics {
            if !active_agent_task_ids.contains(&ep.id) {
                to_close.insert(ep.id.clone());
                cleanup_notes.push(format!(
                    "Closed zombie epic \"{}\" ({}) — completed epic {} exists",
                    ep.title, ep.id, closed_epics[0].id
                ));
            }
        }
    } else if open_epics.len() > 1 {
        let mut sorted: Vec<&BeadsTask> = open_epics.clone();
        sorted.sort_by(|a, b| {
            let a_active = active_agent_task_ids.contains(&a.id);
            let b_active = active_agent_task_ids.contains(&b.id);
            match (a_active, b_active) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => b.updated_timestamp().cmp(&a.updated_timestamp()),
            }
        });
        let keeper = sorted[0];
        for ep in &sorted[1..] {
            if !active_agent_task_ids.contains(&ep.id) {
                to_close.insert(ep.id.clone());
                cleanup_notes.push(format!(
                    "Closed duplicate epic \"{}\" ({}) — keeping {}",
                    ep.title, ep.id, keeper.id
                ));
            }
        }
    }

    // Cascade: close children of zombie epics
    let mut frontier: HashSet<String> = to_close.clone();
    while !frontier.is_empty() {
        let mut next: HashSet<String> = HashSet::new();
        for t in &all_tasks {
            if to_close.contains(&t.id) {
                continue;
            }
            let pid = match t.parent_effective() {
                Some(p) => p.to_string(),
                None => continue,
            };
            if !frontier.contains(&pid) {
                continue;
            }
            if has_completed_epic || !active_agent_task_ids.contains(&t.id) {
                to_close.insert(t.id.clone());
                next.insert(t.id.clone());
            }
        }
        frontier = next;
    }

    // Title-based dedup for surviving non-epic tasks
    let surviving: Vec<&BeadsTask> = all_tasks
        .iter()
        .filter(|t| !to_close.contains(&t.id) && !t.is_epic())
        .collect();

    let mut groups: HashMap<String, Vec<&BeadsTask>> = HashMap::new();
    for t in &surviving {
        let key = format!("{}:{}", t.effective_type(), t.title.trim().to_lowercase());
        groups.entry(key).or_default().push(t);
    }

    for group in groups.values() {
        if group.len() <= 1 {
            continue;
        }
        let mut sorted = group.clone();
        sorted.sort_by(|a, b| {
            match (a.is_closed(), b.is_closed()) {
                (true, false) => return std::cmp::Ordering::Less,
                (false, true) => return std::cmp::Ordering::Greater,
                _ => {}
            }
            let a_active = active_agent_task_ids.contains(&a.id);
            let b_active = active_agent_task_ids.contains(&b.id);
            match (a_active, b_active) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => b.updated_timestamp().cmp(&a.updated_timestamp()),
            }
        });
        let winner = sorted[0];
        for loser in &sorted[1..] {
            if !active_agent_task_ids.contains(&loser.id) {
                to_close.insert(loser.id.clone());
                cleanup_notes.push(format!(
                    "Closed duplicate task \"{}\" ({}) — keeping {}",
                    loser.title, loser.id, winner.id
                ));
            }
        }
    }

    // Perform closing
    let mut closed_ids: Vec<String> = Vec::new();
    let mut close_failed: Vec<CloseFail> = Vec::new();

    for id in &to_close {
        let close_args: Vec<String> = vec![
            "close".to_string(),
            id.clone(),
            "--reason".to_string(),
            "Auto-closed: zombie/duplicate detected by inspection".to_string(),
        ];
        match env.run_bd(path, &close_args) {
            Ok(_) => closed_ids.push(id.clone()),
            Err(e) => close_failed.push(CloseFail {
                id: id.clone(),
                error: e,
            }),
        }
    }

    // --- Classify state ---
    let remaining: Vec<BeadsTask> = all_tasks
        .iter()
        .filter(|t| !to_close.contains(&t.id))
        .cloned()
        .collect();
    let remaining_epics: Vec<&BeadsTask> = remaining.iter().filter(|t| t.is_epic()).collect();
    let final_closed_epics: Vec<&BeadsTask> = remaining_epics
        .iter()
        .filter(|t| t.is_closed())
        .copied()
        .collect();
    let final_open_epics: Vec<&BeadsTask> = remaining_epics
        .iter()
        .filter(|t| !t.is_closed())
        .copied()
        .collect();

    let state = if !final_closed_epics.is_empty() && final_open_epics.is_empty() {
        ProjectState::Completed
    } else if !final_open_epics.is_empty() || !remaining.is_empty() {
        ProjectState::InProgress
    } else {
        ProjectState::New
    };

    // --- Build state context for the system prompt ---
    let mut ctx_lines: Vec<String> = vec![
        String::new(),
        "## Current Project State (auto-detected — do NOT re-query with tools)".to_string(),
        format!("Project path: {}", project_path_str),
        String::new(),
    ];

    if !closed_ids.is_empty() {
        ctx_lines.push("### Auto-Cleanup Performed".to_string());
        ctx_lines.push(format!(
            "Closed {} zombie/duplicate task(s):",
            closed_ids.len()
        ));
        for n in &cleanup_notes {
            ctx_lines.push(format!("- {}", n));
        }
        ctx_lines.push(String::new());
    }

    if !remaining.is_empty() {
        ctx_lines.push("### Existing Tasks".to_string());
        for t in &remaining {
            let ttype = t.effective_type();
            let par = t.parent_effective().unwrap_or("");
            let par_str = if par.is_empty() {
                String::new()
            } else {
                format!(" (parent: {})", par)
            };
            ctx_lines.push(format!(
                "- {} [{}, {}]: \"{}\"{}",
                t.id, ttype, t.status, t.title, par_str
            ));
        }
        ctx_lines.push(String::new());
    }

    if state == ProjectState::Completed {
        let epic = &final_closed_epics[0];
        ctx_lines.push("### WORK IS ALREADY COMPLETED".to_string());
        ctx_lines.push(format!(
            "Epic {} (\"{}\") is {}.",
            epic.id,
            epic.title,
            epic.status.to_uppercase()
        ));
        ctx_lines.push(
            "If the user wants modifications, create individual tasks (NOT epics) under the existing epic.".to_string(),
        );
        ctx_lines.push(String::new());
    } else if state == ProjectState::InProgress && !final_open_epics.is_empty() {
        let epic = &final_open_epics[0];
        ctx_lines.push("### EPIC ALREADY IN PROGRESS".to_string());
        ctx_lines.push(format!(
            "Epic {} (\"{}\") is {}. Do NOT create another epic.",
            epic.id, epic.title, epic.status
        ));
        ctx_lines.push(format!(
            "Add tasks under it with parent_id: \"{}\".",
            epic.id
        ));
        ctx_lines.push(String::new());
    }

    // --- Build completion summary ---
    let completion_summary = if state == ProjectState::Completed {
        let epic = &final_closed_epics[0];
        let children: Vec<&BeadsTask> = remaining
            .iter()
            .filter(|t| t.parent_effective() == Some(&epic.id))
            .collect();
        let task_lines: String = children
            .iter()
            .map(|c| format!("- {}: {}", c.id, c.title))
            .collect::<Vec<_>>()
            .join("\n");

        let tasks_section = if children.is_empty() {
            "All work is finished.".to_string()
        } else {
            format!("**Completed tasks:**\n{}", task_lines)
        };

        Some(format!(
            "This project is already complete.\n\n**Project:** {}\n**Epic:** {} (ID: {})\n\n{}\n\nWould you like me to make any modifications?",
            project_path_str, epic.title, epic.id, tasks_section
        ))
    } else {
        None
    };

    let diagnostics = Diagnostics {
        path_source: path_source.to_string(),
        project_path: Some(project_path_str.to_string()),
        total_tasks: all_tasks.len(),
        closed_epics: closed_epics.iter().map(|e| e.id.clone()).collect(),
        open_epics: open_epics.iter().map(|e| e.id.clone()).collect(),
        active_agent_task_ids: active_agent_task_ids.iter().cloned().collect(),
        close_attempts: to_close.len(),
        close_succeeded: closed_ids.len(),
        close_failed,
        final_state: state,
        remaining_count: remaining.len(),
        remaining_ids: remaining
            .iter()
            .map(|t| format!("{}[{}]", t.id, t.status))
            .collect(),
    };

    InspectionResult {
        state,
        project_path: Some(project_path_str.to_string()),
        completed_epics: final_closed_epics.into_iter().cloned().collect(),
        active_epics: final_open_epics.into_iter().cloned().collect(),
        remaining_tasks: remaining,
        zombies_closed: closed_ids,
        error_message: None,
        state_context: ctx_lines.join("\n"),
        completion_summary,
        diagnostics,
    }
}

/// Convert an InspectionResult into the WmAction the frontend should take.
/// Returns a list of WmEvents to emit.
pub fn decide_events(result: &InspectionResult) -> Vec<WmEvent> {
    let mut events = Vec::new();

    match result.state {
        ProjectState::Completed => {
            let message = result
                .completion_summary
                .clone()
                .unwrap_or_else(|| "This project is already complete.".to_string());
            events.push(WmEvent::ShortCircuit {
                message,
                diagnostics: result.diagnostics.clone(),
            });
        }
        ProjectState::New => {
            events.push(WmEvent::RunLlm {
                system_prompt: String::new(),
                state_context: result.state_context.clone(),
                remove_tools: vec![],
                prompt_variant: "standard".to_string(),
                diagnostics: result.diagnostics.clone(),
            });
        }
        ProjectState::InProgress => {
            events.push(WmEvent::RunLlm {
                system_prompt: String::new(),
                state_context: result.state_context.clone(),
                remove_tools: vec!["open_project_with_beads".to_string()],
                prompt_variant: "standard".to_string(),
                diagnostics: result.diagnostics.clone(),
            });
        }
        ProjectState::Error => {
            let message = result
                .error_message
                .clone()
                .unwrap_or_else(|| "An error occurred during inspection.".to_string());
            events.push(WmEvent::ShowError {
                message,
                diagnostics: Some(result.diagnostics.clone()),
            });
        }
    }

    events
}

// ---------------------------------------------------------------------------
// State machine transitions
// ---------------------------------------------------------------------------

impl WmState {
    pub fn transition_to(&mut self, phase: WmPhase) {
        self.phase = phase;
    }

    pub fn add_message(&mut self, role: &str, content: &str) {
        self.conversation.push(WmMessage {
            role: role.to_string(),
            content: content.to_string(),
        });
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    #[derive(Debug, Clone)]
    struct BdCall {
        args: Vec<String>,
    }

    /// Test implementation of OrchEnv that returns canned responses keyed by first bd arg.
    struct TestWmEnv {
        bd_responses: StdMutex<HashMap<String, Result<String, String>>>,
        bd_calls: Arc<StdMutex<Vec<BdCall>>>,
    }

    impl TestWmEnv {
        fn new() -> Self {
            Self {
                bd_responses: StdMutex::new(HashMap::new()),
                bd_calls: Arc::new(StdMutex::new(Vec::new())),
            }
        }

        fn set_list_response(&self, json: &str) {
            self.bd_responses
                .lock()
                .unwrap()
                .insert("list".to_string(), Ok(json.to_string()));
        }

        fn set_list_error(&self, err: &str) {
            self.bd_responses
                .lock()
                .unwrap()
                .insert("list".to_string(), Err(err.to_string()));
        }

        fn set_close_error(&self, id: &str, err: &str) {
            self.bd_responses
                .lock()
                .unwrap()
                .insert(format!("close:{}", id), Err(err.to_string()));
        }

        fn bd_calls(&self) -> Vec<BdCall> {
            self.bd_calls.lock().unwrap().clone()
        }

        fn close_calls(&self) -> Vec<Vec<String>> {
            self.bd_calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.args.first().map(|a| a.as_str()) == Some("close"))
                .map(|c| c.args.clone())
                .collect()
        }
    }

    impl OrchEnv for TestWmEnv {
        fn emit_event(&self, _event: &str, _payload: serde_json::Value) -> Result<(), String> {
            Ok(())
        }

        fn run_bd(&self, _project_path: &Path, args: &[String]) -> Result<String, String> {
            self.bd_calls.lock().unwrap().push(BdCall {
                args: args.to_vec(),
            });

            let responses = self.bd_responses.lock().unwrap();

            // Check for specific close:<id> response
            if args.first().map(|a| a.as_str()) == Some("close") {
                if let Some(id) = args.get(1) {
                    let key = format!("close:{}", id);
                    if let Some(resp) = responses.get(&key) {
                        return resp.clone();
                    }
                }
            }

            // Check for command-level response
            if let Some(cmd) = args.first() {
                if let Some(resp) = responses.get(cmd.as_str()) {
                    return resp.clone();
                }
            }

            Ok(String::new())
        }

        fn spawn_pty(
            &self,
            _id: &str,
            _cols: u16,
            _rows: u16,
            _cwd: Option<&Path>,
        ) -> Result<(), String> {
            Ok(())
        }

        fn kill_pty(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    // Helper to build a task JSON object
    fn task_json(id: &str, title: &str, task_type: &str, status: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "title": title,
            "type": task_type,
            "status": status
        })
    }

    fn task_with_parent(
        id: &str,
        title: &str,
        task_type: &str,
        status: &str,
        parent: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "title": title,
            "type": task_type,
            "status": status,
            "parent": parent
        })
    }

    fn task_with_updated(
        id: &str,
        title: &str,
        task_type: &str,
        status: &str,
        updated_at: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "title": title,
            "type": task_type,
            "status": status,
            "updated_at": updated_at
        })
    }

    // -----------------------------------------------------------------------
    // Inspection tests
    // -----------------------------------------------------------------------

    #[test]
    fn no_project_path_returns_new() {
        let env = TestWmEnv::new();
        let active = HashSet::new();
        let result = inspect_and_decide(&env, None, &active);
        assert_eq!(result.state, ProjectState::New);
        assert!(result.project_path.is_none());
        assert_eq!(result.diagnostics.path_source, "none");
    }

    #[test]
    fn empty_project_path_returns_new() {
        let env = TestWmEnv::new();
        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some(""), &active);
        assert_eq!(result.state, ProjectState::New);
    }

    #[test]
    fn empty_task_list_returns_new() {
        let env = TestWmEnv::new();
        env.set_list_response("[]");
        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);
        assert_eq!(result.state, ProjectState::New);
        assert_eq!(result.diagnostics.total_tasks, 0);
    }

    #[test]
    fn completed_project_short_circuits() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "done"),
            task_with_parent("task-1", "Setup", "task", "done", "epic-1"),
            task_with_parent("task-2", "Tests", "task", "done", "epic-1"),
        ]);
        env.set_list_response(&tasks.to_string());

        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        assert_eq!(result.state, ProjectState::Completed);
        assert_eq!(result.completed_epics.len(), 1);
        assert!(result.completion_summary.is_some());
        let summary = result.completion_summary.unwrap();
        assert!(summary.contains("already complete"));
        assert!(summary.contains("Build app"));
    }

    #[test]
    fn in_progress_project() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "open"),
            task_with_parent("task-1", "Setup", "task", "in-progress", "epic-1"),
        ]);
        env.set_list_response(&tasks.to_string());

        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        assert_eq!(result.state, ProjectState::InProgress);
        assert!(result.active_epics.len() == 1);
        assert!(result.state_context.contains("EPIC ALREADY IN PROGRESS"));
    }

    #[test]
    fn zombie_epics_closed() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "done"),
            task_json("epic-2", "Build app v2", "epic", "open"),
        ]);
        env.set_list_response(&tasks.to_string());

        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        assert_eq!(result.state, ProjectState::Completed);
        assert!(result.zombies_closed.contains(&"epic-2".to_string()));

        let closes = env.close_calls();
        assert_eq!(closes.len(), 1);
        assert_eq!(closes[0][1], "epic-2");
    }

    #[test]
    fn zombie_children_force_closed() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "done"),
            task_json("epic-2", "Build app v2", "epic", "open"),
            task_with_parent("task-1", "Impl", "task", "in-progress", "epic-2"),
        ]);
        env.set_list_response(&tasks.to_string());

        // task-1 has an active agent, but it's under a zombie epic => force-closed
        let mut active = HashSet::new();
        active.insert("task-1".to_string());

        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        assert_eq!(result.state, ProjectState::Completed);
        assert!(result.zombies_closed.contains(&"epic-2".to_string()));
        assert!(result.zombies_closed.contains(&"task-1".to_string()));
    }

    #[test]
    fn active_epic_protected() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "done"),
            task_json("epic-2", "Build app v2", "epic", "open"),
        ]);
        env.set_list_response(&tasks.to_string());

        let mut active = HashSet::new();
        active.insert("epic-2".to_string());

        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        assert_eq!(result.state, ProjectState::InProgress);
        assert!(!result.zombies_closed.contains(&"epic-2".to_string()));
    }

    #[test]
    fn dedup_open_epics_keeps_newest() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_with_updated(
                "epic-1",
                "Build app",
                "epic",
                "open",
                "2025-01-01T00:00:00Z"
            ),
            task_with_updated(
                "epic-2",
                "Build app v2",
                "epic",
                "open",
                "2025-06-01T00:00:00Z"
            ),
        ]);
        env.set_list_response(&tasks.to_string());

        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        assert_eq!(result.state, ProjectState::InProgress);
        // epic-2 is newer, so epic-1 gets closed
        assert!(result.zombies_closed.contains(&"epic-1".to_string()));
        assert!(!result.zombies_closed.contains(&"epic-2".to_string()));
    }

    #[test]
    fn bd_list_failure_returns_error() {
        let env = TestWmEnv::new();
        env.set_list_error("bd not found");

        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        assert_eq!(result.state, ProjectState::Error);
        assert!(result.error_message.is_some());
        assert!(result.error_message.unwrap().contains("bd not found"));
    }

    #[test]
    fn bd_close_failure_captured() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "done"),
            task_json("epic-2", "Zombie", "epic", "open"),
        ]);
        env.set_list_response(&tasks.to_string());
        env.set_close_error("epic-2", "close failed: DB locked");

        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        assert_eq!(result.diagnostics.close_failed.len(), 1);
        assert_eq!(result.diagnostics.close_failed[0].id, "epic-2");
        assert!(result.diagnostics.close_failed[0]
            .error
            .contains("DB locked"));
    }

    #[test]
    fn title_dedup_keeps_closed() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "open"),
            task_with_parent("task-1", "Setup API", "task", "done", "epic-1"),
            task_with_parent("task-2", "Setup API", "task", "open", "epic-1"),
        ]);
        env.set_list_response(&tasks.to_string());

        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        // task-1 is closed and should be kept; task-2 (open duplicate) should be closed
        assert!(result.zombies_closed.contains(&"task-2".to_string()));
        assert!(!result.zombies_closed.contains(&"task-1".to_string()));
    }

    #[test]
    fn diagnostics_always_complete() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "open"),
            task_with_parent("task-1", "Setup", "task", "in-progress", "epic-1"),
        ]);
        env.set_list_response(&tasks.to_string());

        let mut active = HashSet::new();
        active.insert("task-1".to_string());

        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);
        let d = &result.diagnostics;

        assert_eq!(d.path_source, "metadb");
        assert_eq!(d.project_path, Some("/tmp/proj".to_string()));
        assert_eq!(d.total_tasks, 2);
        assert!(d.open_epics.contains(&"epic-1".to_string()));
        assert!(d.active_agent_task_ids.contains(&"task-1".to_string()));
        assert_eq!(d.final_state, ProjectState::InProgress);
        assert_eq!(d.remaining_count, 2);
    }

    #[test]
    fn state_context_built_correctly() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "open"),
            task_with_parent("task-1", "Setup", "task", "ready", "epic-1"),
        ]);
        env.set_list_response(&tasks.to_string());

        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        assert!(result.state_context.contains("Project path: /tmp/proj"));
        assert!(result.state_context.contains("epic-1"));
        assert!(result.state_context.contains("task-1"));
        assert!(result.state_context.contains("EPIC ALREADY IN PROGRESS"));
    }

    #[test]
    fn completion_summary_has_tasks() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "done"),
            task_with_parent("task-1", "Setup API", "task", "done", "epic-1"),
            task_with_parent("task-2", "Write tests", "task", "done", "epic-1"),
        ]);
        env.set_list_response(&tasks.to_string());

        let active = HashSet::new();
        let result = inspect_and_decide(&env, Some("/tmp/proj"), &active);

        assert_eq!(result.state, ProjectState::Completed);
        let summary = result.completion_summary.as_ref().unwrap();
        assert!(summary.contains("Setup API"));
        assert!(summary.contains("Write tests"));
        assert!(summary.contains("already complete"));
    }

    // -----------------------------------------------------------------------
    // decide_events tests
    // -----------------------------------------------------------------------

    #[test]
    fn decide_completed_emits_short_circuit() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([task_json("epic-1", "Build app", "epic", "done"),]);
        env.set_list_response(&tasks.to_string());

        let result = inspect_and_decide(&env, Some("/tmp/proj"), &HashSet::new());
        let events = decide_events(&result);

        assert_eq!(events.len(), 1);
        match &events[0] {
            WmEvent::ShortCircuit { message, .. } => {
                assert!(message.contains("already complete"));
            }
            _ => panic!("Expected ShortCircuit"),
        }
    }

    #[test]
    fn decide_new_emits_run_llm() {
        let env = TestWmEnv::new();
        env.set_list_response("[]");

        let result = inspect_and_decide(&env, Some("/tmp/proj"), &HashSet::new());
        let events = decide_events(&result);

        assert_eq!(events.len(), 1);
        match &events[0] {
            WmEvent::RunLlm {
                prompt_variant,
                remove_tools,
                ..
            } => {
                assert_eq!(prompt_variant, "standard");
                assert!(remove_tools.is_empty());
            }
            _ => panic!("Expected RunLlm"),
        }
    }

    #[test]
    fn decide_in_progress_removes_beads_tool() {
        let env = TestWmEnv::new();
        let tasks = serde_json::json!([task_json("epic-1", "Build app", "epic", "open"),]);
        env.set_list_response(&tasks.to_string());

        let result = inspect_and_decide(&env, Some("/tmp/proj"), &HashSet::new());
        let events = decide_events(&result);

        assert_eq!(events.len(), 1);
        match &events[0] {
            WmEvent::RunLlm { remove_tools, .. } => {
                assert!(remove_tools.contains(&"open_project_with_beads".to_string()));
            }
            _ => panic!("Expected RunLlm"),
        }
    }

    #[test]
    fn decide_error_emits_show_error() {
        let env = TestWmEnv::new();
        env.set_list_error("bd crashed");

        let result = inspect_and_decide(&env, Some("/tmp/proj"), &HashSet::new());
        let events = decide_events(&result);

        assert_eq!(events.len(), 1);
        match &events[0] {
            WmEvent::ShowError { message, .. } => {
                assert!(message.contains("bd crashed"));
            }
            _ => panic!("Expected ShowError"),
        }
    }

    // -----------------------------------------------------------------------
    // State machine transition tests
    // -----------------------------------------------------------------------

    #[test]
    fn launch_to_completed() {
        let mut state = WmState::default();
        assert_eq!(state.phase, WmPhase::Idle);

        state.transition_to(WmPhase::Inspecting);
        assert_eq!(state.phase, WmPhase::Inspecting);

        // Inspection returns completed -> transition to Completed
        state.transition_to(WmPhase::Completed);
        assert_eq!(state.phase, WmPhase::Completed);
    }

    #[test]
    fn launch_to_running() {
        let mut state = WmState::default();
        state.transition_to(WmPhase::Inspecting);
        state.transition_to(WmPhase::SettingUp);
        assert_eq!(state.phase, WmPhase::SettingUp);
    }

    #[test]
    fn llm_done_to_monitoring() {
        let mut state = WmState::default();
        state.transition_to(WmPhase::SettingUp);
        state.transition_to(WmPhase::Monitoring);
        assert_eq!(state.phase, WmPhase::Monitoring);
    }

    #[test]
    fn followup_after_completed() {
        let mut state = WmState::default();
        state.transition_to(WmPhase::Completed);

        // User sends a follow-up message
        state.transition_to(WmPhase::Inspecting);
        assert_eq!(state.phase, WmPhase::Inspecting);
    }

    #[test]
    fn error_allows_retry() {
        let mut state = WmState::default();
        state.transition_to(WmPhase::Error);

        state.transition_to(WmPhase::Inspecting);
        assert_eq!(state.phase, WmPhase::Inspecting);
    }

    #[test]
    fn conversation_persists_across_turns() {
        let mut state = WmState::default();
        state.add_message("user", "Build me an app");
        state.add_message("assistant", "I'll set that up for you.");

        assert_eq!(state.conversation.len(), 2);
        assert_eq!(state.conversation[0].role, "user");
        assert_eq!(state.conversation[1].content, "I'll set that up for you.");
    }
}
