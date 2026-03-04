//! Testable inner functions for WM Tauri commands.
//!
//! Each `_inner` function contains the full command logic (state loading, inspection,
//! orchestration control, persistence) but returns events instead of emitting them
//! via the Tauri AppHandle. The real Tauri commands are thin wrappers that call these
//! and emit the returned events.

use crate::agent_registry::AgentRegistry;
use crate::orchestration::{OrchEnv, OrchestrationState};
use crate::storage::MetaDb;
use crate::wm_brain::{self, WmEvent, WmPhase, WmState};

/// The result of an inner WM command: the final WM state and events to emit.
pub struct WmCommandResult {
    pub wm_state: WmState,
    pub events: Vec<WmEvent>,
}

pub(crate) fn load_wm_state(meta_db: &MetaDb) -> WmState {
    meta_db
        .get_setting("wm_state")
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

pub(crate) fn persist_wm_state(meta_db: &MetaDb, state: &WmState) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| e.to_string())?;
    meta_db.set_setting("wm_state", &json)
}

pub fn wm_launch_inner(
    env: &dyn OrchEnv,
    meta_db: &MetaDb,
    orch_state: &OrchestrationState,
    registry: &AgentRegistry,
    prompt_text: &str,
) -> Result<WmCommandResult, String> {
    orch_state.set_paused();

    let mut events = Vec::new();
    events.push(WmEvent::OrchStatusChanged {
        status: "paused".to_string(),
    });

    let mut wm = load_wm_state(meta_db);
    wm.transition_to(WmPhase::Inspecting);
    wm.add_message("user", prompt_text);
    events.push(WmEvent::PhaseChanged {
        phase: WmPhase::Inspecting,
    });
    events.push(WmEvent::MessageAdded {
        role: "user".to_string(),
        content: prompt_text.to_string(),
    });

    let mut project_path = meta_db
        .get_setting("beads_project_path")?
        .filter(|p| !p.is_empty());
    if project_path.is_none() {
        project_path = detect_project_path_from_prompt(prompt_text);
    }
    let active = registry.active_task_ids()?;

    let result = wm_brain::inspect_and_decide(env, project_path.as_deref(), &active);
    let decision_events = wm_brain::decide_events(&result);

    wm.project_path = result.project_path.clone();
    wm.last_inspection = Some(result);

    for event in &decision_events {
        match event {
            WmEvent::ShortCircuit { message, .. } => {
                wm.transition_to(WmPhase::Completed);
                wm.add_message("assistant", message);
            }
            WmEvent::RunLlm { .. } => {
                wm.transition_to(WmPhase::SettingUp);
            }
            WmEvent::ShowError { message, .. } => {
                wm.transition_to(WmPhase::Error);
                wm.add_message("assistant", message);
            }
            _ => {}
        }
    }
    events.extend(inject_conversation(decision_events, &wm.conversation));

    persist_wm_state(meta_db, &wm)?;
    Ok(WmCommandResult {
        wm_state: wm,
        events,
    })
}

pub fn wm_handle_message_inner(
    env: &dyn OrchEnv,
    meta_db: &MetaDb,
    orch_state: &OrchestrationState,
    registry: &AgentRegistry,
    text: &str,
) -> Result<WmCommandResult, String> {
    orch_state.set_paused();

    let mut events = Vec::new();
    events.push(WmEvent::OrchStatusChanged {
        status: "paused".to_string(),
    });

    let mut wm = load_wm_state(meta_db);
    wm.transition_to(WmPhase::Inspecting);
    wm.add_message("user", text);
    events.push(WmEvent::PhaseChanged {
        phase: WmPhase::Inspecting,
    });
    events.push(WmEvent::MessageAdded {
        role: "user".to_string(),
        content: text.to_string(),
    });

    let mut project_path = meta_db
        .get_setting("beads_project_path")?
        .filter(|p| !p.is_empty());
    if project_path.is_none() {
        project_path = wm.project_path.clone().filter(|p| !p.is_empty());
    }
    if project_path.is_none() {
        project_path = detect_project_path_from_prompt(text);
    }
    let active = registry.active_task_ids()?;

    let result = wm_brain::inspect_and_decide(env, project_path.as_deref(), &active);

    // For follow-up messages, never short-circuit — the user is asking for something
    // new (e.g. "open it in browser", "add dark mode"). Route through RunLlm so the
    // LLM can act on the request with full project context.
    let decision_events = if result.state == wm_brain::ProjectState::Completed {
        vec![WmEvent::RunLlm {
            system_prompt: String::new(),
            state_context: result.state_context.clone(),
            remove_tools: vec![],
            prompt_variant: "standard".to_string(),
            diagnostics: result.diagnostics.clone(),
            messages: vec![],
        }]
    } else {
        wm_brain::decide_events(&result)
    };

    wm.project_path = result.project_path.clone();
    wm.last_inspection = Some(result);

    for event in &decision_events {
        match event {
            WmEvent::ShortCircuit { message, .. } => {
                wm.transition_to(WmPhase::Completed);
                wm.add_message("assistant", message);
            }
            WmEvent::RunLlm { .. } => {
                wm.transition_to(WmPhase::SettingUp);
            }
            WmEvent::ShowError { message, .. } => {
                wm.transition_to(WmPhase::Error);
                wm.add_message("assistant", message);
            }
            _ => {}
        }
    }
    events.extend(inject_conversation(decision_events, &wm.conversation));

    persist_wm_state(meta_db, &wm)?;
    Ok(WmCommandResult {
        wm_state: wm,
        events,
    })
}

