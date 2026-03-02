//! Agent registry: track spawned agents, TTL, token quotas, and parent-child relationship.
//! All state transitions and tool access go through the state machine.

use crate::agent_state_machine::{self, Event, State, Tool};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Role-specific limits (from plan §3).
#[derive(Debug, Clone)]
pub struct RoleConfig {
    pub ttl_secs: u64,
    pub token_quota: u64,
    pub max_children: u32,
    pub max_count: u32,
}

impl Default for RoleConfig {
    fn default() -> Self {
        Self {
            ttl_secs: 3600,
            token_quota: 500_000,
            max_children: 10,
            max_count: 20,
        }
    }
}

fn default_role_configs() -> HashMap<String, RoleConfig> {
    let mut m = HashMap::new();
    m.insert(
        "workforce_manager".to_string(),
        RoleConfig {
            ttl_secs: 3600,
            token_quota: 500_000,
            max_children: 10,
            max_count: 1,
        },
    );
    m.insert(
        "project_manager".to_string(),
        RoleConfig {
            ttl_secs: 3600,
            token_quota: 500_000,
            max_children: 10,
            max_count: 5,
        },
    );
    m.insert(
        "developer".to_string(),
        RoleConfig {
            ttl_secs: 900,
            token_quota: 200_000,
            max_children: 20,
            max_count: 20,
        },
    );
    m.insert(
        "worker".to_string(),
        RoleConfig {
            ttl_secs: 120,
            token_quota: 10_000,
            max_children: 0,
            max_count: 80,
        },
    );
    m.insert(
        "operator".to_string(),
        RoleConfig {
            ttl_secs: 300,
            token_quota: 50_000,
            max_children: 0,
            max_count: 10,
        },
    );
    m.insert(
        "validator".to_string(),
        RoleConfig {
            ttl_secs: 300,
            token_quota: 50_000,
            max_children: 0,
            max_count: 15,
        },
    );
    m.insert(
        "merge_agent".to_string(),
        RoleConfig {
            ttl_secs: 300,
            token_quota: 100_000,
            max_children: 0,
            max_count: 5,
        },
    );
    m
}

/// Re-export State as AgentStatus for backward compatibility in commands/orchestration.
pub type AgentStatus = State;

