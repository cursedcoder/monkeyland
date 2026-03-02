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
    fn spawn_pty(
        &self,
        id: &str,
        cols: u16,
        rows: u16,
        cwd: Option<&Path>,
    ) -> Result<(), String>;
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

    fn spawn_pty(
        &self,
        id: &str,
        cols: u16,
        rows: u16,
        cwd: Option<&Path>,
    ) -> Result<(), String> {
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
            continue; // no children yet, don't close
        };
        if !children.is_empty() && children.iter().all(|s| s == "done") {
            eligible.push(epic_id);
        }
    }
    eligible.sort();
    eligible.dedup();
    Ok(eligible)
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentSpawnedPayload {
    pub agent_id: String,
    pub role: String,
    pub task_id: Option<String>,
    pub parent_agent_id: Option<String>,
    pub merge_context: Option<MergeContext>,
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

    // 1. bd ready --json
    let args = vec!["ready".to_string(), "--json".to_string()];
    let stdout = env.run_bd(path, &args)?;

    let tasks: Vec<BeadsIssue> = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(_) => {
            // bd might return empty array or different shape
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
                                item.get("priority").and_then(|v| v.as_u64()).unwrap_or(2) as u8;
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
                crate::worktree::create(&wt_path_buf, &wt_agent_id, &wt_task_id)
            })
            .await
            {
                Ok(Ok(wt)) => {
                    let _ = registry.set_worktree_path(&agent_id, wt.to_str().unwrap_or_default());
                    wt
                }
                _ => {
                    eprintln!("[orch] worktree creation failed for {agent_id}, using project dir");
                    path.to_path_buf()
                }
            }
        } else {
            path.to_path_buf()
        };

        if env
            .spawn_pty(&agent_id, 80, 24, Some(agent_cwd.as_path()))
            .is_err()
        {
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

        let _ = env_emit(
            env,
            "agent_spawned",
            &AgentSpawnedPayload {
                agent_id: agent_id.clone(),
                role: role.clone(),
                task_id: Some(task.id.clone()),
                parent_agent_id: None,
                merge_context: None,
            },
        );
        spawned_this_tick += 1;
    }

    // 3. Kill expired agents (clean up worktree without merging, release Beads claim)
    let expired = registry.expired_agent_ids()?;
    for (id, task_id) in expired {
        if let Ok(Some(_wt)) = registry.get_worktree_path(&id) {
            let wt_path = path.to_path_buf();
            let wt_id = id.clone();
            let _ = tokio::task::spawn_blocking(move || crate::worktree::remove(&wt_path, &wt_id))
                .await;
        }
        // Release the Beads task claim so the task can be re-assigned.
        if let Some(tid) = &task_id {
            let unclaim_args = vec![
                "update".to_string(),
                tid.clone(),
                "--status".to_string(),
                "ready".to_string(),
            ];
            let _ = env.run_bd(path, &unclaim_args);
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
        eprintln!(
            "[orch] Emitting validation_requested for developer {}",
            developer_agent_id
        );
        if let Err(e) = env_emit(
            env,
            "validation_requested",
            &ValidationRequestedPayload {
                developer_agent_id: developer_agent_id.clone(),
                task_id,
                git_branch,
                diff_summary,
            },
        ) {
            eprintln!("[orch] FAILED to emit validation_requested: {}", e);
        }
    }
    // 4b. SAFETY NET: Force-yield developers stuck in Running state for > 5 minutes.
    // This catches ALL cases: nudge failed, frontend crashed, LLM looped forever, etc.
    // After force_yield, the agent goes to Yielded without a validation entry,
    // so the NEXT tick's yield_queue (step 4) will pick it up normally.
    let stuck_running = registry.stuck_running_developers(300)?;
    for agent_id in stuck_running {
        eprintln!(
            "[orch] SAFETY NET: Force-yielding developer {} stuck in Running for >5min",
            agent_id
        );
        let _ = registry.force_yield(&agent_id);
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
            eprintln!("[orch] merge agent {agent_id} done for task {task_id}; re-enqueueing for merge");
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
            let done_args = vec![
                "update".to_string(),
                task_id.clone(),
                "--status".to_string(),
                "done".to_string(),
            ];
            let _ = env.run_bd(path, &done_args);
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
                    let done_args = vec![
                        "update".to_string(),
                        task_id.clone(),
                        "--status".to_string(),
                        "done".to_string(),
                    ];
                    let _ = env.run_bd(path, &done_args);
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
                        env, path, registry, merge_queue, metrics, entry, &detail,
                    )
                    .await;
                }
                Ok(Err(e)) => {
                    eprintln!("[orch] merge error for task {task_id}: {e}");
                    handle_merge_conflict(
                        env, path, registry, merge_queue, metrics, entry, &e,
                    )
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
                env, path, registry, merge_queue, metrics, entry, "rebase conflict",
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
        crate::worktree::create(&wt_path, &wt_agent, &wt_task)
    })
    .await
    {
        Ok(Ok(wt)) => {
            let _ = registry.set_worktree_path(&merge_agent_id, wt.to_str().unwrap_or_default());
            wt
        }
        _ => {
            eprintln!("[orch] merge agent worktree creation failed for {task_id}");
            project_path.to_path_buf()
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
            if args.len() >= 3 && args[0] == "show" && args.last().map(|a| a.as_str()) == Some("--json") {
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
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

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
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();
        for (id, _) in [(&id_a, "bd-A"), (&id_b, "bd-B")] {
            for role in &["code_review", "business_logic", "scope"] {
                registry.validation_submit(id, role, true, vec![]).unwrap();
            }
        }

        // Tick: both enter Done → both enqueued for merge → train runs.
        // First merge should be clean. Second should conflict because
        // first already changed shared.txt on main.
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

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
            args.contains(&"update".to_string()) && args.contains(&"done".to_string())
        });
        assert!(
            bd_done_winner,
            "bd update {winner_task} --status done should have been called"
        );

        let bd_done_loser = env.bd_calls_matching(&loser_task).iter().any(|args| {
            args.contains(&"update".to_string()) && args.contains(&"done".to_string())
        });
        assert!(
            !bd_done_loser,
            "bd update {loser_task} --status done should NOT be called (still in conflict)"
        );

        // --- 5. Registry state ---

        let snap = registry.debug_snapshot().unwrap();
        let live_devs: Vec<_> = snap.agents.iter().filter(|a| a.role == "developer").collect();
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
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

        let agent_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str().unwrap().to_string();
        let wt_path = registry.get_worktree_path(&agent_id).unwrap().unwrap();

        // Worktree dir should exist on disk right now
        assert!(
            std::path::Path::new(&wt_path).exists(),
            "worktree should exist on disk before TTL kill"
        );

        // Expire the agent
        registry.test_backdate_spawn(&agent_id, std::time::Duration::from_secs(901));
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

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

        // --- HEAD still on main (TTL kill should not disturb repo state) ---

        let head = git(repo.path(), &["symbolic-ref", "--short", "HEAD"]);
        let head_str = String::from_utf8_lossy(&head.stdout).trim().to_string();
        assert_eq!(head_str, "main", "HEAD should remain on main after TTL kill");
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
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

        let spawned = env.events_named("agent_spawned");
        assert_eq!(spawned.len(), 1, "only the task with an id should spawn");
        assert_eq!(spawned[0]["task_id"].as_str().unwrap(), "bd-ok");
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
            .spawn("developer", Some("bd-partial".to_string()), None, Some(project_path.to_string()))
            .unwrap();

        let yp = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: None,
            git_branch: None,
        };
        registry.yield_for_review(&agent_id, yp).unwrap();
        registry.start_validation(&agent_id, Some("bd-partial".to_string())).unwrap();

        // Only 2 of 3 validators submit
        registry.validation_submit(&agent_id, "code_review", true, vec![]).unwrap();
        registry.validation_submit(&agent_id, "business_logic", true, vec![]).unwrap();

        // Backdate and force-block via safety net
        registry.test_backdate_state_entered(&agent_id, std::time::Duration::from_secs(301));
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

        // --- Metrics: safety net fired ---

        let snap = metrics.snapshot(0);
        assert!(snap.validation_timeout_blocks > 0, "safety net should have fired");

        // --- Registry: agent is in Blocked state, not stuck in InReview ---

        let debug = registry.debug_snapshot().unwrap();
        let agent = debug.agents.iter().find(|a| a.id == agent_id);
        assert!(agent.is_some(), "agent should still exist in registry after force-block");
        assert_eq!(
            agent.unwrap().state, "Blocked",
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
        assert!(agent_after.is_some(), "agent should still exist after late submit");
        assert_eq!(
            agent_after.unwrap().state, "Blocked",
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
        assert!(result.is_ok(), "merge of dead agent's task should not crash");

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

        // --- Beads: bd update should mark task done ---

        let bd_done = env.bd_calls_matching("bd-ghost").iter().any(|args| {
            args.contains(&"update".to_string()) && args.contains(&"done".to_string())
        });
        assert!(
            bd_done,
            "bd update bd-ghost --status done should be called even for dead agent"
        );

        // --- Registry: no agents should remain ---

        let snap = registry.debug_snapshot().unwrap();
        assert_eq!(
            snap.agents.len(),
            0,
            "registry should be empty (dead-agent was never registered)"
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
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();
        assert_eq!(env.events_named("agent_spawned").len(), 1);

        // Tick 2: bd still reports task as ready (claim failed so Beads doesn't know)
        // But registry's claimed_task_ids should prevent a second spawn
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();
        assert_eq!(
            env.events_named("agent_spawned").len(),
            1,
            "registry dedup should prevent double-spawn even when bd claim failed"
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
            .spawn("merge_agent", Some("bd-remerge".to_string()), None, Some(project_path.to_string()))
            .unwrap();

        // Set a retry count (simulating a prior conflict)
        merge_queue.set_retry_count("bd-remerge", 1);

        // The merge_agent "finishes" its work
        registry.complete_task(&ma_id).unwrap();

        // tick should see the done merge_agent in step 5, re-enqueue the task
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

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

        // --- Beads: bd update --status done called ---

        let bd_done = env.bd_calls_matching("bd-remerge").iter().any(|args| {
            args.contains(&"update".to_string()) && args.contains(&"done".to_string())
        });
        assert!(
            bd_done,
            "bd update bd-remerge --status done should be called after successful re-merge"
        );

        // --- Registry: merge agent killed ---

        let snap = registry.debug_snapshot().unwrap();
        assert_eq!(
            snap.agents.len(),
            0,
            "merge agent should be killed after re-merge completes"
        );

        // --- Events: merging + done should both appear ---

        let statuses = env.events_named("merge_status");
        assert!(
            statuses.iter().any(|e| e["status"] == "merging"),
            "merge_status 'merging' should be emitted when re-enqueuing"
        );
        assert!(
            statuses.iter().any(|e| e["status"] == "done" && e["task_id"] == "bd-remerge"),
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
            fn spawn_pty(&self, _id: &str, _c: u16, _r: u16, _cwd: Option<&Path>) -> Result<(), String> {
                Err("PTY pool full (20 slots)".to_string())
            }
            fn kill_pty(&self, _id: &str) -> Result<(), String> {
                Ok(())
            }
        }

        let inner = TestOrchEnv::new();
        inner.set_ready_tasks(r#"[{"id":"bd-nopipe","issue_type":"task","priority":2}]"#);
        let env = FullPoolEnv(inner);

        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

        // No agent_spawned event (spawn_pty failed, agent was killed)
        let spawned = env.0.events_named("agent_spawned");
        assert_eq!(spawned.len(), 0, "should not emit agent_spawned when PTY fails");

        // Registry should be clean (no zombie)
        let status = registry.status().unwrap();
        assert_eq!(
            status.used_slots, 0,
            "no zombie agents should remain when PTY spawn fails"
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
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

        let agent_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str().unwrap().to_string();
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
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();
        for role in &["code_review", "business_logic", "scope"] {
            registry.validation_submit(&agent_id, role, true, vec![]).unwrap();
        }

        // Merge tick
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

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

        // --- Beads: bd update --status done called ---

        let bd_done = env.bd_calls_matching("bd-clean").iter().any(|args| {
            args.contains(&"update".to_string()) && args.contains(&"done".to_string())
        });
        assert!(
            bd_done,
            "bd update bd-clean --status done should have been called"
        );

        // --- Registry: developer killed, no zombies ---

        let snap = registry.debug_snapshot().unwrap();
        let live_devs: Vec<_> = snap.agents.iter().filter(|a| a.role == "developer").collect();
        assert_eq!(
            live_devs.len(),
            0,
            "developer should be killed after successful merge"
        );

        // --- Events: merge_status done emitted ---

        let statuses = env.events_named("merge_status");
        assert!(
            statuses.iter().any(|e| e["status"] == "done" && e["task_id"] == "bd-clean"),
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
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

        let agent_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str().unwrap().to_string();

        registry.test_backdate_state_entered(&agent_id, std::time::Duration::from_secs(301));

        // Tick A: force_yield fires (step 4b) but yield_queue already ran (step 4)
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

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

        // Tick B: NOW the yield_queue should pick up the force-yielded agent
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

        let val_after_tick_b = env.events_named("validation_requested");
        assert_eq!(
            val_after_tick_b.len(),
            1,
            "force-yielded agent should be processed on the next tick"
        );
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
            .spawn("developer", Some("bd-vfail".to_string()), None, Some(project_path.to_string()))
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
        registry.start_validation(&agent_id, Some("bd-vfail".to_string())).unwrap();

        // Fail one validator
        registry.validation_submit(&agent_id, "code_review", false, vec!["bad code".to_string()]).unwrap();
        registry.validation_submit(&agent_id, "business_logic", true, vec![]).unwrap();
        registry.validation_submit(&agent_id, "scope", true, vec![]).unwrap();

        // Agent should now be back in Running state after fail
        // The state_entered_at should be freshly set (not 4 minutes ago)

        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics).await.unwrap();

        // The stuck-running safety net should NOT have fired (agent just entered Running)
        let val_events = env.events_named("validation_requested");
        assert_eq!(
            val_events.len(),
            0,
            "BUG: stuck-running safety net fired immediately after validation fail. \
             state_entered_at was not reset when transitioning back to Running."
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
            .spawn("developer", Some("bd-dup-val".to_string()), None, Some("/tmp".to_string()))
            .unwrap();

        let yp = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: None,
            git_branch: None,
        };
        registry.yield_for_review(&id, yp).unwrap();
        registry.start_validation(&id, Some("bd-dup-val".to_string())).unwrap();

        // Submit code_review twice
        let r1 = registry.validation_submit(&id, "code_review", true, vec![]).unwrap();
        let r2 = registry.validation_submit(&id, "code_review", false, vec!["evil".to_string()]).unwrap();

        // Second submit should be ignored
        assert!(r1.is_none(), "first submit doesn't complete (need 3)");
        assert!(r2.is_none(), "duplicate submit should be ignored, not counted");

        // Submit remaining two
        registry.validation_submit(&id, "business_logic", true, vec![]).unwrap();
        let final_result = registry.validation_submit(&id, "scope", true, vec![]).unwrap();

        assert!(final_result.is_some(), "3 unique submits should complete validation");
        assert!(final_result.unwrap().all_passed, "all should pass (dup was ignored)");
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
            .spawn("developer", Some("bd-sym".to_string()), None, Some(project.to_str().unwrap().to_string()))
            .unwrap();
        registry.set_worktree_path(&id, wt.to_str().unwrap()).unwrap();

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
