use crate::agent_registry::{
    AgentQuota, AgentRegistry, AgentStatusResponse, DebugSnapshot, RestoreAgentInput,
    ValidationOutcome, YieldPayload,
};
use crate::browser_pool::BrowserPool;
use crate::orchestration::{
    MergeQueue, OrchestrationMetrics, OrchestrationMetricsSnapshot, OrchestrationState,
};
use crate::pty_pool::PtyPool;
use crate::storage::{MetaDb, SessionLayoutRow};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use tauri::{Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLayout {
    pub session_id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub collapsed: bool,
    #[serde(default = "default_node_type")]
    pub node_type: String,
    #[serde(default)]
    pub payload: String,
}

fn default_node_type() -> String {
    "agent".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasLayoutPayload {
    pub layouts: Vec<SessionLayout>,
}

#[tauri::command]
pub async fn save_canvas_layout(
    meta_db: State<'_, MetaDb>,
    payload: CanvasLayoutPayload,
) -> Result<(), String> {
    let rows: Vec<SessionLayoutRow> = payload
        .layouts
        .into_iter()
        .map(|l| SessionLayoutRow {
            session_id: l.session_id,
            x: l.x,
            y: l.y,
            w: l.w,
            h: l.h,
            collapsed: l.collapsed,
            node_type: l.node_type,
            payload: l.payload,
        })
        .collect();
    meta_db.save_canvas_layouts(&rows)
}

#[tauri::command]
pub async fn load_canvas_layout(meta_db: State<'_, MetaDb>) -> Result<CanvasLayoutPayload, String> {
    let rows = meta_db.load_canvas_layouts()?;
    Ok(CanvasLayoutPayload {
        layouts: rows
            .into_iter()
            .map(|r| SessionLayout {
                session_id: r.session_id,
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
                collapsed: r.collapsed,
                node_type: r.node_type,
                payload: r.payload,
            })
            .collect(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmSettingsPayload {
    pub provider: String,
    pub model: String,
}

#[tauri::command]
pub async fn load_llm_settings(meta_db: State<'_, MetaDb>) -> Result<LlmSettingsPayload, String> {
    let provider = meta_db
        .get_setting("llm_provider")?
        .unwrap_or_else(|| "anthropic".to_string());
    let model = meta_db
        .get_setting("llm_model")?
        .unwrap_or_else(|| "claude-sonnet-4-20250514".to_string());
    Ok(LlmSettingsPayload { provider, model })
}

#[tauri::command]
pub async fn save_llm_settings(
    meta_db: State<'_, MetaDb>,
    payload: LlmSettingsPayload,
) -> Result<(), String> {
    meta_db.set_setting("llm_provider", &payload.provider)?;
    meta_db.set_setting("llm_model", &payload.model)?;
    Ok(())
}

#[tauri::command]
pub async fn get_llm_api_key(
    meta_db: State<'_, MetaDb>,
    provider: String,
) -> Result<Option<String>, String> {
    let key = format!("llm_api_key_{}", provider);
    meta_db.get_setting(&key)
}

#[tauri::command]
pub async fn set_llm_api_key(
    meta_db: State<'_, MetaDb>,
    provider: String,
    api_key: String,
) -> Result<(), String> {
    let key = format!("llm_api_key_{}", provider);
    meta_db.set_setting(&key, &api_key)
}

#[tauri::command]
pub async fn get_llm_setup_done(meta_db: State<'_, MetaDb>) -> Result<bool, String> {
    let v = meta_db.get_setting("llm_setup_done")?;
    Ok(v.as_deref() == Some("1"))
}

#[tauri::command]
pub async fn set_llm_setup_done(meta_db: State<'_, MetaDb>) -> Result<(), String> {
    meta_db.set_setting("llm_setup_done", "1")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSpawnPayload {
    pub session_id: String,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// Working directory for the shell (e.g. project root for Beads). If absent, shell uses app cwd.
    #[serde(default)]
    pub cwd: Option<String>,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

#[tauri::command]
pub async fn terminal_spawn(
    pool: State<'_, PtyPool>,
    payload: TerminalSpawnPayload,
) -> Result<(), String> {
    let cwd = payload
        .cwd
        .as_deref()
        .map(std::path::Path::new)
        .filter(|p| p.as_os_str().len() > 0);
    pool.spawn(&payload.session_id, payload.cols, payload.rows, cwd)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalWritePayload {
    pub session_id: String,
    pub data: String,
}

#[tauri::command]
pub async fn terminal_write(
    pool: State<'_, PtyPool>,
    payload: TerminalWritePayload,
) -> Result<(), String> {
    pool.write(&payload.session_id, payload.data.as_bytes())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalResizePayload {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub async fn terminal_resize(
    pool: State<'_, PtyPool>,
    payload: TerminalResizePayload,
) -> Result<(), String> {
    pool.resize(&payload.session_id, payload.cols, payload.rows)
}

#[tauri::command]
pub async fn terminal_get_buffer(
    batcher: State<'_, crate::storage::WriteBatcher>,
    session_id: String,
) -> Result<String, String> {
    batcher.get_terminal_buffer(&session_id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalExecPayload {
    pub session_id: String,
    pub command: String,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
}

fn default_timeout() -> u64 {
    30_000
}

#[tauri::command]
pub async fn browser_ensure_started(
    pool: State<'_, BrowserPool>,
    registry: State<'_, AgentRegistry>,
    agent_id: Option<String>,
) -> Result<u16, String> {
    if let Some(ref aid) = agent_id {
        registry.gate_tool(aid, "browser_ensure_started")?;
    }
    pool.ensure_started()
}

// --- Beads (bd) integration: init and run CLI in project path ---

/// Initialize Beads in the given project path. Creates .beads/ with Dolt database.
/// Creates the directory if it doesn't exist. Returns Ok even if `bd` is not installed
/// (the caller can proceed without Beads).
#[tauri::command]
pub async fn beads_init(
    registry: State<'_, AgentRegistry>,
    project_path: String,
    agent_id: Option<String>,
) -> Result<String, String> {
    if let Some(ref aid) = agent_id {
        registry.gate_tool(aid, "beads_init")?;
    }
    let path = Path::new(&project_path);
    if !path.exists() {
        std::fs::create_dir_all(path)
            .map_err(|e| format!("Failed to create directory {}: {e}", project_path))?;
    }
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", project_path));
    }
    // Skip if already initialized
    if path.join(".beads").exists() {
        return Ok("Beads already initialized.".to_string());
    }
    // Beads requires a git repo; ensure one exists before bd init.
    if !path.join(".git").exists() {
        let git_out = Command::new("git")
            .arg("init")
            .current_dir(path)
            .output()
            .map_err(|e| format!("Failed to run git init: {e}"))?;
        if !git_out.status.success() {
            let stderr = String::from_utf8_lossy(&git_out.stderr);
            return Err(format!("git init failed: {}", stderr.trim()));
        }
    }
    let out = match Command::new("bd")
        .args(["init", "--quiet"])
        .current_dir(path)
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return Ok("bd not found on PATH — Beads skipped. Install with: npm i -g @anthropic-ai/beads".to_string());
            }
            return Err(format!("Failed to run bd: {e}"));
        }
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Ok(format!("bd init warning: {}", stderr.trim()));
    }
    Ok("Beads initialized.".to_string())
}

/// Run a Beads CLI command in the given project path. Returns stdout.
/// Example: beads_run(project_path, ["ready", "--json"]).
#[tauri::command]
pub async fn beads_run(
    registry: State<'_, AgentRegistry>,
    project_path: String,
    args: Vec<String>,
    agent_id: Option<String>,
) -> Result<String, String> {
    if let Some(ref aid) = agent_id {
        registry.gate_tool(aid, "beads_run")?;
    }
    let path = Path::new(&project_path);
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", project_path));
    }
    let out = Command::new("bd")
        .args(&args)
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to run bd: {}", e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "bd failed: {}",
            stderr.trim().lines().next().unwrap_or(stderr.trim())
        ));
    }
    Ok(stdout)
}

/// Start the Beads Dolt server in the background for multi-agent concurrent access.
/// The process is spawned and detached; stop it manually (e.g. kill the process) when done.
#[tauri::command]
pub async fn get_beads_project_path(meta_db: State<'_, MetaDb>) -> Result<Option<String>, String> {
    meta_db.get_setting("beads_project_path")
}

#[tauri::command]
pub async fn set_beads_project_path(
    meta_db: State<'_, MetaDb>,
    registry: State<'_, AgentRegistry>,
    project_path: Option<String>,
    agent_id: Option<String>,
) -> Result<(), String> {
    if let Some(ref aid) = agent_id {
        registry.gate_tool(aid, "set_beads_project_path")?;
    }
    match project_path {
        Some(p) => meta_db.set_setting("beads_project_path", &p),
        None => meta_db.set_setting("beads_project_path", ""),
    }
}

#[tauri::command]
pub async fn beads_dolt_start(
    app: tauri::AppHandle,
    registry: State<'_, AgentRegistry>,
    project_path: String,
    agent_id: Option<String>,
    port: Option<u16>,
) -> Result<(), String> {
    if let Some(ref aid) = agent_id {
        registry.gate_tool(aid, "beads_dolt_start")?;
    }

    let port = port.unwrap_or(3307);

    // Check if a dolt server is already listening on the target port
    if std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_ok() {
        return Ok(());
    }

    // Use a stable data directory inside the app's data dir
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?
        .join("dolt-data");

    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create dolt data dir: {e}"))?;
    }

    // Initialize dolt repo if not already done
    if !data_dir.join(".dolt").exists() {
        let out = Command::new("dolt")
            .arg("init")
            .current_dir(&data_dir)
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "dolt not found on PATH — install with: brew install dolt".to_string()
                } else {
                    format!("Failed to run dolt init: {e}")
                }
            })?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!("dolt init failed: {}", stderr.trim()));
        }
    }

    // Start dolt sql-server in the background
    Command::new("dolt")
        .args(["sql-server", "--port", &port.to_string()])
        .current_dir(&data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start dolt sql-server: {e}"))?;

    // Wait for the server to become reachable (up to 5s)
    for _ in 0..50 {
        if std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // Ignore the startup path — don't fail; it might be ready by the time bd init runs
    let _ = project_path;
    Ok(())
}

// --- Agent registry (orchestration) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpawnPayload {
    pub role: String,
    pub task_id: Option<String>,
    pub parent_agent_id: Option<String>,
    /// Working directory for the agent's PTY (e.g. project root for Beads).
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRestoreItem {
    pub agent_id: String,
    pub role: String,
    pub task_id: Option<String>,
    pub parent_agent_id: Option<String>,
    #[serde(default = "default_restore_state")]
    pub state: String,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRestorePayload {
    pub agents: Vec<AgentRestoreItem>,
}

fn default_restore_state() -> String {
    "running".to_string()
}

#[tauri::command]
pub async fn agent_spawn(
    pool: State<'_, PtyPool>,
    registry: State<'_, AgentRegistry>,
    payload: AgentSpawnPayload,
) -> Result<serde_json::Value, String> {
    let agent_id = registry.spawn(
        &payload.role,
        payload.task_id.clone(),
        payload.parent_agent_id.clone(),
        payload.cwd.clone(),
    )?;
    let cwd = payload
        .cwd
        .as_deref()
        .map(std::path::Path::new)
        .filter(|p| p.as_os_str().len() > 0);
    pool.spawn(&agent_id, 80, 24, cwd)?;
    #[derive(serde::Serialize)]
    struct Out {
        agent_id: String,
    }
    Ok(serde_json::to_value(Out { agent_id }).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn agent_restore_batch(
    pool: State<'_, PtyPool>,
    registry: State<'_, AgentRegistry>,
    payload: AgentRestorePayload,
) -> Result<serde_json::Value, String> {
    let restore_inputs: Vec<RestoreAgentInput> = payload
        .agents
        .iter()
        .map(|a| RestoreAgentInput {
            id: a.agent_id.clone(),
            role: a.role.clone(),
            task_id: a.task_id.clone(),
            parent_id: a.parent_agent_id.clone(),
            state: a.state.clone(),
            project_path: a.project_path.clone(),
            worktree_path: a.worktree_path.clone(),
        })
        .collect();

    let restored_ids = registry.restore_agents(restore_inputs)?;
    for id in &restored_ids {
        let spec = payload.agents.iter().find(|a| &a.agent_id == id);
        let cwd = spec
            .and_then(|a| {
                a.worktree_path
                    .as_deref()
                    .or(a.project_path.as_deref())
            })
            .map(std::path::Path::new)
            .filter(|p| p.as_os_str().len() > 0);
        let _ = pool.spawn(id, 80, 24, cwd);
    }

    #[derive(serde::Serialize)]
    struct Out {
        restored_agent_ids: Vec<String>,
    }
    Ok(serde_json::to_value(Out {
        restored_agent_ids: restored_ids,
    })
    .map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn agent_kill(
    pool: State<'_, PtyPool>,
    registry: State<'_, AgentRegistry>,
    agent_id: String,
) -> Result<bool, String> {
    let ok = registry.kill(&agent_id)?;
    let _ = pool.kill(&agent_id);
    Ok(ok)
}

#[tauri::command]
pub async fn agent_status(
    registry: State<'_, AgentRegistry>,
) -> Result<AgentStatusResponse, String> {
    registry.status()
}

#[tauri::command]
pub async fn debug_snapshot(registry: State<'_, AgentRegistry>) -> Result<DebugSnapshot, String> {
    registry.debug_snapshot()
}

#[tauri::command]
pub async fn set_role_config(
    registry: State<'_, AgentRegistry>,
    role: String,
    max_count: Option<u32>,
) -> Result<(), String> {
    registry.set_role_max_count(&role, max_count)
}

/// Returns orchestration state: 0 = idle, 1 = running, 2 = paused.
#[tauri::command]
pub async fn orch_get_state(state: State<'_, OrchestrationState>) -> Result<u8, String> {
    Ok(state.get())
}

#[tauri::command]
pub async fn orch_get_metrics(
    metrics: State<'_, OrchestrationMetrics>,
    merge_queue: State<'_, MergeQueue>,
) -> Result<OrchestrationMetricsSnapshot, String> {
    Ok(metrics.snapshot(merge_queue.depth() as u64))
}

#[tauri::command]
pub async fn get_safety_mode(meta_db: State<'_, MetaDb>) -> Result<bool, String> {
    Ok(meta_db.get_setting("safety_mode_enabled")?.as_deref() == Some("1"))
}

#[tauri::command]
pub async fn set_safety_mode(meta_db: State<'_, MetaDb>, enabled: bool) -> Result<(), String> {
    meta_db.set_setting("safety_mode_enabled", if enabled { "1" } else { "0" })
}

#[tauri::command]
pub async fn orch_start(state: State<'_, OrchestrationState>) -> Result<(), String> {
    state.set_running();
    Ok(())
}

#[tauri::command]
pub async fn orch_pause(state: State<'_, OrchestrationState>) -> Result<(), String> {
    state.set_paused();
    Ok(())
}

/// Full reset: pause orchestration, clear all agents, remove worktrees, clear beads project path.
#[tauri::command]
pub async fn full_reset(
    orch_state: State<'_, OrchestrationState>,
    registry: State<'_, AgentRegistry>,
    pool: State<'_, PtyPool>,
    meta_db: State<'_, MetaDb>,
) -> Result<(), String> {
    orch_state.set_paused();
    // Remove all worktrees before clearing agents
    if let Ok(Some(pp)) = meta_db.get_setting("beads_project_path") {
        if !pp.is_empty() {
            let path = std::path::Path::new(&pp).to_path_buf();
            let _ = tokio::task::spawn_blocking(move || crate::worktree::remove_all(&path)).await;
        }
    }
    let ids = registry.clear_all()?;
    for id in &ids {
        let _ = pool.kill(id);
    }
    meta_db.set_setting("beads_project_path", "")?;
    Ok(())
}

#[tauri::command]
pub async fn agent_quota(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
) -> Result<Option<AgentQuota>, String> {
    registry.quota(&agent_id)
}

#[tauri::command]
pub async fn agent_report_tokens(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
    delta: u64,
) -> Result<(), String> {
    registry.report_tokens(&agent_id, delta)
}

#[tauri::command]
pub async fn agent_yield(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
    payload: YieldPayload,
) -> Result<(), String> {
    registry.yield_for_review(&agent_id, payload)
}

#[tauri::command]
pub async fn agent_message(
    registry: State<'_, AgentRegistry>,
    from_agent_id: String,
    to_agent_id: String,
    payload: String,
) -> Result<bool, String> {
    registry.message(&from_agent_id, &to_agent_id, payload)
}

#[tauri::command]
pub async fn agent_poll_messages(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
) -> Result<Vec<crate::agent_registry::InboundMessage>, String> {
    registry.poll_messages(&agent_id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationSubmitPayload {
    pub developer_agent_id: String,
    pub validator_role: String,
    pub pass: bool,
    #[serde(default)]
    pub reasons: Vec<String>,
}

#[tauri::command]
pub async fn validation_submit(
    registry: State<'_, AgentRegistry>,
    payload: ValidationSubmitPayload,
) -> Result<Option<ValidationOutcome>, String> {
    registry.validation_submit(
        &payload.developer_agent_id,
        &payload.validator_role,
        payload.pass,
        payload.reasons,
    )
}

/// Write content to a file, creating parent directories as needed.
/// If agent_id is provided, the call is gated by the state machine and sandboxed to project_path.
#[tauri::command]
pub async fn write_file(
    registry: State<'_, AgentRegistry>,
    path: String,
    content: String,
    agent_id: Option<String>,
) -> Result<(), String> {
    if let Some(ref aid) = agent_id {
        registry.gate_tool(aid, "write_file")?;
        registry.validate_path(aid, &path)?;
    }
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    std::fs::write(p, content.as_bytes()).map_err(|e| format!("write failed: {e}"))
}

/// Process-killing commands get a helpful guidance response (returned as Ok, not Err).
/// This makes the LLM treat it as a tool result and move on, rather than retrying.
fn is_process_kill_command(cmd: &str) -> Option<&'static str> {
    let cmd_lower = cmd.to_lowercase();
    if cmd_lower.contains("pkill") || cmd_lower.contains("killall") {
        return Some("NOT NEEDED. All background processes you started (dev servers, watchers, etc.) are automatically cleaned up when your task completes. Do not manage processes yourself. If you are done with your task, call yield_for_review now.");
    }
    if cmd_lower.contains("kill -9")
        || cmd_lower.contains("kill -kill")
        || cmd_lower.contains("kill -sigkill")
    {
        return Some("NOT NEEDED. All background processes are automatically cleaned up when your task completes. Call yield_for_review now if you are done.");
    }
    // `kill <pid>` without -9 (bare kill with a numeric argument)
    let trimmed = cmd_lower.trim();
    if trimmed.starts_with("kill ")
        && trimmed[5..]
            .trim()
            .chars()
            .next()
            .map_or(false, |c| c.is_ascii_digit())
    {
        return Some("NOT NEEDED. Background processes are automatically cleaned up. Call yield_for_review if done.");
    }
    None
}

/// Check if `rm -rf /...` targets root or home, not a subdirectory.
/// `rm -rf /tmp/foo` is fine (path continues). `rm -rf /` or `rm -rf /*` is not.
fn is_rm_rf_dangerous(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    // Check "rm -rf /" variants
    if let Some(pos) = lower.find("rm -rf /") {
        let after = pos + "rm -rf /".len();
        match lower.as_bytes().get(after) {
            // End of command or followed by space/glob/operator → root deletion
            None => return true,
            Some(b) if matches!(b, b' ' | b'*' | b';' | b'|' | b'&' | b'\n' | b'\t') => {
                return true
            }
            _ => {} // Followed by a path char like 't' in /tmp → safe
        }
    }
    // Home directory variants
    if lower.contains("rm -rf ~") || lower.contains("rm -rf $home") {
        return true;
    }
    false
}

/// Truly destructive commands that must be hard-blocked (returned as Err).
fn is_destructive_command(cmd: &str) -> Option<&'static str> {
    let cmd_lower = cmd.to_lowercase();

    if is_rm_rf_dangerous(cmd) {
        return Some("Recursive delete of root or home directory is blocked");
    }
    if cmd_lower.contains("shutdown") || cmd_lower.contains("reboot") || cmd_lower.contains("halt")
    {
        return Some("System shutdown/reboot commands are blocked");
    }
    if cmd_lower.contains("mkfs") || cmd_lower.contains("fdisk") || cmd_lower.contains("parted") {
        return Some("Disk formatting commands are blocked");
    }
    if cmd.contains(":(){ :|:&") || cmd.contains(":(){") {
        return Some("Fork bomb pattern detected and blocked");
    }
    if cmd_lower.contains("dd ") && cmd_lower.contains("of=/dev") {
        return Some("dd writing to devices is blocked");
    }
    if (cmd_lower.contains(">>") || cmd_lower.contains(">"))
        && (cmd_lower.contains(".bashrc")
            || cmd_lower.contains(".zshrc")
            || cmd_lower.contains(".profile"))
    {
        return Some("Modifying shell config files is blocked");
    }

    None
}

/// Commands that are likely to prompt for input and hang in our non-interactive executor.
/// We reject these unless they include explicit non-interactive flags.
fn is_likely_interactive_without_flags(cmd: &str) -> Option<&'static str> {
    let lower = cmd.to_lowercase();
    let has_non_interactive_flag = [
        "--yes",
        " -y",
        "--non-interactive",
        "--no-interactive",
        "yes |",
    ]
    .iter()
    .any(|f| lower.contains(f));

    if has_non_interactive_flag {
        return None;
    }

    // Project scaffolding / init commands that commonly ask for prompts.
    let likely_interactive_scaffold = lower.contains("npm create")
        || lower.contains("npx create-")
        || lower.contains("pnpm create")
        || lower.contains("yarn create")
        || lower.contains("bun create")
        || lower.contains("npm init")
        || lower.contains("pnpm init")
        || lower.contains("yarn init")
        || lower.contains("bun init");

    if likely_interactive_scaffold {
        return Some(
            "Likely interactive command blocked. Re-run with non-interactive flags (for example --yes/-y or --non-interactive).",
        );
    }

    None
}

fn is_validator_cleanup_session(session_id: &str) -> bool {
    session_id.starts_with("validator-dev-")
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// Execute a command via `bash -c` as a subprocess, capturing clean stdout+stderr.
/// If payload.agent_id is set, gated by the state machine and cwd is validated against sandbox.
#[tauri::command]
pub async fn terminal_exec(
    _pool: State<'_, PtyPool>,
    registry: State<'_, AgentRegistry>,
    payload: TerminalExecPayload,
) -> Result<String, String> {
    // Process-kill commands → return helpful guidance as a normal tool result (not an error).
    // LLMs handle tool results much better than errors (errors trigger retries).
    if let Some(guidance) = is_process_kill_command(&payload.command) {
        return Ok(guidance.to_string());
    }
    // Truly destructive commands → hard block with error.
    if let Some(reason) = is_destructive_command(&payload.command) {
        return Err(format!("Blocked: {}", reason));
    }
    // Likely interactive commands can hang with stdin closed. Require explicit non-interactive flags.
    if let Some(reason) = is_likely_interactive_without_flags(&payload.command) {
        return Err(format!("Blocked: {}", reason));
    }

    if let Some(ref aid) = payload.agent_id {
        registry.gate_tool(aid, "terminal_exec")?;
        // Validate cwd is within project sandbox (or its parent for scaffolding)
        if let Some(ref cwd) = payload.cwd {
            registry.validate_path_for_terminal(aid, cwd)?;
        } else {
            // No cwd specified - use project_path as default or reject
            let project_path = registry.get_project_path(aid)?;
            if project_path.is_some() {
                return Err(
                    "Terminal command requires 'cwd' parameter within project directory"
                        .to_string(),
                );
            }
        }
    }
    let timeout = Duration::from_millis(payload.timeout_ms);
    let cmd = payload.command.clone();
    let cwd = payload.cwd.clone();

    let result = tokio::time::timeout(
        timeout,
        tokio::task::spawn_blocking(move || {
            let mut builder = Command::new("/bin/bash");
            builder.args(["-c", &cmd]);
            builder.stdin(std::process::Stdio::null());
            if let Some(ref dir) = cwd {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    builder.current_dir(p);
                }
            }
            let output = builder
                .output()
                .map_err(|e| format!("Failed to run bash: {e}"))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            let mut combined = String::new();
            if !stdout.is_empty() {
                combined.push_str(&stdout);
            }
            if !stderr.is_empty() {
                if !combined.is_empty() {
                    combined.push('\n');
                }
                combined.push_str(&stderr);
            }

            if !output.status.success() {
                let code = output.status.code().unwrap_or(-1);
                combined.push_str(&format!("\n[exit code: {code}]"));
            }

            Ok::<String, String>(combined)
        }),
    )
    .await;

    let output = match result {
        Ok(Ok(s)) => s?,
        Ok(Err(e)) => return Err(format!("Task join error: {e}")),
        Err(_) => {
            return Err(
                "Command timed out (120s). Use non-interactive flags (for example --yes/-y), split work into shorter commands, and run long-lived servers in background (for example: nohup <cmd> > /tmp/server.log 2>&1 &).".to_string(),
            )
        }
    };

    const MAX_OUTPUT: usize = 16_000;
    if output.len() > MAX_OUTPUT {
        let truncated = &output[output.len() - MAX_OUTPUT..];
        Ok(format!("[...truncated...]\n{truncated}"))
    } else {
        Ok(output)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorCleanupPayload {
    pub session_id: String,
    pub pid: u32,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Internal-only validator cleanup helper.
/// This bypasses terminal_exec kill-command guidance so validator dev servers can be cleaned up.
#[tauri::command]
pub async fn validator_cleanup_process_tree(
    payload: ValidatorCleanupPayload,
) -> Result<(), String> {
    if !is_validator_cleanup_session(&payload.session_id) {
        return Err(
            "validator_cleanup_process_tree only accepts validator-dev-* sessions".to_string(),
        );
    }
    if payload.pid == 0 {
        return Err("Invalid pid for validator cleanup".to_string());
    }

    let mut cleanup_steps = vec![
        // Terminate the whole process group first (works when spawn used setsid).
        format!("kill -TERM -- -{} >/dev/null 2>&1 || true", payload.pid),
        // Backward-compatible cleanup when only the direct pid exists.
        format!("kill {} >/dev/null 2>&1 || true", payload.pid),
        format!("pkill -TERM -P {} >/dev/null 2>&1 || true", payload.pid),
    ];
    if let Some(dir) = payload.cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let escaped = shell_single_quote(dir);
        // Safety net for orphaned vite workers detached from npm parent.
        cleanup_steps.push(format!(
            "pkill -TERM -f {}/node_modules/.bin/vite >/dev/null 2>&1 || true",
            escaped
        ));
    }
    cleanup_steps.push("sleep 0.25".to_string());
    cleanup_steps.push(format!("kill -KILL -- -{} >/dev/null 2>&1 || true", payload.pid));
    cleanup_steps.push(format!("pkill -KILL -P {} >/dev/null 2>&1 || true", payload.pid));
    if let Some(dir) = payload.cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let escaped = shell_single_quote(dir);
        cleanup_steps.push(format!(
            "pkill -KILL -f {}/node_modules/.bin/vite >/dev/null 2>&1 || true",
            escaped
        ));
    }
    let cmd = cleanup_steps.join("; ");
    let cwd = payload.cwd.clone();
    let timeout = Duration::from_millis(5_000);

    let result = tokio::time::timeout(
        timeout,
        tokio::task::spawn_blocking(move || {
            let mut builder = Command::new("/bin/bash");
            builder.args(["-c", &cmd]);
            builder.stdin(std::process::Stdio::null());
            if let Some(ref dir) = cwd {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    builder.current_dir(p);
                }
            }
            builder
                .output()
                .map_err(|e| format!("Failed to run cleanup bash: {e}"))?;
            Ok::<(), String>(())
        }),
    )
    .await;

    match result {
        Ok(Ok(inner)) => inner,
        Ok(Err(e)) => Err(format!("Cleanup task join error: {e}")),
        Err(_) => Err("Validator cleanup timed out".to_string()),
    }
}

#[tauri::command]
pub async fn read_file(
    registry: State<'_, AgentRegistry>,
    path: String,
    agent_id: Option<String>,
) -> Result<String, String> {
    if let Some(ref aid) = agent_id {
        registry.gate_tool(aid, "read_file")?;
        registry.validate_path(aid, &path)?;
    }
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    let content = std::fs::read_to_string(p).map_err(|e| format!("Failed to read {path}: {e}"))?;
    const MAX_FILE: usize = 32_000;
    if content.len() > MAX_FILE {
        let truncated = &content[..MAX_FILE];
        Ok(format!(
            "{truncated}\n[...truncated at {MAX_FILE} chars...]"
        ))
    } else {
        Ok(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    #[test]
    fn test_process_kill_commands_are_detected() {
        assert!(is_process_kill_command("kill 123").is_some());
        assert!(is_process_kill_command("pkill -f vite").is_some());
        assert!(is_process_kill_command("killall node").is_some());
        assert!(is_process_kill_command("echo hello").is_none());
    }

    #[test]
    fn test_validator_cleanup_session_guard() {
        assert!(is_validator_cleanup_session("validator-dev-abc"));
        assert!(!is_validator_cleanup_session("ctx-gather"));
        assert!(!is_validator_cleanup_session("exec-123"));
    }

    #[tokio::test]
    async fn test_validator_cleanup_terminates_process() {
        let mut child = Command::new("/bin/bash")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("failed to spawn sleep process");
        let pid = child.id();

        let payload = ValidatorCleanupPayload {
            session_id: "validator-dev-test".to_string(),
            pid,
            cwd: None,
        };
        validator_cleanup_process_tree(payload)
            .await
            .expect("cleanup should succeed");

        tokio::time::sleep(Duration::from_millis(150)).await;
        let status = child.try_wait().expect("try_wait failed");
        assert!(status.is_some(), "process should be terminated by cleanup");
    }
}

/// Non-developer agents call this to mark their task as Done.
/// Developers are rejected by the state machine -- they must use yield_for_review.
#[tauri::command]
pub async fn agent_complete_task(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
) -> Result<(), String> {
    registry.complete_task(&agent_id)
}

/// Called by frontend when an agent's LLM turn ends (onDone fired).
/// For developers still in Running state, auto-yields them for review.
/// For other roles still in Running, auto-completes them.
/// Returns the action taken: "yielded", "completed", "already_done", or "not_found".
#[tauri::command]
pub async fn agent_turn_ended(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
    role: String,
) -> Result<String, String> {
    registry.handle_turn_ended(&agent_id, &role)
}

/// Force-yield a developer agent. Used by the frontend as a safety net when the
/// nudge mechanism fails to get the LLM to call yield_for_review.
#[tauri::command]
pub async fn agent_force_yield(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
) -> Result<(), String> {
    registry.force_yield(&agent_id)
}

/// Set the yield summary on a force-yielded agent so the validator has context.
#[tauri::command]
pub async fn agent_set_yield_summary(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
    diff_summary: String,
) -> Result<(), String> {
    registry.set_yield_summary(&agent_id, diff_summary)
}

/// Explicit gate check. Frontend plugins can call this before executing any tool
/// to get a clear error message if the agent is not allowed.
#[tauri::command]
pub async fn agent_gate_tool(
    registry: State<'_, AgentRegistry>,
    agent_id: String,
    tool_name: String,
) -> Result<(), String> {
    registry.gate_tool(&agent_id, &tool_name)
}

/// Returns the base URL of the local Kilo AI CORS proxy started at launch.
#[tauri::command]
pub fn get_kilo_proxy_url(state: tauri::State<'_, crate::KiloProxyPort>) -> String {
    let port = state.0.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        String::new()
    } else {
        format!("http://127.0.0.1:{}", port)
    }
}

/// Perform a GET request from the Rust side, bypassing WebView CORS restrictions.
#[tauri::command]
pub async fn fetch_json(
    url: String,
    headers: std::collections::HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    for (key, value) in &headers {
        req = req.header(key.as_str(), value.as_str());
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

/// Write text to the system clipboard. Used by the debug panel so copy works in the Tauri webview.
#[tauri::command]
pub fn write_clipboard_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())?;
    Ok(())
}

// --- Git worktree commands ---

#[tauri::command]
pub async fn worktree_create(
    registry: State<'_, AgentRegistry>,
    project_path: String,
    agent_id: String,
    task_id: String,
) -> Result<String, String> {
    let path = std::path::Path::new(&project_path).to_path_buf();
    let wt =
        tokio::task::spawn_blocking(move || crate::worktree::create(&path, &agent_id, &task_id))
            .await
            .map_err(|e| e.to_string())??;

    let wt_str = wt.to_str().unwrap_or_default().to_string();
    // Store on the agent entry if it exists (agent_id from the outer scope is moved,
    // so we extract it from the returned path).
    if let Some(name) = wt.file_name().and_then(|n| n.to_str()) {
        let _ = registry.set_worktree_path(name, &wt_str);
    }
    Ok(wt_str)
}

#[tauri::command]
pub async fn worktree_remove(project_path: String, agent_id: String) -> Result<(), String> {
    let path = std::path::Path::new(&project_path).to_path_buf();
    tokio::task::spawn_blocking(move || crate::worktree::remove(&path, &agent_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn worktree_diff(project_path: String, task_id: String) -> Result<String, String> {
    let path = std::path::Path::new(&project_path).to_path_buf();
    tokio::task::spawn_blocking(move || crate::worktree::diff_against_base(&path, &task_id))
        .await
        .map_err(|e| e.to_string())?
}