#[derive(Debug, Clone)]
pub struct AgentEntry {
    pub id: String,
    pub role: String,
    pub task_id: Option<String>,
    pub parent_id: Option<String>,
    pub spawned_at: Instant,
    pub token_used: u64,
    pub state: State,
    /// Tracks when the agent last entered its current state (for stuck-agent safety nets).
    pub state_entered_at: Instant,
    pub children_count: u32,
    pub yield_git_branch: Option<String>,
    pub yield_diff_summary: Option<String>,
    pub validation_retry_count: u32,
    /// Project directory this agent is sandboxed to. File operations outside this path are rejected.
    pub project_path: Option<String>,
    /// Isolated worktree directory for this agent (developer agents only).
    /// When set, file operations are sandboxed to this path instead of project_path.
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YieldPayload {
    pub status: String,
    pub git_branch: Option<String>,
    pub diff_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentQuota {
    pub tokens_used: u64,
    pub tokens_remaining: u64,
    pub ttl_remaining_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatusResponse {
    pub total_slots: usize,
    pub used_slots: usize,
    pub by_role: HashMap<String, usize>,
    pub queue_depth: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugSnapshot {
    pub agents: Vec<DebugAgentEntry>,
    pub pending_validations: Vec<DebugValidationEntry>,
    pub queue_depth: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugAgentEntry {
    pub id: String,
    pub role: String,
    pub state: String,
    pub task_id: Option<String>,
    pub parent_id: Option<String>,
    pub age_secs: u64,
    pub tokens_used: u64,
    pub children: u32,
    pub retry_count: u32,
    pub project_path: Option<String>,
    pub worktree_path: Option<String>,
    pub yield_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugValidationEntry {
    pub developer_agent_id: String,
    pub task_id: Option<String>,
    pub results_received: usize,
    pub results: Vec<DebugValidatorResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugValidatorResult {
    pub role: String,
    pub pass: bool,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboundMessage {
    pub from: String,
    pub payload: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorResult {
    pub role: String,
    pub pass: bool,
    pub reasons: Vec<String>,
}

/// Returned by validation_submit when all 3 validators have reported.
#[derive(Debug, Clone, Serialize)]
pub struct ValidationOutcome {
    pub all_passed: bool,
    pub retry_count: u32,
    pub max_retries: u32,
    pub failures: Vec<ValidatorFailure>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidatorFailure {
    pub role: String,
    pub reasons: Vec<String>,
}

struct ValidationState {
    developer_agent_id: String,
    task_id: Option<String>,
    results: Vec<ValidatorResult>,
}

struct AgentRegistryInner {
    agents: HashMap<String, AgentEntry>,
    role_config: HashMap<String, RoleConfig>,
    inbox: HashMap<String, Vec<InboundMessage>>,
    queue_depth: usize,
    /// Developer agent_id -> validation state (3 validators must report).
    validation: HashMap<String, ValidationState>,
}

pub struct AgentRegistry {
    inner: Mutex<AgentRegistryInner>,
}

#[derive(Debug, Clone)]
pub struct RestoreAgentInput {
    pub id: String,
    pub role: String,
    pub task_id: Option<String>,
    pub parent_id: Option<String>,
    pub state: String,
    pub project_path: Option<String>,
    pub worktree_path: Option<String>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AgentRegistryInner {
                agents: HashMap::new(),
                role_config: default_role_configs(),
                inbox: HashMap::new(),
                queue_depth: 0,
                validation: HashMap::new(),
            }),
        }
    }

    /// Dynamically update `max_count` for a role at runtime (called from frontend debug panel).
    pub fn set_role_max_count(&self, role: &str, max_count: Option<u32>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let config = inner
            .role_config
            .entry(role.to_string())
            .or_insert_with(RoleConfig::default);
        config.max_count = max_count.unwrap_or(u32::MAX);
        Ok(())
    }

    /// Spawn a new agent (register only; caller must create PTY/session with returned id).
    /// Returns agent_id to use as session_id for the PTY.
    /// `project_path` is the sandbox directory - file operations outside it will be rejected.
    pub fn spawn(
        &self,
        role: &str,
        task_id: Option<String>,
        parent_id: Option<String>,
        project_path: Option<String>,
    ) -> Result<String, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let config = inner
            .role_config
            .get(role)
            .ok_or_else(|| format!("Unknown role: {}", role))?;

        // Collect active (non-terminal) agent counts by role for spawn validation.
        let mut active_role_counts = std::collections::HashMap::new();
        for a in inner.agents.values().filter(|a| !a.state.is_terminal()) {
            *active_role_counts.entry(a.role.clone()).or_insert(0usize) += 1;
        }
        agent_state_machine::validate_spawn(role, &task_id, &active_role_counts)?;

        if let Some(ref pid) = parent_id {
            if let Some(parent) = inner.agents.get(pid) {
                // Use the PARENT's config for max_children check, not the child's
                let parent_config = inner
                    .role_config
                    .get(&parent.role)
                    .cloned()
                    .unwrap_or_default();
                if parent.children_count >= parent_config.max_children {
                    return Err(format!(
                        "Parent {} at max_children {}",
                        pid, parent_config.max_children
                    ));
                }
            }
        }

        let count_for_role = active_role_counts.get(role).copied().unwrap_or(0);
        if count_for_role >= config.max_count as usize {
            return Err(format!("Role {} at max_count {}", role, config.max_count));
        }

        let id = ulid::Ulid::new().to_string();
        let initial = agent_state_machine::try_transition(State::Spawned, Event::Start, role)
            .map_err(|e| format!("State machine rejected spawn: {e}"))?;
        let now = Instant::now();
        let entry = AgentEntry {
            id: id.clone(),
            role: role.to_string(),
            task_id,
            parent_id: parent_id.clone(),
            spawned_at: now,
            token_used: 0,
            state: initial,
            state_entered_at: now,
            children_count: 0,
            yield_git_branch: None,
            yield_diff_summary: None,
            validation_retry_count: 0,
            project_path,
            worktree_path: None,
        };
        inner.agents.insert(id.clone(), entry);

        if let Some(pid) = parent_id {
            if let Some(p) = inner.agents.get_mut(&pid) {
                p.children_count += 1;
            }
        }

        Ok(id)
    }

    /// Restore agents after app restart/crash using persisted canvas/runtime metadata.
    /// State is provided by the caller and validated against the state machine enum.
    pub fn restore_agents(&self, agents: Vec<RestoreAgentInput>) -> Result<Vec<String>, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let mut restored = Vec::new();

        for a in agents {
            if a.id.trim().is_empty() {
                continue;
            }
            if inner.agents.contains_key(&a.id) {
                continue;
            }
            if !inner.role_config.contains_key(&a.role) {
                continue;
            }
            let state = match parse_restore_state(&a.state) {
                Some(s) => s,
                None => continue,
            };

            let now = Instant::now();
            inner.agents.insert(
                a.id.clone(),
                AgentEntry {
                    id: a.id.clone(),
                    role: a.role,
                    task_id: a.task_id,
                    parent_id: a.parent_id,
                    spawned_at: now,
                    token_used: 0,
                    state,
                    state_entered_at: now,
                    children_count: 0,
                    yield_git_branch: None,
                    yield_diff_summary: None,
                    validation_retry_count: 0,
                    project_path: a.project_path,
                    worktree_path: a.worktree_path,
                },
            );
            restored.push(a.id);
        }

        // Recompute parent->children counters for restored graph consistency.
        let parent_ids: Vec<Option<String>> = inner
            .agents
            .values()
            .map(|e| e.parent_id.clone())
            .collect();
        for e in inner.agents.values_mut() {
            e.children_count = 0;
        }
        for pid in parent_ids.into_iter().flatten() {
            if let Some(parent) = inner.agents.get_mut(&pid) {
                parent.children_count = parent.children_count.saturating_add(1);
            }
        }

        Ok(restored)
    }

    pub fn kill(&self, agent_id: &str) -> Result<bool, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = match inner.agents.get_mut(agent_id) {
            Some(e) => e,
            None => return Ok(false),
        };
        // Terminal states stay as-is; non-terminal states transition to Stopped.
        if !entry.state.is_terminal() {
            match agent_state_machine::try_transition(entry.state, Event::Kill, &entry.role) {
                Ok(new_state) => entry.state = new_state,
                Err(_) => entry.state = State::Stopped,
            }
        }
        // Remove from registry.
        let entry = inner.agents.remove(agent_id).unwrap();
        if let Some(pid) = &entry.parent_id {
            if let Some(p) = inner.agents.get_mut(pid) {
                p.children_count = p.children_count.saturating_sub(1);
            }
        }
        inner.inbox.remove(agent_id);
        // Clean up any pending validation state for this developer
        inner.validation.remove(agent_id);
        Ok(true)
    }

    /// Remove all agents, inboxes, and validation state. Used by "clear canvas".
    pub fn clear_all(&self) -> Result<Vec<String>, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let ids: Vec<String> = inner.agents.keys().cloned().collect();
        inner.agents.clear();
        inner.inbox.clear();
        inner.validation.clear();
        inner.queue_depth = 0;
        Ok(ids)
    }

    /// Detailed snapshot for the "Copy debug data" button.
    pub fn debug_snapshot(&self) -> Result<DebugSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let agents: Vec<DebugAgentEntry> = inner
            .agents
            .values()
            .map(|e| DebugAgentEntry {
                id: e.id.clone(),
                role: e.role.clone(),
                state: format!("{:?}", e.state),
                task_id: e.task_id.clone(),
                parent_id: e.parent_id.clone(),
                age_secs: e.spawned_at.elapsed().as_secs(),
                tokens_used: e.token_used,
                children: e.children_count,
                retry_count: e.validation_retry_count,
                project_path: e.project_path.clone(),
                worktree_path: e.worktree_path.clone(),
                yield_summary: e.yield_diff_summary.clone(),
            })
            .collect();

        let pending_validations: Vec<DebugValidationEntry> = inner
            .validation
            .iter()
            .map(|(dev_id, vs)| DebugValidationEntry {
                developer_agent_id: dev_id.clone(),
                task_id: vs.task_id.clone(),
                results_received: vs.results.len(),
                results: vs
                    .results
                    .iter()
                    .map(|r| DebugValidatorResult {
                        role: r.role.clone(),
                        pass: r.pass,
                        reasons: r.reasons.clone(),
                    })
                    .collect(),
            })
            .collect();

        Ok(DebugSnapshot {
            agents,
            pending_validations,
            queue_depth: inner.queue_depth,
        })
    }

    pub fn status(&self) -> Result<AgentStatusResponse, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let mut by_role: HashMap<String, usize> = HashMap::new();
        for a in inner.agents.values() {
            if !a.state.is_terminal() {
                *by_role.entry(a.role.clone()).or_insert(0) += 1;
            }
        }
        let used_slots = inner.agents.len();
        const TOTAL_SLOTS: usize = 100;
        Ok(AgentStatusResponse {
            total_slots: TOTAL_SLOTS,
            used_slots,
            by_role,
            queue_depth: inner.queue_depth,
        })
    }

    pub fn quota(&self, agent_id: &str) -> Result<Option<AgentQuota>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = match inner.agents.get(agent_id) {
            Some(e) => e,
            None => return Ok(None),
        };
        let config = match inner.role_config.get(&entry.role) {
            Some(c) => c,
            None => return Ok(None),
        };
        let ttl_remaining =
            config.ttl_secs as i64 * 1000 - entry.spawned_at.elapsed().as_millis() as i64;
        let ttl_remaining_ms = ttl_remaining.max(0);
        let tokens_remaining = config.token_quota.saturating_sub(entry.token_used);
        Ok(Some(AgentQuota {
            tokens_used: entry.token_used,
            tokens_remaining,
            ttl_remaining_ms,
        }))
    }

