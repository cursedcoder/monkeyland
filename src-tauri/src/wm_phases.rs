//! Workforce Manager agent execution phases: tracks conversational lifecycle.
//!
//! This module provides a secondary state machine that operates within the `Running` state
//! of the main agent lifecycle for WM agents. It tracks the WM's conversational flow from
//! initial request through project setup, planning, execution monitoring, and conclusion.
//!
//! Unlike developers and PMs, the WM maintains a persistent conversation and can cycle
//! between phases as the user makes follow-up requests.

/// Execution phases for workforce manager agents within the Running state.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum WMPhase {
    /// Initial state: WM has just been spawned, ready to receive first request.
    #[default]
    Initial,
    /// WM is inspecting existing project state before acting.
    Inspecting,
    /// WM is setting up a new project (opening with Beads, etc.).
    ProjectSetup,
    /// WM is working with PM to create tasks and plan the work.
    Planning,
    /// Agents are actively working; WM monitors progress.
    Executing,
    /// WM is actively monitoring running agents and responding to status queries.
    Monitoring,
    /// WM is intervening in the workflow (pausing, reprioritizing, micromanaging).
    Intervening,
    /// Work is complete or user has ended the session.
    Concluding,
}

impl std::fmt::Display for WMPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WMPhase::Initial => write!(f, "initial"),
            WMPhase::Inspecting => write!(f, "inspecting"),
            WMPhase::ProjectSetup => write!(f, "project_setup"),
            WMPhase::Planning => write!(f, "planning"),
            WMPhase::Executing => write!(f, "executing"),
            WMPhase::Monitoring => write!(f, "monitoring"),
            WMPhase::Intervening => write!(f, "intervening"),
            WMPhase::Concluding => write!(f, "concluding"),
        }
    }
}

/// Events that trigger WM phase transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WMPhaseEvent {
    /// User sends initial request, WM starts project setup (Initial → ProjectSetup).
    StartProject,
    /// Project opened, WM begins planning (ProjectSetup → Planning).
    ProjectReady,
    /// Planning complete, agents start execution (Planning → Executing).
    StartExecution,
    /// Execution started, WM enters monitoring (Executing → Monitoring).
    BeginMonitoring,
    /// User requests intervention (Monitoring → Intervening).
    UserIntervenes,
    /// Intervention complete, return to monitoring (Intervening → Monitoring).
    InterventionComplete,
    /// All work done or user ends session (any → Concluding).
    Conclude,
    /// User starts a new request/project (any → Initial or ProjectSetup).
    NewRequest,
    /// User asks an informational question (stays in current phase).
    InformationalQuery,
}

/// Attempt a WM phase transition. Returns the new phase or an error explaining why it's illegal.
/// Note: WM transitions are more flexible than other roles since the conversation is persistent.
pub fn try_wm_phase_transition(current: WMPhase, event: WMPhaseEvent) -> Result<WMPhase, String> {
    match (current, event) {
        // Initial -> Inspecting (or ProjectSetup) when user sends first request
        (WMPhase::Initial, WMPhaseEvent::StartProject) => Ok(WMPhase::Inspecting),

        // Inspecting -> ProjectSetup after inspection completes
        (WMPhase::Inspecting, WMPhaseEvent::ProjectReady) => Ok(WMPhase::ProjectSetup),
        (WMPhase::Inspecting, WMPhaseEvent::StartExecution) => Ok(WMPhase::Executing),
        (WMPhase::Inspecting, WMPhaseEvent::BeginMonitoring) => Ok(WMPhase::Monitoring),

        // ProjectSetup -> Planning when project is opened
        (WMPhase::ProjectSetup, WMPhaseEvent::ProjectReady) => Ok(WMPhase::Planning),

        // Planning -> Executing when tasks are ready and orchestration starts
        (WMPhase::Planning, WMPhaseEvent::StartExecution) => Ok(WMPhase::Executing),

        // Executing -> Monitoring when agents start working
        (WMPhase::Executing, WMPhaseEvent::BeginMonitoring) => Ok(WMPhase::Monitoring),

        // Monitoring -> Intervening when user requests changes
        (WMPhase::Monitoring, WMPhaseEvent::UserIntervenes) => Ok(WMPhase::Intervening),

        // Intervening -> Monitoring when intervention is complete
        (WMPhase::Intervening, WMPhaseEvent::InterventionComplete) => Ok(WMPhase::Monitoring),

        // Any phase -> Concluding when work is done
        (_, WMPhaseEvent::Conclude) => Ok(WMPhase::Concluding),

        // Informational queries don't change phase
        (phase, WMPhaseEvent::InformationalQuery) => Ok(phase),

        // Allow direct transitions for flexibility (WM is conversational)
        // ProjectSetup can go to Executing if no project needed (quick dispatch)
        (WMPhase::ProjectSetup, WMPhaseEvent::StartExecution) => Ok(WMPhase::Executing),

        // Monitoring can go back to Planning if user wants to add more tasks
        (WMPhase::Monitoring, WMPhaseEvent::NewRequest) => Ok(WMPhase::Planning),

        // NewRequest can restart the flow from most phases (except monitoring which goes to planning)
        (_, WMPhaseEvent::NewRequest) => Ok(WMPhase::ProjectSetup),

        // Illegal transitions
        _ => Err(format!(
            "Illegal WM phase transition: {} + {:?}",
            current, event
        )),
    }
}

