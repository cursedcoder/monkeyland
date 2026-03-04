//! Orchestration loop: poll bd ready, spawn agents, claim tasks, kill expired, process yield queue.

use crate::agent_registry::AgentRegistry;
use crate::pty_pool::PtyPool;
use crate::storage::MetaDb;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use tauri::Emitter;
use tokio::sync::Mutex as TokioMutex;

// ---------------------------------------------------------------------------
// OrchEnv trait — abstracts external I/O so tick() is testable without Tauri
// ---------------------------------------------------------------------------

/// External environment used by the orchestration loop.
/// Production code uses `TauriOrchEnv`; tests inject a stub.
pub trait OrchEnv: Send + Sync {
    fn emit_event(&self, event: &str, payload: serde_json::Value) -> Result<(), String>;
    fn run_bd(&self, project_path: &Path, args: &[String]) -> Result<String, String>;
    fn spawn_pty(&self, id: &str, cols: u16, rows: u16, cwd: Option<&Path>) -> Result<(), String>;
    fn kill_pty(&self, id: &str) -> Result<(), String>;
}

// Convenience helpers for calling env methods from async tick().
// env.run_bd() blocks briefly, acceptable since tick() runs on its own spawned task.
fn env_emit<T: Serialize>(env: &dyn OrchEnv, event: &str, payload: &T) -> Result<(), String> {
    let val = serde_json::to_value(payload).map_err(|e| e.to_string())?;
    env.emit_event(event, val)
}

/// Production implementation wrapping Tauri AppHandle + PtyPool.
pub struct TauriOrchEnv<'a> {
    pub app_handle: &'a tauri::AppHandle,
    pub pool: &'a PtyPool,
}

impl<'a> OrchEnv for TauriOrchEnv<'a> {
    fn emit_event(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
        self.app_handle
            .emit(event, payload)
            .map_err(|e| e.to_string())
    }

    fn run_bd(&self, project_path: &Path, args: &[String]) -> Result<String, String> {
        run_bd_sync(project_path, args)
    }

    fn spawn_pty(&self, id: &str, cols: u16, rows: u16, cwd: Option<&Path>) -> Result<(), String> {
        self.pool.spawn(id, cols, rows, cwd)
    }

    fn kill_pty(&self, id: &str) -> Result<(), String> {
        self.pool.kill(id)
    }
}

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

/// Return epic IDs that are eligible to close.
///
/// Preferred path uses `bd epic close-eligible --json`.
/// Fallback path computes eligibility from `bd list --json --all --limit 0`
/// so we still work on older/newer Beads CLIs where epic subcommands differ.
fn close_eligible_epic_ids_sync(project_path: &Path) -> Result<Vec<String>, String> {
    let preferred = vec![
        "epic".to_string(),
        "close-eligible".to_string(),
        "--json".to_string(),
    ];
    if let Ok(stdout) = run_bd_sync(project_path, &preferred) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&stdout) {
            if let Some(arr) = val.as_array() {
                let mut ids: Vec<String> = arr
                    .iter()
                    .filter_map(|epic| epic.get("id").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
                    .collect();
                ids.sort();
                ids.dedup();
                return Ok(ids);
            }
        }
    }

    // Fallback: derive close-eligible epics from full task list.
    let list_args = vec![
        "list".to_string(),
        "--json".to_string(),
        "--all".to_string(),
        "--limit".to_string(),
        "0".to_string(),
    ];
    let stdout = run_bd_sync(project_path, &list_args)?;
    let val: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse bd list json for epic fallback: {e}"))?;
    let Some(items) = val.as_array() else {
        return Ok(Vec::new());
    };

    Ok(close_eligible_from_task_list(items))
}

