//! Project Manager agent execution phases: tracks work phases within the Running lifecycle state.
//!
//! This module provides a secondary state machine that operates within the `Running` state
//! of the main agent lifecycle for PM agents. It enforces phase-specific tool permissions
//! and tracks progress through Exploration → TaskDrafting → DependencyReview → Finalization.
//!
//! When validation fails, the agent enters Revising phase to address feedback before
//! re-reviewing dependencies and re-submitting for review.

use crate::agent_state_machine::Tool;
use crate::developer_phases::EnforcementMode;
use std::collections::HashSet;

/// Execution phases for project manager agents within the Running state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PMPhase {
    /// PM reads files, understands codebase and epic requirements.
    Exploration,
    /// PM creates tasks with deferred status (hidden from bd ready).
    TaskDrafting,
    /// PM reviews and confirms dependencies for all tasks.
    DependencyReview,
    /// PM prepares to yield for validation review.
    Finalization,
    /// PM fixes task breakdown based on validator feedback (post-validation failure).
    Revising,
}

impl Default for PMPhase {
    fn default() -> Self {
        PMPhase::Exploration
    }
}

impl std::fmt::Display for PMPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PMPhase::Exploration => write!(f, "exploration"),
            PMPhase::TaskDrafting => write!(f, "task_drafting"),
            PMPhase::DependencyReview => write!(f, "dependency_review"),
            PMPhase::Finalization => write!(f, "finalization"),
            PMPhase::Revising => write!(f, "revising"),
        }
    }
}

/// Events that trigger PM phase transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PMPhaseEvent {
    /// Exploration is complete, ready to create tasks (Exploration → TaskDrafting).
    ExplorationComplete,
    /// All tasks created, ready to review dependencies (TaskDrafting → DependencyReview).
    DraftingComplete,
    /// Need to create more tasks (DependencyReview → TaskDrafting).
    NeedsMoreTasks,
    /// Dependencies reviewed, ready to finalize (DependencyReview → Finalization).
    ReviewComplete,
    /// Validation failed, enter revision cycle (Finalization → Revising).
    ValidationFailed,
    /// Revision complete, ready to re-review dependencies (Revising → DependencyReview).
    RevisionComplete,
    /// Reset to exploration phase (any → Exploration).
    Reset,
}

/// Attempt a PM phase transition. Returns the new phase or an error explaining why it's illegal.
pub fn try_pm_phase_transition(current: PMPhase, event: PMPhaseEvent) -> Result<PMPhase, String> {
    match (current, event) {
        // Normal forward flow
        (PMPhase::Exploration, PMPhaseEvent::ExplorationComplete) => Ok(PMPhase::TaskDrafting),
        (PMPhase::TaskDrafting, PMPhaseEvent::DraftingComplete) => Ok(PMPhase::DependencyReview),
        (PMPhase::DependencyReview, PMPhaseEvent::ReviewComplete) => Ok(PMPhase::Finalization),

        // Back to drafting if more tasks needed
        (PMPhase::DependencyReview, PMPhaseEvent::NeedsMoreTasks) => Ok(PMPhase::TaskDrafting),

        // Validation failure triggers revision cycle
        (PMPhase::Finalization, PMPhaseEvent::ValidationFailed) => Ok(PMPhase::Revising),

        // After revising, go back to dependency review
        (PMPhase::Revising, PMPhaseEvent::RevisionComplete) => Ok(PMPhase::DependencyReview),

        // Reset is always allowed
        (_, PMPhaseEvent::Reset) => Ok(PMPhase::Exploration),

        // Illegal transitions
        _ => Err(format!(
            "Illegal PM phase transition: {} + {:?}",
            current, event
        )),
    }
}

/// Tools permitted for each PM phase.
/// This is more restrictive than the role-level permissions in agent_state_machine.
pub fn pm_phase_tools(phase: PMPhase) -> HashSet<Tool> {
    match phase {
        PMPhase::Exploration => {
            // Exploration: read-only operations
            [Tool::ReadFile].into_iter().collect()
        }
        PMPhase::TaskDrafting => {
            // TaskDrafting: read + create tasks (via BeadsRun)
            [Tool::ReadFile, Tool::BeadsRun].into_iter().collect()
        }
        PMPhase::DependencyReview => {
            // DependencyReview: update tasks only (via BeadsRun)
            [Tool::ReadFile, Tool::BeadsRun].into_iter().collect()
        }
        PMPhase::Finalization => {
            // Finalization: read-only, preparing for yield
            [Tool::ReadFile].into_iter().collect()
        }
        PMPhase::Revising => {
            // Revising: can create new tasks or update existing ones
            [Tool::ReadFile, Tool::BeadsRun].into_iter().collect()
        }
    }
}

