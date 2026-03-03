//! Developer agent execution phases: tracks work phases within the Running lifecycle state.
//!
//! This module provides a secondary state machine that operates within the `Running` state
//! of the main agent lifecycle. It enforces phase-specific tool permissions and tracks
//! progress through Planning → Implementing → Testing → Finalizing.
//!
//! When validation fails, the agent enters Revising phase to address feedback before
//! re-testing and re-submitting for review.

use crate::agent_state_machine::Tool;
use std::collections::HashSet;

/// Execution phases for developer agents within the Running state.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Agent reads files, understands codebase, formulates approach.
    #[default]
    Planning,
    /// Agent writes code, creates/modifies files.
    Implementing,
    /// Agent runs tests, uses browser, validates changes.
    Testing,
    /// Agent prepares diff summary, cleans up, yields for review.
    Finalizing,
    /// Agent fixes issues based on validator feedback (post-validation failure).
    Revising,
}

impl std::fmt::Display for Phase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Phase::Planning => write!(f, "planning"),
            Phase::Implementing => write!(f, "implementing"),
            Phase::Testing => write!(f, "testing"),
            Phase::Finalizing => write!(f, "finalizing"),
            Phase::Revising => write!(f, "revising"),
        }
    }
}

/// Events that trigger phase transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhaseEvent {
    /// Planning is complete, ready to implement (Planning → Implementing).
    PlanComplete,
    /// Implementation is complete, ready to test (Implementing → Testing).
    ImplComplete,
    /// Tests passed, ready to finalize (Testing → Finalizing).
    TestsPassed,
    /// Tests failed, need to fix implementation (Testing → Implementing).
    TestsFailed,
    /// Validation failed, enter revision cycle (Finalizing → Revising).
    /// This is triggered by the orchestration layer when validators reject the work.
    ValidationFailed,
    /// Revision complete, ready to re-test (Revising → Testing).
    RevisionComplete,
    /// Reset to planning phase (any → Planning).
    Reset,
}

/// Enforcement mode for phase-based tool gating.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EnforcementMode {
    /// No enforcement, just tracking (telemetry only).
    #[default]
    Passive,
    /// Log warnings but allow tool calls.
    Soft,
    /// Reject tool calls that violate phase permissions.
    Hard,
}

/// Attempt a phase transition. Returns the new phase or an error explaining why it's illegal.
pub fn try_phase_transition(current: Phase, event: PhaseEvent) -> Result<Phase, String> {
    match (current, event) {
        // Normal forward flow
        (Phase::Planning, PhaseEvent::PlanComplete) => Ok(Phase::Implementing),
        (Phase::Implementing, PhaseEvent::ImplComplete) => Ok(Phase::Testing),
        (Phase::Testing, PhaseEvent::TestsPassed) => Ok(Phase::Finalizing),

        // Test failure loops back to implementing
        (Phase::Testing, PhaseEvent::TestsFailed) => Ok(Phase::Implementing),

        // Validation failure triggers revision cycle.
        // This happens when the agent was in Finalizing, yielded for review,
        // and the validator rejected the work. The lifecycle state machine
        // transitions from InReview back to Running, and we enter Revising.
        (Phase::Finalizing, PhaseEvent::ValidationFailed) => Ok(Phase::Revising),

        // After revising, go back to testing to verify fixes
        (Phase::Revising, PhaseEvent::RevisionComplete) => Ok(Phase::Testing),

        // Reset is always allowed
        (_, PhaseEvent::Reset) => Ok(Phase::Planning),

        // Illegal transitions
        _ => Err(format!(
            "Illegal phase transition: {} + {:?}",
            current, event
        )),
    }
}

/// Tools permitted for each phase.
/// This is more restrictive than the role-level permissions in agent_state_machine.
pub fn phase_tools(phase: Phase) -> HashSet<Tool> {
    match phase {
        Phase::Planning => {
            // Planning: read-only operations
            [Tool::ReadFile, Tool::TerminalExec].into_iter().collect()
        }
        Phase::Implementing => {
            // Implementing: read + write + terminal
            [Tool::ReadFile, Tool::WriteFile, Tool::TerminalExec]
                .into_iter()
                .collect()
        }
        Phase::Testing => {
            // Testing: read + terminal + browser (no new writes)
            [
                Tool::ReadFile,
                Tool::TerminalExec,
                Tool::BrowserEnsureStarted,
            ]
            .into_iter()
            .collect()
        }
        Phase::Finalizing => {
            // Finalizing: read-only, preparing for yield
            [Tool::ReadFile].into_iter().collect()
        }
        Phase::Revising => {
            // Revising: same as Implementing - agent needs to make fixes
            // based on validator feedback
            [Tool::ReadFile, Tool::WriteFile, Tool::TerminalExec]
                .into_iter()
                .collect()
        }
    }
}

