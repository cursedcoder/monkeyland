//! Agent registry: track spawned agents, TTL, token quotas, and parent-child relationship.
//! Used by the orchestration loop and containment protocol.

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentStatus {
    Running,
    Waiting,
    InReview,
    Blocked,
    Stopped,
}

impl std::fmt::Display for AgentStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentStatus::Running => write!(f, "running"),
            AgentStatus::Waiting => write!(f, "waiting"),
            AgentStatus::InReview => write!(f, "in_review"),
            AgentStatus::Blocked => write!(f, "blocked"),
            AgentStatus::Stopped => write!(f, "stopped"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentEntry {
    pub id: String,
    pub role: String,
    pub task_id: Option<String>,
    pub parent_id: Option<String>,
    pub spawned_at: Instant,
    pub token_used: u64,
    pub status: AgentStatus,
    pub children_count: u32,
    /// Set when agent yields for validation (Phase 3).
    pub yield_git_branch: Option<String>,
    pub yield_diff_summary: Option<String>,
    /// Number of validation attempts (max 3 per plan).
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
            .filter(|a| a.role == role && a.status != AgentStatus::Stopped)
            .count();
        if count_for_role >= config.max_count as usize {
            return Err(format!(
                "Role {} at max_count {}",
                role, config.max_count
            ));
        }

        let id = ulid::Ulid::new().to_string();
        let entry = AgentEntry {
            id: id.clone(),
            role: role.to_string(),
            task_id,
            parent_id: parent_id.clone(),
            spawned_at: Instant::now(),
            token_used: 0,
            status: AgentStatus::Running,
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
        let entry = match inner.agents.remove(agent_id) {
            Some(e) => e,
            None => return Ok(false),
        };
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
            if a.status != AgentStatus::Stopped {
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
        if let Some(e) = inner.agents.get_mut(agent_id) {
            e.token_used = e.token_used.saturating_add(delta);
        }
        Ok(())
    }

    pub fn yield_for_review(
        &self,
        agent_id: &str,
        payload: YieldPayload,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(e) = inner.agents.get_mut(agent_id) {
            if e.validation_retry_count >= 3 {
                e.status = AgentStatus::Blocked;
                return Err("Max validation retries (3) exceeded".to_string());
            }
            e.status = AgentStatus::InReview;
            e.yield_git_branch = payload.git_branch;
            e.yield_diff_summary = payload.diff_summary;
        }
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
            if entry.status == AgentStatus::Stopped {
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
            .filter(|a| a.status != AgentStatus::Stopped && a.task_id.is_some())
            .filter_map(|a| a.task_id.clone())
            .collect())
    }

    /// Start validation for a developer that yielded: record that we're waiting for 3 validator results.
    pub fn start_validation(&self, developer_agent_id: &str, task_id: Option<String>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.validation.contains_key(developer_agent_id) {
            return Ok(());
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
    pub fn validation_submit(
        &self,
        developer_agent_id: &str,
        role: &str,
        pass: bool,
        reasons: Vec<String>,
    ) -> Result<Option<bool>, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let state = match inner.validation.get_mut(developer_agent_id) {
            Some(s) => s,
            None => return Ok(None),
        };
        if state.results.iter().any(|r| r.role == role) {
            return Ok(None);
        }
        state.results.push(ValidatorResult {
            role: role.to_string(),
            pass,
            reasons,
        });
        if state.results.len() < 3 {
            return Ok(None);
        }
        let all_passed = state.results.iter().all(|r| r.pass);
        inner.validation.remove(developer_agent_id);
        if let Some(e) = inner.agents.get_mut(developer_agent_id) {
            if all_passed {
                e.status = AgentStatus::Running;
            } else {
                e.validation_retry_count += 1;
                e.status = if e.validation_retry_count >= 3 {
                    AgentStatus::Blocked
                } else {
                    AgentStatus::Running
                };
            }
        }
        Ok(Some(all_passed))
    }

    /// Returns (task_id, git_branch, diff_summary) for agents in InReview that have not yet had validation started.
    pub fn yield_queue(&self) -> Result<Vec<(String, Option<String>, Option<String>, Option<String>)>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for (id, entry) in inner.agents.iter() {
            if entry.status != AgentStatus::InReview {
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
            .filter(|a| a.role == role && a.status != AgentStatus::Stopped)
            .count();
        Ok(count < config.max_count as usize)
    }
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}
