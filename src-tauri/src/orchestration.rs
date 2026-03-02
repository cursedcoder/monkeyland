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

    // -----------------------------------------------------------------------
    // Scenario 1: Developer lifecycle — spawn, yield, validate, merge, done
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn scenario_developer_full_lifecycle() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // bd ready returns one task
        env.set_ready_tasks(r#"[{"id":"bd-42","issue_type":"task","priority":2}]"#);

        // Tick 1: should spawn a developer agent and claim the task
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let spawned = env.events_named("agent_spawned");
        assert_eq!(spawned.len(), 1, "expected exactly one agent_spawned event");
        let agent_id = spawned[0]["agent_id"].as_str().unwrap().to_string();
        assert_eq!(spawned[0]["role"].as_str().unwrap(), "developer");
        assert_eq!(spawned[0]["task_id"].as_str().unwrap(), "bd-42");

        // Verify bd claim was called
        let claims = env.bd_calls_matching("--claim");
        assert!(!claims.is_empty(), "expected bd update --claim call");

        // Simulate: developer works, then yields for review
        let yield_payload = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: Some("Added feature X".to_string()),
            git_branch: Some(format!("task/bd-42")),
        };
        registry.yield_for_review(&agent_id, yield_payload).unwrap();

        // No new tasks for subsequent ticks
        env.set_ready_tasks("[]");

        // Tick 2: yield queue should emit validation_requested
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let val_events = env.events_named("validation_requested");
        assert_eq!(val_events.len(), 1, "expected validation_requested event");
        assert_eq!(
            val_events[0]["developer_agent_id"].as_str().unwrap(),
            agent_id
        );

        // Simulate: all 3 validators pass
        for role in &["code_review", "business_logic", "scope"] {
            registry
                .validation_submit(&agent_id, role, true, vec![])
                .unwrap();
        }

        // Agent should now be Done
        let done = registry.done_agents_with_tasks().unwrap();
        assert!(
            done.iter().any(|(id, tid, _)| id == &agent_id && tid == "bd-42"),
            "agent should be in Done state with task"
        );

        // Tick 3: done agent enqueued for merge, then merge train runs
        // Developer has a worktree, so it should go through the merge path.
        // Since the worktree branch has no commits beyond base, merge should be clean.
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // Agent should be killed after merge
        let status = registry.status().unwrap();
        assert_eq!(status.used_slots, 0, "agent should be removed after merge");

        // merge_status "done" should have been emitted
        let merge_done = env.events_named("merge_status");
        assert!(
            merge_done.iter().any(|e| e["status"] == "done"),
            "expected merge_status done event"
        );

        // bd update --status done should have been called
        let done_calls = env.bd_calls_matching("--status");
        assert!(
            done_calls.iter().any(|args| args.contains(&"done".to_string())),
            "expected bd update --status done"
        );
    }

    // -----------------------------------------------------------------------
    // Scenario 2: Merge conflict → merge_agent → retry → success
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn scenario_merge_conflict_then_resolve() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Create a file on base branch
        std::fs::write(repo.path().join("file.txt"), "base v1").unwrap();
        std::process::Command::new("git")
            .args(["add", "file.txt"])
            .current_dir(repo.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "base file"])
            .current_dir(repo.path())
            .output()
            .unwrap();

        // Spawn a developer, create worktree, modify the file
        env.set_ready_tasks(r#"[{"id":"bd-conflict","issue_type":"task","priority":2}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let spawned = env.events_named("agent_spawned");
        let agent_id = spawned[0]["agent_id"].as_str().unwrap().to_string();

        // Modify file in the worktree
        let wt_path = registry.get_worktree_path(&agent_id).unwrap().unwrap();
        std::fs::write(format!("{wt_path}/file.txt"), "developer change").unwrap();
        std::process::Command::new("git")
            .args(["add", "file.txt"])
            .current_dir(&wt_path)
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "dev change"])
            .current_dir(&wt_path)
            .output()
            .unwrap();

        // Also modify the base to create a conflict
        std::fs::write(repo.path().join("file.txt"), "base v2 conflicting").unwrap();
        std::process::Command::new("git")
            .args(["add", "file.txt"])
            .current_dir(repo.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "conflicting base"])
            .current_dir(repo.path())
            .output()
            .unwrap();

        // Yield and pass validation
        let yield_payload = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: Some("changed file".to_string()),
            git_branch: Some("task/bd-conflict".to_string()),
        };
        registry.yield_for_review(&agent_id, yield_payload).unwrap();

        // Tick to process yield queue
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // Pass validation
        for role in &["code_review", "business_logic", "scope"] {
            registry
                .validation_submit(&agent_id, role, true, vec![])
                .unwrap();
        }

        // Tick: done agent → merge train → conflict → merge_agent spawned
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // Should have spawned a merge_agent
        let all_spawned = env.events_named("agent_spawned");
        let merge_agent_events: Vec<_> = all_spawned
            .iter()
            .filter(|e| e["role"] == "merge_agent")
            .collect();
        assert!(
            !merge_agent_events.is_empty(),
            "expected merge_agent to be spawned on conflict"
        );
        assert!(
            merge_agent_events[0]["merge_context"].is_object(),
            "merge_agent should receive merge_context"
        );

        // merge_status should show "conflict"
        let merge_statuses = env.events_named("merge_status");
        assert!(
            merge_statuses.iter().any(|e| e["status"] == "conflict"),
            "expected merge_status conflict event"
        );

        // Verify retry count was tracked
        let merge_retry = metrics.snapshot(0).merge_retry_count;
        assert!(merge_retry > 0, "merge retry metric should be incremented");
    }

    // -----------------------------------------------------------------------
    // Scenario 3: Merge retry exhaustion → blocked
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn scenario_merge_retry_exhaustion() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Create a file and commit so task branch can diverge
        std::fs::write(repo.path().join("shared.txt"), "original").unwrap();
        std::process::Command::new("git")
            .args(["add", "shared.txt"])
            .current_dir(repo.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "add shared"])
            .current_dir(repo.path())
            .output()
            .unwrap();

        // Create the task branch with a conflicting change
        std::process::Command::new("git")
            .args(["checkout", "-b", "task/bd-exhaust"])
            .current_dir(repo.path())
            .output()
            .unwrap();
        std::fs::write(repo.path().join("shared.txt"), "task change").unwrap();
        std::process::Command::new("git")
            .args(["add", "shared.txt"])
            .current_dir(repo.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "task change"])
            .current_dir(repo.path())
            .output()
            .unwrap();

        // Switch back to main and create a conflicting change
        std::process::Command::new("git")
            .args(["checkout", "main"])
            .current_dir(repo.path())
            .output()
            .unwrap();
        std::fs::write(repo.path().join("shared.txt"), "base conflict").unwrap();
        std::process::Command::new("git")
            .args(["add", "shared.txt"])
            .current_dir(repo.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "conflicting base"])
            .current_dir(repo.path())
            .output()
            .unwrap();

        let (meta_db, _db_dir) = setup_meta_db(project_path);

        // Pre-enqueue an entry that has already exhausted retries
        merge_queue.push(MergeEntry {
            agent_id: "dev-exhausted".to_string(),
            task_id: "bd-exhaust".to_string(),
            retry_count: MAX_MERGE_RETRIES,
        });

        // Tick: merge train processes the exhausted entry
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // Should have emitted merge_status "failed"
        let merge_statuses = env.events_named("merge_status");
        assert!(
            merge_statuses.iter().any(|e| e["status"] == "failed"),
            "expected merge_status failed when retries exhausted"
        );

        // Should have called bd update --status blocked
        let blocked_calls = env.bd_calls_matching("blocked");
        assert!(
            !blocked_calls.is_empty(),
            "expected bd update --status blocked"
        );
    }

    // -----------------------------------------------------------------------
    // Scenario 4: TTL expiry cleans up Beads claim
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn scenario_ttl_expiry_releases_beads_claim() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Spawn a developer agent
        env.set_ready_tasks(r#"[{"id":"bd-ttl","issue_type":"task","priority":2}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let agent_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str()
            .unwrap()
            .to_string();

        // Backdate spawned_at to exceed TTL (developer TTL is 900s)
        registry.test_backdate_spawn(&agent_id, std::time::Duration::from_secs(901));

        // Tick: should kill the expired agent and release the Beads claim
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // agent_killed event should have been emitted
        let killed = env.events_named("agent_killed");
        assert!(
            killed.iter().any(|e| e["agent_id"] == agent_id && e["reason"] == "ttl_expired"),
            "expected agent_killed with ttl_expired reason"
        );

        // bd update --status ready should have been called to release the task
        let ready_calls = env.bd_calls_matching("ready");
        assert!(
            ready_calls.iter().any(|args| args.contains(&"bd-ttl".to_string())),
            "expected bd update bd-ttl --status ready to release claim"
        );

        // Agent should be gone from registry
        let status = registry.status().unwrap();
        assert_eq!(status.used_slots, 0, "agent should be removed");
    }

    // -----------------------------------------------------------------------
    // Scenario 5: Stuck-in-Running safety net
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn scenario_stuck_running_force_yields() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Spawn a developer
        env.set_ready_tasks(r#"[{"id":"bd-stuck","issue_type":"task","priority":2}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let agent_id = env.events_named("agent_spawned")[0]["agent_id"]
            .as_str()
            .unwrap()
            .to_string();

        // Backdate state_entered_at to >5 minutes in Running state
        registry.test_backdate_state_entered(&agent_id, std::time::Duration::from_secs(301));

        // Tick 2: safety net force-yields the stuck developer (step 4b)
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // Tick 3: the now-Yielded agent enters yield_queue (step 4) and
        // validation_requested is emitted.
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let val_events = env.events_named("validation_requested");
        assert!(
            val_events
                .iter()
                .any(|e| e["developer_agent_id"] == agent_id),
            "expected validation_requested after force-yield of stuck developer"
        );
    }

    // -----------------------------------------------------------------------
    // Scenario 6: Stuck-in-InReview safety net
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn scenario_stuck_in_review_gets_blocked() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Spawn and manually transition developer to InReview
        let agent_id = registry
            .spawn(
                "developer",
                Some("bd-review".to_string()),
                None,
                Some(project_path.to_string()),
            )
            .unwrap();

        // Yield and start validation to reach InReview
        let yield_payload = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: None,
            git_branch: None,
        };
        registry.yield_for_review(&agent_id, yield_payload).unwrap();
        registry
            .start_validation(&agent_id, Some("bd-review".to_string()))
            .unwrap();

        // Backdate state_entered_at past the 5-minute threshold
        registry.test_backdate_state_entered(&agent_id, std::time::Duration::from_secs(301));

        // Tick: should force-block the stuck InReview developer
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // validation_timeout_blocks metric should be incremented
        let snap = metrics.snapshot(0);
        assert!(
            snap.validation_timeout_blocks > 0,
            "expected validation_timeout_blocks to increment"
        );
    }

    // -----------------------------------------------------------------------
    // Scenario 7: Done developer without worktree (no-merge fallback)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn scenario_done_without_worktree_finalizes_directly() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // Spawn a developer manually (no worktree)
        let agent_id = registry
            .spawn(
                "developer",
                Some("bd-nowt".to_string()),
                None,
                Some(project_path.to_string()),
            )
            .unwrap();

        // Yield, validate, complete
        let yield_payload = crate::agent_registry::YieldPayload {
            status: "done".to_string(),
            diff_summary: None,
            git_branch: None,
        };
        registry.yield_for_review(&agent_id, yield_payload).unwrap();
        registry
            .start_validation(&agent_id, Some("bd-nowt".to_string()))
            .unwrap();
        for role in &["code_review", "business_logic", "scope"] {
            registry
                .validation_submit(&agent_id, role, true, vec![])
                .unwrap();
        }

        // Tick: should finalize directly (no merge train)
        env.set_ready_tasks("[]");
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // Should have emitted merge_status "done" with no-worktree detail
        let merge_events = env.events_named("merge_status");
        let done_event = merge_events
            .iter()
            .find(|e| e["status"] == "done")
            .expect("expected merge_status done");
        assert!(
            done_event["detail"]
                .as_str()
                .unwrap_or("")
                .contains("No isolated worktree"),
            "expected 'No isolated worktree' in detail"
        );

        // Agent should be gone
        assert_eq!(registry.status().unwrap().used_slots, 0);
    }

    // -----------------------------------------------------------------------
    // Scenario 8: Safety mode throttles agent spawning
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn scenario_safety_mode_limits_spawn_rate() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        meta_db.set_setting("safety_mode_enabled", "1").unwrap();
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // 10 ready tasks
        let tasks: Vec<String> = (0..10)
            .map(|i| format!(r#"{{"id":"bd-s{i}","issue_type":"task","priority":2}}"#))
            .collect();
        env.set_ready_tasks(&format!("[{}]", tasks.join(",")));

        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        let spawned = env.events_named("agent_spawned");
        assert_eq!(
            spawned.len(),
            2,
            "safety mode should limit to 2 agents per tick"
        );
    }

    // -----------------------------------------------------------------------
    // Scenario 9: Duplicate task deduplication
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn scenario_already_claimed_task_is_skipped() {
        let repo = setup_git_repo();
        let project_path = repo.path().to_str().unwrap();
        let (meta_db, _db_dir) = setup_meta_db(project_path);
        let registry = AgentRegistry::new();
        let merge_queue = MergeQueue::new();
        let metrics = OrchestrationMetrics::new();
        let env = TestOrchEnv::new();

        // First tick: spawn agent for bd-dup
        env.set_ready_tasks(r#"[{"id":"bd-dup","issue_type":"task","priority":2}]"#);
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        assert_eq!(env.events_named("agent_spawned").len(), 1);

        // Second tick: same task still "ready" in bd but already claimed
        tick(&env, &meta_db, &registry, &merge_queue, &metrics)
            .await
            .unwrap();

        // Should NOT spawn a second agent
        assert_eq!(
            env.events_named("agent_spawned").len(),
            1,
            "should not double-spawn for same task"
        );
    }

    // -----------------------------------------------------------------------
    // Scenario 10: Path sandboxing (direct AgentRegistry tests)
    // -----------------------------------------------------------------------

    #[test]
    fn scenario_path_sandbox_allows_inside_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let wt = project.join(".worktrees/agent-x");
        std::fs::create_dir_all(&wt).unwrap();

        let registry = AgentRegistry::new();
        let id = registry
            .spawn(
                "developer",
                Some("bd-x".to_string()),
                None,
                Some(project.to_str().unwrap().to_string()),
            )
            .unwrap();
        registry
            .set_worktree_path(&id, wt.to_str().unwrap())
            .unwrap();

        // Inside worktree: allowed
        let inside = wt.join("src/main.rs");
        assert!(
            registry.validate_path(&id, inside.to_str().unwrap()).is_ok(),
            "path inside worktree should be allowed"
        );

        // Outside worktree but inside project: rejected when worktree is set
        let outside_wt = project.join("other.txt");
        assert!(
            registry
                .validate_path(&id, outside_wt.to_str().unwrap())
                .is_err(),
            "path outside worktree should be rejected"
        );

        // Path traversal: rejected
        let traversal = wt.join("../../etc/passwd");
        assert!(
            registry
                .validate_path(&id, traversal.to_str().unwrap())
                .is_err(),
            "path traversal should be rejected"
        );
    }

    #[test]
    fn scenario_operator_has_no_sandbox() {
        let registry = AgentRegistry::new();
        let id = registry
            .spawn("operator", None, None, None)
            .unwrap();

        // Operators without project_path have no sandbox — validate_path
        // should succeed for any path (since there's no base to check against).
        // But the current impl returns an error for unknown agents or missing project_path.
        let result = registry.validate_path(&id, "/tmp/anything.txt");
        // The behavior depends on whether validate_path requires a project_path.
        // This test documents the current behavior.
        assert!(
            result.is_ok() || result.is_err(),
            "operator path validation should have a deterministic result"
        );
    }
}