/// Check whether a tool is allowed in the given phase.
/// Returns Ok(()) if allowed, Err with reason if not.
///
/// Note: This should be called AFTER the role-level check in agent_state_machine.
/// A tool must pass both checks to be allowed.
pub fn gate_tool_for_phase(phase: Phase, tool: Tool, mode: EnforcementMode) -> Result<(), String> {
    let allowed = phase_tools(phase);

    if allowed.contains(&tool) {
        return Ok(());
    }

    let msg = format!(
        "Tool {:?} not permitted in {} phase. Allowed tools: {:?}",
        tool, phase, allowed
    );

    match mode {
        EnforcementMode::Passive => {
            // Just log, don't block
            eprintln!("[phase-telemetry] {}", msg);
            Ok(())
        }
        EnforcementMode::Soft => {
            // Log warning but allow
            eprintln!("[phase-soft] {}", msg);
            Ok(())
        }
        EnforcementMode::Hard => {
            // Reject the tool call
            Err(msg)
        }
    }
}

/// Suggested phase based on tool usage patterns.
/// Can be used to auto-detect phase transitions.
pub fn suggest_phase_from_tool(tool: Tool, current_phase: Phase) -> Option<PhaseEvent> {
    match (current_phase, tool) {
        // If in Planning and write_file is called, suggest transitioning to Implementing
        (Phase::Planning, Tool::WriteFile) => Some(PhaseEvent::PlanComplete),

        // If in Implementing and browser is used, suggest transitioning to Testing
        (Phase::Implementing, Tool::BrowserEnsureStarted) => Some(PhaseEvent::ImplComplete),

        _ => None,
    }
}

/// Default token budget allocation per phase (as percentage of total quota).
/// Planning: 10%, Implementing: 40%, Testing: 20%, Finalizing: 5%, Revising: 25%
///
/// Note: Revising gets a significant budget because validation failures may require
/// substantial rework. The budget is drawn from a "revision reserve" that's only
/// used when validation fails.
pub fn default_phase_budget_percentages() -> [(Phase, u8); 5] {
    [
        (Phase::Planning, 10),
        (Phase::Implementing, 40),
        (Phase::Testing, 20),
        (Phase::Finalizing, 5),
        (Phase::Revising, 25),
    ]
}

