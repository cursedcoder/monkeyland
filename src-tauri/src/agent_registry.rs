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
        "code_review_validator".to_string(),
        RoleConfig {
            ttl_secs: 300,
            token_quota: 50_000,
            max_children: 0,
            max_count: 15,
        },
    );
    m.insert(
        "business_logic_validator".to_string(),
        RoleConfig {
            ttl_secs: 300,
            token_quota: 50_000,
            max_children: 0,
            max_count: 15,
        },
    );
    m.insert(
        "scope_validator".to_string(),
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

    /// Spawn a new agent (register only; caller must create PTY/session with returned id).
    /// Returns agent_id to use as session_id for the PTY.
    pub fn spawn(
        &self,
        role: &str,
        task_id: Option<String>,
        parent_id: Option<String>,
    ) -> Result<String, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let config = inner
            .role_config
            .get(role)
            .ok_or_else(|| format!("Unknown role: {}", role))?;

        if let Some(ref pid) = parent_id {
            if let Some(parent) = inner.agents.get(pid) {
                if parent.children_count >= config.max_children {
                    return Err(format!(
                        "Parent {} at max_children {}",
                        pid, config.max_children
                    ));
                }
            }
        }

        let count_for_role = inner
            .agents
            .values()
            .filter(|a| a.role == role && !a.state.is_terminal())
            .count();
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
        Ok(true)
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

    /// Submit a validator result. Returns Some(true) if all 3 passed, Some(false) if any failed, None if still waiting.
    /// Uses the state machine for InReview → Done / Running / Blocked transitions.
    pub fn validation_submit(
        &self,
        developer_agent_id: &str,
        role: &str,
        pass: bool,
        reasons: Vec<String>,
    ) -> Result<Option<bool>, String> {
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
        inner.validation.remove(developer_agent_id);
        if let Some(e) = inner.agents.get_mut(developer_agent_id) {
            if all_passed {
                let new_state = agent_state_machine::try_transition(
                    e.state, Event::ValidationPass, &e.role,
                )?;
                e.state = new_state;
            } else {
                e.validation_retry_count += 1;
                let event = if e.validation_retry_count >= 3 {
                    Event::ValidationBlock
                } else {
                    Event::ValidationFail
                };
                let new_state = agent_state_machine::try_transition(e.state, event, &e.role)?;
                e.state = new_state;
            }
        }
        Ok(Some(all_passed))
    }

    /// Returns (task_id, git_branch, diff_summary) for agents in InReview that have not yet had validation started.
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

    /// Gate a tool call: checks that the agent exists, is Running, has permission, and is within quota/TTL.
    /// Every Tauri command that an LLM agent can invoke must call this first.
    pub fn gate_tool(&self, agent_id: &str, command_name: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = inner
            .agents
            .get(agent_id)
            .ok_or_else(|| format!("Agent {agent_id} not found in registry"))?;
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
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}