/// Scan the user's prompt for absolute paths that contain a `.beads` directory,
/// indicating an already-initialized project. Returns the first match.
fn detect_project_path_from_prompt(prompt: &str) -> Option<String> {
    use std::path::Path;

    for word in prompt.split_whitespace() {
        let candidate = word.trim_matches(|c: char| c == '"' || c == '\'' || c == ',' || c == '.');
        if !candidate.starts_with('/') {
            continue;
        }
        let p = Path::new(candidate);
        if p.join(".beads").is_dir() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Fill the `messages` field of any RunLlm events with the current conversation.
/// This ensures the frontend has the authoritative conversation from the backend
/// and doesn't need to rely on its own (potentially stale) React state.
fn inject_conversation(events: Vec<WmEvent>, conversation: &[wm_brain::WmMessage]) -> Vec<WmEvent> {
    events
        .into_iter()
        .map(|event| match event {
            WmEvent::RunLlm {
                system_prompt,
                state_context,
                remove_tools,
                prompt_variant,
                diagnostics,
                ..
            } => WmEvent::RunLlm {
                system_prompt,
                state_context,
                remove_tools,
                prompt_variant,
                diagnostics,
                messages: conversation.to_vec(),
            },
            other => other,
        })
        .collect()
}

pub fn wm_llm_done_inner(
    meta_db: &MetaDb,
    orch_state: &OrchestrationState,
    response_text: &str,
) -> Result<WmCommandResult, String> {
    let mut wm = load_wm_state(meta_db);
    wm.transition_to(WmPhase::Monitoring);
    wm.add_message("assistant", response_text);

    orch_state.set_running();

    let events = vec![
        WmEvent::MessageAdded {
            role: "assistant".to_string(),
            content: response_text.to_string(),
        },
        WmEvent::LlmDone {},
        WmEvent::PhaseChanged {
            phase: WmPhase::Monitoring,
        },
        WmEvent::OrchStatusChanged {
            status: "running".to_string(),
        },
    ];

    persist_wm_state(meta_db, &wm)?;
    Ok(WmCommandResult {
        wm_state: wm,
        events,
    })
}

pub fn wm_llm_error_inner(meta_db: &MetaDb, error: &str) -> Result<WmCommandResult, String> {
    let mut wm = load_wm_state(meta_db);
    wm.transition_to(WmPhase::Error);
    wm.add_message("assistant", &format!("Error: {}", error));

    let events = vec![
        WmEvent::ShowError {
            message: error.to_string(),
            diagnostics: None,
        },
        WmEvent::PhaseChanged {
            phase: WmPhase::Error,
        },
    ];

    persist_wm_state(meta_db, &wm)?;
    Ok(WmCommandResult {
        wm_state: wm,
        events,
    })
}

// ===========================================================================
// Integration tests — full MetaDb → inspect → event chain
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_registry::AgentRegistry;
    use crate::orchestration::OrchestrationState;
    use crate::storage::MetaDb;
    use crate::wm_brain::test_support::*;
    use crate::wm_brain::{WmEvent, WmPhase};
    use tempfile::NamedTempFile;

    /// Returns (MetaDb, _guard) — the guard keeps the temp file alive.
    fn make_meta_db() -> (MetaDb, NamedTempFile) {
        let f = NamedTempFile::new().unwrap();
        let db = MetaDb::open(f.path()).unwrap();
        (db, f)
    }

    fn has_event<F: Fn(&WmEvent) -> bool>(events: &[WmEvent], pred: F) -> bool {
        events.iter().any(pred)
    }

    // #1 — New project launch (no beads_project_path in MetaDb)
    #[test]
    fn new_project_launch() {
        let (db, _f) = make_meta_db();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        let r = wm_launch_inner(&env, &db, &orch, &reg, "Build me an app").unwrap();

        assert_eq!(r.wm_state.phase, WmPhase::SettingUp);
        assert_eq!(orch.get(), 2); // paused
        assert!(has_event(&r.events, |e| matches!(
            e,
            WmEvent::RunLlm {
                prompt_variant, ..
            } if prompt_variant == "standard"
        )));
    }

    // #2 — Completed project launch
    #[test]
    fn completed_project_launch() {
        let (db, _f) = make_meta_db();
        db.set_setting("beads_project_path", "/tmp/proj").unwrap();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "done"),
            task_with_parent("task-1", "Setup", "task", "done", "epic-1"),
        ]);
        env.set_list_response(&tasks.to_string());

        let r = wm_launch_inner(&env, &db, &orch, &reg, "Check status").unwrap();

        assert_eq!(r.wm_state.phase, WmPhase::Completed);
        assert!(has_event(&r.events, |e| matches!(
            e,
            WmEvent::ShortCircuit { message, .. } if message.contains("already complete")
        )));
        assert!(r
            .wm_state
            .conversation
            .iter()
            .any(|m| m.role == "assistant" && m.content.contains("already complete")));
    }

    // #3 — In-progress launch keeps open_project_with_beads available
    #[test]
    fn in_progress_launch() {
        let (db, _f) = make_meta_db();
        db.set_setting("beads_project_path", "/tmp/proj").unwrap();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "open"),
            task_with_parent("task-1", "Setup", "task", "in-progress", "epic-1"),
        ]);
        env.set_list_response(&tasks.to_string());

        let r = wm_launch_inner(&env, &db, &orch, &reg, "Continue").unwrap();

        assert_eq!(r.wm_state.phase, WmPhase::SettingUp);
        assert!(has_event(&r.events, |e| matches!(
            e,
            WmEvent::RunLlm { remove_tools, .. }
                if remove_tools.is_empty()
        )));
    }

    // #4 — Launch → LLM done → Monitoring
    #[test]
    fn launch_then_llm_done() {
        let (db, _f) = make_meta_db();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        wm_launch_inner(&env, &db, &orch, &reg, "Build me an app").unwrap();
        assert_eq!(orch.get(), 2); // paused after launch

        let r = wm_llm_done_inner(&db, &orch, "I've set up the project.").unwrap();

        assert_eq!(r.wm_state.phase, WmPhase::Monitoring);
        assert!(orch.is_running());
        assert!(r
            .wm_state
            .conversation
            .iter()
            .any(|m| m.role == "assistant" && m.content == "I've set up the project."));
        assert!(has_event(&r.events, |e| matches!(
            e,
            WmEvent::MessageAdded { role, content }
                if role == "assistant" && content == "I've set up the project."
        )));
    }

    // #5 — Launch → LLM error → Error
    #[test]
    fn launch_then_llm_error() {
        let (db, _f) = make_meta_db();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        wm_launch_inner(&env, &db, &orch, &reg, "Build me an app").unwrap();

        let r = wm_llm_error_inner(&db, "rate limit exceeded").unwrap();

        assert_eq!(r.wm_state.phase, WmPhase::Error);
        assert!(r
            .wm_state
            .conversation
            .iter()
            .any(|m| m.role == "assistant" && m.content.contains("rate limit")));
        assert!(has_event(&r.events, |e| matches!(
            e,
            WmEvent::ShowError { message, .. } if message.contains("rate limit")
        )));
    }

    // #6 — Follow-up after completed: routes to RunLlm, not ShortCircuit
    #[test]
    fn followup_after_completed() {
        let (db, _f) = make_meta_db();
        db.set_setting("beads_project_path", "/tmp/proj").unwrap();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        let tasks = serde_json::json!([task_json("epic-1", "Build app", "epic", "done"),]);
        env.set_list_response(&tasks.to_string());

        let r1 = wm_launch_inner(&env, &db, &orch, &reg, "Check status").unwrap();
        assert_eq!(r1.wm_state.phase, WmPhase::Completed);
        assert!(has_event(&r1.events, |e| matches!(
            e,
            WmEvent::ShortCircuit { .. }
        )));

        let r2 = wm_handle_message_inner(&env, &db, &orch, &reg, "Open it in browser").unwrap();

        assert_eq!(r2.wm_state.phase, WmPhase::SettingUp);
        assert!(has_event(&r2.events, |e| matches!(
            e,
            WmEvent::RunLlm { .. }
        )));
        assert!(!has_event(&r2.events, |e| matches!(
            e,
            WmEvent::ShortCircuit { .. }
        )));
        assert!(r2
            .wm_state
            .conversation
            .iter()
            .any(|m| m.role == "user" && m.content == "Open it in browser"));
    }

    // #7 — Zombie cleanup during launch
    #[test]
    fn zombie_cleanup_during_launch() {
        let (db, _f) = make_meta_db();
        db.set_setting("beads_project_path", "/tmp/proj").unwrap();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "done"),
            task_json("epic-2", "Build app v2", "epic", "open"),
        ]);
        env.set_list_response(&tasks.to_string());

        let r = wm_launch_inner(&env, &db, &orch, &reg, "Status?").unwrap();

        let closes = env.close_calls();
        assert!(closes
            .iter()
            .any(|c| c.get(1).map(|s| s.as_str()) == Some("epic-2")));
        assert!(has_event(&r.events, |e| matches!(
            e,
            WmEvent::ShortCircuit { .. }
        )));
    }

    // #8 — State persisted to MetaDb
    #[test]
    fn state_persisted_to_metadb() {
        let (db, _f) = make_meta_db();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        let r = wm_launch_inner(&env, &db, &orch, &reg, "Build me an app").unwrap();

        let raw = db.get_setting("wm_state").unwrap().unwrap();
        let loaded: WmState = serde_json::from_str(&raw).unwrap();
        assert_eq!(loaded.phase, r.wm_state.phase);
        assert_eq!(loaded.conversation.len(), r.wm_state.conversation.len());
    }

    // #9 — Recovery: load persisted state
    #[test]
    fn recovery_load_persisted_state() {
        let (db, _f) = make_meta_db();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        wm_launch_inner(&env, &db, &orch, &reg, "Build me an app").unwrap();
        wm_llm_done_inner(&db, &orch, "Done setting up.").unwrap();

        let recovered = load_wm_state(&db);
        assert_eq!(recovered.phase, WmPhase::Monitoring);
        assert_eq!(recovered.conversation.len(), 2); // user + assistant
        assert_eq!(recovered.conversation[0].role, "user");
        assert_eq!(recovered.conversation[1].role, "assistant");
    }

    // #10 — Active agent protects epic from zombie cleanup
    #[test]
    fn active_agent_protects_epic() {
        let (db, _f) = make_meta_db();
        db.set_setting("beads_project_path", "/tmp/proj").unwrap();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        reg.spawn("developer", Some("epic-2".to_string()), None, None)
            .unwrap();

        let tasks = serde_json::json!([
            task_json("epic-1", "Build app", "epic", "done"),
            task_json("epic-2", "Build app v2", "epic", "open"),
        ]);
        env.set_list_response(&tasks.to_string());

        let r = wm_launch_inner(&env, &db, &orch, &reg, "Status?").unwrap();

        let closes = env.close_calls();
        assert!(!closes
            .iter()
            .any(|c| c.get(1).map(|s| s.as_str()) == Some("epic-2")));
        assert_eq!(r.wm_state.phase, WmPhase::SettingUp);
    }

    // #11 — Path detected from prompt when beads_project_path is empty
    #[test]
    fn prompt_path_detection_triggers_inspection() {
        let (db, _f) = make_meta_db();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(".beads")).unwrap();
        let proj_path = tmp.path().to_str().unwrap();

        let tasks = serde_json::json!([
            task_json("epic-1", "Create HTML site", "epic", "done"),
            task_with_parent("task-1", "Create index.html", "task", "done", "epic-1"),
        ]);
        env.set_list_response(&tasks.to_string());

        let prompt = format!("Create a site in {}", proj_path);
        let r = wm_launch_inner(&env, &db, &orch, &reg, &prompt).unwrap();

        assert_eq!(r.wm_state.phase, WmPhase::Completed);
        assert!(has_event(&r.events, |e| matches!(
            e,
            WmEvent::ShortCircuit { .. }
        )));
    }

    // #12 — No .beads dir means prompt path is ignored
    #[test]
    fn prompt_path_without_beads_dir_ignored() {
        let (db, _f) = make_meta_db();
        let orch = OrchestrationState::new();
        let reg = AgentRegistry::new();
        let env = TestWmEnv::new();

        let tmp = tempfile::tempdir().unwrap();
        let proj_path = tmp.path().to_str().unwrap();

        let prompt = format!("Create a site in {}", proj_path);
        let r = wm_launch_inner(&env, &db, &orch, &reg, &prompt).unwrap();

        assert_eq!(r.wm_state.phase, WmPhase::SettingUp);
        assert!(has_event(&r.events, |e| matches!(
            e,
            WmEvent::RunLlm { .. }
        )));
    }
}