/// Check whether a tool is allowed in the given PM phase.
/// Returns Ok(()) if allowed, Err with reason if not.
///
/// Note: This should be called AFTER the role-level check in agent_state_machine.
/// A tool must pass both checks to be allowed.
pub fn gate_tool_for_pm_phase(
    phase: PMPhase,
    tool: Tool,
    mode: EnforcementMode,
) -> Result<(), String> {
    let allowed = pm_phase_tools(phase);

    if allowed.contains(&tool) {
        return Ok(());
    }

    let msg = format!(
        "Tool {:?} not permitted in PM {} phase. Allowed tools: {:?}",
        tool, phase, allowed
    );

    match mode {
        EnforcementMode::Passive => {
            eprintln!("[pm-phase-telemetry] {}", msg);
            Ok(())
        }
        EnforcementMode::Soft => {
            eprintln!("[pm-phase-soft] {}", msg);
            Ok(())
        }
        EnforcementMode::Hard => Err(msg),
    }
}

/// Suggested PM phase based on tool usage patterns.
/// Can be used to auto-detect phase transitions.
pub fn suggest_pm_phase_from_tool(tool: Tool, current_phase: PMPhase) -> Option<PMPhaseEvent> {
    match (current_phase, tool) {
        // If in Exploration and BeadsRun is called (creating a task), suggest transitioning
        (PMPhase::Exploration, Tool::BeadsRun) => Some(PMPhaseEvent::ExplorationComplete),

        _ => None,
    }
}

/// Default token budget allocation per PM phase (as percentage of total quota).
/// Exploration: 15%, TaskDrafting: 35%, DependencyReview: 20%, Finalization: 5%, Revising: 25%
pub fn default_pm_phase_budget_percentages() -> [(PMPhase, u8); 5] {
    [
        (PMPhase::Exploration, 15),
        (PMPhase::TaskDrafting, 35),
        (PMPhase::DependencyReview, 20),
        (PMPhase::Finalization, 5),
        (PMPhase::Revising, 25),
    ]
}