/// Tool names permitted for each WM phase.
/// WM has broad tool access across most phases since it orchestrates other agents.
/// Returns tool names as strings (matching frontend plugin names).
pub fn wm_phase_tools(phase: WMPhase) -> Vec<&'static str> {
    match phase {
        WMPhase::Initial => {
            // Initial: waiting for request, limited tools
            vec![]
        }
        WMPhase::Inspecting => {
            // Inspecting: code-level inspection runs, no LLM tools needed
            vec![]
        }
        WMPhase::ProjectSetup => {
            // ProjectSetup: can open projects and read files
            vec!["open_project_with_beads", "read_file"]
        }
        WMPhase::Planning => {
            // Planning: can create tasks, dispatch agents, read files
            vec![
                "create_beads_task",
                "update_beads_task",
                "dispatch_agent",
                "read_file",
            ]
        }
        WMPhase::Executing => {
            // Executing: orchestration control tools
            vec![
                "pause_orchestration",
                "resume_orchestration",
                "get_orchestration_status",
                "dispatch_agent",
            ]
        }
        WMPhase::Monitoring => {
            // Monitoring: status queries and light intervention
            vec![
                "get_orchestration_status",
                "pause_orchestration",
                "resume_orchestration",
                "message_agent",
            ]
        }
        WMPhase::Intervening => {
            // Intervening: full control including cancellation and micromanagement
            vec![
                "pause_orchestration",
                "resume_orchestration",
                "cancel_task",
                "message_agent",
                "reprioritize_task",
                "get_orchestration_status",
                "create_beads_task",
                "update_beads_task",
            ]
        }
        WMPhase::Concluding => {
            // Concluding: read-only status
            vec!["get_orchestration_status"]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_to_inspecting() {
        let result = try_wm_phase_transition(WMPhase::Initial, WMPhaseEvent::StartProject);
        assert_eq!(result, Ok(WMPhase::Inspecting));
    }

    #[test]
    fn inspecting_to_project_setup() {
        let result = try_wm_phase_transition(WMPhase::Inspecting, WMPhaseEvent::ProjectReady);
        assert_eq!(result, Ok(WMPhase::ProjectSetup));
    }

    #[test]
    fn inspecting_to_monitoring() {
        let result = try_wm_phase_transition(WMPhase::Inspecting, WMPhaseEvent::BeginMonitoring);
        assert_eq!(result, Ok(WMPhase::Monitoring));
    }

    #[test]
    fn project_setup_to_planning() {
        let result = try_wm_phase_transition(WMPhase::ProjectSetup, WMPhaseEvent::ProjectReady);
        assert_eq!(result, Ok(WMPhase::Planning));
    }

    #[test]
    fn planning_to_executing() {
        let result = try_wm_phase_transition(WMPhase::Planning, WMPhaseEvent::StartExecution);
        assert_eq!(result, Ok(WMPhase::Executing));
    }

    #[test]
    fn executing_to_monitoring() {
        let result = try_wm_phase_transition(WMPhase::Executing, WMPhaseEvent::BeginMonitoring);
        assert_eq!(result, Ok(WMPhase::Monitoring));
    }

    #[test]
    fn monitoring_to_intervening() {
        let result = try_wm_phase_transition(WMPhase::Monitoring, WMPhaseEvent::UserIntervenes);
        assert_eq!(result, Ok(WMPhase::Intervening));
    }

    #[test]
    fn intervening_to_monitoring() {
        let result =
            try_wm_phase_transition(WMPhase::Intervening, WMPhaseEvent::InterventionComplete);
        assert_eq!(result, Ok(WMPhase::Monitoring));
    }

    #[test]
    fn any_phase_can_conclude() {
        for phase in [
            WMPhase::Initial,
            WMPhase::Inspecting,
            WMPhase::ProjectSetup,
            WMPhase::Planning,
            WMPhase::Executing,
            WMPhase::Monitoring,
            WMPhase::Intervening,
        ] {
            let result = try_wm_phase_transition(phase, WMPhaseEvent::Conclude);
            assert_eq!(
                result,
                Ok(WMPhase::Concluding),
                "Failed for phase: {}",
                phase
            );
        }
    }

    #[test]
    fn informational_query_preserves_phase() {
        for phase in [
            WMPhase::Planning,
            WMPhase::Executing,
            WMPhase::Monitoring,
            WMPhase::Intervening,
        ] {
            let result = try_wm_phase_transition(phase, WMPhaseEvent::InformationalQuery);
            assert_eq!(result, Ok(phase), "Failed for phase: {}", phase);
        }
    }

    #[test]
    fn wm_phase_tools_not_empty_except_initial_and_inspecting() {
        assert!(wm_phase_tools(WMPhase::Initial).is_empty());
        assert!(wm_phase_tools(WMPhase::Inspecting).is_empty());
        assert!(!wm_phase_tools(WMPhase::ProjectSetup).is_empty());
        assert!(!wm_phase_tools(WMPhase::Planning).is_empty());
        assert!(!wm_phase_tools(WMPhase::Executing).is_empty());
        assert!(!wm_phase_tools(WMPhase::Monitoring).is_empty());
        assert!(!wm_phase_tools(WMPhase::Intervening).is_empty());
        assert!(!wm_phase_tools(WMPhase::Concluding).is_empty());
    }

    #[test]
    fn intervening_has_most_tools() {
        let intervening_tools = wm_phase_tools(WMPhase::Intervening);
        let monitoring_tools = wm_phase_tools(WMPhase::Monitoring);
        assert!(intervening_tools.len() > monitoring_tools.len());
    }
}
