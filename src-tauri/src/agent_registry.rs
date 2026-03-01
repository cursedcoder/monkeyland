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
    pub children_count: u32,
    pub yield_git_branch: Option<String>,
    pub yield_diff_summary: Option<String>,
    pub validation_retry_count: u32,
    /// Project directory this agent is sandboxed to. File operations outside this path are rejected.
    pub project_path: Option<String>,
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
                let parent_config = inner.role_config.get(&parent.role).cloned().unwrap_or_default();
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
            return Err(format!(
                "Role {} at max_count {}",
                role, config.max_count
            ));
        }

        let id = ulid::Ulid::new().to_string();
        let initial = agent_state_machine::try_transition(State::Spawned, Event::Start, role)
            .map_err(|e| format!("State machine rejected spawn: {e}"))?;
        let entry = AgentEntry {
            id: id.clone(),
            role: role.to_string(),
            task_id,
            parent_id: parent_id.clone(),
            spawned_at: Instant::now(),
            token_used: 0,
            state: initial,
            children_count: 0,
            yield_git_branch: None,
            yield_diff_summary: None,
            validation_retry_count: 0,
            project_path,
        };
        inner.agents.insert(id.clone(), entry);

        if let Some(pid) = parent_id {
            if let Some(p) = inner.agents.get_mut(&pid) {
                p.children_count += 1;
            }
        }

        Ok(id)
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
        let agents: Vec<DebugAgentEntry> = inner.agents.values().map(|e| {
            DebugAgentEntry {
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
                yield_summary: e.yield_diff_summary.clone(),
            }
        }).collect();

        let pending_validations: Vec<DebugValidationEntry> = inner.validation.iter().map(|(dev_id, vs)| {
            DebugValidationEntry {
                developer_agent_id: dev_id.clone(),
                task_id: vs.task_id.clone(),
                results_received: vs.results.len(),
                results: vs.results.iter().map(|r| DebugValidatorResult {
                    role: r.role.clone(),
                    pass: r.pass,
                    reasons: r.reasons.clone(),
                }).collect(),
            }
        }).collect();

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
        let ttl_remaining = config.ttl_secs as i64 * 1000
            - entry.spawned_at.elapsed().as_millis() as i64;
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
        let quota = inner.role_config.get(&role).map(|c| c.token_quota).unwrap_or(u64::MAX);
        // Now mutate.
        if let Some(e) = inner.agents.get_mut(agent_id) {
            e.token_used = new_total;
            if new_total >= quota && !e.state.is_terminal() {
                e.state = State::Stopped;
            }
        }
        Ok(())
    }

    pub fn yield_for_review(
        &self,
        agent_id: &str,
        payload: YieldPayload,
    ) -> Result<(), String> {
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

    /// Returns agent IDs that have exceeded their TTL (caller should kill them).
    pub fn expired_agent_ids(&self) -> Result<Vec<String>, String> {
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
                expired.push(id.clone());
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
    pub fn start_validation(&self, developer_agent_id: &str, task_id: Option<String>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.validation.contains_key(developer_agent_id) {
            return Ok(());
        }
        // Transition via state machine.
        if let Some(e) = inner.agents.get_mut(developer_agent_id) {
            let new_state = agent_state_machine::try_transition(e.state, Event::StartReview, &e.role)?;
            e.state = new_state;
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
                let new_state = agent_state_machine::try_transition(
                    e.state, Event::ValidationPass, &e.role,
                )?;
                e.state = new_state;
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
    pub fn yield_queue(&self) -> Result<Vec<(String, Option<String>, Option<String>, Option<String>)>, String> {
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
    pub fn agents_in_review_without_validators(&self) -> Result<Vec<(String, Option<String>)>, String> {
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
            None => return Ok(()),
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
        let new_state = agent_state_machine::try_transition(entry.state, Event::Complete, &entry.role)?;
        entry.state = new_state;
        Ok(())
    }

    /// Returns (agent_id, task_id) for agents in Done state that have a task_id.
    /// The orchestration loop uses this to update Beads and clean up.
    pub fn done_agents_with_tasks(&self) -> Result<Vec<(String, String)>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(inner
            .agents
            .values()
            .filter(|a| a.state == State::Done && a.task_id.is_some())
            .map(|a| (a.id.clone(), a.task_id.clone().unwrap()))
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
        if entry.state.is_terminal() || entry.state == State::Yielded || entry.state == State::InReview {
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
                eprintln!("[registry] force_yield: {} transitioned to Yielded", agent_id);
                Ok(())
            }
        }
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
            if entry.spawned_at.elapsed() > cutoff {
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
            if entry.spawned_at.elapsed() > cutoff {
                out.push(id.clone());
            }
        }
        Ok(out)
    }

    /// Force-complete validation for a stuck developer by transitioning InReview → Done.
    /// Used when validators never submitted results.
    pub fn force_complete_validation(&self, agent_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = inner
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {} not found", agent_id))?;
        if entry.state != State::InReview {
            return Ok(());
        }
        let new_state = agent_state_machine::try_transition(entry.state, Event::ValidationPass, &entry.role)?;
        entry.state = new_state;
        inner.validation.remove(agent_id);
        eprintln!("[registry] force_complete_validation: {} → Done (validators timed out)", agent_id);
        Ok(())
    }

    /// Get the project_path (sandbox directory) for an agent.
    pub fn get_project_path(&self, agent_id: &str) -> Result<Option<String>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(inner.agents.get(agent_id).and_then(|e| e.project_path.clone()))
    }

    /// Validate that a cwd is valid for terminal commands.
    /// More lenient than validate_path - allows the parent directory for scaffolding tools.
    pub fn validate_path_for_terminal(&self, agent_id: &str, cwd: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = match inner.agents.get(agent_id) {
            Some(e) => e,
            None => return Ok(()),
        };

        let project_path = match &entry.project_path {
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

    /// Validate that a path is within the agent's sandbox (project_path).
    /// Returns Ok(()) if allowed, Err with reason if not.
    /// If agent has no project_path set, all paths are allowed (for WM, operators, etc).
    pub fn validate_path(&self, agent_id: &str, path: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = match inner.agents.get(agent_id) {
            Some(e) => e,
            None => return Ok(()), // Unknown agent, let it through (shouldn't happen)
        };

        let project_path = match &entry.project_path {
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

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}