    pub fn report_tokens(&self, agent_id: &str, delta: u64) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        // Read role and compute new token count first.
        let (role, new_total) = match inner.agents.get(agent_id) {
            Some(e) => (e.role.clone(), e.token_used.saturating_add(delta)),
            None => return Ok(()),
        };
        let quota = inner
            .role_config
            .get(&role)
            .map(|c| c.token_quota)
            .unwrap_or(u64::MAX);
        // Now mutate.
        if let Some(e) = inner.agents.get_mut(agent_id) {
            e.token_used = new_total;
            if new_total >= quota && !e.state.is_terminal() {
                e.state = State::Stopped;
                e.state_entered_at = Instant::now();
            }
        }
        Ok(())
    }

    pub fn yield_for_review(&self, agent_id: &str, payload: YieldPayload) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let e = inner
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {agent_id} not found"))?;

        if e.validation_retry_count >= 3 {
            e.state = agent_state_machine::try_transition(e.state, Event::Kill, &e.role)
                .unwrap_or(State::Blocked);
            return Err("Max validation retries (3) exceeded".to_string());
        }

        let new_state = agent_state_machine::try_transition(e.state, Event::Yield, &e.role)?;
        e.state = new_state;
        e.state_entered_at = Instant::now();
        e.yield_git_branch = payload.git_branch;
        e.yield_diff_summary = payload.diff_summary;
        Ok(())
    }

    pub fn message(
        &self,
        from_agent_id: &str,
        to_agent_id: &str,
        payload: String,
    ) -> Result<bool, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if !inner.agents.contains_key(to_agent_id) {
            return Ok(false);
        }
        let ts = chrono::Utc::now().timestamp_millis();
        let msg = InboundMessage {
            from: from_agent_id.to_string(),
            payload,
            ts,
        };
        inner
            .inbox
            .entry(to_agent_id.to_string())
            .or_default()
            .push(msg);
        Ok(true)
    }

    pub fn poll_messages(&self, agent_id: &str) -> Result<Vec<InboundMessage>, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let msgs = inner.inbox.remove(agent_id).unwrap_or_default();
        Ok(msgs)
    }

    /// Returns (agent_id, task_id) pairs for agents that have exceeded their TTL.
    pub fn expired_agent_ids(&self) -> Result<Vec<(String, Option<String>)>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let mut expired = Vec::new();
        for (id, entry) in inner.agents.iter() {
            if entry.state.is_terminal() {
                continue;
            }
            let config = match inner.role_config.get(&entry.role) {
                Some(c) => c,
                None => continue,
            };
            if entry.spawned_at.elapsed() >= Duration::from_secs(config.ttl_secs) {
                expired.push((id.clone(), entry.task_id.clone()));
            }
        }
        Ok(expired)
    }

    pub fn set_queue_depth(&self, depth: usize) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.queue_depth = depth;
        Ok(())
    }

    /// Returns task IDs that are currently claimed by a running agent (so we don't double-claim in Beads).
    pub fn claimed_task_ids(&self) -> Result<Vec<String>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(inner
            .agents
            .values()
            .filter(|a| !a.state.is_terminal() && a.task_id.is_some())
            .filter_map(|a| a.task_id.clone())
            .collect())
    }

    /// Start validation for a developer that yielded.
    /// Transitions Yielded → InReview via the state machine.
    pub fn start_validation(
        &self,
        developer_agent_id: &str,
        task_id: Option<String>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.validation.contains_key(developer_agent_id) {
            return Ok(());
        }
        // Transition via state machine.
        if let Some(e) = inner.agents.get_mut(developer_agent_id) {
            let new_state =
                agent_state_machine::try_transition(e.state, Event::StartReview, &e.role)?;
            e.state = new_state;
            e.state_entered_at = Instant::now();
        }
        inner.validation.insert(
            developer_agent_id.to_string(),
            ValidationState {
                developer_agent_id: developer_agent_id.to_string(),
                task_id,
                results: Vec::new(),
            },
        );
        Ok(())
    }

    /// Submit a validator result. Returns the outcome once all 3 validators have reported.
    /// Uses the state machine for InReview → Done / Running / Blocked transitions.
    pub fn validation_submit(
        &self,
        developer_agent_id: &str,
        role: &str,
        pass: bool,
        reasons: Vec<String>,
    ) -> Result<Option<ValidationOutcome>, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let vstate = match inner.validation.get_mut(developer_agent_id) {
            Some(s) => s,
            None => return Ok(None),
        };
        if vstate.results.iter().any(|r| r.role == role) {
            return Ok(None);
        }
        vstate.results.push(ValidatorResult {
            role: role.to_string(),
            pass,
            reasons,
        });
        if vstate.results.len() < 3 {
            return Ok(None);
        }
        let all_passed = vstate.results.iter().all(|r| r.pass);
        let failures: Vec<ValidatorFailure> = vstate
            .results
            .iter()
            .filter(|r| !r.pass)
            .map(|r| ValidatorFailure {
                role: r.role.clone(),
                reasons: r.reasons.clone(),
            })
            .collect();

        inner.validation.remove(developer_agent_id);
        let mut retry_count = 0u32;
        if let Some(e) = inner.agents.get_mut(developer_agent_id) {
            if all_passed {
                let new_state =
                    agent_state_machine::try_transition(e.state, Event::ValidationPass, &e.role)?;
                e.state = new_state;
                e.state_entered_at = Instant::now();
            } else {
                e.validation_retry_count += 1;
                retry_count = e.validation_retry_count;
                let event = if e.validation_retry_count >= 3 {
                    Event::ValidationBlock
                } else {
                    Event::ValidationFail
                };
                let new_state = agent_state_machine::try_transition(e.state, event, &e.role)?;
                e.state = new_state;
                e.state_entered_at = Instant::now();
            }
        }
        Ok(Some(ValidationOutcome {
            all_passed,
            retry_count,
            max_retries: 3,
            failures,
        }))
    }

    /// Returns (task_id, git_branch, diff_summary) for agents in Yielded state that have not yet had validation started.
    pub fn yield_queue(
        &self,
    ) -> Result<Vec<(String, Option<String>, Option<String>, Option<String>)>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for (id, entry) in inner.agents.iter() {
            if entry.state != State::Yielded {
                continue;
            }
            if inner.validation.contains_key(id) {
                continue;
            }
            out.push((
                id.clone(),
                entry.task_id.clone(),
                entry.yield_git_branch.clone(),
                entry.yield_diff_summary.clone(),
            ));
        }
        Ok(out)
    }

    /// Returns agents in InReview state that have validation started but no validator results yet.
    /// Used by the watchdog to re-emit validation_requested for stuck agents.
    pub fn agents_in_review_without_validators(
        &self,
    ) -> Result<Vec<(String, Option<String>)>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for (id, entry) in inner.agents.iter() {
            if entry.state != State::InReview {
                continue;
            }
            // Check if validation has started but no results yet
            if let Some(vstate) = inner.validation.get(id) {
                if vstate.results.is_empty() {
                    out.push((id.clone(), entry.task_id.clone()));
                }
            }
        }
        Ok(out)
    }

    /// Force a stuck Yielded agent to InReview state if validation hasn't started.
    /// Returns true if the agent was unstuck.
    pub fn force_start_validation(&self, agent_id: &str) -> Result<bool, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;

        // Get task_id first to avoid borrow issues
        let task_id = inner.agents.get(agent_id).and_then(|e| e.task_id.clone());

        let entry = match inner.agents.get_mut(agent_id) {
            Some(e) => e,
            None => return Ok(false),
        };
        if entry.state != State::Yielded {
            return Ok(false);
        }
        // Force transition
        entry.state = State::InReview;
        entry.state_entered_at = Instant::now();

        // Drop the mutable borrow before inserting into validation
        drop(entry);

        if !inner.validation.contains_key(agent_id) {
            inner.validation.insert(
                agent_id.to_string(),
                ValidationState {
                    developer_agent_id: agent_id.to_string(),
                    task_id,
                    results: Vec::new(),
                },
            );
        }
        Ok(true)
    }

    /// Gate a tool call: checks that the agent exists, is Running, has permission, and is within quota/TTL.
    /// Every Tauri command that an LLM agent can invoke must call this first.
    pub fn gate_tool(&self, agent_id: &str, command_name: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = match inner.agents.get(agent_id) {
            Some(e) => e,
            None => return Err(format!("Unknown agent ID: {agent_id}")),
        };
        let tool = Tool::from_command_name(command_name)
            .ok_or_else(|| format!("Unknown tool command: {command_name}"))?;
        let config = inner
            .role_config
            .get(&entry.role)
            .cloned()
            .unwrap_or_default();

        agent_state_machine::gate_tool_call(
            &entry.role,
            entry.state,
            tool,
            entry.token_used,
            config.token_quota,
            entry.spawned_at,
            Duration::from_secs(config.ttl_secs),
        )
    }

    /// Non-developer agents complete their task directly (Running → Done via state machine).
    /// Developers MUST use yield_for_review; the state machine rejects Complete for them.
    pub fn complete_task(&self, agent_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = inner
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {agent_id} not found"))?;
        let new_state =
            agent_state_machine::try_transition(entry.state, Event::Complete, &entry.role)?;
        entry.state = new_state;
        entry.state_entered_at = Instant::now();
        Ok(())
    }

    /// Returns (agent_id, task_id) for agents in Done state that have a task_id.
    /// The orchestration loop uses this to update Beads and clean up.
    pub fn done_agents_with_tasks(&self) -> Result<Vec<(String, String, String)>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(inner
            .agents
            .values()
            .filter(|a| a.state == State::Done && a.task_id.is_some())
            .map(|a| (a.id.clone(), a.task_id.clone().unwrap(), a.role.clone()))
            .collect())
    }

    /// Returns true if one more agent of this role can be spawned (under max_count).
    pub fn can_spawn_role(&self, role: &str) -> Result<bool, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let config = match inner.role_config.get(role) {
            Some(c) => c,
            None => return Ok(false),
        };
        let count = inner
            .agents
            .values()
            .filter(|a| a.role == role && !a.state.is_terminal())
            .count();
        Ok(count < config.max_count as usize)
    }

    /// Handle an agent's LLM turn ending without explicit completion/yield.
    /// For developers still in Running: returns "needs_nudge" so frontend can prompt them.
    /// For other roles in Running: auto-complete.
    /// Returns: "needs_nudge", "completed", "already_done", or "not_found".
    pub fn handle_turn_ended(&self, agent_id: &str, role: &str) -> Result<String, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = match inner.agents.get_mut(agent_id) {
            Some(e) => e,
            None => return Ok("not_found".to_string()),
        };

        // If already in a terminal or yielded state, nothing to do
        if entry.state.is_terminal()
            || entry.state == State::Yielded
            || entry.state == State::InReview
        {
            return Ok("already_done".to_string());
        }

        // Only handle Running state
        if entry.state != State::Running {
            return Ok("already_done".to_string());
        }

        if role == "developer" {
            // Developers need a nudge to call yield_for_review
            Ok("needs_nudge".to_string())
        } else {
            // Non-developers get auto-completed
            match agent_state_machine::try_transition(entry.state, Event::Complete, &entry.role) {
                Ok(new_state) => {
                    entry.state = new_state;
                    entry.state_entered_at = Instant::now();
                    Ok("completed".to_string())
                }
                Err(_) => Ok("already_done".to_string()),
            }
        }
    }

    /// Force-yield an agent. Transitions Running/Spawned → Yielded.
    /// No-op if the agent is already Yielded, InReview, or in a terminal state.
    /// Used as a safety net when LLM turns end without calling yield_for_review.
    pub fn force_yield(&self, agent_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = inner
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {} not found", agent_id))?;

        match entry.state {
            State::Yielded | State::InReview | State::Done | State::Blocked | State::Stopped => {
                Ok(())
            }
            State::Running | State::Spawned => {
                entry.state = State::Yielded;
                entry.state_entered_at = Instant::now();
                eprintln!(
                    "[registry] force_yield: {} transitioned to Yielded",
                    agent_id
                );
                Ok(())
            }
        }
    }

    /// Set the yield diff_summary on a Yielded agent (e.g. after force-yield with diagnostics).
    pub fn set_yield_summary(&self, agent_id: &str, summary: String) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = inner
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {} not found", agent_id))?;
        entry.yield_diff_summary = Some(summary);
        Ok(())
    }

    /// Returns developers stuck in Running state longer than `max_running_secs`.
    /// The orchestration loop uses this as an ultimate safety net.
    pub fn stuck_running_developers(&self, max_running_secs: u64) -> Result<Vec<String>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let cutoff = Duration::from_secs(max_running_secs);
        let mut out = Vec::new();
        for (id, entry) in inner.agents.iter() {
            if entry.role != "developer" || entry.state != State::Running {
                continue;
            }
            if entry.state_entered_at.elapsed() > cutoff {
                out.push(id.clone());
            }
        }
        Ok(out)
    }

    /// Returns developers stuck in InReview state longer than `max_secs`.
    /// Validators may have failed to spawn or errored out without submitting results.
    pub fn stuck_in_review_developers(&self, max_secs: u64) -> Result<Vec<String>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let cutoff = Duration::from_secs(max_secs);
        let mut out = Vec::new();
        for (id, entry) in inner.agents.iter() {
            if entry.role != "developer" || entry.state != State::InReview {
                continue;
            }
            if entry.state_entered_at.elapsed() > cutoff {
                out.push(id.clone());
            }
        }
        Ok(out)
    }

    /// Force-block validation for a stuck developer by transitioning InReview → Blocked.
    /// Used when validators never submitted results.
    pub fn force_block_validation(&self, agent_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = inner
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {} not found", agent_id))?;
        if entry.state != State::InReview {
            return Ok(());
        }
        let new_state =
            agent_state_machine::try_transition(entry.state, Event::ValidationBlock, &entry.role)?;
        entry.state = new_state;
        entry.state_entered_at = Instant::now();
        inner.validation.remove(agent_id);
        eprintln!(
            "[registry] force_block_validation: {} → Blocked (validators timed out)",
            agent_id
        );
        Ok(())
    }

    /// Get the project_path (sandbox directory) for an agent.
    pub fn get_project_path(&self, agent_id: &str) -> Result<Option<String>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(inner
            .agents
            .get(agent_id)
            .and_then(|e| e.project_path.clone()))
    }

    /// Set the worktree path for a developer agent (called after worktree creation).
    pub fn set_worktree_path(&self, agent_id: &str, path: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = inner
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {agent_id} not found"))?;
        entry.worktree_path = Some(path.to_string());
        Ok(())
    }

    /// Get the worktree path for an agent, if set.
    pub fn get_worktree_path(&self, agent_id: &str) -> Result<Option<String>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(inner
            .agents
            .get(agent_id)
            .and_then(|e| e.worktree_path.clone()))
    }

    /// Returns the effective sandbox directory: worktree_path if set, otherwise project_path.
    pub fn get_effective_cwd(&self, agent_id: &str) -> Result<Option<String>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(inner
            .agents
            .get(agent_id)
            .and_then(|e| e.worktree_path.clone().or_else(|| e.project_path.clone())))
    }

    /// Validate that a cwd is valid for terminal commands.
    /// More lenient than validate_path - allows the parent directory for scaffolding tools.
    /// Uses worktree_path as sandbox when set, falling back to project_path.
    pub fn validate_path_for_terminal(&self, agent_id: &str, cwd: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = match inner.agents.get(agent_id) {
            Some(e) => e,
            None => return Err(format!("Unknown agent ID: {agent_id}")),
        };

        let project_path = match entry.worktree_path.as_ref().or(entry.project_path.as_ref()) {
            Some(p) => p,
            None => return Ok(()),
        };

        let project = std::path::Path::new(project_path);
        let cwd_path = std::path::Path::new(cwd);

        // Allow if cwd IS the project path
        if cwd_path == project {
            return Ok(());
        }

        // Allow if cwd is inside the project path
        if cwd_path.starts_with(project) {
            return Ok(());
        }

        // Allow if cwd is the parent of project path (for scaffolding tools like create-vite)
        if let Some(parent) = project.parent() {
            if cwd_path == parent {
                return Ok(());
            }
        }

        Err(format!(
            "Terminal cwd '{}' must be within or parent of project directory '{}'",
            cwd, project_path
        ))
    }

    /// Validate that a path is within the agent's sandbox.
    /// Uses worktree_path as sandbox when set, falling back to project_path.
    /// Returns Ok(()) if allowed, Err with reason if not.
    /// If agent has no sandbox set, all paths are allowed (for WM, operators, etc).
    pub fn validate_path(&self, agent_id: &str, path: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = match inner.agents.get(agent_id) {
            Some(e) => e,
            None => return Err(format!("Unknown agent ID: {agent_id}")),
        };

        let project_path = match entry.worktree_path.as_ref().or(entry.project_path.as_ref()) {
            Some(p) => p,
            None => return Ok(()), // No sandbox, allow all (WM, operators)
        };

        // Canonicalize both paths for comparison
        let sandbox = match std::fs::canonicalize(project_path) {
            Ok(p) => p,
            Err(_) => {
                // Project path doesn't exist yet? Allow if target is under the raw project_path
                let sandbox = std::path::Path::new(project_path);
                let target = std::path::Path::new(path);
                if target.starts_with(sandbox) {
                    return Ok(());
                }
                return Err(format!(
                    "Path '{}' is outside project directory '{}'",
                    path, project_path
                ));
            }
        };

        // For the target path, try to canonicalize. If it doesn't exist, check parent dirs.
        let target = std::path::Path::new(path);
        let resolved = if target.exists() {
            std::fs::canonicalize(target).map_err(|e| e.to_string())?
        } else {
            // File doesn't exist - check if any existing ancestor is under sandbox
            let mut check = target.to_path_buf();
            loop {
                if check.exists() {
                    let canonical = std::fs::canonicalize(&check).map_err(|e| e.to_string())?;
                    if !canonical.starts_with(&sandbox) {
                        return Err(format!(
                            "Path '{}' is outside project directory '{}'",
                            path, project_path
                        ));
                    }
                    return Ok(());
                }
                if !check.pop() {
                    // Reached root without finding existing ancestor - check raw path
                    if target.starts_with(&sandbox) || target.starts_with(project_path) {
                        return Ok(());
                    }
                    return Err(format!(
                        "Path '{}' is outside project directory '{}'",
                        path, project_path
                    ));
                }
            }
        };

        if !resolved.starts_with(&sandbox) {
            return Err(format!(
                "Path '{}' is outside project directory '{}'",
                path, project_path
            ));
        }

        Ok(())
    }
}