/// Calculate PM phase-specific token budgets from total quota.
pub fn calculate_pm_phase_budgets(total_quota: u64) -> [(PMPhase, u64); 5] {
    let percentages = default_pm_phase_budget_percentages();
    percentages.map(|(phase, pct)| (phase, (total_quota * pct as u64) / 100))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exploration_to_task_drafting() {
        let result =
            try_pm_phase_transition(PMPhase::Exploration, PMPhaseEvent::ExplorationComplete);
        assert_eq!(result.unwrap(), PMPhase::TaskDrafting);
    }

    #[test]
    fn task_drafting_to_dependency_review() {
        let result = try_pm_phase_transition(PMPhase::TaskDrafting, PMPhaseEvent::DraftingComplete);
        assert_eq!(result.unwrap(), PMPhase::DependencyReview);
    }

    #[test]
    fn dependency_review_to_finalization() {
        let result =
            try_pm_phase_transition(PMPhase::DependencyReview, PMPhaseEvent::ReviewComplete);
        assert_eq!(result.unwrap(), PMPhase::Finalization);
    }

    #[test]
    fn dependency_review_back_to_drafting() {
        let result =
            try_pm_phase_transition(PMPhase::DependencyReview, PMPhaseEvent::NeedsMoreTasks);
        assert_eq!(result.unwrap(), PMPhase::TaskDrafting);
    }

    #[test]
    fn validation_failure_enters_revising() {
        let result = try_pm_phase_transition(PMPhase::Finalization, PMPhaseEvent::ValidationFailed);
        assert_eq!(result.unwrap(), PMPhase::Revising);
    }

    #[test]
    fn revision_complete_returns_to_dependency_review() {
        let result = try_pm_phase_transition(PMPhase::Revising, PMPhaseEvent::RevisionComplete);
        assert_eq!(result.unwrap(), PMPhase::DependencyReview);
    }

    #[test]
    fn full_revision_cycle() {
        let mut phase = PMPhase::Finalization;

        // Validation fails
        phase = try_pm_phase_transition(phase, PMPhaseEvent::ValidationFailed).unwrap();
        assert_eq!(phase, PMPhase::Revising);

        // PM fixes issues
        phase = try_pm_phase_transition(phase, PMPhaseEvent::RevisionComplete).unwrap();
        assert_eq!(phase, PMPhase::DependencyReview);

        // Review passes
        phase = try_pm_phase_transition(phase, PMPhaseEvent::ReviewComplete).unwrap();
        assert_eq!(phase, PMPhase::Finalization);
    }

    #[test]
    fn reset_from_any_phase() {
        for phase in [
            PMPhase::Exploration,
            PMPhase::TaskDrafting,
            PMPhase::DependencyReview,
            PMPhase::Finalization,
            PMPhase::Revising,
        ] {
            let result = try_pm_phase_transition(phase, PMPhaseEvent::Reset);
            assert_eq!(result.unwrap(), PMPhase::Exploration);
        }
    }

    #[test]
    fn illegal_transition_rejected() {
        // Can't go from Exploration directly to Finalization
        let result = try_pm_phase_transition(PMPhase::Exploration, PMPhaseEvent::ReviewComplete);
        assert!(result.is_err());
    }

    #[test]
    fn validation_failed_only_from_finalization() {
        for phase in [
            PMPhase::Exploration,
            PMPhase::TaskDrafting,
            PMPhase::DependencyReview,
            PMPhase::Revising,
        ] {
            let result = try_pm_phase_transition(phase, PMPhaseEvent::ValidationFailed);
            assert!(
                result.is_err(),
                "ValidationFailed should not work from {:?}",
                phase
            );
        }
    }

    #[test]
    fn exploration_allows_read_file() {
        let tools = pm_phase_tools(PMPhase::Exploration);
        assert!(tools.contains(&Tool::ReadFile));
    }

    #[test]
    fn exploration_disallows_beads_run() {
        let tools = pm_phase_tools(PMPhase::Exploration);
        assert!(!tools.contains(&Tool::BeadsRun));
    }

    #[test]
    fn task_drafting_allows_beads_run() {
        let tools = pm_phase_tools(PMPhase::TaskDrafting);
        assert!(tools.contains(&Tool::BeadsRun));
    }

    #[test]
    fn dependency_review_allows_beads_run() {
        let tools = pm_phase_tools(PMPhase::DependencyReview);
        assert!(tools.contains(&Tool::BeadsRun));
    }

    #[test]
    fn finalization_is_read_only() {
        let tools = pm_phase_tools(PMPhase::Finalization);
        assert!(tools.contains(&Tool::ReadFile));
        assert!(!tools.contains(&Tool::BeadsRun));
    }

    #[test]
    fn revising_allows_beads_run() {
        let tools = pm_phase_tools(PMPhase::Revising);
        assert!(tools.contains(&Tool::ReadFile));
        assert!(tools.contains(&Tool::BeadsRun));
    }

    #[test]
    fn hard_enforcement_rejects_invalid_tool() {
        let result =
            gate_tool_for_pm_phase(PMPhase::Exploration, Tool::BeadsRun, EnforcementMode::Hard);
        assert!(result.is_err());
    }

    #[test]
    fn soft_enforcement_allows_invalid_tool() {
        let result =
            gate_tool_for_pm_phase(PMPhase::Exploration, Tool::BeadsRun, EnforcementMode::Soft);
        assert!(result.is_ok());
    }

    #[test]
    fn passive_enforcement_allows_invalid_tool() {
        let result = gate_tool_for_pm_phase(
            PMPhase::Exploration,
            Tool::BeadsRun,
            EnforcementMode::Passive,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn suggest_phase_detects_beads_run_in_exploration() {
        let suggestion = suggest_pm_phase_from_tool(Tool::BeadsRun, PMPhase::Exploration);
        assert_eq!(suggestion, Some(PMPhaseEvent::ExplorationComplete));
    }

    #[test]
    fn pm_phase_budgets_sum_to_100_percent() {
        let percentages = default_pm_phase_budget_percentages();
        let total: u8 = percentages.iter().map(|(_, pct)| pct).sum();
        assert_eq!(total, 100);
    }

    #[test]
    fn calculate_pm_budgets_distributes_quota() {
        let budgets = calculate_pm_phase_budgets(100_000);
        assert_eq!(budgets[0], (PMPhase::Exploration, 15_000));
        assert_eq!(budgets[1], (PMPhase::TaskDrafting, 35_000));
        assert_eq!(budgets[2], (PMPhase::DependencyReview, 20_000));
        assert_eq!(budgets[3], (PMPhase::Finalization, 5_000));
        assert_eq!(budgets[4], (PMPhase::Revising, 25_000));
    }

    #[test]
    fn pm_phase_display() {
        assert_eq!(format!("{}", PMPhase::Exploration), "exploration");
        assert_eq!(format!("{}", PMPhase::TaskDrafting), "task_drafting");
        assert_eq!(
            format!("{}", PMPhase::DependencyReview),
            "dependency_review"
        );
        assert_eq!(format!("{}", PMPhase::Finalization), "finalization");
        assert_eq!(format!("{}", PMPhase::Revising), "revising");
    }

    #[test]
    fn pm_phase_default_is_exploration() {
        assert_eq!(PMPhase::default(), PMPhase::Exploration);
    }
}