/// Parse a full task list to find epic IDs whose children are ALL done.
/// Extracted from `close_eligible_epic_ids_sync` for testability.
fn close_eligible_from_task_list(items: &[serde_json::Value]) -> Vec<String> {
    let mut epics = HashSet::new();
    let mut child_statuses: HashMap<String, Vec<String>> = HashMap::new();
    for item in items {
        let issue_type = item
            .get("issue_type")
            .or_else(|| item.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_lowercase();
        let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
            continue;
        };

        if issue_type == "epic" {
            epics.insert(id.to_string());
        }

        if let Some(parent) = item.get("parent").and_then(|v| v.as_str()) {
            let status = item
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_lowercase();
            child_statuses
                .entry(parent.to_string())
                .or_default()
                .push(status);
        }
    }

    let mut eligible = Vec::new();
    for epic_id in epics {
        let Some(children) = child_statuses.get(&epic_id) else {
            continue;
        };
        if !children.is_empty() && children.iter().all(|s| s == "done" || s == "closed") {
            eligible.push(epic_id);
        }
    }
    eligible.sort();
    eligible.dedup();
    eligible
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSpawnedPayload {
    pub agent_id: String,
    pub role: String,
    pub task_id: Option<String>,
    pub parent_agent_id: Option<String>,
    pub merge_context: Option<MergeContext>,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeContext {
    pub base_branch: String,
    pub task_branch: String,
    pub conflict_diff: String,
    pub task_description: String,
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
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PMValidationRequestedPayload {
    pub pm_agent_id: String,
    pub epic_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EpicProgressPayload {
    pub epic_id: String,
    pub total: u32,
    pub done: u32,
    pub in_progress: u32,
    pub open: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeStatusPayload {
    pub task_id: String,
    pub status: String, // "merging" | "conflict" | "done" | "failed"
    pub detail: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MergeEntry {
    pub agent_id: String,
    pub task_id: String,
    pub retry_count: u8,
}

/// Serialized merge queue. Only one merge runs at a time via the git_lock mutex.
pub struct MergeQueue {
    queue: Mutex<VecDeque<MergeEntry>>,
    queued_tasks: Mutex<HashSet<String>>,
    git_lock: TokioMutex<()>,
    /// Tracks retry counts for tasks with active merge agents.
    /// Set when a merge agent is spawned; consumed when the merge agent completes.
    retry_counts: Mutex<HashMap<String, u8>>,
}

impl MergeQueue {
    pub fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            queued_tasks: Mutex::new(HashSet::new()),
            git_lock: TokioMutex::new(()),
            retry_counts: Mutex::new(HashMap::new()),
        }
    }

    pub fn push(&self, entry: MergeEntry) -> bool {
        let mut queued = self.queued_tasks.lock().unwrap();
        if queued.contains(&entry.task_id) {
            return false;
        }
        queued.insert(entry.task_id.clone());
        drop(queued);
        let mut q = self.queue.lock().unwrap();
        q.push_back(entry);
        true
    }

    pub fn pop_front(&self) -> Option<MergeEntry> {
        let mut q = self.queue.lock().unwrap();
        let entry = q.pop_front();
        drop(q);
        if let Some(ref e) = entry {
            let mut queued = self.queued_tasks.lock().unwrap();
            queued.remove(&e.task_id);
        }
        entry
    }

    pub fn is_empty(&self) -> bool {
        self.queue.lock().unwrap().is_empty()
    }

    pub fn depth(&self) -> usize {
        self.queue.lock().unwrap().len()
    }

    /// Record the retry count for a task with an active merge agent.
    pub fn set_retry_count(&self, task_id: &str, count: u8) {
        self.retry_counts
            .lock()
            .unwrap()
            .insert(task_id.to_string(), count);
    }

    /// Consume and return the retry count for a task (returns 0 if unset).
    pub fn take_retry_count(&self, task_id: &str) -> u8 {
        self.retry_counts
            .lock()
            .unwrap()
            .remove(task_id)
            .unwrap_or(0)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OrchestrationMetricsSnapshot {
    pub merge_queue_depth: u64,
    pub merge_retry_count: u64,
    pub validation_timeout_blocks: u64,
    pub safety_mode_enabled: bool,
}

pub struct OrchestrationMetrics {
    merge_retry_count: AtomicU64,
    validation_timeout_blocks: AtomicU64,
    safety_mode_enabled: AtomicBool,
}

impl OrchestrationMetrics {
    pub fn new() -> Self {
        Self {
            merge_retry_count: AtomicU64::new(0),
            validation_timeout_blocks: AtomicU64::new(0),
            safety_mode_enabled: AtomicBool::new(false),
        }
    }

    pub fn inc_merge_retry(&self) {
        self.merge_retry_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_validation_timeout_block(&self) {
        self.validation_timeout_blocks
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn set_safety_mode_enabled(&self, enabled: bool) {
        self.safety_mode_enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn snapshot(&self, merge_queue_depth: u64) -> OrchestrationMetricsSnapshot {
        OrchestrationMetricsSnapshot {
            merge_queue_depth,
            merge_retry_count: self.merge_retry_count.load(Ordering::Relaxed),
            validation_timeout_blocks: self.validation_timeout_blocks.load(Ordering::Relaxed),
            safety_mode_enabled: self.safety_mode_enabled.load(Ordering::Relaxed),
        }
    }
}

/// One tick: get ready tasks, spawn agents, claim in Beads, kill expired, process yield queue.
pub async fn tick(
    env: &dyn OrchEnv,
    meta_db: &MetaDb,
    registry: &AgentRegistry,
    merge_queue: &MergeQueue,
    metrics: &OrchestrationMetrics,
) -> Result<(), String> {
    let project_path = match meta_db.get_setting(BEADS_PROJECT_PATH_KEY)? {
        Some(p) if !p.is_empty() => p,
        _ => return Ok(()),
    };
    let path = std::path::Path::new(&project_path);
    if !path.is_dir() {
        return Ok(());
    }

    let safety_mode_enabled = meta_db
        .get_setting("safety_mode_enabled")?
        .map(|v| v == "1")
        .unwrap_or(false);
    metrics.set_safety_mode_enabled(safety_mode_enabled);
    let max_new_agents_per_tick = if safety_mode_enabled {
        2usize
    } else {
        usize::MAX
    };
    let max_merges_per_tick = if safety_mode_enabled { 1usize } else { 3usize };

    // 1. bd ready --json — failure must NOT prevent steps 3–6 (merge train, cleanup, etc.)
    let tasks: Vec<BeadsIssue> =
        match env.run_bd(path, &vec!["ready".to_string(), "--json".to_string()]) {
            Ok(stdout) => match serde_json::from_str(&stdout) {
                Ok(v) => v,
                Err(_) => {
                    if let Ok(arr) = serde_json::from_str::<serde_json::Value>(&stdout) {
                        if let Some(arr) = arr.as_array() {
                            let mut out = Vec::new();
                            for item in arr {
                                if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                                    let issue_type = item
                                        .get("issue_type")
                                        .or_else(|| item.get("type"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("task")
                                        .to_string();
                                    let priority =
                                        item.get("priority").and_then(|v| v.as_u64()).unwrap_or(2)
                                            as u8;
                                    out.push(BeadsIssue {
                                        id: id.to_string(),
                                        issue_type,
                                        priority,
                                    });
                                }
                            }
                            out
                        } else {
                            Vec::new()
                        }
                    } else {
                        Vec::new()
                    }
                }
            },
            Err(e) => {
                eprintln!("[orch] bd ready failed (non-fatal, continuing tick): {e}");
                Vec::new()
            }
        };

    // 2. For each task, try to spawn and claim (skip if already claimed by an agent we track)
    let claimed_task_ids = registry.claimed_task_ids()?;
    let mut spawned_this_tick = 0usize;
    for task in tasks {
        if spawned_this_tick >= max_new_agents_per_tick {
            break;
        }
        if claimed_task_ids.contains(&task.id) {
            continue;
        }
        let role = role_for_task(&task.issue_type, task.priority);
        if !registry.can_spawn_role(&role)? {
            continue;
        }
        let agent_id = match registry.spawn(
            &role,
            Some(task.id.clone()),
            None,
            Some(project_path.clone()),
        ) {
            Ok(id) => id,
            Err(_) => continue,
        };

        // For developer agents, create an isolated git worktree so concurrent
        // agents don't stomp on each other's files.
        let agent_cwd = if role == "developer" && path.join(".git").exists() {
            let wt_path_buf = path.to_path_buf();
            let wt_agent_id = agent_id.clone();
            let wt_task_id = task.id.clone();
            match tokio::task::spawn_blocking(move || {
                // Use Project abstraction for proper state validation
                let mut project =
                    crate::project::Project::open(&wt_path_buf).map_err(|e| e.to_string())?;

                // Ensure project is ready (has commits) before creating worktree
                project.ensure_ready().map_err(|e| e.to_string())?;

                // Create the worktree
                project
                    .create_worktree(&wt_agent_id, &wt_task_id)
                    .map_err(|e| e.to_string())
            })
            .await
            {
                Ok(Ok(wt)) => {
                    let _ = registry.set_worktree_path(&agent_id, wt.to_str().unwrap_or_default());
                    wt
                }
                Ok(Err(e)) => {
                    eprintln!("[orch] worktree creation failed for {agent_id}: {e}");
                    // Kill the agent rather than falling back to project dir
                    // This ensures isolation is maintained
                    let _ = registry.kill(&agent_id);
                    continue;
                }
                Err(join_err) => {
                    eprintln!("[orch] worktree spawn_blocking panicked for {agent_id}: {join_err}");
                    let _ = registry.kill(&agent_id);
                    continue;
                }
            }
        } else {
            path.to_path_buf()
        };

        if env
            .spawn_pty(&agent_id, 80, 24, Some(agent_cwd.as_path()))
            .is_err()
        {
            if let Ok(Some(_)) = registry.get_worktree_path(&agent_id) {
                let rm_path = path.to_path_buf();
                let rm_agent = agent_id.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    crate::worktree::remove(&rm_path, &rm_agent)
                })
                .await;
            }
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
        let _ = env.run_bd(path, &claim_args);

        let worktree_path = if role == "developer" {
            Some(agent_cwd.to_string_lossy().to_string())
        } else {
            None
        };
        let _ = env_emit(
            env,
            "agent_spawned",
            &AgentSpawnedPayload {
                agent_id: agent_id.clone(),
                role: role.clone(),
                task_id: Some(task.id.clone()),
                parent_agent_id: None,
                merge_context: None,
                worktree_path,
            },
        );
        spawned_this_tick += 1;
    }

    // 3. Kill expired agents (clean up worktree without merging, release Beads claim)
    let expired = registry.expired_agent_ids()?;
    for (id, task_id, role) in expired {
        if let Ok(Some(_wt)) = registry.get_worktree_path(&id) {
            let wt_path = path.to_path_buf();
            let wt_id = id.clone();
            let _ = tokio::task::spawn_blocking(move || crate::worktree::remove(&wt_path, &wt_id))
                .await;
        }
        // Release the Beads task claim so the task can be re-assigned —
        // but only for roles that own the task (spawned via bd ready).
        // Validators and merge_agents carry the developer's task_id for
        // association but must NOT reset the task status on expiry.
        let owns_task = role != "validator" && role != "merge_agent";
        if owns_task {
            if let Some(tid) = &task_id {
                let unclaim_args = vec![
                    "update".to_string(),
                    tid.clone(),
                    "--status".to_string(),
                    "ready".to_string(),
                ];
                let _ = env.run_bd(path, &unclaim_args);
            }
        }
        let _ = registry.kill(&id);
        let _ = env.kill_pty(&id);
        let _ = env_emit(
            env,
            "agent_killed",
            &AgentKilledPayload {
                agent_id: id.clone(),
                reason: "ttl_expired".to_string(),
            },
        );
    }

    // 4. Process yield queue: agents in Yielded state get validation started and frontend is notified
    // Note: yield_queue only returns agents that haven't had start_validation called yet,
    // so this naturally runs only once per yielded developer.
    let yield_queue = registry.yield_queue()?;
    for (developer_agent_id, task_id, git_branch, diff_summary) in yield_queue {
        eprintln!(
            "[orch] Processing yield queue: developer {} in Yielded state",
            developer_agent_id
        );
        match registry.start_validation(&developer_agent_id, task_id.clone()) {
            Ok(_) => eprintln!(
                "[orch] start_validation succeeded for {}",
                developer_agent_id
            ),
            Err(e) => {
                eprintln!(
                    "[orch] start_validation FAILED for {}: {}",
                    developer_agent_id, e
                );
                // Force it anyway
                let _ = registry.force_start_validation(&developer_agent_id);
            }
        }
        // Get the developer's worktree path so the validator can work on the same code
        let worktree_path = registry
            .get_worktree_path(&developer_agent_id)
            .ok()
            .flatten();
        eprintln!(
            "[orch] Emitting validation_requested for developer {} (worktree: {:?})",
            developer_agent_id, worktree_path
        );
        if let Err(e) = env_emit(
            env,
            "validation_requested",
            &ValidationRequestedPayload {
                developer_agent_id: developer_agent_id.clone(),
                task_id,
                git_branch,
                diff_summary,
                worktree_path,
            },
        ) {
            eprintln!("[orch] FAILED to emit validation_requested: {}", e);
        }
    }

    // 4a. Process PM yield queue: PM agents in Yielded state get PM validation started
    let pm_yield_queue = registry.pm_yield_queue()?;
    for (pm_agent_id, epic_id) in pm_yield_queue {
        eprintln!(
            "[orch] Processing PM yield queue: PM {} in Yielded state for epic {:?}",
            pm_agent_id, epic_id
        );
        match registry.start_pm_validation(&pm_agent_id, epic_id.clone()) {
            Ok(_) => eprintln!("[orch] start_pm_validation succeeded for {}", pm_agent_id),
            Err(e) => {
                eprintln!(
                    "[orch] start_pm_validation FAILED for {}: {}",
                    pm_agent_id, e
                );
            }
        }
        eprintln!(
            "[orch] Emitting pm_validation_requested for PM {}",
            pm_agent_id
        );
        if let Err(e) = env_emit(
            env,
            "pm_validation_requested",
            &PMValidationRequestedPayload {
                pm_agent_id: pm_agent_id.clone(),
                epic_id,
            },
        ) {
            eprintln!("[orch] FAILED to emit pm_validation_requested: {}", e);
        }
    }

    // 4b. SAFETY NET: Force-yield developers stuck in Running state for > 5 minutes.
    // This catches ALL cases: nudge failed, frontend crashed, LLM looped forever, etc.
    // After force_yield, the agent goes to Yielded without a validation entry,
    // so the NEXT tick's yield_queue (step 4) will pick it up normally.
    let stuck_running = registry.stuck_running_developers(300)?;
    for agent_id in &stuck_running {
        eprintln!(
            "[orch] SAFETY NET: Force-yielding developer {} stuck in Running for >5min",
            agent_id
        );
        let _ = registry.force_yield(agent_id);
        let _ = env_emit(
            env,
            "agent_force_yielded",
            &serde_json::json!({ "agent_id": agent_id, "reason": "stuck_running_timeout" }),
        );
    }

    // 4c. SAFETY NET: Force-block developers stuck in InReview for > 5 minutes.
    // Validators may have failed to spawn/complete without submitting results.
    let stuck_review = registry.stuck_in_review_developers(300)?;
    for agent_id in stuck_review {
        eprintln!(
            "[orch] SAFETY NET: Force-blocking developer {} stuck in InReview for >5min",
            agent_id
        );
        metrics.inc_validation_timeout_block();
        let _ = registry.force_block_validation(&agent_id);
    }

    // 4d. SAFETY NET: Force-yield PMs stuck in Running state for > 5 minutes.
    // PMs should create subtasks and yield for validation. If the frontend nudge mechanism
    // fails or the PM gets stuck, this ensures they eventually enter the yield queue.
    let stuck_pms = registry.stuck_running_pms(300)?;
    for agent_id in &stuck_pms {
        eprintln!(
            "[orch] SAFETY NET: Force-yielding PM {} stuck in Running for >5min",
            agent_id
        );
        let _ = registry.force_yield(agent_id);
        let _ = env_emit(
            env,
            "agent_force_yielded",
            &serde_json::json!({ "agent_id": agent_id, "reason": "pm_stuck_running_timeout" }),
        );
    }

    // 5. Enqueue done agents for merge (or kill non-merging roles immediately).
    //    Developer agents get their worktree removed and pushed onto the merge queue,
    //    then killed so they aren't re-processed on the next tick.
    //    PM agents are killed immediately (epics handled by auto-close in step 6).
    //    Merge agents re-enqueue the task for another merge attempt (retry tracked externally).
    let done_agents = registry.done_agents_with_tasks()?;
    for (agent_id, task_id, role) in done_agents {
        if role == "project_manager" {
            eprintln!("[orch] skipping merge for epic task {task_id} (PM agent); auto-close will handle it");
            let _ = registry.kill(&agent_id);
            let _ = env.kill_pty(&agent_id);
            continue;
        }
        if role == "merge_agent" {
            eprintln!(
                "[orch] merge agent {agent_id} done for task {task_id}; re-enqueueing for merge"
            );
            if let Ok(Some(_wt)) = registry.get_worktree_path(&agent_id) {
                let rm_path = path.to_path_buf();
                let rm_agent = agent_id.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    crate::worktree::remove(&rm_path, &rm_agent)
                })
                .await;
            }
            let retry = merge_queue.take_retry_count(&task_id);
            if merge_queue.push(MergeEntry {
                agent_id: agent_id.clone(),
                task_id: task_id.clone(),
                retry_count: retry,
            }) {
                let _ = env_emit(
                    env,
                    "merge_status",
                    &MergeStatusPayload {
                        task_id: task_id.clone(),
                        status: "merging".to_string(),
                        detail: Some(format!(
                            "Merge agent completed; retrying merge (attempt {})",
                            retry + 1
                        )),
                    },
                );
            }
            let _ = registry.kill(&agent_id);
            let _ = env.kill_pty(&agent_id);
            continue;
        }

        // Fallback path: if this developer never got an isolated worktree/branch
        // (for example repo bootstrap/unborn HEAD scenarios), avoid merge-train
        // retries on a missing task/<id> branch and finalize the task directly.
        let has_worktree = registry
            .get_worktree_path(&agent_id)
            .ok()
            .flatten()
            .is_some();
        if !has_worktree {
            eprintln!(
                "[orch] task {task_id} (agent {agent_id}) completed without worktree; finalizing without merge"
            );
            let close_args = vec!["close".to_string(), task_id.clone()];
            if let Err(e) = env.run_bd(path, &close_args) {
                eprintln!(
                    "[orch] WARNING: bd close failed for {task_id}: {e}; falling back to bd update --status done"
                );
                let done_args = vec![
                    "update".to_string(),
                    task_id.clone(),
                    "--status".to_string(),
                    "done".to_string(),
                ];
                if let Err(e2) = env.run_bd(path, &done_args) {
                    eprintln!(
                        "[orch] WARNING: bd update --status done also failed for {task_id}: {e2}"
                    );
                }
            }
            let _ = registry.kill(&agent_id);
            let _ = env.kill_pty(&agent_id);
            let _ = env_emit(
                env,
                "merge_status",
                &MergeStatusPayload {
                    task_id,
                    status: "done".to_string(),
                    detail: Some("No isolated worktree branch; finalized directly".to_string()),
                },
            );
            continue;
        }

        // Remove worktree (frees the branch for rebase/merge from main repo dir)
        if let Ok(Some(_wt)) = registry.get_worktree_path(&agent_id) {
            let rm_path = path.to_path_buf();
            let rm_agent = agent_id.clone();
            let _ =
                tokio::task::spawn_blocking(move || crate::worktree::remove(&rm_path, &rm_agent))
                    .await;
        }

        eprintln!("[orch] enqueuing task {task_id} (agent {agent_id}) for merge");
        if merge_queue.push(MergeEntry {
            agent_id: agent_id.clone(),
            task_id: task_id.clone(),
            retry_count: 0,
        }) {
            let _ = env_emit(
                env,
                "merge_status",
                &MergeStatusPayload {
                    task_id: task_id.clone(),
                    status: "merging".to_string(),
                    detail: None,
                },
            );
        }
        // Kill the developer now so done_agents_with_tasks won't return it on
        // subsequent ticks. The MergeEntry carries all the info the merge train needs.
        let _ = registry.kill(&agent_id);
        let _ = env.kill_pty(&agent_id);
    }

    // 5b. Merge train: process multiple queued entries per tick to reduce backlog latency.
    //     git_lock still ensures merges execute serially for correctness.
    for _ in 0..max_merges_per_tick {
        let Some(entry) = merge_queue.pop_front() else {
            break;
        };
        let _git_guard = merge_queue.git_lock.lock().await;
        let task_id = entry.task_id.clone();
        let agent_id = entry.agent_id.clone();

        // Step 1: Rebase task branch onto base
        let rebase_path = path.to_path_buf();
        let rebase_task = task_id.clone();
        let rebase_ok = tokio::task::spawn_blocking(move || {
            crate::worktree::rebase_onto_base(&rebase_path, &rebase_task)
        })
        .await;

        let rebase_clean = match rebase_ok {
            Ok(Ok(true)) => true,
            Ok(Ok(false)) => {
                eprintln!("[orch] rebase conflict for task {task_id}");
                false
            }
            Ok(Err(e)) => {
                eprintln!("[orch] rebase error for task {task_id}: {e}");
                false
            }
            Err(e) => {
                eprintln!("[orch] rebase join error for task {task_id}: {e}");
                false
            }
        };

        if rebase_clean {
            // Step 2: Merge (--no-ff) into base
            let merge_path = path.to_path_buf();
            let merge_task = task_id.clone();
            let merge_result = tokio::task::spawn_blocking(move || {
                crate::worktree::merge_to_base(&merge_path, &merge_task)
            })
            .await;

            match merge_result {
                Ok(Ok(crate::worktree::MergeOutcome::Clean)) => {
                    eprintln!("[orch] merge clean for task {task_id}");
                    let close_args = vec!["close".to_string(), task_id.clone()];
                    if let Err(e) = env.run_bd(path, &close_args) {
                        eprintln!(
                            "[orch] WARNING: bd close failed for {task_id}: {e}; falling back to bd update --status done"
                        );
                        let done_args = vec![
                            "update".to_string(),
                            task_id.clone(),
                            "--status".to_string(),
                            "done".to_string(),
                        ];
                        if let Err(e2) = env.run_bd(path, &done_args) {
                            eprintln!(
                                "[orch] ERROR: bd update --status done also failed for {task_id}: {e2}"
                            );
                        }
                    }
                    let del_path = path.to_path_buf();
                    let del_task = task_id.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        crate::worktree::delete_task_branch(&del_path, &del_task)
                    })
                    .await;
                    let _ = registry.kill(&agent_id);
                    let _ = env.kill_pty(&agent_id);
                    let _ = env_emit(
                        env,
                        "merge_status",
                        &MergeStatusPayload {
                            task_id,
                            status: "done".to_string(),
                            detail: None,
                        },
                    );
                }
                Ok(Ok(crate::worktree::MergeOutcome::Conflict(detail))) => {
                    handle_merge_conflict(
                        env,
                        path,
                        registry,
                        merge_queue,
                        metrics,
                        entry,
                        &detail,
                    )
                    .await;
                }
                Ok(Err(e)) => {
                    eprintln!("[orch] merge error for task {task_id}: {e}");
                    handle_merge_conflict(env, path, registry, merge_queue, metrics, entry, &e)
                        .await;
                }
                Err(e) => {
                    eprintln!("[orch] merge join error for task {task_id}: {e}");
                    let _ = registry.kill(&agent_id);
                    let _ = env.kill_pty(&agent_id);
                }
            }
        } else {
            // Rebase failed -- treat as conflict
            handle_merge_conflict(
                env,
                path,
                registry,
                merge_queue,
                metrics,
                entry,
                "rebase conflict",
            )
            .await;
        }
    }

    // 6. Auto-close epics whose children are ALL done (and have at least 1 child).
    //    If direct close is unavailable, fallback to status update.
    //    If both fail, append a PM nudge note.
    {
        let path_epic = path.to_path_buf();
        if let Ok(Ok(epic_ids)) = tokio::task::spawn_blocking({
            let path_epic = path_epic.clone();
            move || close_eligible_epic_ids_sync(&path_epic)
        })
        .await
        {
            for epic_id in epic_ids {
                let close_args = vec!["close".to_string(), epic_id.clone()];
                if env.run_bd(path, &close_args).is_ok() {
                    eprintln!("[orch] auto-closed epic {} via `bd close`", epic_id);
                    continue;
                }

                let done_args = vec![
                    "update".to_string(),
                    epic_id.clone(),
                    "--status".to_string(),
                    "done".to_string(),
                ];
                if env.run_bd(path, &done_args).is_ok() {
                    eprintln!("[orch] auto-closed epic {} via status fallback", epic_id);
                    continue;
                }

                let note_args = vec![
                    "update".to_string(),
                    epic_id.clone(),
                    "--append-notes".to_string(),
                    "System note: all child tasks are done. If no new work came up, please close this epic.".to_string(),
                ];
                let _ = env.run_bd(path, &note_args);
                eprintln!(
                    "[orch] could not auto-close epic {}; appended PM nudge note",
                    epic_id
                );
            }
        }
    }

    // 7. Emit epic progress to frontend
    {
        let status_args = vec![
            "epic".to_string(),
            "status".to_string(),
            "--json".to_string(),
        ];
        if let Ok(stdout) = env.run_bd(path, &status_args) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&stdout) {
                let epics = if val.is_array() {
                    val.as_array().cloned().unwrap_or_default()
                } else {
                    vec![val]
                };
                for epic in epics {
                    let epic_id = epic.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                    if epic_id.is_empty() {
                        continue;
                    }
                    let total = epic.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
                    let done = epic
                        .get("done")
                        .and_then(|v| v.as_u64())
                        .or_else(|| epic.get("closed").and_then(|v| v.as_u64()))
                        .unwrap_or(0);
                    let in_progress = epic
                        .get("in_progress")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let open = epic.get("open").and_then(|v| v.as_u64()).unwrap_or(0);

                    let _ = env_emit(
                        env,
                        "epic_progress",
                        &EpicProgressPayload {
                            epic_id: epic_id.to_string(),
                            total: total as u32,
                            done: done as u32,
                            in_progress: in_progress as u32,
                            open: open as u32,
                        },
                    );
                }
            }
        }
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
        _ => "developer".to_string(),
    }
}

const MAX_MERGE_RETRIES: u8 = 2;

/// Handle a merge or rebase conflict: spawn merge agent (if retries remain) or mark blocked.
async fn handle_merge_conflict(
    env: &dyn OrchEnv,
    project_path: &Path,
    registry: &AgentRegistry,
    merge_queue: &MergeQueue,
    metrics: &OrchestrationMetrics,
    entry: MergeEntry,
    detail: &str,
) {
    let task_id = entry.task_id.clone();
    let agent_id = entry.agent_id.clone();

    if entry.retry_count >= MAX_MERGE_RETRIES {
        eprintln!(
            "[orch] merge permanently failed for task {task_id} after {} retries",
            entry.retry_count
        );
        let block_args = vec![
            "update".to_string(),
            task_id.clone(),
            "--status".to_string(),
            "blocked".to_string(),
        ];
        let _ = env.run_bd(project_path, &block_args);
        let _ = registry.kill(&agent_id);
        let _ = env.kill_pty(&agent_id);
        let _ = env_emit(
            env,
            "merge_status",
            &MergeStatusPayload {
                task_id,
                status: "failed".to_string(),
                detail: Some(detail.to_string()),
            },
        );
        return;
    }

    eprintln!(
        "[orch] merge conflict for task {task_id} (retry {}), spawning merge agent",
        entry.retry_count
    );

    let diff_path = project_path.to_path_buf();
    let diff_task = task_id.clone();
    let conflict_context =
        tokio::task::spawn_blocking(move || crate::worktree::conflict_diff(&diff_path, &diff_task))
            .await
            .unwrap_or_else(|e| Err(e.to_string()))
            .unwrap_or_else(|e| format!("(failed to get diff: {e})"));

    let show_args = vec!["show".to_string(), task_id.clone(), "--json".to_string()];
    let task_desc = match env.run_bd(project_path, &show_args) {
        Ok(stdout) => serde_json::from_str::<serde_json::Value>(&stdout)
            .ok()
            .and_then(|v| {
                v.get("description")
                    .and_then(|d| d.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default(),
        _ => String::new(),
    };

    let base_branch = {
        let pp = project_path.to_path_buf();
        tokio::task::spawn_blocking(move || crate::worktree::detect_base_branch(&pp))
            .await
            .unwrap_or_else(|_| "main".to_string())
    };

    let merge_agent_id = match registry.spawn(
        "merge_agent",
        Some(task_id.clone()),
        None,
        Some(project_path.to_str().unwrap_or_default().to_string()),
    ) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("[orch] failed to spawn merge agent for {task_id}: {e}");
            metrics.inc_merge_retry();
            let _ = merge_queue.push(MergeEntry {
                agent_id,
                task_id: task_id.clone(),
                retry_count: entry.retry_count + 1,
            });
            return;
        }
    };

    let wt_path = project_path.to_path_buf();
    let wt_agent = merge_agent_id.clone();
    let wt_task = task_id.clone();
    let agent_cwd = match tokio::task::spawn_blocking(move || {
        // Use Project abstraction for proper state validation
        let mut project = crate::project::Project::open(&wt_path).map_err(|e| e.to_string())?;
        project.ensure_ready().map_err(|e| e.to_string())?;
        project
            .create_worktree(&wt_agent, &wt_task)
            .map_err(|e| e.to_string())
    })
    .await
    {
        Ok(Ok(wt)) => {
            let _ = registry.set_worktree_path(&merge_agent_id, wt.to_str().unwrap_or_default());
            wt
        }
        Ok(Err(e)) => {
            eprintln!("[orch] merge agent worktree creation failed for {task_id}: {e}");
            let _ = registry.kill(&merge_agent_id);
            metrics.inc_merge_retry();
            let _ = merge_queue.push(MergeEntry {
                agent_id,
                task_id: task_id.clone(),
                retry_count: entry.retry_count + 1,
            });
            return;
        }
        Err(join_err) => {
            eprintln!(
                "[orch] merge agent worktree spawn_blocking panicked for {task_id}: {join_err}"
            );
            let _ = registry.kill(&merge_agent_id);
            metrics.inc_merge_retry();
            let _ = merge_queue.push(MergeEntry {
                agent_id,
                task_id: task_id.clone(),
                retry_count: entry.retry_count + 1,
            });
            return;
        }
    };

    if env
        .spawn_pty(&merge_agent_id, 80, 24, Some(agent_cwd.as_path()))
        .is_err()
    {
        eprintln!("[orch] failed to spawn pty for merge agent {merge_agent_id}");
        let _ = registry.kill(&merge_agent_id);
        metrics.inc_merge_retry();
        let _ = merge_queue.push(MergeEntry {
            agent_id,
            task_id: task_id.clone(),
            retry_count: entry.retry_count + 1,
        });
        return;
    }

    let task_branch = format!("task/{task_id}");
    let _ = env_emit(
        env,
        "agent_spawned",
        &AgentSpawnedPayload {
            agent_id: merge_agent_id.clone(),
            role: "merge_agent".to_string(),
            task_id: Some(task_id.clone()),
            parent_agent_id: Some(agent_id.clone()),
            merge_context: Some(MergeContext {
                base_branch,
                task_branch,
                conflict_diff: conflict_context,
                task_description: task_desc,
            }),
            worktree_path: Some(agent_cwd.to_string_lossy().to_string()),
        },
    );

    let _ = env_emit(
        env,
        "merge_status",
        &MergeStatusPayload {
            task_id: task_id.clone(),
            status: "conflict".to_string(),
            detail: Some(format!(
                "Retry {}/{MAX_MERGE_RETRIES} — merge agent spawned",
                entry.retry_count + 1
            )),
        },
    );

    metrics.inc_merge_retry();
    merge_queue.set_retry_count(&task_id, entry.retry_count + 1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    // -----------------------------------------------------------------------
    // Test infrastructure
    // -----------------------------------------------------------------------

    /// Captured event from TestOrchEnv.
    #[derive(Debug, Clone)]
    struct EmittedEvent {
        event: String,
        payload: serde_json::Value,
    }

    /// Captured bd call from TestOrchEnv.
    #[derive(Debug, Clone)]
    struct BdCall {
        args: Vec<String>,
    }

    /// Test implementation of OrchEnv that records all side effects.
    struct TestOrchEnv {
        events: Arc<StdMutex<Vec<EmittedEvent>>>,
        bd_calls: Arc<StdMutex<Vec<BdCall>>>,
        /// Canned response for `bd ready --json`.  Set before calling tick().
        bd_ready_response: StdMutex<String>,
        /// If true, all bd calls succeed with empty string.  Otherwise errors.
        bd_default_ok: bool,
    }

    impl TestOrchEnv {
        fn new() -> Self {
            Self {
                events: Arc::new(StdMutex::new(Vec::new())),
                bd_calls: Arc::new(StdMutex::new(Vec::new())),
                bd_ready_response: StdMutex::new("[]".to_string()),
                bd_default_ok: true,
            }
        }

        fn set_ready_tasks(&self, json: &str) {
            *self.bd_ready_response.lock().unwrap() = json.to_string();
        }

        fn events(&self) -> Vec<EmittedEvent> {
            self.events.lock().unwrap().clone()
        }

        fn events_named(&self, name: &str) -> Vec<serde_json::Value> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e.event == name)
                .map(|e| e.payload.clone())
                .collect()
        }

        fn bd_calls(&self) -> Vec<BdCall> {
            self.bd_calls.lock().unwrap().clone()
        }

        fn bd_calls_matching(&self, needle: &str) -> Vec<Vec<String>> {
            self.bd_calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.args.iter().any(|a| a.contains(needle)))
                .map(|c| c.args.clone())
                .collect()
        }
    }

    impl OrchEnv for TestOrchEnv {
        fn emit_event(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
            self.events.lock().unwrap().push(EmittedEvent {
                event: event.to_string(),
                payload,
            });
            Ok(())
        }

        fn run_bd(&self, _project_path: &Path, args: &[String]) -> Result<String, String> {
            self.bd_calls.lock().unwrap().push(BdCall {
                args: args.to_vec(),
            });
            // Return canned response for `bd ready --json`
            if args.len() >= 2 && args[0] == "ready" && args[1] == "--json" {
                return Ok(self.bd_ready_response.lock().unwrap().clone());
            }
            // Return empty JSON for `bd show ... --json`
            if args.len() >= 3
                && args[0] == "show"
                && args.last().map(|a| a.as_str()) == Some("--json")
            {
                return Ok("{}".to_string());
            }
            // Return empty array for epic commands
            if args.first().map(|a| a.as_str()) == Some("epic") {
                return Ok("[]".to_string());
            }
            if self.bd_default_ok {
                Ok(String::new())
            } else {
                Err("bd not available in test".to_string())
            }
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

    /// Create a temp git repo with an initial commit (used for worktree tests).
    fn setup_git_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::process::Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "--allow-empty", "-m", "init"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        dir
    }

    /// Create a MetaDb in a temp directory pointing at the given project path.
    /// Returns (MetaDb, TempDir) — hold the TempDir to keep the DB alive.
    fn setup_meta_db(project_path: &str) -> (crate::storage::MetaDb, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("meta.db");
        let db = crate::storage::MetaDb::open(&db_path).unwrap();
        db.set_setting("beads_project_path", project_path).unwrap();
        (db, dir)
    }

    // -----------------------------------------------------------------------
    // Existing unit tests
    // -----------------------------------------------------------------------

    #[test]
    fn merge_queue_dedupes_by_task_id() {
        let q = MergeQueue::new();
        assert!(q.push(MergeEntry {
            agent_id: "a1".to_string(),
            task_id: "bd-1".to_string(),
            retry_count: 0,
        }));
        assert!(!q.push(MergeEntry {
            agent_id: "a2".to_string(),
            task_id: "bd-1".to_string(),
            retry_count: 1,
        }));
        assert_eq!(q.depth(), 1);
    }

    #[test]
    fn merge_queue_handles_burst_push_pop_order() {
        let q = MergeQueue::new();
        for i in 0..50 {
            let _ = q.push(MergeEntry {
                agent_id: format!("agent-{i}"),
                task_id: format!("bd-{i}"),
                retry_count: 0,
            });
        }
        assert_eq!(q.depth(), 50);

        for i in 0..50 {
            let entry = q.pop_front().expect("missing entry");
            assert_eq!(entry.task_id, format!("bd-{i}"));
        }
        assert_eq!(q.depth(), 0);
    }

    // ===================================================================
    // Adversarial integration tests — designed to probe real edge cases
    // ===================================================================

    // -----------------------------------------------------------------------
    // BUG PROBE: Two developers finish, both need merge. Second should
    // conflict against first's merged changes. Tests the FULL merge train
    // serialization under real git.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn two_devs_overlapping_file_second_merge_conflicts() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Seed a file on main
        std::fs::write(repo.path().join("shared.txt"), "original").unwrap();
        git(repo.path(), &["add", "shared.txt"]);
        git(repo.path(), &["commit", "-m", "seed"]);

        // Spawn two developers for different tasks
        env.set_ready_tasks(
            r#"[{"id":"bd-A","issue_type":"task","priority":2},{"id":"bd-B","issue_type":"task","priority":2}]"#,
        );
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let spawned = env.events_named("agent_spawned");
        assert_eq!(spawned.len(), 2, "two developers should spawn");
        let id_a = spawned[0]["agent_id"].as_str().unwrap().to_string();
        let id_b = spawned[1]["agent_id"].as_str().unwrap().to_string();

        // Both modify shared.txt differently in their worktrees
        let wt_a = registry.get_worktree_path(&id_a).unwrap().unwrap();
        let wt_b = registry.get_worktree_path(&id_b).unwrap().unwrap();

        std::fs::write(format!("{wt_a}/shared.txt"), "change from A").unwrap();
        git_in(&wt_a, &["add", "shared.txt"]);
        git_in(&wt_a, &["commit", "-m", "A's change"]);

        std::fs::write(format!("{wt_b}/shared.txt"), "change from B").unwrap();
        git_in(&wt_b, &["add", "shared.txt"]);
        git_in(&wt_b, &["commit", "-m", "B's change"]);

        // Both yield + pass validation
        env.set_ready_tasks("[]");
        for (id, task) in [(&id_a, "bd-A"), (&id_b, "bd-B")] {
            let yp = crate::agent_registry::YieldPayload {
                status: "done".to_string(),
                diff_summary: None,
                git_branch: Some(format!("task/{task}")),
            };
            registry.yield_for_review(id, yp).unwrap();
        }
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();
        for (id, _) in [(&id_a, "bd-A"), (&id_b, "bd-B")] {
            for role in &["code_review", "business_logic", "scope"] {
                registry.validation_submit(id, role, true, vec![]).unwrap();
            }
        }

        // Tick: both enter Done → both enqueued for merge → train runs.
        // First merge should be clean. Second should conflict because
        // first already changed shared.txt on main.
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // Determine which task merged cleanly and which conflicted.
        // done_agents_with_tasks() iterates a HashMap so ordering is
        // non-deterministic — either A or B can win the merge race.
        let merge_statuses = env.events_named("merge_status");
        let winner_task = merge_statuses
            .iter()
            .find(|e| e["status"] == "done")
            .expect("exactly one merge should succeed")["task_id"]
            .as_str()
            .unwrap()
            .to_string();
        let loser_task = merge_statuses
            .iter()
            .find(|e| e["status"] == "conflict")
            .expect("exactly one merge should conflict")["task_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(winner_task, loser_task);
        let winner_content = if winner_task == "bd-A" {
            "change from A"
        } else {
            "change from B"
        };
        let loser_content = if loser_task == "bd-A" {
            "change from A"
        } else {
            "change from B"
        };

        // --- 1. Git state on main ---

        let content = std::fs::read_to_string(repo.path().join("shared.txt")).unwrap();
        assert_eq!(
            content, winner_content,
            "main should contain the winner's change"
        );
        assert_ne!(
            content, loser_content,
            "loser's change must not silently overwrite the winner"
        );

        let head = git(repo.path(), &["symbolic-ref", "--short", "HEAD"]);
        let head_str = String::from_utf8_lossy(&head.stdout).trim().to_string();
        assert_eq!(head_str, "main", "HEAD should be on main, not detached");

        assert!(
            !repo.path().join(".git/MERGE_HEAD").exists(),
            "MERGE_HEAD should not exist — merge must be cleanly finished or aborted"
        );

        // --- 2. Task branch state ---

        let winner_branch = format!("task/{winner_task}");
        let loser_branch = format!("task/{loser_task}");

        let winner_exists = git(repo.path(), &["rev-parse", "--verify", &winner_branch]);
        assert!(
            !winner_exists.status.success(),
            "{winner_branch} should be deleted after clean merge"
        );

        let loser_exists = git(repo.path(), &["rev-parse", "--verify", &loser_branch]);
        assert!(
            loser_exists.status.success(),
            "{loser_branch} should still exist for merge agent"
        );

        // --- 3. Filesystem state (worktrees) ---

        assert!(
            !std::path::Path::new(&wt_a).exists(),
            "A's worktree should be removed from disk"
        );
        assert!(
            !std::path::Path::new(&wt_b).exists(),
            "B's worktree should be removed from disk"
        );

        let wt_list = git(repo.path(), &["worktree", "list", "--porcelain"]);
        let wt_stdout = String::from_utf8_lossy(&wt_list.stdout).to_string();
        assert!(
            !wt_stdout.contains(&id_a),
            "A's worktree entry should be pruned from git"
        );
        assert!(
            !wt_stdout.contains(&id_b),
            "B's worktree entry should be pruned from git"
        );

        // --- 4. Beads (bd) calls ---

        let bd_done_winner = env.bd_calls_matching(&winner_task).iter().any(|args| {
            args.contains(&"close".to_string())
                || (args.contains(&"update".to_string()) && args.contains(&"done".to_string()))
        });
        assert!(
            bd_done_winner,
            "bd close (or bd update --status done) should have been called for {winner_task}"
        );

        let bd_done_loser = env
            .bd_calls_matching(&loser_task)
            .iter()
            .any(|args| args.contains(&"update".to_string()) && args.contains(&"done".to_string()));
        assert!(
            !bd_done_loser,
            "bd update {loser_task} --status done should NOT be called (still in conflict)"
        );

        // --- 5. Registry state ---

        let snap = registry.debug_snapshot().unwrap();
        let live_devs: Vec<_> = snap
            .agents
            .iter()
            .filter(|a| a.role == "developer")
            .collect();
        assert_eq!(
            live_devs.len(),
            0,
            "both developers should be killed after merge tick"
        );

        let merge_agents: Vec<_> = snap
            .agents
            .iter()
            .filter(|a| a.role == "merge_agent")
            .collect();
        if !merge_agents.is_empty() {
            assert_eq!(
                merge_agents[0].task_id.as_deref(),
                Some(loser_task.as_str()),
                "merge agent should be for the conflicting task {loser_task}"
            );
        }

        // --- 6. Merge agent spawn event verification ---

        let ma_spawns: Vec<_> = env
            .events_named("agent_spawned")
            .into_iter()
            .filter(|e| e["role"] == "merge_agent")
            .collect();
        assert_eq!(
            ma_spawns.len(),
            1,
            "exactly one merge agent should be spawned"
        );
        assert_eq!(
            ma_spawns[0]["task_id"].as_str(),
            Some(loser_task.as_str()),
            "merge agent should target the conflicting task"
        );
        let mc = &ma_spawns[0]["merge_context"];
        assert!(
            mc["conflict_diff"]
                .as_str()
                .map_or(false, |d| !d.is_empty()),
            "merge_context.conflict_diff should be non-empty"
        );

        // --- 7. Merge agent worktree created successfully ---

        let ma_id = ma_spawns[0]["agent_id"].as_str().unwrap().to_string();
        let ma_wt = registry.get_worktree_path(&ma_id).unwrap();
        assert!(
            ma_wt.is_some(),
            "merge agent should have its own worktree, not fall back to project root"
        );
        let ma_wt_path = ma_wt.unwrap();
        assert!(
            std::path::Path::new(&ma_wt_path).exists(),
            "merge agent worktree should exist on disk (no stale lock preventing creation)"
        );
        assert_ne!(
            ma_wt_path, project_path,
            "merge agent worktree must not be the project root (that would stomp other agents)"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: TTL-killed developer's worktree should be ACTUALLY removed
    // from disk, not just from the registry.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn ttl_kill_actually_removes_worktree_from_disk() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        env.set_ready_tasks(r#"[{"id":"bd-ttl-wt","issue_type":"task","priority":2}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let agent_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str()
            .unwrap()
            .to_string();
        let wt_path = registry.get_worktree_path(&agent_id).unwrap().unwrap();

        // Worktree dir should exist on disk right now
        assert!(
            std::path::Path::new(&wt_path).exists(),
            "worktree should exist on disk before TTL kill"
        );

        // Expire the agent
        registry.test_backdate_spawn(&agent_id, std::time::Duration::from_secs(901));
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // --- Filesystem: worktree directory gone ---

        assert!(
            !std::path::Path::new(&wt_path).exists(),
            "worktree should be DELETED from disk after TTL kill"
        );

        // --- Git: no stale worktree entry ---

        let wt_list = git(repo.path(), &["worktree", "list", "--porcelain"]);
        let wt_stdout = String::from_utf8_lossy(&wt_list.stdout).to_string();
        assert!(
            !wt_stdout.contains(&agent_id),
            "stale worktree entry should be pruned from git after TTL kill"
        );

        // --- Registry: agent fully removed ---

        let snap = registry.debug_snapshot().unwrap();
        assert_eq!(
            snap.agents.len(),
            0,
            "TTL-killed agent should be removed from registry, not left as zombie"
        );

        // --- Beads: task claim released so task can be re-assigned ---

        let unclaim_calls = env.bd_calls_matching("bd-ttl-wt").iter().any(|args| {
            args.contains(&"update".to_string()) && args.contains(&"ready".to_string())
        });
        assert!(
            unclaim_calls,
            "bd update bd-ttl-wt --status ready should be called to release claim after TTL kill"
        );

        // --- Task branch still exists (TTL kill should NOT delete the branch) ---

        let branch_check = git(repo.path(), &["rev-parse", "--verify", "task/bd-ttl-wt"]);
        assert!(
            branch_check.status.success(),
            "task branch should NOT be deleted by TTL kill (work may be resumable)"
        );

        // --- HEAD still on main (TTL kill should not disturb repo state) ---

        let head = git(repo.path(), &["symbolic-ref", "--short", "HEAD"]);
        let head_str = String::from_utf8_lossy(&head.stdout).trim().to_string();
        assert_eq!(
            head_str, "main",
            "HEAD should remain on main after TTL kill"
        );

        // --- claimed_task_ids is empty (dedup cleared for the killed agent) ---

        let claimed = registry.claimed_task_ids().unwrap();
        assert!(
            !claimed.contains(&"bd-ttl-wt".to_string()),
            "task should not appear in claimed_task_ids after TTL kill"
        );
    }

    // -----------------------------------------------------------------------
    // Validator TTL expiry must NOT reset the developer's task status.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn validator_ttl_expiry_does_not_unclaim_task() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Spawn a developer via bd ready
        env.set_ready_tasks(r#"[{"id":"bd-val-ttl","issue_type":"task","priority":2}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let agent_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str()
            .unwrap()
            .to_string();

        // Spawn a validator as a child of the developer, carrying the same task_id
        let validator_id = registry
            .spawn(
                "validator",
                Some("bd-val-ttl".into()),
                Some(agent_id.clone()),
                None,
            )
            .unwrap();

        // Expire only the validator (300s TTL)
        registry.test_backdate_spawn(&validator_id, std::time::Duration::from_secs(301));
        env.set_ready_tasks("[]");

        // Clear bd_calls before this tick so we can check what THIS tick does
        env.bd_calls.lock().unwrap().clear();

        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // Validator should be killed
        let snap = registry.debug_snapshot().unwrap();
        assert!(
            !snap.agents.iter().any(|a| a.id == validator_id),
            "validator should be removed from registry after TTL"
        );

        // The task should NOT have been reset to ready
        let unclaim_calls = env.bd_calls_matching("bd-val-ttl").iter().any(|args| {
            args.contains(&"update".to_string()) && args.contains(&"ready".to_string())
        });
        assert!(
            !unclaim_calls,
            "validator TTL expiry must NOT reset the task to ready"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: bd returns garbage JSON — tick() should not crash.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn bd_returns_garbage_tick_does_not_crash() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        env.set_ready_tasks("THIS IS NOT JSON AT ALL {{{");
        let result = tick(&env, &meta_db, &registry, &merge_queue, &metrics).await;
        assert!(result.is_ok(), "tick should not crash on garbage bd output");
        assert_eq!(
            env.events_named("agent_spawned").len(),
            0,
            "no agents should spawn on garbage input"
        );

        // Registry should be completely clean (no partially-created agents)
        let snap = registry.debug_snapshot().unwrap();
        assert_eq!(
            snap.agents.len(),
            0,
            "no agents should exist in registry after garbage input"
        );

        // Merge queue untouched
        assert_eq!(merge_queue.depth(), 0, "merge queue should be empty");
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: bd ready returns a task with NO id field — should skip
    // gracefully, not panic.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn bd_task_missing_id_is_skipped() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // One valid task, one with missing id
        env.set_ready_tasks(
            r#"[{"issue_type":"task","priority":2},{"id":"bd-ok","issue_type":"task","priority":2}]"#,
        );
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let spawned = env.events_named("agent_spawned");
        assert_eq!(spawned.len(), 1, "only the task with an id should spawn");
        assert_eq!(spawned[0]["task_id"].as_str().unwrap(), "bd-ok");

        // Registry: exactly one agent with the valid task
        let snap = registry.debug_snapshot().unwrap();
        assert_eq!(snap.agents.len(), 1, "exactly one agent in registry");
        assert_eq!(snap.agents[0].task_id.as_deref(), Some("bd-ok"));

        // claimed_task_ids: only bd-ok, not the invalid task
        let claimed = registry.claimed_task_ids().unwrap();
        assert_eq!(claimed, vec!["bd-ok".to_string()]);

        // bd claim should only be called for bd-ok
        let claim_calls = env.bd_calls_matching("--claim");
        assert_eq!(claim_calls.len(), 1, "exactly one claim call");
        assert!(
            claim_calls[0].contains(&"bd-ok".to_string()),
            "claim should be for bd-ok"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: Partial validation (only 2 of 3 validators submit) + stuck
    // InReview safety net fires. After force-block, the 3rd validator submits
    // late. This should NOT crash or corrupt state.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn partial_validation_then_late_submit_does_not_corrupt() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        let agent_id = registry
            .spawn(
                "developer",
                Some("bd-partial".to_string()),
                None,
                Some(project_path.to_string()),
            )
            .unwrap();

        let yp = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: None,
            git_branch: None,
        };
        registry.yield_for_review(&agent_id, yp).unwrap();
        registry
            .start_validation(&agent_id, Some("bd-partial".to_string()))
            .unwrap();

        // Only 2 of 3 validators submit
        registry
            .validation_submit(&agent_id, "code_review", true, vec![])
            .unwrap();
        registry
            .validation_submit(&agent_id, "business_logic", true, vec![])
            .unwrap();

        // Backdate and force-block via safety net
        registry.test_backdate_state_entered(&agent_id, std::time::Duration::from_secs(301));
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // --- Metrics: safety net fired ---

        let snap = metrics.snapshot(0);
        assert!(
            snap.validation_timeout_blocks > 0,
            "safety net should have fired"
        );

        // --- Registry: agent is in Blocked state, not stuck in InReview ---

        let debug = registry.debug_snapshot().unwrap();
        let agent = debug.agents.iter().find(|a| a.id == agent_id);
        assert!(
            agent.is_some(),
            "agent should still exist in registry after force-block"
        );
        assert_eq!(
            agent.unwrap().state,
            "Blocked",
            "agent should be in Blocked state after force_block_validation"
        );

        // --- Validation state cleaned up (no pending_validations entry) ---

        let pending_for_agent: Vec<_> = debug
            .pending_validations
            .iter()
            .filter(|v| v.developer_agent_id == agent_id)
            .collect();
        assert_eq!(
            pending_for_agent.len(),
            0,
            "validation state should be cleaned up after force-block"
        );

        // --- Late 3rd validator: should not panic or corrupt ---

        let result = registry.validation_submit(&agent_id, "scope", true, vec![]);
        assert!(
            result.is_ok(),
            "late validation submit after force-block should not error: {:?}",
            result
        );

        // State should still be Blocked (late submit must not resurrect the agent)
        let debug_after = registry.debug_snapshot().unwrap();
        let agent_after = debug_after.agents.iter().find(|a| a.id == agent_id);
        assert!(
            agent_after.is_some(),
            "agent should still exist after late submit"
        );
        assert_eq!(
            agent_after.unwrap().state,
            "Blocked",
            "agent must remain Blocked after late validator submit (no resurrection)"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: Agent killed by TTL while its task is sitting in the merge
    // queue. The merge train will try to process it with a dead agent_id.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn merge_entry_survives_agent_ttl_kill() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Create file, task branch with change
        std::fs::write(repo.path().join("f.txt"), "v1").unwrap();
        git(repo.path(), &["add", "f.txt"]);
        git(repo.path(), &["commit", "-m", "seed f"]);
        git(repo.path(), &["checkout", "-b", "task/bd-ghost"]);
        std::fs::write(repo.path().join("f.txt"), "v2").unwrap();
        git(repo.path(), &["add", "f.txt"]);
        git(repo.path(), &["commit", "-m", "ghost change"]);
        git(repo.path(), &["checkout", "main"]);

        // Manually enqueue a merge for an agent that's already dead
        merge_queue.push(MergeEntry {
            agent_id: "dead-agent".to_string(),
            task_id: "bd-ghost".to_string(),
            retry_count: 0,
        });

        // tick should handle it without panicking
        env.set_ready_tasks("[]");
        let result = tick(&env, &meta_db, &registry, &merge_queue, &metrics).await;
        assert!(
            result.is_ok(),
            "merge of dead agent's task should not crash"
        );

        // --- Git state: merge should have landed on main ---

        let content = std::fs::read_to_string(repo.path().join("f.txt")).unwrap();
        assert_eq!(
            content, "v2",
            "dead agent's change should be merged to main"
        );

        let head = git(repo.path(), &["symbolic-ref", "--short", "HEAD"]);
        let head_str = String::from_utf8_lossy(&head.stdout).trim().to_string();
        assert_eq!(head_str, "main", "HEAD should be on main after merge");

        assert!(
            !repo.path().join(".git/MERGE_HEAD").exists(),
            "no stale MERGE_HEAD should remain"
        );

        // Task branch should be deleted after clean merge
        let branch_check = git(repo.path(), &["rev-parse", "--verify", "task/bd-ghost"]);
        assert!(
            !branch_check.status.success(),
            "task/bd-ghost branch should be deleted after clean merge"
        );

        // --- Beads: bd close should mark task done ---

        let bd_done = env.bd_calls_matching("bd-ghost").iter().any(|args| {
            args.contains(&"close".to_string())
                || (args.contains(&"update".to_string()) && args.contains(&"done".to_string()))
        });
        assert!(
            bd_done,
            "bd close (or bd update --status done) should be called even for dead agent"
        );

        // --- Registry: no agents should remain ---

        let snap = registry.debug_snapshot().unwrap();
        assert_eq!(
            snap.agents.len(),
            0,
            "registry should be empty (dead-agent was never registered)"
        );

        // --- Merge queue: fully drained ---

        assert_eq!(
            merge_queue.depth(),
            0,
            "merge queue should be empty after processing"
        );

        // --- Events: merge_status done should be emitted ---

        let statuses = env.events_named("merge_status");
        assert!(
            statuses.iter().any(|e| e["status"] == "done"),
            "merge_status should report done for a clean merge of a valid branch"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: bd claim fails silently (let _ = ...) — next tick sees the
    // same task as "ready" but it's already claimed locally. Does the dedup
    // actually prevent a double-spawn?
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn failed_bd_claim_still_prevents_double_spawn() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();

        // Env that fails all bd calls except "ready"
        let env = TestOrchEnv {
            events: Arc::new(StdMutex::new(Vec::new())),
            bd_calls: Arc::new(StdMutex::new(Vec::new())),
            bd_ready_response: StdMutex::new(
                r#"[{"id":"bd-noclaim","issue_type":"task","priority":2}]"#.to_string(),
            ),
            bd_default_ok: false, // claim will fail
        };

        // Tick 1: spawns agent, bd claim fails silently
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();
        assert_eq!(env.events_named("agent_spawned").len(), 1);

        // --- bd claim was attempted (even though it will fail) ---

        let claim_calls = env.bd_calls_matching("--claim");
        assert_eq!(
            claim_calls.len(),
            1,
            "bd claim should have been attempted once"
        );
        assert!(
            claim_calls[0].contains(&"bd-noclaim".to_string()),
            "claim attempt should be for bd-noclaim"
        );

        // --- Registry: agent exists with correct task_id ---

        let claimed = registry.claimed_task_ids().unwrap();
        assert!(
            claimed.contains(&"bd-noclaim".to_string()),
            "bd-noclaim should be in claimed_task_ids even though bd claim failed"
        );

        let snap = registry.debug_snapshot().unwrap();
        assert_eq!(snap.agents.len(), 1, "exactly one agent should exist");
        assert_eq!(
            snap.agents[0].task_id.as_deref(),
            Some("bd-noclaim"),
            "agent should own task bd-noclaim"
        );

        // Tick 2: bd still reports task as ready (claim failed so Beads doesn't know)
        // But registry's claimed_task_ids should prevent a second spawn
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();
        assert_eq!(
            env.events_named("agent_spawned").len(),
            1,
            "registry dedup should prevent double-spawn even when bd claim failed"
        );

        // --- Registry: still exactly one agent (no double-spawn) ---

        let snap_after = registry.debug_snapshot().unwrap();
        assert_eq!(
            snap_after.agents.len(),
            1,
            "registry should still have exactly one agent after tick 2"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: Merge queue dedup blocks re-enqueueing a task that needs
    // another merge attempt. After merge_agent completes, does the task
    // actually get re-queued despite dedup?
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn merge_agent_done_reenqueues_despite_dedup() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Create a real task branch with a change so the re-merge has something to merge
        std::fs::write(repo.path().join("remerge.txt"), "v1").unwrap();
        git(repo.path(), &["add", "remerge.txt"]);
        git(repo.path(), &["commit", "-m", "seed remerge"]);
        git(repo.path(), &["checkout", "-b", "task/bd-remerge"]);
        std::fs::write(repo.path().join("remerge.txt"), "v2 fixed by merge agent").unwrap();
        git(repo.path(), &["add", "remerge.txt"]);
        git(repo.path(), &["commit", "-m", "merge agent fix"]);
        git(repo.path(), &["checkout", "main"]);

        // Spawn a merge_agent and make it complete
        let ma_id = registry
            .spawn(
                "merge_agent",
                Some("bd-remerge".to_string()),
                None,
                Some(project_path.to_string()),
            )
            .unwrap();

        // Set a retry count (simulating a prior conflict)
        merge_queue.set_retry_count("bd-remerge", 1);

        // The merge_agent "finishes" its work
        registry.complete_task(&ma_id).unwrap();

        // tick should see the done merge_agent in step 5, re-enqueue the task
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // --- Git state: the re-merge should land on main ---

        let content = std::fs::read_to_string(repo.path().join("remerge.txt")).unwrap();
        assert_eq!(
            content, "v2 fixed by merge agent",
            "merge agent's fix should be on main after re-enqueue + merge"
        );

        let head = git(repo.path(), &["symbolic-ref", "--short", "HEAD"]);
        let head_str = String::from_utf8_lossy(&head.stdout).trim().to_string();
        assert_eq!(head_str, "main", "HEAD should be on main after re-merge");

        assert!(
            !repo.path().join(".git/MERGE_HEAD").exists(),
            "no stale MERGE_HEAD after re-merge"
        );

        // Task branch should be deleted after the successful re-merge
        let branch_check = git(repo.path(), &["rev-parse", "--verify", "task/bd-remerge"]);
        assert!(
            !branch_check.status.success(),
            "task/bd-remerge branch should be deleted after successful re-merge"
        );

        // --- Beads: bd close called ---

        let bd_done = env.bd_calls_matching("bd-remerge").iter().any(|args| {
            args.contains(&"close".to_string())
                || (args.contains(&"update".to_string()) && args.contains(&"done".to_string()))
        });
        assert!(
            bd_done,
            "bd close (or bd update --status done) should be called after successful re-merge"
        );

        // --- Registry: merge agent killed ---

        let snap = registry.debug_snapshot().unwrap();
        assert_eq!(
            snap.agents.len(),
            0,
            "merge agent should be killed after re-merge completes"
        );

        // --- Merge queue: fully drained after re-merge ---

        assert_eq!(
            merge_queue.depth(),
            0,
            "merge queue should be empty after successful re-merge"
        );

        // --- Events: merging + done should both appear ---

        let statuses = env.events_named("merge_status");
        assert!(
            statuses.iter().any(|e| e["status"] == "merging"),
            "merge_status 'merging' should be emitted when re-enqueuing"
        );
        assert!(
            statuses
                .iter()
                .any(|e| e["status"] == "done" && e["task_id"] == "bd-remerge"),
            "merge_status 'done' should be emitted after successful re-merge"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: PTY pool is full (20 slots). Spawning should fail gracefully
    // — agent should be killed, not left as a zombie in Running state.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn pty_full_does_not_leave_zombie_agent() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();

        // Env where spawn_pty always fails
        struct FullPoolEnv(TestOrchEnv);
        impl OrchEnv for FullPoolEnv {
            fn emit_event(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
                self.0.emit_event(event, payload)
            }
            fn run_bd(&self, p: &Path, args: &[String]) -> Result<String, String> {
                self.0.run_bd(p, args)
            }
            fn spawn_pty(
                &self,
                _id: &str,
                _c: u16,
                _r: u16,
                _cwd: Option<&Path>,
            ) -> Result<(), String> {
                Err("PTY pool full (20 slots)".to_string())
            }
            fn kill_pty(&self, _id: &str) -> Result<(), String> {
                Ok(())
            }
        }

        let inner = TestOrchEnv::new();
        inner.set_ready_tasks(r#"[{"id":"bd-nopipe","issue_type":"task","priority":2}]"#);
        let env = FullPoolEnv(inner);

        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // --- Events: no agent_spawned emitted ---

        let spawned = env.0.events_named("agent_spawned");
        assert_eq!(
            spawned.len(),
            0,
            "should not emit agent_spawned when PTY fails"
        );

        // --- Registry: no zombie agent ---

        let status = registry.status().unwrap();
        assert_eq!(
            status.used_slots, 0,
            "no zombie agents should remain when PTY spawn fails"
        );

        // --- Filesystem: worktree cleaned up (not leaked on disk) ---

        let wt_dir = repo.path().join(".worktrees");
        if wt_dir.exists() {
            let entries: Vec<_> = std::fs::read_dir(&wt_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().map_or(false, |ft| ft.is_dir()))
                .collect();
            assert_eq!(
                entries.len(),
                0,
                "worktree should be cleaned up after PTY failure, found {:?}",
                entries.iter().map(|e| e.file_name()).collect::<Vec<_>>()
            );
        }

        // --- Git: no stale worktree entries ---

        let wt_list = git(repo.path(), &["worktree", "list", "--porcelain"]);
        let wt_stdout = String::from_utf8_lossy(&wt_list.stdout).to_string();
        let worktree_count = wt_stdout.matches("worktree ").count();
        assert_eq!(
            worktree_count, 1,
            "only the main worktree should exist (no leaked entries), got: {wt_stdout}"
        );

        // --- Beads: no claim was made (claim happens AFTER pty spawn) ---

        let claim_calls = env.0.bd_calls_matching("--claim");
        assert_eq!(
            claim_calls.len(),
            0,
            "bd claim should not be called when PTY fails (it runs after spawn_pty)"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: Worktree left on disk after successful merge — cleanup should
    // delete the worktree directory AND prune git's worktree list.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn successful_merge_cleans_up_worktree_on_disk() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Seed a file
        std::fs::write(repo.path().join("clean.txt"), "v1").unwrap();
        git(repo.path(), &["add", "clean.txt"]);
        git(repo.path(), &["commit", "-m", "seed clean"]);

        env.set_ready_tasks(r#"[{"id":"bd-clean","issue_type":"task","priority":2}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let agent_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str()
            .unwrap()
            .to_string();
        let wt_path = registry.get_worktree_path(&agent_id).unwrap().unwrap();

        // Modify file in worktree (non-conflicting change)
        std::fs::write(format!("{wt_path}/clean.txt"), "v2 from agent").unwrap();
        git_in(&wt_path, &["add", "clean.txt"]);
        git_in(&wt_path, &["commit", "-m", "agent change"]);

        // Yield + validate
        let yp = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: None,
            git_branch: Some("task/bd-clean".to_string()),
        };
        registry.yield_for_review(&agent_id, yp).unwrap();
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();
        for role in &["code_review", "business_logic", "scope"] {
            registry
                .validation_submit(&agent_id, role, true, vec![])
                .unwrap();
        }

        // Merge tick
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // --- Git state on main ---

        let content = std::fs::read_to_string(repo.path().join("clean.txt")).unwrap();
        assert_eq!(content, "v2 from agent", "merged content should be on main");

        let head = git(repo.path(), &["symbolic-ref", "--short", "HEAD"]);
        let head_str = String::from_utf8_lossy(&head.stdout).trim().to_string();
        assert_eq!(head_str, "main", "HEAD should be on main after merge");

        assert!(
            !repo.path().join(".git/MERGE_HEAD").exists(),
            "no stale MERGE_HEAD should remain after clean merge"
        );

        // --- Task branch deleted ---

        let branch_check = git(repo.path(), &["rev-parse", "--verify", "task/bd-clean"]);
        assert!(
            !branch_check.status.success(),
            "task/bd-clean branch should be deleted after clean merge"
        );

        // --- Worktree cleaned up on disk AND in git ---

        assert!(
            !std::path::Path::new(&wt_path).exists(),
            "worktree directory should be removed after successful merge"
        );

        let wt_list = git(repo.path(), &["worktree", "list", "--porcelain"]);
        let wt_stdout = String::from_utf8_lossy(&wt_list.stdout).to_string();
        assert!(
            !wt_stdout.contains(&agent_id),
            "worktree entry should be pruned from git after merge"
        );

        // --- Beads: bd close called ---

        let bd_done = env.bd_calls_matching("bd-clean").iter().any(|args| {
            args.contains(&"close".to_string())
                || (args.contains(&"update".to_string()) && args.contains(&"done".to_string()))
        });
        assert!(
            bd_done,
            "bd close (or bd update --status done) should have been called for bd-clean"
        );

        // --- Registry: developer killed, no zombies ---

        let snap = registry.debug_snapshot().unwrap();
        let live_devs: Vec<_> = snap
            .agents
            .iter()
            .filter(|a| a.role == "developer")
            .collect();
        assert_eq!(
            live_devs.len(),
            0,
            "developer should be killed after successful merge"
        );

        // --- Events: merge_status done emitted ---

        // --- Merge queue: fully drained ---

        assert_eq!(
            merge_queue.depth(),
            0,
            "merge queue should be empty after clean merge"
        );

        let statuses = env.events_named("merge_status");
        assert!(
            statuses
                .iter()
                .any(|e| e["status"] == "done" && e["task_id"] == "bd-clean"),
            "merge_status should report done for bd-clean"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: Force-yield fires, then on the SAME tick the yield_queue is
    // already processed. The force-yielded agent should NOT be stuck in
    // Yielded forever because yield_queue already ran earlier in the tick.
    // This is a known ordering issue: step 4 runs before step 4b.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn force_yield_requires_extra_tick_to_process() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        env.set_ready_tasks(r#"[{"id":"bd-fy","issue_type":"task","priority":2}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let agent_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str()
            .unwrap()
            .to_string();

        registry.test_backdate_state_entered(&agent_id, std::time::Duration::from_secs(301));

        // Tick A: force_yield fires (step 4b) but yield_queue already ran (step 4)
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // validation_requested should NOT be emitted on this tick
        // (because yield_queue ran before force_yield)
        let val_after_tick_a = env.events_named("validation_requested");
        assert_eq!(
            val_after_tick_a.len(),
            0,
            "BUG: force_yield and yield_queue run in the wrong order — \
             validation_requested should NOT appear on the same tick as force_yield. \
             This means stuck developers need 2 ticks to recover, adding ~10s latency."
        );

        // Agent should be in Yielded state after force_yield
        let snap_a = registry.debug_snapshot().unwrap();
        let agent_a = snap_a.agents.iter().find(|a| a.id == agent_id).unwrap();
        assert_eq!(
            agent_a.state, "Yielded",
            "agent should be in Yielded state after force_yield (tick A)"
        );

        // Tick B: NOW the yield_queue should pick up the force-yielded agent
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let val_after_tick_b = env.events_named("validation_requested");
        assert_eq!(
            val_after_tick_b.len(),
            1,
            "force-yielded agent should be processed on the next tick"
        );

        // Agent should now be in InReview state (validation started)
        let snap_b = registry.debug_snapshot().unwrap();
        let agent_b = snap_b.agents.iter().find(|a| a.id == agent_id).unwrap();
        assert_eq!(
            agent_b.state, "InReview",
            "agent should be in InReview state after yield_queue processes it (tick B)"
        );
    }

    // -----------------------------------------------------------------------
    // PM Safety Net: Force-yield PMs stuck in Running state for > 5 minutes.
    // This catches cases where frontend nudging fails or PM gets stuck.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn pm_stuck_running_safety_net_force_yields() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Spawn PM via bd ready (epic task)
        env.set_ready_tasks(r#"[{"id":"epic-stuck","issue_type":"epic","priority":1}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let pm_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str()
            .unwrap()
            .to_string();

        // Verify PM is in Running state
        let snap = registry.debug_snapshot().unwrap();
        let pm = snap.agents.iter().find(|a| a.id == pm_id).unwrap();
        assert_eq!(pm.state, "Running", "PM should start in Running state");
        assert_eq!(pm.role, "project_manager");

        // PM is NOT stuck yet (< 5 minutes)
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let snap = registry.debug_snapshot().unwrap();
        let pm = snap.agents.iter().find(|a| a.id == pm_id).unwrap();
        assert_eq!(
            pm.state, "Running",
            "PM should still be Running (not stuck yet)"
        );

        // Backdate PM to > 5 minutes in Running state
        registry.test_backdate_state_entered(&pm_id, std::time::Duration::from_secs(301));

        // Safety net should fire on this tick
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // PM should be force-yielded
        let snap = registry.debug_snapshot().unwrap();
        let pm = snap.agents.iter().find(|a| a.id == pm_id).unwrap();
        assert_eq!(
            pm.state, "Yielded",
            "PM should be force-yielded after stuck running timeout"
        );

        // Check that agent_force_yielded event was emitted with PM-specific reason
        let force_yield_events = env.events_named("agent_force_yielded");
        assert_eq!(
            force_yield_events.len(),
            1,
            "agent_force_yielded should be emitted"
        );
        assert_eq!(
            force_yield_events[0]["reason"].as_str().unwrap(),
            "pm_stuck_running_timeout",
            "reason should indicate PM stuck running"
        );

        // Next tick should process PM in yield queue
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let snap = registry.debug_snapshot().unwrap();
        let pm = snap.agents.iter().find(|a| a.id == pm_id).unwrap();
        assert_eq!(
            pm.state, "InReview",
            "PM should move to InReview after yield_queue processes it"
        );

        // pm_validation_requested should be emitted
        let pm_val_events = env.events_named("pm_validation_requested");
        assert_eq!(
            pm_val_events.len(),
            1,
            "pm_validation_requested should be emitted for force-yielded PM"
        );
    }

    #[tokio::test]
    async fn pm_safety_net_does_not_fire_for_yielded_pm() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Spawn PM
        env.set_ready_tasks(r#"[{"id":"epic-yielded","issue_type":"epic","priority":1}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let pm_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str()
            .unwrap()
            .to_string();

        // PM properly yields for review
        use crate::pm_phases::PMPhaseEvent;
        registry
            .transition_pm_phase(&pm_id, PMPhaseEvent::ExplorationComplete)
            .unwrap();
        registry
            .transition_pm_phase(&pm_id, PMPhaseEvent::DraftingComplete)
            .unwrap();
        registry
            .transition_pm_phase(&pm_id, PMPhaseEvent::ReviewComplete)
            .unwrap();

        let yp = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: None,
            git_branch: Some("task/epic-yielded".to_string()),
        };
        registry.yield_for_review(&pm_id, yp).unwrap();

        // Backdate to simulate long wait
        registry.test_backdate_state_entered(&pm_id, std::time::Duration::from_secs(301));

        // Safety net should NOT fire (PM is Yielded, not Running)
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // No extra force_yield events
        let force_yield_events = env.events_named("agent_force_yielded");
        assert_eq!(
            force_yield_events.len(),
            0,
            "safety net should NOT fire for Yielded PM"
        );

        // PM should move to InReview normally
        let snap = registry.debug_snapshot().unwrap();
        let pm = snap.agents.iter().find(|a| a.id == pm_id).unwrap();
        assert_eq!(pm.state, "InReview", "PM should be in InReview");
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: Validation fails → developer returns to Running → but
    // state_entered_at resets, so the 5-min stuck detector shouldn't trigger.
    // If state_entered_at is NOT updated, the safety net fires immediately.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn validation_fail_resets_state_entered_at() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        let agent_id = registry
            .spawn(
                "developer",
                Some("bd-vfail".to_string()),
                None,
                Some(project_path.to_string()),
            )
            .unwrap();

        // Backdate state_entered_at to 4 minutes ago (NOT past 5 min threshold)
        registry.test_backdate_state_entered(&agent_id, std::time::Duration::from_secs(240));

        // Yield + validate with failure
        let yp = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: None,
            git_branch: None,
        };
        registry.yield_for_review(&agent_id, yp).unwrap();
        registry
            .start_validation(&agent_id, Some("bd-vfail".to_string()))
            .unwrap();

        // Fail one validator
        registry
            .validation_submit(
                &agent_id,
                "code_review",
                false,
                vec!["bad code".to_string()],
            )
            .unwrap();
        registry
            .validation_submit(&agent_id, "business_logic", true, vec![])
            .unwrap();
        registry
            .validation_submit(&agent_id, "scope", true, vec![])
            .unwrap();

        // Agent should now be back in Running state after fail
        let snap_before = registry.debug_snapshot().unwrap();
        let agent_before = snap_before
            .agents
            .iter()
            .find(|a| a.id == agent_id)
            .unwrap();
        assert_eq!(
            agent_before.state, "Running",
            "agent should be back in Running after validation failure"
        );

        // Validation state should be cleaned up
        let pending: Vec<_> = snap_before
            .pending_validations
            .iter()
            .filter(|v| v.developer_agent_id == agent_id)
            .collect();
        assert_eq!(
            pending.len(),
            0,
            "validation state should be cleaned up after failure"
        );

        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // The stuck-running safety net should NOT have fired (agent just entered Running)
        let val_events = env.events_named("validation_requested");
        assert_eq!(
            val_events.len(),
            0,
            "BUG: stuck-running safety net fired immediately after validation fail. \
             state_entered_at was not reset when transitioning back to Running."
        );

        // Agent should still be Running (safety net didn't force-yield it)
        let snap_after = registry.debug_snapshot().unwrap();
        let agent_after = snap_after.agents.iter().find(|a| a.id == agent_id).unwrap();
        assert_eq!(
            agent_after.state, "Running",
            "agent should remain Running (safety net should not have fired)"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: Duplicate validator submission (same role submits twice).
    // Should be idempotent, not count double.
    // -----------------------------------------------------------------------

    #[test]
    fn duplicate_validator_submit_is_idempotent() {
        let registry = AgentRegistry::new();
        let id = registry
            .spawn(
                "developer",
                Some("bd-dup-val".to_string()),
                None,
                Some("/tmp".to_string()),
            )
            .unwrap();

        let yp = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: None,
            git_branch: None,
        };
        registry.yield_for_review(&id, yp).unwrap();
        registry
            .start_validation(&id, Some("bd-dup-val".to_string()))
            .unwrap();

        // Submit code_review twice
        let r1 = registry
            .validation_submit(&id, "code_review", true, vec![])
            .unwrap();
        let r2 = registry
            .validation_submit(&id, "code_review", false, vec!["evil".to_string()])
            .unwrap();

        // Second submit should be ignored
        assert!(r1.is_none(), "first submit doesn't complete (need 3)");
        assert!(
            r2.is_none(),
            "duplicate submit should be ignored, not counted"
        );

        // Submit remaining two
        registry
            .validation_submit(&id, "business_logic", true, vec![])
            .unwrap();
        let final_result = registry
            .validation_submit(&id, "scope", true, vec![])
            .unwrap();

        assert!(
            final_result.is_some(),
            "3 unique submits should complete validation"
        );
        assert!(
            final_result.unwrap().all_passed,
            "all should pass (dup was ignored)"
        );

        // Agent should now be in Done state
        let snap = registry.debug_snapshot().unwrap();
        let agent = snap.agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!(
            agent.state, "Done",
            "agent should be Done after all validators passed"
        );

        // Validation state should be cleaned up
        let pending: Vec<_> = snap
            .pending_validations
            .iter()
            .filter(|v| v.developer_agent_id == id)
            .collect();
        assert_eq!(
            pending.len(),
            0,
            "pending_validations should be empty after completion"
        );
    }

    // -----------------------------------------------------------------------
    // BUG PROBE: Symlink traversal attack — developer sets a symlink in
    // the worktree pointing outside. validate_path should catch it.
    // -----------------------------------------------------------------------

    #[test]
    fn symlink_escape_from_worktree_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let wt = project.join(".worktrees/agent-sym");
        std::fs::create_dir_all(&wt).unwrap();

        // Create a file outside the sandbox
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, "sensitive data").unwrap();

        // Create a symlink inside the worktree pointing outside
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, wt.join("escape")).unwrap();
        }

        let registry = AgentRegistry::new();
        let id = registry
            .spawn(
                "developer",
                Some("bd-sym".to_string()),
                None,
                Some(project.to_str().unwrap().to_string()),
            )
            .unwrap();
        registry
            .set_worktree_path(&id, wt.to_str().unwrap())
            .unwrap();

        // Try to access the symlinked path
        let escape_path = wt.join("escape");
        let result = registry.validate_path(&id, escape_path.to_str().unwrap());

        // This SHOULD fail because the canonical path resolves outside the worktree.
        // If it passes, that's a sandbox escape bug.
        #[cfg(unix)]
        assert!(
            result.is_err(),
            "BUG: symlink escape should be rejected by validate_path, \
             but it was allowed. The sandbox uses starts_with() on the \
             raw path instead of the canonicalized path."
        );
    }

    // -----------------------------------------------------------------------
    // close_eligible_from_task_list unit tests
    // -----------------------------------------------------------------------

    #[test]
    fn close_eligible_all_children_done() {
        let items: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
            {"id": "epic-1", "issue_type": "epic", "status": "in_progress"},
            {"id": "task-1", "type": "task", "status": "done", "parent": "epic-1"},
            {"id": "task-2", "type": "task", "status": "done", "parent": "epic-1"}
        ]"#,
        )
        .unwrap();
        let eligible = close_eligible_from_task_list(&items);
        assert_eq!(eligible, vec!["epic-1"]);
    }

    #[test]
    fn close_eligible_not_all_done() {
        let items: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
            {"id": "epic-1", "issue_type": "epic", "status": "in_progress"},
            {"id": "task-1", "type": "task", "status": "done", "parent": "epic-1"},
            {"id": "task-2", "type": "task", "status": "ready", "parent": "epic-1"}
        ]"#,
        )
        .unwrap();
        let eligible = close_eligible_from_task_list(&items);
        assert!(eligible.is_empty());
    }

    #[test]
    fn close_eligible_epic_no_children_not_eligible() {
        let items: Vec<serde_json::Value> =
            serde_json::from_str(r#"[{"id": "epic-1", "issue_type": "epic", "status": "open"}]"#)
                .unwrap();
        let eligible = close_eligible_from_task_list(&items);
        assert!(eligible.is_empty());
    }

    #[test]
    fn close_eligible_multiple_epics_mixed() {
        let items: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
            {"id": "epic-1", "issue_type": "epic", "status": "in_progress"},
            {"id": "epic-2", "issue_type": "epic", "status": "in_progress"},
            {"id": "task-1", "type": "task", "status": "done", "parent": "epic-1"},
            {"id": "task-2", "type": "task", "status": "done", "parent": "epic-2"},
            {"id": "task-3", "type": "task", "status": "ready", "parent": "epic-2"}
        ]"#,
        )
        .unwrap();
        let eligible = close_eligible_from_task_list(&items);
        assert_eq!(eligible, vec!["epic-1"]);
    }

    #[test]
    fn close_eligible_empty_list() {
        let eligible = close_eligible_from_task_list(&[]);
        assert!(eligible.is_empty());
    }

    #[test]
    fn close_eligible_type_alias_both_accepted() {
        let items: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
            {"id": "e1", "type": "epic"},
            {"id": "t1", "issue_type": "task", "status": "done", "parent": "e1"}
        ]"#,
        )
        .unwrap();
        let eligible = close_eligible_from_task_list(&items);
        assert_eq!(
            eligible,
            vec!["e1"],
            "type alias should work same as issue_type"
        );
    }

    #[test]
    fn close_eligible_items_without_id_skipped() {
        let items: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
            {"issue_type": "epic"},
            {"id": "e1", "issue_type": "epic"},
            {"id": "t1", "type": "task", "status": "done", "parent": "e1"}
        ]"#,
        )
        .unwrap();
        let eligible = close_eligible_from_task_list(&items);
        assert_eq!(eligible, vec!["e1"]);
    }

    #[test]
    fn close_eligible_all_children_closed() {
        let items: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
            {"id": "epic-1", "issue_type": "epic", "status": "in_progress"},
            {"id": "task-1", "type": "task", "status": "closed", "parent": "epic-1"},
            {"id": "task-2", "type": "task", "status": "closed", "parent": "epic-1"}
        ]"#,
        )
        .unwrap();
        let eligible = close_eligible_from_task_list(&items);
        assert_eq!(eligible, vec!["epic-1"]);
    }

    #[test]
    fn close_eligible_mixed_done_and_closed_children() {
        let items: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
            {"id": "epic-1", "issue_type": "epic", "status": "in_progress"},
            {"id": "task-1", "type": "task", "status": "done", "parent": "epic-1"},
            {"id": "task-2", "type": "task", "status": "closed", "parent": "epic-1"}
        ]"#,
        )
        .unwrap();
        let eligible = close_eligible_from_task_list(&items);
        assert_eq!(eligible, vec!["epic-1"]);
    }

    // -----------------------------------------------------------------------
    // role_for_task unit tests
    // -----------------------------------------------------------------------

    #[test]
    fn role_for_task_epic_maps_to_pm() {
        assert_eq!(role_for_task("epic", 2), "project_manager");
        assert_eq!(role_for_task("Epic", 1), "project_manager");
        assert_eq!(role_for_task("EPIC", 0), "project_manager");
    }

    #[test]
    fn role_for_task_default_is_developer() {
        assert_eq!(role_for_task("task", 2), "developer");
        assert_eq!(role_for_task("bug", 1), "developer");
        assert_eq!(role_for_task("", 2), "developer");
        assert_eq!(role_for_task("unknown_type", 2), "developer");
    }

    // -----------------------------------------------------------------------
    // Safety mode: caps spawns per tick to 2
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn safety_mode_caps_spawns_per_tick() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        meta_db.set_setting("safety_mode_enabled", "1").unwrap();
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        env.set_ready_tasks(
            r#"[
            {"id":"bd-s1","issue_type":"task","priority":2},
            {"id":"bd-s2","issue_type":"task","priority":2},
            {"id":"bd-s3","issue_type":"task","priority":2},
            {"id":"bd-s4","issue_type":"task","priority":2},
            {"id":"bd-s5","issue_type":"task","priority":2}
        ]"#,
        );

        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let spawned = env.events_named("agent_spawned");
        assert_eq!(
            spawned.len(),
            2,
            "safety mode should cap at 2 spawns per tick, got {}",
            spawned.len()
        );

        let snap = metrics.snapshot(0);
        assert!(snap.safety_mode_enabled);
    }

    // -----------------------------------------------------------------------
    // Merge retry exhaustion: task marked blocked after MAX_MERGE_RETRIES
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn merge_retry_exhausted_marks_task_blocked() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Create conflicting branches so merge fails
        std::fs::write(repo.path().join("clash.txt"), "base").unwrap();
        git(repo.path(), &["add", "clash.txt"]);
        git(repo.path(), &["commit", "-m", "seed"]);
        git(repo.path(), &["checkout", "-b", "task/bd-exhaust"]);
        std::fs::write(repo.path().join("clash.txt"), "task version").unwrap();
        git(repo.path(), &["add", "clash.txt"]);
        git(repo.path(), &["commit", "-m", "task change"]);
        git(repo.path(), &["checkout", "main"]);
        std::fs::write(repo.path().join("clash.txt"), "conflicting base").unwrap();
        git(repo.path(), &["add", "clash.txt"]);
        git(repo.path(), &["commit", "-m", "base conflict"]);

        // Enqueue with retry_count at the limit
        merge_queue.push(MergeEntry {
            agent_id: "dead-agent".to_string(),
            task_id: "bd-exhaust".to_string(),
            retry_count: MAX_MERGE_RETRIES,
        });

        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let statuses = env.events_named("merge_status");
        assert!(
            statuses
                .iter()
                .any(|e| e["status"] == "failed" && e["task_id"] == "bd-exhaust"),
            "merge should be marked permanently failed after retry exhaustion"
        );

        let blocked_calls = env.bd_calls_matching("bd-exhaust").iter().any(|args| {
            args.contains(&"update".to_string()) && args.contains(&"blocked".to_string())
        });
        assert!(
            blocked_calls,
            "task should be marked blocked in Beads after retry exhaustion"
        );

        let ma_spawns: Vec<_> = env
            .events_named("agent_spawned")
            .into_iter()
            .filter(|e| e["role"] == "merge_agent")
            .collect();
        assert_eq!(
            ma_spawns.len(),
            0,
            "no merge agent should be spawned when retries are exhausted"
        );
    }

    // -----------------------------------------------------------------------
    // OrchestrationState transitions
    // -----------------------------------------------------------------------

    #[test]
    fn orchestration_state_transitions() {
        let state = OrchestrationState::new();
        assert_eq!(state.get(), 0);
        assert!(!state.is_running());

        state.set_running();
        assert_eq!(state.get(), 1);
        assert!(state.is_running());

        state.set_paused();
        assert_eq!(state.get(), 2);
        assert!(!state.is_running());
    }

    // -----------------------------------------------------------------------
    // MergeQueue retry count tracking
    // -----------------------------------------------------------------------

    #[test]
    fn merge_queue_retry_count_set_and_take() {
        let q = MergeQueue::new();
        assert_eq!(q.take_retry_count("bd-1"), 0, "default retry count is 0");
        q.set_retry_count("bd-1", 2);
        assert_eq!(q.take_retry_count("bd-1"), 2);
        assert_eq!(
            q.take_retry_count("bd-1"),
            0,
            "take should consume the count"
        );
    }

    // -----------------------------------------------------------------------
    // OrchestrationMetrics accumulation
    // -----------------------------------------------------------------------

    #[test]
    fn metrics_accumulate_correctly() {
        let m = OrchestrationMetrics::new();
        m.inc_merge_retry();
        m.inc_merge_retry();
        m.inc_validation_timeout_block();
        m.set_safety_mode_enabled(true);
        let snap = m.snapshot(5);
        assert_eq!(snap.merge_retry_count, 2);
        assert_eq!(snap.validation_timeout_blocks, 1);
        assert_eq!(snap.merge_queue_depth, 5);
        assert!(snap.safety_mode_enabled);
    }

    // ===================================================================
    // E2E integration tests — multi-tick lifecycle flows
    // ===================================================================

    // -----------------------------------------------------------------------
    // E2E: Full lifecycle: spawn → yield → validate (pass) → merge → done
    // Verifies the COMPLETE event sequence across 3 ticks.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn e2e_full_lifecycle_spawn_validate_merge() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        std::fs::write(repo.path().join("feature.txt"), "original").unwrap();
        git(repo.path(), &["add", "feature.txt"]);
        git(repo.path(), &["commit", "-m", "seed"]);

        // --- Tick 1: bd ready → spawn developer ---

        env.set_ready_tasks(r#"[{"id":"bd-lifecycle","issue_type":"task","priority":2}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let spawned = env.events_named("agent_spawned");
        assert_eq!(spawned.len(), 1, "tick 1: exactly one developer spawned");
        let agent_id = spawned[0]["agent_id"].as_str().unwrap().to_string();
        assert_eq!(spawned[0]["role"].as_str().unwrap(), "developer");
        assert_eq!(spawned[0]["task_id"].as_str().unwrap(), "bd-lifecycle");

        let wt_path = registry.get_worktree_path(&agent_id).unwrap().unwrap();
        assert!(
            std::path::Path::new(&wt_path).exists(),
            "worktree created on disk"
        );

        let claim_calls = env.bd_calls_matching("--claim");
        assert_eq!(claim_calls.len(), 1, "bd claim called once");
        assert!(claim_calls[0].contains(&"bd-lifecycle".to_string()));

        // Developer does work in worktree
        std::fs::write(format!("{wt_path}/feature.txt"), "implemented feature").unwrap();
        git_in(&wt_path, &["add", "feature.txt"]);
        git_in(&wt_path, &["commit", "-m", "implement feature"]);

        let yp = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: Some("Implemented the feature".to_string()),
            git_branch: Some("task/bd-lifecycle".to_string()),
        };
        registry.yield_for_review(&agent_id, yp).unwrap();

        // --- Tick 2: yield queue → validation_requested ---

        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let val_events = env.events_named("validation_requested");
        assert_eq!(val_events.len(), 1, "tick 2: validation_requested emitted");
        assert_eq!(
            val_events[0]["developer_agent_id"].as_str().unwrap(),
            agent_id
        );
        assert_eq!(val_events[0]["task_id"].as_str().unwrap(), "bd-lifecycle");

        let snap = registry.debug_snapshot().unwrap();
        let agent = snap.agents.iter().find(|a| a.id == agent_id).unwrap();
        assert_eq!(
            agent.state, "InReview",
            "agent should be InReview after tick 2"
        );

        // All 3 validators pass
        for role in &["code_review", "business_logic", "scope"] {
            registry
                .validation_submit(&agent_id, role, true, vec![])
                .unwrap();
        }

        let snap = registry.debug_snapshot().unwrap();
        let agent = snap.agents.iter().find(|a| a.id == agent_id).unwrap();
        assert_eq!(
            agent.state, "Done",
            "agent enters Done after all validators pass"
        );

        // --- Tick 3: done → merge queue → merge clean → done ---

        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let content = std::fs::read_to_string(repo.path().join("feature.txt")).unwrap();
        assert_eq!(content, "implemented feature", "change merged to main");

        let head = git(repo.path(), &["symbolic-ref", "--short", "HEAD"]);
        assert_eq!(
            String::from_utf8_lossy(&head.stdout).trim(),
            "main",
            "HEAD on main"
        );
        assert!(
            !repo.path().join(".git/MERGE_HEAD").exists(),
            "no stale MERGE_HEAD"
        );

        let branch = git(repo.path(), &["rev-parse", "--verify", "task/bd-lifecycle"]);
        assert!(!branch.status.success(), "task branch deleted after merge");

        assert!(
            !std::path::Path::new(&wt_path).exists(),
            "worktree removed from disk"
        );

        let statuses = env.events_named("merge_status");
        assert!(
            statuses
                .iter()
                .any(|e| e["status"] == "done" && e["task_id"] == "bd-lifecycle"),
            "merge_status=done emitted"
        );

        let bd_done = env.bd_calls_matching("bd-lifecycle").iter().any(|args| {
            args.contains(&"close".to_string())
                || (args.contains(&"update".to_string()) && args.contains(&"done".to_string()))
        });
        assert!(bd_done, "bd close (or bd update --status done) called");

        let snap = registry.debug_snapshot().unwrap();
        assert_eq!(snap.agents.len(), 0, "registry empty after full lifecycle");
        assert_eq!(merge_queue.depth(), 0, "merge queue drained");

        // Verify complete event sequence
        let all_events: Vec<String> = env.events().iter().map(|e| e.event.clone()).collect();
        let spawned_idx = all_events
            .iter()
            .position(|e| e == "agent_spawned")
            .unwrap();
        let val_idx = all_events
            .iter()
            .position(|e| e == "validation_requested")
            .unwrap();
        let merge_done_idx = all_events
            .iter()
            .rposition(|e| e == "merge_status")
            .unwrap();
        assert!(
            spawned_idx < val_idx && val_idx < merge_done_idx,
            "event ordering: agent_spawned < validation_requested < merge_status"
        );
    }

    // -----------------------------------------------------------------------
    // E2E: Validation fails → retry → pass → merge
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn e2e_validation_fail_retry_then_pass() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        std::fs::write(repo.path().join("retry.txt"), "v1").unwrap();
        git(repo.path(), &["add", "retry.txt"]);
        git(repo.path(), &["commit", "-m", "seed"]);

        // Tick 1: spawn developer
        env.set_ready_tasks(r#"[{"id":"bd-retry","issue_type":"task","priority":2}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let agent_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str()
            .unwrap()
            .to_string();
        let wt_path = registry.get_worktree_path(&agent_id).unwrap().unwrap();

        // First attempt: developer modifies file and yields
        std::fs::write(format!("{wt_path}/retry.txt"), "v2 buggy").unwrap();
        git_in(&wt_path, &["add", "retry.txt"]);
        git_in(&wt_path, &["commit", "-m", "first attempt"]);

        let yp1 = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: Some("First attempt".to_string()),
            git_branch: Some("task/bd-retry".to_string()),
        };
        registry.yield_for_review(&agent_id, yp1).unwrap();

        // Tick 2: yield queue → validation_requested #1
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let val_events_1 = env.events_named("validation_requested");
        assert_eq!(val_events_1.len(), 1, "first validation_requested emitted");

        // Validators: code_review FAILS, others pass
        registry
            .validation_submit(
                &agent_id,
                "code_review",
                false,
                vec!["Missing error handling".to_string()],
            )
            .unwrap();
        registry
            .validation_submit(&agent_id, "business_logic", true, vec![])
            .unwrap();
        let outcome = registry
            .validation_submit(&agent_id, "scope", true, vec![])
            .unwrap();
        assert!(outcome.is_some(), "outcome returned after 3 validators");
        assert!(!outcome.unwrap().all_passed, "validation should fail");

        let snap = registry.debug_snapshot().unwrap();
        let agent = snap.agents.iter().find(|a| a.id == agent_id).unwrap();
        assert_eq!(agent.state, "Running", "agent back to Running after fail");

        // Second attempt: developer fixes and re-yields
        std::fs::write(format!("{wt_path}/retry.txt"), "v3 fixed").unwrap();
        git_in(&wt_path, &["add", "retry.txt"]);
        git_in(&wt_path, &["commit", "-m", "fix error handling"]);

        let yp2 = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: Some("Fixed error handling".to_string()),
            git_branch: Some("task/bd-retry".to_string()),
        };
        registry.yield_for_review(&agent_id, yp2).unwrap();

        // Tick 3: second yield → validation_requested #2
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let val_events_2 = env.events_named("validation_requested");
        assert_eq!(val_events_2.len(), 2, "second validation_requested emitted");

        // All validators pass this time
        for role in &["code_review", "business_logic", "scope"] {
            registry
                .validation_submit(&agent_id, role, true, vec![])
                .unwrap();
        }

        let snap = registry.debug_snapshot().unwrap();
        let agent = snap.agents.iter().find(|a| a.id == agent_id).unwrap();
        assert_eq!(agent.state, "Done", "agent Done after second validation");

        // Tick 4: merge
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let content = std::fs::read_to_string(repo.path().join("retry.txt")).unwrap();
        assert_eq!(content, "v3 fixed", "fixed version merged to main");

        let statuses = env.events_named("merge_status");
        assert!(
            statuses
                .iter()
                .any(|e| e["status"] == "done" && e["task_id"] == "bd-retry"),
            "merge_status=done emitted for retry task"
        );

        let snap = registry.debug_snapshot().unwrap();
        assert_eq!(snap.agents.len(), 0, "registry empty after retry lifecycle");
    }

    // -----------------------------------------------------------------------
    // E2E: Mixed roles — epic spawns PM, tasks spawn developers
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn e2e_epic_plus_tasks_mixed_roles() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        std::fs::write(repo.path().join("a.txt"), "a").unwrap();
        git(repo.path(), &["add", "a.txt"]);
        git(repo.path(), &["commit", "-m", "seed"]);

        // bd ready returns an epic + 2 tasks
        env.set_ready_tasks(
            r#"[
            {"id":"epic-main","issue_type":"epic","priority":1},
            {"id":"bd-task-1","issue_type":"task","priority":2},
            {"id":"bd-task-2","issue_type":"task","priority":2}
        ]"#,
        );
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let spawned = env.events_named("agent_spawned");
        assert_eq!(spawned.len(), 3, "PM + 2 developers spawned");

        let pm: Vec<_> = spawned
            .iter()
            .filter(|e| e["role"] == "project_manager")
            .collect();
        let devs: Vec<_> = spawned
            .iter()
            .filter(|e| e["role"] == "developer")
            .collect();
        assert_eq!(pm.len(), 1, "one PM for epic");
        assert_eq!(devs.len(), 2, "two developers for tasks");
        assert_eq!(pm[0]["task_id"].as_str().unwrap(), "epic-main");

        let pm_id = pm[0]["agent_id"].as_str().unwrap().to_string();
        let dev_ids: Vec<String> = devs
            .iter()
            .map(|e| e["agent_id"].as_str().unwrap().to_string())
            .collect();

        // PM should NOT have a worktree (only developers get worktrees)
        let pm_wt = registry.get_worktree_path(&pm_id).unwrap();
        assert!(pm_wt.is_none(), "PM should not have a worktree");

        // Both devs should have worktrees
        for dev_id in &dev_ids {
            let wt = registry.get_worktree_path(dev_id).unwrap();
            assert!(wt.is_some(), "developer {} should have a worktree", dev_id);
        }

        // PM yields for review (PMs must yield, like developers)
        // First transition PM through phases to Finalization
        use crate::pm_phases::PMPhaseEvent;
        registry
            .transition_pm_phase(&pm_id, PMPhaseEvent::ExplorationComplete)
            .unwrap();
        registry
            .transition_pm_phase(&pm_id, PMPhaseEvent::DraftingComplete)
            .unwrap();
        registry
            .transition_pm_phase(&pm_id, PMPhaseEvent::ReviewComplete)
            .unwrap();

        let pm_task_id = pm[0]["task_id"].as_str().unwrap();
        let yp = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: None,
            git_branch: Some(format!("task/{pm_task_id}")),
        };
        registry.yield_for_review(&pm_id, yp).unwrap();

        // Both developers do work and yield
        for dev_id in &dev_ids {
            let wt_path = registry.get_worktree_path(dev_id).unwrap().unwrap();
            let filename = format!(
                "{wt_path}/work-{}.txt",
                dev_id.chars().take(8).collect::<String>()
            );
            std::fs::write(&filename, "developer work").unwrap();
            git_in(&wt_path, &["add", "."]);
            git_in(&wt_path, &["commit", "-m", "dev work"]);

            let task_id = registry
                .debug_snapshot()
                .unwrap()
                .agents
                .iter()
                .find(|a| a.id == *dev_id)
                .unwrap()
                .task_id
                .clone()
                .unwrap();
            let yp = crate::agent_registry::YieldPayload {
                status: "done".to_string(),
                diff_summary: None,
                git_branch: Some(format!("task/{task_id}")),
            };
            registry.yield_for_review(dev_id, yp).unwrap();
        }

        // Tick 2: PM enters validation, devs enter validation
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // PM should be in InReview state (pending validation)
        let snap = registry.debug_snapshot().unwrap();
        let pm_agent = snap
            .agents
            .iter()
            .find(|a| a.role == "project_manager")
            .expect("PM should still exist");
        assert_eq!(pm_agent.state, "InReview", "PM should be in InReview state");

        // Check that pm_validation_requested was emitted
        let pm_val_events = env.events_named("pm_validation_requested");
        assert_eq!(
            pm_val_events.len(),
            1,
            "pm_validation_requested should be emitted"
        );

        // Complete PM validation (simulating frontend validation passing)
        registry
            .complete_pm_validation(&pm_id, true, true, vec![])
            .unwrap();

        // PM should now be Done
        let snap = registry.debug_snapshot().unwrap();
        let live_pms: Vec<_> = snap
            .agents
            .iter()
            .filter(|a| a.role == "project_manager" && a.state != "Done")
            .collect();
        assert_eq!(
            live_pms.len(),
            0,
            "PM should be Done after validation passes"
        );

        let val_events = env.events_named("validation_requested");
        assert_eq!(val_events.len(), 2, "both devs get validation_requested");

        // Pass all validators for both devs
        for dev_id in &dev_ids {
            for role in &["code_review", "business_logic", "scope"] {
                registry
                    .validation_submit(dev_id, role, true, vec![])
                    .unwrap();
            }
        }

        // Tick 3: merge both developers
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let merge_dones: Vec<_> = env
            .events_named("merge_status")
            .into_iter()
            .filter(|e| e["status"] == "done")
            .collect();
        assert!(
            merge_dones.len() >= 1,
            "at least one merge_status=done emitted"
        );

        let snap = registry.debug_snapshot().unwrap();
        let live_devs: Vec<_> = snap
            .agents
            .iter()
            .filter(|a| a.role == "developer")
            .collect();
        assert_eq!(live_devs.len(), 0, "all developers killed after merge");
    }

    // -----------------------------------------------------------------------
    // E2E: Safety mode throttles merges to 1 per tick
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn e2e_safety_mode_merge_throttling() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        meta_db.set_setting("safety_mode_enabled", "1").unwrap();
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Create two non-conflicting task branches
        std::fs::write(repo.path().join("file1.txt"), "v1").unwrap();
        std::fs::write(repo.path().join("file2.txt"), "v1").unwrap();
        git(repo.path(), &["add", "."]);
        git(repo.path(), &["commit", "-m", "seed"]);

        git(repo.path(), &["checkout", "-b", "task/bd-merge-1"]);
        std::fs::write(repo.path().join("file1.txt"), "changed by task 1").unwrap();
        git(repo.path(), &["add", "file1.txt"]);
        git(repo.path(), &["commit", "-m", "task 1 change"]);
        git(repo.path(), &["checkout", "main"]);

        git(repo.path(), &["checkout", "-b", "task/bd-merge-2"]);
        std::fs::write(repo.path().join("file2.txt"), "changed by task 2").unwrap();
        git(repo.path(), &["add", "file2.txt"]);
        git(repo.path(), &["commit", "-m", "task 2 change"]);
        git(repo.path(), &["checkout", "main"]);

        // Pre-fill merge queue with 2 entries
        merge_queue.push(MergeEntry {
            agent_id: "agent-m1".to_string(),
            task_id: "bd-merge-1".to_string(),
            retry_count: 0,
        });
        merge_queue.push(MergeEntry {
            agent_id: "agent-m2".to_string(),
            task_id: "bd-merge-2".to_string(),
            retry_count: 0,
        });
        assert_eq!(merge_queue.depth(), 2, "pre-check: 2 entries in queue");

        // Tick: safety mode caps merges at 1
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        assert_eq!(
            merge_queue.depth(),
            1,
            "safety mode should process only 1 merge per tick, leaving 1 in queue"
        );

        let statuses = env.events_named("merge_status");
        let done_count = statuses.iter().filter(|e| e["status"] == "done").count();
        assert_eq!(
            done_count, 1,
            "exactly 1 merge_status=done emitted this tick"
        );

        // Tick again: process the remaining entry
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        assert_eq!(
            merge_queue.depth(),
            0,
            "queue fully drained after second tick"
        );

        let statuses = env.events_named("merge_status");
        let done_count = statuses.iter().filter(|e| e["status"] == "done").count();
        assert_eq!(done_count, 2, "both merges completed after 2 ticks");

        // Verify both changes landed on main
        let f1 = std::fs::read_to_string(repo.path().join("file1.txt")).unwrap();
        let f2 = std::fs::read_to_string(repo.path().join("file2.txt")).unwrap();
        assert_eq!(f1, "changed by task 1", "task 1 change on main");
        assert_eq!(f2, "changed by task 2", "task 2 change on main");
    }

    // -----------------------------------------------------------------------
    // Helper: run git commands concisely in tests
    // -----------------------------------------------------------------------

    fn git(dir: &Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
    }

    fn git_in(dir: &str, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
    }
}