fn parse_restore_state(raw: &str) -> Option<State> {
    match raw {
        "spawned" => Some(State::Spawned),
        "running" => Some(State::Running),
        "yielded" => Some(State::Yielded),
        "in_review" => Some(State::InReview),
        "done" => Some(State::Done),
        "blocked" => Some(State::Blocked),
        "stopped" => Some(State::Stopped),
        _ => None,
    }
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_path_uses_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let worktree = dir.path().join("worktree");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();

        let registry = AgentRegistry::new();
        let id = registry
            .spawn(
                "developer",
                Some("bd-1".to_string()),
                None,
                Some(project.to_str().unwrap().to_string()),
            )
            .unwrap();
        registry
            .set_worktree_path(&id, worktree.to_str().unwrap())
            .unwrap();

        // Path inside worktree should be allowed
        let inside = worktree.join("src/main.rs");
        assert!(registry
            .validate_path(&id, inside.to_str().unwrap())
            .is_ok());

        // Path inside original project_path (but outside worktree) should be rejected
        let outside = project.join("src/main.rs");
        assert!(registry
            .validate_path(&id, outside.to_str().unwrap())
            .is_err());
    }

    #[test]
    fn test_validate_path_falls_back_to_project() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();

        let registry = AgentRegistry::new();
        let id = registry
            .spawn(
                "developer",
                Some("bd-2".to_string()),
                None,
                Some(project.to_str().unwrap().to_string()),
            )
            .unwrap();
        // No worktree_path set — should fall back to project_path

        let inside = project.join("src/main.rs");
        assert!(registry
            .validate_path(&id, inside.to_str().unwrap())
            .is_ok());

        let outside = dir.path().join("other/file.txt");
        assert!(registry
            .validate_path(&id, outside.to_str().unwrap())
            .is_err());
    }

    #[test]
    fn test_unknown_agent_gate_tool_fails_closed() {
        let registry = AgentRegistry::new();
        let result = registry.gate_tool("missing-agent", "terminal_exec");
        assert!(result.is_err());
    }

    // --- Spawn tests ---

    #[test]
    fn spawn_returns_unique_ids() {
        let registry = AgentRegistry::new();
        let id1 = registry.spawn("operator", None, None, None).unwrap();
        let id2 = registry.spawn("operator", None, None, None).unwrap();
        assert_ne!(id1, id2);
    }

    #[test]
    fn spawn_unknown_role_is_rejected() {
        let registry = AgentRegistry::new();
        let result = registry.spawn("hacker", None, None, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown role"));
    }

    #[test]
    fn spawn_enforces_max_count() {
        let registry = AgentRegistry::new();
        // workforce_manager has max_count=1
        let _id1 = registry.spawn("workforce_manager", None, None, None).unwrap();
        let result = registry.spawn("workforce_manager", None, None, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("max_count"));
    }

    #[test]
    fn spawn_developer_requires_task_id() {
        let registry = AgentRegistry::new();
        let result = registry.spawn("developer", None, None, None);
        assert!(result.is_err());
    }

    #[test]
    fn spawn_developer_with_task_id_succeeds() {
        let registry = AgentRegistry::new();
        let id = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();
        assert!(!id.is_empty());
    }

    #[test]
    fn spawn_increments_parent_children_count() {
        let registry = AgentRegistry::new();
        let parent = registry.spawn("project_manager", Some("t-1".into()), None, None).unwrap();
        let _child = registry.spawn("operator", None, Some(parent.clone()), None).unwrap();
        let status = registry.status().unwrap();
        assert_eq!(status.used_slots, 2);
    }

    #[test]
    fn spawn_rejects_when_parent_at_max_children() {
        let registry = AgentRegistry::new();
        // Worker has max_children=0
        let worker = registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        let result = registry.spawn("operator", None, Some(worker), None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("max_children"));
    }

    // --- Kill tests ---

    #[test]
    fn kill_removes_agent_and_decrements_parent() {
        let registry = AgentRegistry::new();
        let parent = registry.spawn("project_manager", Some("t-1".into()), None, None).unwrap();
        let child = registry.spawn("operator", None, Some(parent.clone()), None).unwrap();
        assert_eq!(registry.status().unwrap().used_slots, 2);

        registry.kill(&child).unwrap();
        assert_eq!(registry.status().unwrap().used_slots, 1);
    }

    #[test]
    fn kill_nonexistent_returns_false() {
        let registry = AgentRegistry::new();
        assert!(!registry.kill("ghost").unwrap());
    }

    #[test]
    fn kill_cleans_up_inbox_and_validation() {
        let registry = AgentRegistry::new();
        let dev = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();
        // Send a message to the developer
        let sender = registry.spawn("project_manager", Some("t-1".into()), None, None).unwrap();
        registry.message(&sender, &dev, "hello".into()).unwrap();
        // Start validation
        registry.yield_for_review(&dev, YieldPayload {
            status: "done".into(), git_branch: None, diff_summary: None,
        }).unwrap();
        registry.start_validation(&dev, Some("bd-1".into())).unwrap();

        // Kill should clean up everything
        registry.kill(&dev).unwrap();
        assert_eq!(registry.status().unwrap().used_slots, 1); // only sender remains
    }

    // --- Token quota tests ---

    #[test]
    fn report_tokens_accumulates() {
        let registry = AgentRegistry::new();
        let id = registry.spawn("operator", None, None, None).unwrap();
        registry.report_tokens(&id, 100).unwrap();
        registry.report_tokens(&id, 200).unwrap();
        let quota = registry.quota(&id).unwrap().unwrap();
        assert_eq!(quota.tokens_used, 300);
    }

    #[test]
    fn report_tokens_exceeding_quota_stops_agent() {
        let registry = AgentRegistry::new();
        // Worker has token_quota=10_000
        let id = registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        registry.report_tokens(&id, 10_000).unwrap();
        // Agent should be Stopped now — gate_tool should fail
        let result = registry.gate_tool(&id, "terminal_exec");
        assert!(result.is_err());
    }

    // --- Yield and validation lifecycle tests ---

    #[test]
    fn full_validation_pass_lifecycle() {
        let registry = AgentRegistry::new();
        let dev = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();

        // Yield for review
        registry.yield_for_review(&dev, YieldPayload {
            status: "done".into(), git_branch: Some("feat/x".into()), diff_summary: Some("added x".into()),
        }).unwrap();

        // Start validation (transitions Yielded → InReview)
        registry.start_validation(&dev, Some("bd-1".into())).unwrap();

        // Submit 3 passing results
        let r1 = registry.validation_submit(&dev, "code_review", true, vec![]).unwrap();
        assert!(r1.is_none()); // Not complete yet
        let r2 = registry.validation_submit(&dev, "business_logic", true, vec![]).unwrap();
        assert!(r2.is_none());
        let r3 = registry.validation_submit(&dev, "scope", true, vec![]).unwrap();
        assert!(r3.is_some());
        let outcome = r3.unwrap();
        assert!(outcome.all_passed);
        assert_eq!(outcome.retry_count, 0);
    }

    #[test]
    fn validation_failure_sends_back_to_running() {
        let registry = AgentRegistry::new();
        let dev = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();

        registry.yield_for_review(&dev, YieldPayload {
            status: "done".into(), git_branch: None, diff_summary: None,
        }).unwrap();
        registry.start_validation(&dev, Some("bd-1".into())).unwrap();

        registry.validation_submit(&dev, "code_review", true, vec![]).unwrap();
        registry.validation_submit(&dev, "business_logic", false, vec!["bug found".into()]).unwrap();
        let outcome = registry.validation_submit(&dev, "scope", true, vec![]).unwrap().unwrap();

        assert!(!outcome.all_passed);
        assert_eq!(outcome.retry_count, 1);
        assert_eq!(outcome.failures.len(), 1);
        assert_eq!(outcome.failures[0].role, "business_logic");
    }

    #[test]
    fn duplicate_validator_role_is_ignored() {
        let registry = AgentRegistry::new();
        let dev = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();
        registry.yield_for_review(&dev, YieldPayload {
            status: "done".into(), git_branch: None, diff_summary: None,
        }).unwrap();
        registry.start_validation(&dev, Some("bd-1".into())).unwrap();

        registry.validation_submit(&dev, "code_review", true, vec![]).unwrap();
        // Submit same role again — should be ignored
        let dup = registry.validation_submit(&dev, "code_review", false, vec![]).unwrap();
        assert!(dup.is_none());
    }

    #[test]
    fn yield_blocked_after_3_retries() {
        let registry = AgentRegistry::new();
        let dev = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();

        for attempt in 0..3u32 {
            registry.yield_for_review(&dev, YieldPayload {
                status: "done".into(), git_branch: None, diff_summary: None,
            }).unwrap();
            registry.start_validation(&dev, Some("bd-1".into())).unwrap();

            registry.validation_submit(&dev, "code_review", true, vec![]).unwrap();
            registry.validation_submit(&dev, "business_logic", false, vec!["nope".into()]).unwrap();
            let outcome = registry.validation_submit(&dev, "scope", true, vec![]).unwrap().unwrap();
            assert_eq!(outcome.retry_count, attempt + 1);

            if attempt == 2 {
                // 3rd failure → Blocked
                assert!(!outcome.all_passed);
            }
        }

        // 4th yield attempt should be rejected
        let result = registry.yield_for_review(&dev, YieldPayload {
            status: "done".into(), git_branch: None, diff_summary: None,
        });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Max validation retries"));
    }

    // --- Complete task tests ---

    #[test]
    fn developer_cannot_self_complete() {
        let registry = AgentRegistry::new();
        let dev = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();
        let result = registry.complete_task(&dev);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("yield_for_review"));
    }

    #[test]
    fn non_developer_can_complete() {
        let registry = AgentRegistry::new();
        let worker = registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        assert!(registry.complete_task(&worker).is_ok());
    }

    // --- Turn ended tests ---

    #[test]
    fn turn_ended_developer_returns_needs_nudge() {
        let registry = AgentRegistry::new();
        let dev = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();
        let result = registry.handle_turn_ended(&dev, "developer").unwrap();
        assert_eq!(result, "needs_nudge");
    }

    #[test]
    fn turn_ended_worker_auto_completes() {
        let registry = AgentRegistry::new();
        let worker = registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        let result = registry.handle_turn_ended(&worker, "worker").unwrap();
        assert_eq!(result, "completed");
    }

    #[test]
    fn turn_ended_nonexistent_returns_not_found() {
        let registry = AgentRegistry::new();
        let result = registry.handle_turn_ended("ghost", "worker").unwrap();
        assert_eq!(result, "not_found");
    }

    // --- Force yield tests ---

    #[test]
    fn force_yield_transitions_running_to_yielded() {
        let registry = AgentRegistry::new();
        let dev = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();
        registry.force_yield(&dev).unwrap();
        let queue = registry.yield_queue().unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].0, dev);
    }

    #[test]
    fn force_yield_noop_for_terminal_states() {
        let registry = AgentRegistry::new();
        let worker = registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        registry.complete_task(&worker).unwrap();
        // Force yield on Done agent is a no-op
        assert!(registry.force_yield(&worker).is_ok());
    }

    // --- Restore tests ---

    #[test]
    fn restore_agents_skips_invalid() {
        let registry = AgentRegistry::new();
        let inputs = vec![
            RestoreAgentInput { id: "".into(), role: "worker".into(), task_id: None, parent_id: None, state: "running".into(), project_path: None, worktree_path: None },
            RestoreAgentInput { id: "a1".into(), role: "unknown_role".into(), task_id: None, parent_id: None, state: "running".into(), project_path: None, worktree_path: None },
            RestoreAgentInput { id: "a2".into(), role: "worker".into(), task_id: None, parent_id: None, state: "invalid_state".into(), project_path: None, worktree_path: None },
            RestoreAgentInput { id: "a3".into(), role: "worker".into(), task_id: None, parent_id: None, state: "running".into(), project_path: None, worktree_path: None },
        ];
        let restored = registry.restore_agents(inputs).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0], "a3");
    }

    #[test]
    fn restore_recomputes_parent_children_counts() {
        let registry = AgentRegistry::new();
        let inputs = vec![
            RestoreAgentInput { id: "parent".into(), role: "project_manager".into(), task_id: None, parent_id: None, state: "running".into(), project_path: None, worktree_path: None },
            RestoreAgentInput { id: "child1".into(), role: "operator".into(), task_id: None, parent_id: Some("parent".into()), state: "running".into(), project_path: None, worktree_path: None },
            RestoreAgentInput { id: "child2".into(), role: "operator".into(), task_id: None, parent_id: Some("parent".into()), state: "running".into(), project_path: None, worktree_path: None },
        ];
        registry.restore_agents(inputs).unwrap();
        let status = registry.status().unwrap();
        assert_eq!(status.used_slots, 3);
    }

    // --- TTL expiry tests ---

    #[test]
    fn expired_agent_ids_detects_ttl_exceeded() {
        let registry = AgentRegistry::new();
        // Worker has ttl_secs=120
        let id = registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        assert!(registry.expired_agent_ids().unwrap().is_empty());

        registry.test_backdate_spawn(&id, std::time::Duration::from_secs(200));
        let expired = registry.expired_agent_ids().unwrap();
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].0, id);
    }

    // --- Stuck developer detection ---

    #[test]
    fn stuck_running_developers_detected() {
        let registry = AgentRegistry::new();
        let dev = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();
        assert!(registry.stuck_running_developers(60).unwrap().is_empty());

        registry.test_backdate_state_entered(&dev, std::time::Duration::from_secs(120));
        let stuck = registry.stuck_running_developers(60).unwrap();
        assert_eq!(stuck.len(), 1);
        assert_eq!(stuck[0], dev);
    }

    // --- Clear all tests ---

    #[test]
    fn clear_all_removes_everything() {
        let registry = AgentRegistry::new();
        registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        registry.spawn("operator", None, None, None).unwrap();
        let cleared = registry.clear_all().unwrap();
        assert_eq!(cleared.len(), 2);
        assert_eq!(registry.status().unwrap().used_slots, 0);
    }

    // --- Claimed task IDs ---

    #[test]
    fn claimed_task_ids_returns_active_tasks() {
        let registry = AgentRegistry::new();
        registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();
        registry.spawn("developer", Some("bd-2".into()), None, None).unwrap();
        registry.spawn("operator", None, None, None).unwrap(); // no task_id
        let claimed = registry.claimed_task_ids().unwrap();
        assert_eq!(claimed.len(), 2);
        assert!(claimed.contains(&"bd-1".to_string()));
        assert!(claimed.contains(&"bd-2".to_string()));
    }

    // --- Validate path for terminal ---

    #[test]
    fn validate_path_for_terminal_allows_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("myapp");
        std::fs::create_dir_all(&project).unwrap();

        let registry = AgentRegistry::new();
        let id = registry.spawn("developer", Some("bd-1".into()), None, Some(project.to_str().unwrap().into())).unwrap();

        // Parent of project dir should be allowed (for scaffolding)
        assert!(registry.validate_path_for_terminal(&id, dir.path().to_str().unwrap()).is_ok());
        // Project dir itself should be allowed
        assert!(registry.validate_path_for_terminal(&id, project.to_str().unwrap()).is_ok());
        // Completely unrelated path should be rejected
        assert!(registry.validate_path_for_terminal(&id, "/tmp/evil").is_err());
    }

    // --- Token quota enforcement (state transitions) ---

    #[test]
    fn report_tokens_over_quota_transitions_to_stopped() {
        let registry = AgentRegistry::new();
        let id = registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        registry.report_tokens(&id, 10_001).unwrap();
        let snap = registry.debug_snapshot().unwrap();
        let agent = snap.agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!(agent.state, "Stopped", "agent should be Stopped after exceeding token quota");
    }

    #[test]
    fn report_tokens_under_quota_stays_running() {
        let registry = AgentRegistry::new();
        let id = registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        registry.report_tokens(&id, 9_999).unwrap();
        let snap = registry.debug_snapshot().unwrap();
        let agent = snap.agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!(agent.state, "Running", "agent should stay Running under quota");
    }

    #[test]
    fn report_tokens_nonexistent_agent_is_noop() {
        let registry = AgentRegistry::new();
        assert!(registry.report_tokens("ghost", 1000).is_ok());
    }

    #[test]
    fn report_tokens_terminal_agent_not_double_stopped() {
        let registry = AgentRegistry::new();
        let id = registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        registry.complete_task(&id).unwrap();
        // Already Done — reporting tokens should not change state
        registry.report_tokens(&id, 999_999).unwrap();
        let snap = registry.debug_snapshot().unwrap();
        let agent = snap.agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!(agent.state, "Done", "terminal state should not change on token report");
    }

    // --- Message passing ---

    #[test]
    fn message_to_nonexistent_returns_false() {
        let registry = AgentRegistry::new();
        let result = registry.message("from", "ghost", "hello".into()).unwrap();
        assert!(!result);
    }

    #[test]
    fn message_delivery_and_poll_drain() {
        let registry = AgentRegistry::new();
        let id = registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        assert!(registry.message("sender", &id, "msg1".into()).unwrap());
        assert!(registry.message("sender", &id, "msg2".into()).unwrap());

        let msgs = registry.poll_messages(&id).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].payload, "msg1");
        assert_eq!(msgs[1].payload, "msg2");
        assert_eq!(msgs[0].from, "sender");

        let msgs2 = registry.poll_messages(&id).unwrap();
        assert!(msgs2.is_empty(), "poll should drain the inbox");
    }

    #[test]
    fn poll_messages_nonexistent_returns_empty() {
        let registry = AgentRegistry::new();
        let msgs = registry.poll_messages("ghost").unwrap();
        assert!(msgs.is_empty());
    }

    // --- validate_path edge cases ---

    #[test]
    fn validate_path_traversal_with_dotdot_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();

        let registry = AgentRegistry::new();
        let id = registry.spawn("developer", Some("bd-1".into()), None, Some(project.to_str().unwrap().into())).unwrap();

        let escape = format!("{}/../../../etc/passwd", project.to_str().unwrap());
        let result = registry.validate_path(&id, &escape);
        assert!(result.is_err(), "path traversal with .. should be rejected");
    }

    #[test]
    fn validate_path_root_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();

        let registry = AgentRegistry::new();
        let id = registry.spawn("developer", Some("bd-1".into()), None, Some(project.to_str().unwrap().into())).unwrap();

        let result = registry.validate_path(&id, "/");
        assert!(result.is_err(), "root path should be rejected");
    }

    #[test]
    fn validate_path_no_sandbox_allows_all() {
        let registry = AgentRegistry::new();
        let id = registry.spawn("operator", None, None, None).unwrap();
        assert!(registry.validate_path(&id, "/any/path").is_ok(), "no sandbox should allow all");
    }

    #[test]
    fn validate_path_empty_string_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();

        let registry = AgentRegistry::new();
        let id = registry.spawn("developer", Some("bd-1".into()), None, Some(project.to_str().unwrap().into())).unwrap();

        let result = registry.validate_path(&id, "");
        assert!(result.is_err(), "empty path should be rejected");
    }

    // --- Effective CWD ---

    #[test]
    fn get_effective_cwd_prefers_worktree() {
        let registry = AgentRegistry::new();
        let id = registry.spawn("developer", Some("bd-1".into()), None, Some("/project".into())).unwrap();
        assert_eq!(registry.get_effective_cwd(&id).unwrap(), Some("/project".to_string()));

        registry.set_worktree_path(&id, "/worktree").unwrap();
        assert_eq!(registry.get_effective_cwd(&id).unwrap(), Some("/worktree".to_string()));
    }

    // --- Spawn limits ---

    #[test]
    fn spawn_respects_max_count_per_role() {
        let registry = AgentRegistry::new();
        registry.set_role_max_count("worker", Some(2)).unwrap();
        registry.spawn("worker", Some("t-1".into()), None, None).unwrap();
        registry.spawn("worker", Some("t-2".into()), None, None).unwrap();
        let result = registry.spawn("worker", Some("t-3".into()), None, None);
        assert!(result.is_err(), "should fail at max_count");
        assert!(result.unwrap_err().contains("max_count"));
    }

    #[test]
    fn spawn_max_children_enforced() {
        let registry = AgentRegistry::new();
        registry.set_role_max_count("operator", Some(100)).unwrap();
        let parent = registry.spawn("operator", None, None, None).unwrap();
        // Operator max_children is 0 by default
        let result = registry.spawn("operator", None, Some(parent.clone()), None);
        assert!(result.is_err(), "operator with max_children=0 should reject children");
        assert!(result.unwrap_err().contains("max_children"));
    }

    // --- can_spawn_role ---

    #[test]
    fn can_spawn_role_unknown_role_returns_false() {
        let registry = AgentRegistry::new();
        assert!(!registry.can_spawn_role("nonexistent_role").unwrap());
    }

    // --- agents_in_review_without_validators ---

    #[test]
    fn agents_in_review_without_validators_detected() {
        let registry = AgentRegistry::new();
        let id = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();
        let yp = YieldPayload { status: "done".into(), diff_summary: None, git_branch: None };
        registry.yield_for_review(&id, yp).unwrap();
        registry.start_validation(&id, Some("bd-1".into())).unwrap();

        let stuck = registry.agents_in_review_without_validators().unwrap();
        assert_eq!(stuck.len(), 1);
        assert_eq!(stuck[0].0, id);
    }

    // --- Yield with max retries exceeded ---

    #[test]
    fn yield_after_max_retries_blocks_agent() {
        let registry = AgentRegistry::new();
        let id = registry.spawn("developer", Some("bd-1".into()), None, None).unwrap();

        for _ in 0..3 {
            let yp = YieldPayload { status: "done".into(), diff_summary: None, git_branch: None };
            registry.yield_for_review(&id, yp).unwrap();
            registry.start_validation(&id, Some("bd-1".into())).unwrap();
            registry
                .validation_submit(&id, "code_review", false, vec!["bad".into()])
                .unwrap();
            registry.validation_submit(&id, "business_logic", true, vec![]).unwrap();
            registry.validation_submit(&id, "scope", true, vec![]).unwrap();
        }

        // retry_count is now 3 — next yield should be rejected
        let yp = YieldPayload { status: "done".into(), diff_summary: None, git_branch: None };
        let result = registry.yield_for_review(&id, yp);
        assert!(result.is_err(), "yield after 3 retries should be rejected");
        assert!(result.unwrap_err().contains("Max validation retries"));

        let snap = registry.debug_snapshot().unwrap();
        let agent = snap.agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!(agent.state, "Blocked", "agent should be Blocked after max retries");
    }
}

// Test-only helpers for manipulating agent internals (timestamp backdating, etc.)
#[cfg(test)]
impl AgentRegistry {
    /// Backdate `spawned_at` by the given duration so TTL expiry fires in tests.
    pub fn test_backdate_spawn(&self, agent_id: &str, by: std::time::Duration) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(entry) = inner.agents.get_mut(agent_id) {
            entry.spawned_at = entry.spawned_at.checked_sub(by).unwrap_or(entry.spawned_at);
        }
    }

    /// Backdate `state_entered_at` by the given duration so stuck-agent detection fires.
    pub fn test_backdate_state_entered(&self, agent_id: &str, by: std::time::Duration) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(entry) = inner.agents.get_mut(agent_id) {
            entry.state_entered_at = entry
                .state_entered_at
                .checked_sub(by)
                .unwrap_or(entry.state_entered_at);
        }
    }
}
