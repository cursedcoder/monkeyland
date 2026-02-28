//! Orchestration loop: poll bd ready, spawn agents, claim tasks, kill expired, process yield queue.

use crate::agent_registry::AgentRegistry;
use crate::pty_pool::PtyPool;
use crate::storage::MetaDb;
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::Emitter;

const BEADS_PROJECT_PATH_KEY: &str = "beads_project_path";

/// 0 = idle (never started), 1 = running, 2 = paused
pub struct OrchestrationState(AtomicU8);

impl OrchestrationState {
    pub fn new() -> Self {
        Self(AtomicU8::new(0))
    }

    pub fn get(&self) -> u8 {
        self.0.load(Ordering::Relaxed)
    }

    pub fn set_running(&self) {
        self.0.store(1, Ordering::Relaxed);
    }

    pub fn set_paused(&self) {
        self.0.store(2, Ordering::Relaxed);
    }

    pub fn is_running(&self) -> bool {
        self.0.load(Ordering::Relaxed) == 1
    }
}

/// Run `bd` with args in project_path. Returns stdout. Runs in blocking context.
pub fn run_bd_sync(project_path: &Path, args: &[String]) -> Result<String, String> {
    if !project_path.is_dir() {
        return Err("project_path is not a directory".to_string());
    }
    let out = Command::new("bd")
        .args(args)
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("Failed to run bd: {}", e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("bd failed: {}", stderr.trim()));
    }
    Ok(stdout)
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSpawnedPayload {
    pub agent_id: String,
    pub role: String,
    pub task_id: Option<String>,
    pub parent_agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentKilledPayload {
    pub agent_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ValidationRequestedPayload {
    pub developer_agent_id: String,
    pub task_id: Option<String>,
    pub git_branch: Option<String>,
    pub diff_summary: Option<String>,
}

/// One tick: get ready tasks, spawn agents, claim in Beads, kill expired, process yield queue.
pub async fn tick(
    app_handle: &tauri::AppHandle,
    meta_db: &MetaDb,
    registry: &AgentRegistry,
    pool: &PtyPool,
) -> Result<(), String> {
    let project_path = match meta_db.get_setting(BEADS_PROJECT_PATH_KEY)? {
        Some(p) if !p.is_empty() => p,
        _ => return Ok(()),
    };
    let path = std::path::Path::new(&project_path);
    if !path.is_dir() {
        return Ok(());
    }

    // 1. bd ready --json
    let args = vec!["ready".to_string(), "--json".to_string()];
    let stdout = tokio::task::spawn_blocking({
        let path = path.to_path_buf();
        move || run_bd_sync(&path, &args)
    })
    .await
    .map_err(|e| e.to_string())??;

    let tasks: Vec<BeadsIssue> = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(_) => {
            // bd might return empty array or different shape
            if let Ok(arr) = serde_json::from_str::<serde_json::Value>(&stdout) {
                if let Some(arr) = arr.as_array() {
                    let mut out = Vec::new();
                    for item in arr {
                        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                            let issue_type = item.get("issue_type")
                                .or_else(|| item.get("type"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("task")
                                .to_string();
                            let priority = item.get("priority").and_then(|v| v.as_u64()).unwrap_or(2) as u8;
                            out.push(BeadsIssue {
                                id: id.to_string(),
                                issue_type,
                                priority,
                            });
                        }
                    }
                    out
                } else {
                    return Ok(());
                }
            } else {
                return Ok(());
            }
        }
    };

    let path_for_claim = path.to_path_buf();

    // 2. For each task, try to spawn and claim (skip if already claimed by an agent we track)
    let claimed_task_ids = registry.claimed_task_ids()?;
    for task in tasks {
        if claimed_task_ids.contains(&task.id) {
            continue;
        }
        let role = role_for_task(&task.issue_type, task.priority);
        if !registry.can_spawn_role(&role)? {
            continue;
        }
        let agent_id = match registry.spawn(&role, Some(task.id.clone()), None, Some(project_path.clone())) {
            Ok(id) => id,
            Err(_) => continue,
        };
        if pool.spawn(&agent_id, 80, 24, Some(path)).is_err() {
            let _ = registry.kill(&agent_id);
            continue;
        }
        // bd update <id> --claim --assignee <agent_id>
        let claim_args = vec![
            "update".to_string(),
            task.id.clone(),
            "--claim".to_string(),
            "--assignee".to_string(),
            agent_id.clone(),
        ];
        let path_claim = path_for_claim.clone();
        let _ = tokio::task::spawn_blocking(move || run_bd_sync(&path_claim, &claim_args)).await;

        let _ = app_handle.emit(
            "agent_spawned",
            AgentSpawnedPayload {
                agent_id: agent_id.clone(),
                role: role.clone(),
                task_id: Some(task.id.clone()),
                parent_agent_id: None,
            },
        );
    }

    // 3. Kill expired agents
    let expired = registry.expired_agent_ids()?;
    for id in expired {
        let _ = registry.kill(&id);
        let _ = pool.kill(&id);
        let _ = app_handle.emit(
            "agent_killed",
            AgentKilledPayload {
                agent_id: id.clone(),
                reason: "ttl_expired".to_string(),
            },
        );
    }

    // 4. Process yield queue: agents in Yielded state get validation started and frontend is notified
    let yield_queue = registry.yield_queue()?;
    for (developer_agent_id, task_id, git_branch, diff_summary) in yield_queue {
        let _ = registry.start_validation(&developer_agent_id, task_id.clone());
        let _ = app_handle.emit(
            "validation_requested",
            ValidationRequestedPayload {
                developer_agent_id: developer_agent_id.clone(),
                task_id,
                git_branch,
                diff_summary,
            },
        );
    }

    // 5. Mark completed tasks in Beads (agents in Done state with a task_id)
    let done_agents = registry.done_agents_with_tasks()?;
    for (agent_id, task_id) in done_agents {
        let done_args = vec![
            "update".to_string(),
            task_id.clone(),
            "--status".to_string(),
            "done".to_string(),
        ];
        let path_done = path.to_path_buf();
        let _ = tokio::task::spawn_blocking(move || run_bd_sync(&path_done, &done_args)).await;
        // Clean up the agent from registry now that it's fully done.
        let _ = registry.kill(&agent_id);
        let _ = pool.kill(&agent_id);
    }

    Ok(())
}

#[derive(Debug, serde::Deserialize)]
struct BeadsIssue {
    id: String,
    #[serde(alias = "type", alias = "issue_type", default)]
    issue_type: String,
    #[serde(default = "default_priority")]
    priority: u8,
}

fn default_priority() -> u8 {
    2
}

fn role_for_task(issue_type: &str, _priority: u8) -> String {
    match issue_type.to_lowercase().as_str() {
        "epic" => "project_manager".to_string(),
        // All task types go to developers. Workers are sub-agents spawned by
        // developers on-demand, not independent task assignees from Beads.
        // Developers go through validation; workers don't.
        _ => "developer".to_string(),
    }
}