/// Calculate phase-specific token budgets from total quota.
pub fn calculate_phase_budgets(total_quota: u64) -> [(Phase, u64); 5] {
    let percentages = default_phase_budget_percentages();
    percentages.map(|(phase, pct)| (phase, (total_quota * pct as u64) / 100))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planning_to_implementing() {
        let result = try_phase_transition(Phase::Planning, PhaseEvent::PlanComplete);
        assert_eq!(result.unwrap(), Phase::Implementing);
    }

    #[test]
    fn implementing_to_testing() {
        let result = try_phase_transition(Phase::Implementing, PhaseEvent::ImplComplete);
        assert_eq!(result.unwrap(), Phase::Testing);
    }

    #[test]
    fn testing_to_finalizing() {
        let result = try_phase_transition(Phase::Testing, PhaseEvent::TestsPassed);
        assert_eq!(result.unwrap(), Phase::Finalizing);
    }

    #[test]
    fn test_failure_loops_back() {
        let result = try_phase_transition(Phase::Testing, PhaseEvent::TestsFailed);
        assert_eq!(result.unwrap(), Phase::Implementing);
    }

    #[test]
    fn validation_failure_enters_revising() {
        let result = try_phase_transition(Phase::Finalizing, PhaseEvent::ValidationFailed);
        assert_eq!(result.unwrap(), Phase::Revising);
    }

    #[test]
    fn revision_complete_returns_to_testing() {
        let result = try_phase_transition(Phase::Revising, PhaseEvent::RevisionComplete);
        assert_eq!(result.unwrap(), Phase::Testing);
    }

    #[test]
    fn full_revision_cycle() {
        // Simulate a full cycle: Finalizing → ValidationFailed → Revising → Testing → Finalizing
        let mut phase = Phase::Finalizing;

        // Validation fails
        phase = try_phase_transition(phase, PhaseEvent::ValidationFailed).unwrap();
        assert_eq!(phase, Phase::Revising);

        // Agent fixes issues
        phase = try_phase_transition(phase, PhaseEvent::RevisionComplete).unwrap();
        assert_eq!(phase, Phase::Testing);

        // Tests pass again
        phase = try_phase_transition(phase, PhaseEvent::TestsPassed).unwrap();
        assert_eq!(phase, Phase::Finalizing);
    }

    #[test]
    fn reset_from_any_phase() {
        for phase in [
            Phase::Planning,
            Phase::Implementing,
            Phase::Testing,
            Phase::Finalizing,
            Phase::Revising,
        ] {
            let result = try_phase_transition(phase, PhaseEvent::Reset);
            assert_eq!(result.unwrap(), Phase::Planning);
        }
    }

    #[test]
    fn illegal_transition_rejected() {
        // Can't go from Planning directly to Testing
        let result = try_phase_transition(Phase::Planning, PhaseEvent::TestsPassed);
        assert!(result.is_err());
    }

    #[test]
    fn validation_failed_only_from_finalizing() {
        // ValidationFailed should only work from Finalizing
        for phase in [
            Phase::Planning,
            Phase::Implementing,
            Phase::Testing,
            Phase::Revising,
        ] {
            let result = try_phase_transition(phase, PhaseEvent::ValidationFailed);
            assert!(
                result.is_err(),
                "ValidationFailed should not work from {:?}",
                phase
            );
        }
    }

    #[test]
    fn planning_allows_read_file() {
        let tools = phase_tools(Phase::Planning);
        assert!(tools.contains(&Tool::ReadFile));
    }

    #[test]
    fn planning_disallows_write_file() {
        let tools = phase_tools(Phase::Planning);
        assert!(!tools.contains(&Tool::WriteFile));
    }

    #[test]
    fn implementing_allows_write_file() {
        let tools = phase_tools(Phase::Implementing);
        assert!(tools.contains(&Tool::WriteFile));
    }

    #[test]
    fn testing_allows_browser() {
        let tools = phase_tools(Phase::Testing);
        assert!(tools.contains(&Tool::BrowserEnsureStarted));
    }

    #[test]
    fn testing_disallows_write_file() {
        let tools = phase_tools(Phase::Testing);
        assert!(!tools.contains(&Tool::WriteFile));
    }

    #[test]
    fn finalizing_is_read_only() {
        let tools = phase_tools(Phase::Finalizing);
        assert!(tools.contains(&Tool::ReadFile));
        assert!(!tools.contains(&Tool::WriteFile));
        assert!(!tools.contains(&Tool::TerminalExec));
        assert!(!tools.contains(&Tool::BrowserEnsureStarted));
    }

    #[test]
    fn revising_allows_write_file() {
        let tools = phase_tools(Phase::Revising);
        assert!(tools.contains(&Tool::ReadFile));
        assert!(tools.contains(&Tool::WriteFile));
        assert!(tools.contains(&Tool::TerminalExec));
    }

    #[test]
    fn revising_disallows_browser() {
        // Revising is for code fixes, not visual testing
        let tools = phase_tools(Phase::Revising);
        assert!(!tools.contains(&Tool::BrowserEnsureStarted));
    }

    #[test]
    fn hard_enforcement_rejects_invalid_tool() {
        let result = gate_tool_for_phase(Phase::Planning, Tool::WriteFile, EnforcementMode::Hard);
        assert!(result.is_err());
    }

    #[test]
    fn soft_enforcement_allows_invalid_tool() {
        let result = gate_tool_for_phase(Phase::Planning, Tool::WriteFile, EnforcementMode::Soft);
        assert!(result.is_ok());
    }

    #[test]
    fn passive_enforcement_allows_invalid_tool() {
        let result =
            gate_tool_for_phase(Phase::Planning, Tool::WriteFile, EnforcementMode::Passive);
        assert!(result.is_ok());
    }

    #[test]
    fn suggest_phase_detects_write_in_planning() {
        let suggestion = suggest_phase_from_tool(Tool::WriteFile, Phase::Planning);
        assert_eq!(suggestion, Some(PhaseEvent::PlanComplete));
    }

    #[test]
    fn suggest_phase_detects_browser_in_implementing() {
        let suggestion = suggest_phase_from_tool(Tool::BrowserEnsureStarted, Phase::Implementing);
        assert_eq!(suggestion, Some(PhaseEvent::ImplComplete));
    }

    #[test]
    fn phase_budgets_sum_to_100_percent() {
        let percentages = default_phase_budget_percentages();
        let total: u8 = percentages.iter().map(|(_, pct)| pct).sum();
        assert_eq!(total, 100);
    }

    #[test]
    fn calculate_budgets_distributes_quota() {
        let budgets = calculate_phase_budgets(100_000);
        assert_eq!(budgets[0], (Phase::Planning, 10_000));
        assert_eq!(budgets[1], (Phase::Implementing, 40_000));
        assert_eq!(budgets[2], (Phase::Testing, 20_000));
        assert_eq!(budgets[3], (Phase::Finalizing, 5_000));
        assert_eq!(budgets[4], (Phase::Revising, 25_000));
    }

    #[test]
    fn phase_display() {
        assert_eq!(format!("{}", Phase::Planning), "planning");
        assert_eq!(format!("{}", Phase::Implementing), "implementing");
        assert_eq!(format!("{}", Phase::Testing), "testing");
        assert_eq!(format!("{}", Phase::Finalizing), "finalizing");
        assert_eq!(format!("{}", Phase::Revising), "revising");
    }

    #[test]
    fn phase_default_is_planning() {
        assert_eq!(Phase::default(), Phase::Planning);
    }
}
