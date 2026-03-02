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
}

impl MergeQueue {
    pub fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            queued_tasks: Mutex::new(HashSet::new()),
            git_lock: TokioMutex::new(()),
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
    app_handle: &tauri::AppHandle,
    meta_db: &MetaDb,
    registry: &AgentRegistry,
    pool: &PtyPool,
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

    let path_for_claim = path.to_path_buf();

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

        if pool
            .spawn(&agent_id, 80, 24, Some(agent_cwd.as_path()))
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
        let path_claim = path_for_claim.clone();
        let _ = tokio::task::spawn_blocking(move || run_bd_sync(&path_claim, &claim_args)).await;

        let _ = app_handle.emit(
            "agent_spawned",
            AgentSpawnedPayload {
                agent_id: agent_id.clone(),
                role: role.clone(),
                task_id: Some(task.id.clone()),
                parent_agent_id: None,
                merge_context: None,
            },
        );
        spawned_this_tick += 1;
    }

    // 3. Kill expired agents (clean up worktree without merging)
    let expired = registry.expired_agent_ids()?;
    for id in expired {
        if let Ok(Some(_wt)) = registry.get_worktree_path(&id) {
            let wt_path = path.to_path_buf();
            let wt_id = id.clone();
            let _ = tokio::task::spawn_blocking(move || crate::worktree::remove(&wt_path, &wt_id))
                .await;
        }
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
        if let Err(e) = app_handle.emit(
            "validation_requested",
            ValidationRequestedPayload {
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
    //    Developer agents get their worktree removed and pushed onto the merge queue.
    //    PM agents are killed immediately (epics handled by auto-close in step 6).
    //    Merge agents are cleaned up — the original task is already re-queued by handle_merge_conflict.
    let done_agents = registry.done_agents_with_tasks()?;
    for (agent_id, task_id, role) in done_agents {
        if role == "project_manager" {
            eprintln!("[orch] skipping merge for epic task {task_id} (PM agent); auto-close will handle it");
            let _ = registry.kill(&agent_id);
            let _ = pool.kill(&agent_id);
            continue;
        }
        if role == "merge_agent" {
            eprintln!("[orch] merge agent {agent_id} done for task {task_id}; cleaning up");
            if let Ok(Some(_wt)) = registry.get_worktree_path(&agent_id) {
                let rm_path = path.to_path_buf();
                let rm_agent = agent_id.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    crate::worktree::remove(&rm_path, &rm_agent)
                })
                .await;
            }
            let _ = registry.kill(&agent_id);
            let _ = pool.kill(&agent_id);
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
            let path_done = path.to_path_buf();
            let _ = tokio::task::spawn_blocking(move || run_bd_sync(&path_done, &done_args)).await;
            let _ = registry.kill(&agent_id);
            let _ = pool.kill(&agent_id);
            let _ = app_handle.emit(
                "merge_status",
                MergeStatusPayload {
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
            let _ = app_handle.emit(
                "merge_status",
                MergeStatusPayload {
                    task_id,
                    status: "merging".to_string(),
                    detail: None,
                },
            );
        }
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
                    // Mark done in Beads
                    let done_args = vec![
                        "update".to_string(),
                        task_id.clone(),
                        "--status".to_string(),
                        "done".to_string(),
                    ];
                    let path_done = path.to_path_buf();
                    let _ =
                        tokio::task::spawn_blocking(move || run_bd_sync(&path_done, &done_args))
                            .await;
                    // Clean up branch
                    let del_path = path.to_path_buf();
                    let del_task = task_id.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        crate::worktree::delete_task_branch(&del_path, &del_task)
                    })
                    .await;
                    // Kill agent
                    let _ = registry.kill(&agent_id);
                    let _ = pool.kill(&agent_id);
                    let _ = app_handle.emit(
                        "merge_status",
                        MergeStatusPayload {
                            task_id,
                            status: "done".to_string(),
                            detail: None,
                        },
                    );
                }
                Ok(Ok(crate::worktree::MergeOutcome::Conflict(detail))) => {
                    handle_merge_conflict(
                        app_handle,
                        path,
                        registry,
                        pool,
                        merge_queue,
                        metrics,
                        entry,
                        &detail,
                    )
                    .await;
                }
                Ok(Err(e)) => {
                    eprintln!("[orch] merge error for task {task_id}: {e}");
                    handle_merge_conflict(
                        app_handle,
                        path,
                        registry,
                        pool,
                        merge_queue,
                        metrics,
                        entry,
                        &e,
                    )
                    .await;
                }
                Err(e) => {
                    eprintln!("[orch] merge join error for task {task_id}: {e}");
                    let _ = registry.kill(&agent_id);
                    let _ = pool.kill(&agent_id);
                }
            }
        } else {
            // Rebase failed -- treat as conflict
            handle_merge_conflict(
                app_handle,
                path,
                registry,
                pool,
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
                let close_path = path_epic.clone();
                let close_ok =
                    matches!(tokio::task::spawn_blocking(move || run_bd_sync(&close_path, &close_args)).await, Ok(Ok(_)));

                if close_ok {
                    eprintln!("[orch] auto-closed epic {} via `bd close`", epic_id);
                    continue;
                }

                // Fallback for Beads versions without `bd close` command.
                let done_args = vec![
                    "update".to_string(),
                    epic_id.clone(),
                    "--status".to_string(),
                    "done".to_string(),
                ];
                let done_path = path_epic.clone();
                let mark_done_ok =
                    matches!(tokio::task::spawn_blocking(move || run_bd_sync(&done_path, &done_args)).await, Ok(Ok(_)));

                if mark_done_ok {
                    eprintln!("[orch] auto-closed epic {} via status fallback", epic_id);
                    continue;
                }

                // Last resort: nudge PM in epic notes for manual closure.
                let note_args = vec![
                    "update".to_string(),
                    epic_id.clone(),
                    "--append-notes".to_string(),
                    "System note: all child tasks are done. If no new work came up, please close this epic.".to_string(),
                ];
                let note_path = path_epic.clone();
                let _ = tokio::task::spawn_blocking(move || run_bd_sync(&note_path, &note_args)).await;
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
        let path_status = path.to_path_buf();
        if let Ok(Ok(stdout)) = tokio::task::spawn_blocking({
            let path_status = path_status.clone();
            move || run_bd_sync(&path_status, &status_args)
        })
        .await
        {
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

                    let _ = app_handle.emit(
                        "epic_progress",
                        EpicProgressPayload {
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
    app_handle: &tauri::AppHandle,
    project_path: &Path,
    registry: &AgentRegistry,
    pool: &PtyPool,
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
        // Mark blocked in Beads
        let block_args = vec![
            "update".to_string(),
            task_id.clone(),
            "--status".to_string(),
            "blocked".to_string(),
        ];
        let path_block = project_path.to_path_buf();
        let _ = tokio::task::spawn_blocking(move || run_bd_sync(&path_block, &block_args)).await;
        // Kill the agent
        let _ = registry.kill(&agent_id);
        let _ = pool.kill(&agent_id);
        let _ = app_handle.emit(
            "merge_status",
            MergeStatusPayload {
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

    // Get conflict context for the merge agent
    let diff_path = project_path.to_path_buf();
    let diff_task = task_id.clone();
    let conflict_context =
        tokio::task::spawn_blocking(move || crate::worktree::conflict_diff(&diff_path, &diff_task))
            .await
            .unwrap_or_else(|e| Err(e.to_string()))
            .unwrap_or_else(|e| format!("(failed to get diff: {e})"));

    // Get task description from Beads
    let show_args = vec!["show".to_string(), task_id.clone(), "--json".to_string()];
    let show_path = project_path.to_path_buf();
    let task_desc =
        match tokio::task::spawn_blocking(move || run_bd_sync(&show_path, &show_args)).await {
            Ok(Ok(stdout)) => serde_json::from_str::<serde_json::Value>(&stdout)
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

    // Spawn merge agent
    let merge_agent_id = match registry.spawn(
        "merge_agent",
        Some(task_id.clone()),
        None,
        Some(project_path.to_str().unwrap_or_default().to_string()),
    ) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("[orch] failed to spawn merge agent for {task_id}: {e}");
            // Re-queue with incremented retry count
            metrics.inc_merge_retry();
            let _ = merge_queue.push(MergeEntry {
                agent_id,
                task_id: task_id.clone(),
                retry_count: entry.retry_count + 1,
            });
            return;
        }
    };

    // Create worktree for merge agent
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

    if pool
        .spawn(&merge_agent_id, 80, 24, Some(agent_cwd.as_path()))
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
    let _ = app_handle.emit(
        "agent_spawned",
        AgentSpawnedPayload {
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

    let _ = app_handle.emit(
        "merge_status",
        MergeStatusPayload {
            task_id: task_id.clone(),
            status: "conflict".to_string(),
            detail: Some(format!(
                "Retry {}/{MAX_MERGE_RETRIES} — merge agent spawned",
                entry.retry_count + 1
            )),
        },
    );

    // Re-queue the original entry with incremented retry count.
    // When the merge agent completes (enters Done), the next tick will pick it up
    // via done_agents_with_tasks and re-enqueue for merge.
    metrics.inc_merge_retry();
    let _ = merge_queue.push(MergeEntry {
        agent_id,
        task_id,
        retry_count: entry.retry_count + 1,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
