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

fn write_file_core(path: &str, content: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    std::fs::write(p, content.as_bytes()).map_err(|e| format!("write failed: {e}"))
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
    write_file_core(&path, &content)
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

    Ok(truncate_end(&output, MAX_EXEC_OUTPUT))
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

const MAX_FILE_OUTPUT: usize = 32_000;

fn read_file_core(path: &str) -> Result<String, String> {
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }
    let content = std::fs::read_to_string(p).map_err(|e| format!("Failed to read {path}: {e}"))?;
    Ok(truncate_start(content, MAX_FILE_OUTPUT))
}

fn truncate_start(content: String, max: usize) -> String {
    if content.len() > max {
        let truncated = &content[..max];
        format!("{truncated}\n[...truncated at {max} chars...]")
    } else {
        content
    }
}

const MAX_EXEC_OUTPUT: usize = 16_000;

fn truncate_end(content: &str, max: usize) -> String {
    if content.len() > max {
        let truncated = &content[content.len() - max..];
        format!("[...truncated...]\n{truncated}")
    } else {
        content.to_string()
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
    read_file_core(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;
    use tauri::Manager;

    fn test_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        let dir = tempfile::tempdir().unwrap();
        let dir_path = dir.path().to_path_buf();
        crate::manage_state(&app, &dir_path, 0).unwrap();
        // Leak the tempdir so it persists for the lifetime of the app
        std::mem::forget(dir);
        app
    }

    fn test_app_with_dir() -> (tauri::App<tauri::test::MockRuntime>, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let dir_path = dir.path().to_path_buf();
        let app = tauri::test::mock_app();
        crate::manage_state(&app, &dir_path, 0).unwrap();
        std::mem::forget(dir);
        (app, dir_path)
    }

    #[test]
    fn test_process_kill_commands_are_detected() {
        assert!(is_process_kill_command("kill 123").is_some());
        assert!(is_process_kill_command("pkill -f vite").is_some());
        assert!(is_process_kill_command("killall node").is_some());
        assert!(is_process_kill_command("echo hello").is_none());
    }

    #[test]
    fn test_process_kill_detects_kill_9_variants() {
        assert!(is_process_kill_command("kill -9 12345").is_some());
        assert!(is_process_kill_command("kill -KILL 12345").is_some());
        assert!(is_process_kill_command("kill -SIGKILL 12345").is_some());
    }

    #[test]
    fn test_process_kill_ignores_non_kill_with_kill_substring() {
        // "skill" contains "kill" as a substring — should NOT be detected
        // (pkill/killall/kill are checked via contains, so "skill" won't match "kill " at start)
        assert!(is_process_kill_command("echo 'kill nothing'").is_none());
    }

    #[test]
    fn test_validator_cleanup_session_guard() {
        assert!(is_validator_cleanup_session("validator-dev-abc"));
        assert!(!is_validator_cleanup_session("ctx-gather"));
        assert!(!is_validator_cleanup_session("exec-123"));
    }

    // --- is_rm_rf_dangerous tests ---

    #[test]
    fn rm_rf_root_is_dangerous() {
        assert!(is_rm_rf_dangerous("rm -rf /"));
        assert!(is_rm_rf_dangerous("rm -rf /*"));
        assert!(is_rm_rf_dangerous("rm -rf / ; echo done"));
    }

    #[test]
    fn rm_rf_home_is_dangerous() {
        assert!(is_rm_rf_dangerous("rm -rf ~"));
        assert!(is_rm_rf_dangerous("rm -rf $HOME"));
    }

    #[test]
    fn rm_rf_subdirectory_is_safe() {
        assert!(!is_rm_rf_dangerous("rm -rf /tmp/build"));
        assert!(!is_rm_rf_dangerous("rm -rf ./node_modules"));
        assert!(!is_rm_rf_dangerous("rm -rf dist/"));
    }

    #[test]
    fn rm_rf_root_with_trailing_path_is_safe() {
        assert!(!is_rm_rf_dangerous("rm -rf /var/log/old"));
    }

    // --- is_destructive_command tests ---

    #[test]
    fn destructive_commands_blocked() {
        assert!(is_destructive_command("shutdown -h now").is_some());
        assert!(is_destructive_command("reboot").is_some());
        assert!(is_destructive_command("mkfs.ext4 /dev/sda1").is_some());
        assert!(is_destructive_command("dd if=/dev/zero of=/dev/sda").is_some());
    }

    #[test]
    fn fork_bomb_blocked() {
        assert!(is_destructive_command(":(){ :|:& };:").is_some());
    }

    #[test]
    fn shell_config_modification_blocked() {
        assert!(is_destructive_command("echo 'alias ll=ls' >> .bashrc").is_some());
        assert!(is_destructive_command("echo 'export PATH' >> .zshrc").is_some());
        assert!(is_destructive_command("cat > .profile").is_some());
    }

    #[test]
    fn safe_commands_not_blocked() {
        assert!(is_destructive_command("npm install").is_none());
        assert!(is_destructive_command("cargo build").is_none());
        assert!(is_destructive_command("git status").is_none());
        assert!(is_destructive_command("ls -la").is_none());
    }

    // --- is_likely_interactive_without_flags tests ---

    #[test]
    fn interactive_scaffold_commands_blocked() {
        assert!(is_likely_interactive_without_flags("npm create vite@latest").is_some());
        assert!(is_likely_interactive_without_flags("npx create-react-app my-app").is_some());
        assert!(is_likely_interactive_without_flags("pnpm create next-app").is_some());
        assert!(is_likely_interactive_without_flags("yarn create vite").is_some());
        assert!(is_likely_interactive_without_flags("bun create vite").is_some());
        assert!(is_likely_interactive_without_flags("npm init").is_some());
    }

    #[test]
    fn interactive_with_yes_flag_allowed() {
        assert!(is_likely_interactive_without_flags("npm create vite@latest --yes").is_none());
        assert!(is_likely_interactive_without_flags("npm init -y").is_none());
        assert!(is_likely_interactive_without_flags("yes | npm create vite").is_none());
    }

    #[test]
    fn non_interactive_commands_allowed() {
        assert!(is_likely_interactive_without_flags("npm install express").is_none());
        assert!(is_likely_interactive_without_flags("npm run build").is_none());
        assert!(is_likely_interactive_without_flags("cargo test").is_none());
    }

    #[test]
    fn interactive_with_no_interactive_flag_allowed() {
        assert!(is_likely_interactive_without_flags("npm create vite@latest --no-interactive").is_none());
    }

    #[test]
    fn bun_init_and_pnpm_init_blocked() {
        assert!(is_likely_interactive_without_flags("bun init").is_some());
        assert!(is_likely_interactive_without_flags("pnpm init").is_some());
        assert!(is_likely_interactive_without_flags("yarn init").is_some());
    }

    // --- shell_single_quote tests ---

    #[test]
    fn shell_single_quote_simple() {
        assert_eq!(shell_single_quote("hello"), "'hello'");
    }

    #[test]
    fn shell_single_quote_with_embedded_quotes() {
        let result = shell_single_quote("it's");
        assert!(!result.is_empty());
        assert!(result.starts_with('\''));
        assert!(result.ends_with('\''));
    }

    #[test]
    fn shell_single_quote_empty() {
        assert_eq!(shell_single_quote(""), "''");
    }

    #[test]
    fn shell_single_quote_spaces_and_special() {
        let result = shell_single_quote("path with spaces/$VAR");
        assert!(result.starts_with('\''));
        assert!(result.ends_with('\''));
    }

    // --- Additional is_rm_rf_dangerous edge cases ---

    #[test]
    fn rm_rf_root_with_tab_is_dangerous() {
        assert!(is_rm_rf_dangerous("rm -rf /\t"));
    }

    #[test]
    fn rm_rf_root_with_pipe_is_dangerous() {
        assert!(is_rm_rf_dangerous("rm -rf /|cat"));
    }

    #[test]
    fn rm_rf_root_with_ampersand_is_dangerous() {
        assert!(is_rm_rf_dangerous("rm -rf /&"));
    }

    #[test]
    fn rm_rf_root_with_newline_is_dangerous() {
        assert!(is_rm_rf_dangerous("rm -rf /\necho done"));
    }

    // --- is_destructive_command false positive / edge cases ---

    #[test]
    fn dd_without_dev_target_is_safe() {
        assert!(
            is_destructive_command("dd if=input.img of=output.img").is_none(),
            "dd not targeting /dev should be safe"
        );
    }

    #[test]
    fn halt_substring_in_echo_is_known_false_positive() {
        let result = is_destructive_command("echo halt > log.txt");
        assert!(result.is_some(), "known false positive: 'halt' substring in echo");
    }

    #[test]
    fn safe_dd_read_from_dev() {
        assert!(
            is_destructive_command("dd if=/dev/zero of=testfile bs=1M count=10").is_none(),
            "dd reading from /dev but writing to file should be safe"
        );
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

    // --- write_file_core tests ---

    #[test]
    fn write_file_core_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a").join("b").join("file.txt");
        write_file_core(path.to_str().unwrap(), "hello").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
    }

    #[test]
    fn write_file_core_overwrites_existing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.txt");
        std::fs::write(&path, "old").unwrap();
        write_file_core(path.to_str().unwrap(), "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    #[test]
    fn write_file_core_empty_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.txt");
        write_file_core(path.to_str().unwrap(), "").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
    }

    // --- read_file_core tests ---

    #[test]
    fn read_file_core_returns_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "hello world").unwrap();
        let result = read_file_core(path.to_str().unwrap()).unwrap();
        assert_eq!(result, "hello world");
    }

    #[test]
    fn read_file_core_not_found() {
        let result = read_file_core("/nonexistent/path/to/file.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[test]
    fn read_file_core_truncates_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        let content = "x".repeat(MAX_FILE_OUTPUT + 1000);
        std::fs::write(&path, &content).unwrap();
        let result = read_file_core(path.to_str().unwrap()).unwrap();
        assert!(result.contains("[...truncated at"));
        assert!(result.len() < content.len());
    }

    #[test]
    fn read_file_core_exact_limit_not_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("exact.txt");
        let content = "x".repeat(MAX_FILE_OUTPUT);
        std::fs::write(&path, &content).unwrap();
        let result = read_file_core(path.to_str().unwrap()).unwrap();
        assert_eq!(result, content);
    }

    // --- truncate_start / truncate_end tests ---

    #[test]
    fn truncate_start_short_string_unchanged() {
        assert_eq!(truncate_start("abc".to_string(), 100), "abc");
    }

    #[test]
    fn truncate_start_long_string_keeps_beginning() {
        let result = truncate_start("abcdef".to_string(), 3);
        assert!(result.starts_with("abc"));
        assert!(result.contains("[...truncated at 3 chars...]"));
    }

    #[test]
    fn truncate_end_short_string_unchanged() {
        assert_eq!(truncate_end("abc", 100), "abc");
    }

    #[test]
    fn truncate_end_long_string_keeps_end() {
        let result = truncate_end("abcdef", 3);
        assert!(result.contains("def"));
        assert!(result.starts_with("[...truncated...]"));
    }

    // --- format_kilo_proxy_url tests ---

    #[test]
    fn kilo_proxy_url_zero_returns_empty() {
        assert_eq!(format_kilo_proxy_url(0), "");
    }

    #[test]
    fn kilo_proxy_url_nonzero_returns_url() {
        assert_eq!(format_kilo_proxy_url(8080), "http://127.0.0.1:8080");
    }

    #[test]
    fn kilo_proxy_url_max_port() {
        assert_eq!(format_kilo_proxy_url(65535), "http://127.0.0.1:65535");
    }

    // --- default functions ---

    #[test]
    fn default_node_type_is_agent() {
        assert_eq!(default_node_type(), "agent");
    }

    #[test]
    fn default_cols_is_80() {
        assert_eq!(default_cols(), 80);
    }

    #[test]
    fn default_rows_is_24() {
        assert_eq!(default_rows(), 24);
    }

    #[test]
    fn default_timeout_is_30s() {
        assert_eq!(default_timeout(), 30_000);
    }

    #[test]
    fn default_restore_state_is_running() {
        assert_eq!(default_restore_state(), "running");
    }

    // --- validator cleanup edge cases ---

    #[tokio::test]
    async fn validator_cleanup_rejects_non_validator_session() {
        let payload = ValidatorCleanupPayload {
            session_id: "regular-session".to_string(),
            pid: 1,
            cwd: None,
        };
        let result = validator_cleanup_process_tree(payload).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("only accepts validator-dev-*"));
    }

    #[tokio::test]
    async fn validator_cleanup_rejects_zero_pid() {
        let payload = ValidatorCleanupPayload {
            session_id: "validator-dev-test".to_string(),
            pid: 0,
            cwd: None,
        };
        let result = validator_cleanup_process_tree(payload).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid pid"));
    }

    #[tokio::test]
    async fn validator_cleanup_with_cwd() {
        let mut child = Command::new("/bin/bash")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("failed to spawn sleep process");
        let pid = child.id();
        let dir = tempfile::tempdir().unwrap();

        let payload = ValidatorCleanupPayload {
            session_id: "validator-dev-cwd".to_string(),
            pid,
            cwd: Some(dir.path().to_str().unwrap().to_string()),
        };
        validator_cleanup_process_tree(payload).await.unwrap();

        tokio::time::sleep(Duration::from_millis(150)).await;
        let status = child.try_wait().expect("try_wait failed");
        assert!(status.is_some());
    }

    // --- CanvasLayoutPayload / SessionLayout serde ---

    #[test]
    fn session_layout_defaults() {
        let json = r#"{"session_id":"s1","x":0,"y":0,"w":100,"h":100,"collapsed":false}"#;
        let layout: SessionLayout = serde_json::from_str(json).unwrap();
        assert_eq!(layout.node_type, "agent");
        assert_eq!(layout.payload, "");
    }

    #[test]
    fn session_layout_custom_type() {
        let json = r#"{"session_id":"s1","x":0,"y":0,"w":100,"h":100,"collapsed":false,"node_type":"log","payload":"data"}"#;
        let layout: SessionLayout = serde_json::from_str(json).unwrap();
        assert_eq!(layout.node_type, "log");
        assert_eq!(layout.payload, "data");
    }

    // --- TerminalExecPayload serde ---

    #[test]
    fn terminal_exec_payload_defaults() {
        let json = r#"{"session_id":"s1","command":"echo hi"}"#;
        let p: TerminalExecPayload = serde_json::from_str(json).unwrap();
        assert_eq!(p.timeout_ms, 30_000);
        assert!(p.cwd.is_none());
        assert!(p.agent_id.is_none());
    }

    // --- LlmSettingsPayload serde ---

    #[test]
    fn llm_settings_roundtrip() {
        let payload = LlmSettingsPayload {
            provider: "anthropic".to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        let back: LlmSettingsPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back.provider, "anthropic");
        assert_eq!(back.model, "claude-sonnet-4-20250514");
    }

    // --- AgentSpawnPayload serde ---

    #[test]
    fn agent_spawn_payload_minimal() {
        let json = r#"{"role":"developer"}"#;
        let p: AgentSpawnPayload = serde_json::from_str(json).unwrap();
        assert_eq!(p.role, "developer");
        assert!(p.task_id.is_none());
        assert!(p.parent_agent_id.is_none());
        assert!(p.cwd.is_none());
    }

    // --- ValidationSubmitPayload serde ---

    #[test]
    fn validation_payload_defaults() {
        let json = r#"{"developer_agent_id":"d1","validator_role":"test","pass":true}"#;
        let p: ValidationSubmitPayload = serde_json::from_str(json).unwrap();
        assert!(p.pass);
        assert!(p.reasons.is_empty());
    }

    // --- AgentRestoreItem serde ---

    #[test]
    fn restore_item_defaults() {
        let json = r#"{"agent_id":"a1","role":"dev"}"#;
        let p: AgentRestoreItem = serde_json::from_str(json).unwrap();
        assert_eq!(p.state, "running");
        assert!(p.project_path.is_none());
        assert!(p.worktree_path.is_none());
    }

    // =====================================================================
    // Tauri mock-runtime command handler tests
    // =====================================================================

    // --- Group A: MetaDb commands ---

    #[tokio::test]
    async fn cmd_save_load_canvas_layout_roundtrip() {
        let app = test_app();
        let db = app.state::<crate::storage::MetaDb>();

        let payload = CanvasLayoutPayload {
            layouts: vec![
                SessionLayout {
                    session_id: "s1".into(),
                    x: 10.0, y: 20.0, w: 300.0, h: 200.0,
                    collapsed: false,
                    node_type: "agent".into(),
                    payload: "".into(),
                },
                SessionLayout {
                    session_id: "s2".into(),
                    x: 50.0, y: 60.0, w: 400.0, h: 100.0,
                    collapsed: true,
                    node_type: "log".into(),
                    payload: "data".into(),
                },
            ],
        };
        save_canvas_layout(db.clone(), payload).await.unwrap();

        let loaded = load_canvas_layout(db).await.unwrap();
        assert_eq!(loaded.layouts.len(), 2);
        let s1 = loaded.layouts.iter().find(|l| l.session_id == "s1").unwrap();
        assert_eq!(s1.x, 10.0);
        assert_eq!(s1.node_type, "agent");
        let s2 = loaded.layouts.iter().find(|l| l.session_id == "s2").unwrap();
        assert!(s2.collapsed);
        assert_eq!(s2.payload, "data");
    }

    #[tokio::test]
    async fn cmd_load_canvas_layout_empty() {
        let app = test_app();
        let db = app.state::<crate::storage::MetaDb>();
        let loaded = load_canvas_layout(db).await.unwrap();
        assert!(loaded.layouts.is_empty());
    }

    #[tokio::test]
    async fn cmd_save_load_llm_settings() {
        let app = test_app();
        let db = app.state::<crate::storage::MetaDb>();

        let defaults = load_llm_settings(db.clone()).await.unwrap();
        assert_eq!(defaults.provider, "anthropic");
        assert!(defaults.model.contains("claude"));

        save_llm_settings(db.clone(), LlmSettingsPayload {
            provider: "openai".into(),
            model: "gpt-4o".into(),
        }).await.unwrap();

        let updated = load_llm_settings(db).await.unwrap();
        assert_eq!(updated.provider, "openai");
        assert_eq!(updated.model, "gpt-4o");
    }

    #[tokio::test]
    async fn cmd_get_set_llm_api_key() {
        let app = test_app();
        let db = app.state::<crate::storage::MetaDb>();

        let none_key = get_llm_api_key(db.clone(), "anthropic".into()).await.unwrap();
        assert!(none_key.is_none());

        set_llm_api_key(db.clone(), "anthropic".into(), "sk-test-123".into()).await.unwrap();

        let key = get_llm_api_key(db, "anthropic".into()).await.unwrap();
        assert_eq!(key, Some("sk-test-123".to_string()));
    }

    #[tokio::test]
    async fn cmd_llm_setup_done() {
        let app = test_app();
        let db = app.state::<crate::storage::MetaDb>();

        let before = get_llm_setup_done(db.clone()).await.unwrap();
        assert!(!before);

        set_llm_setup_done(db.clone()).await.unwrap();

        let after = get_llm_setup_done(db).await.unwrap();
        assert!(after);
    }

    #[tokio::test]
    async fn cmd_safety_mode_toggle() {
        let app = test_app();
        let db = app.state::<crate::storage::MetaDb>();

        let initial = get_safety_mode(db.clone()).await.unwrap();
        assert!(!initial);

        set_safety_mode(db.clone(), true).await.unwrap();
        assert!(get_safety_mode(db.clone()).await.unwrap());

        set_safety_mode(db.clone(), false).await.unwrap();
        assert!(!get_safety_mode(db).await.unwrap());
    }

    #[tokio::test]
    async fn cmd_beads_project_path() {
        let app = test_app();
        let db = app.state::<crate::storage::MetaDb>();
        let reg = app.state::<AgentRegistry>();

        let none_path = get_beads_project_path(db.clone()).await.unwrap();
        assert!(none_path.is_none() || none_path.as_deref() == Some(""));

        set_beads_project_path(db.clone(), reg.clone(), Some("/tmp/project".into()), None)
            .await.unwrap();
        let path = get_beads_project_path(db.clone()).await.unwrap();
        assert_eq!(path, Some("/tmp/project".to_string()));

        set_beads_project_path(db.clone(), reg, None, None).await.unwrap();
        let cleared = get_beads_project_path(db).await.unwrap();
        assert_eq!(cleared, Some("".to_string()));
    }

    // --- Group B: Agent registry commands ---

    #[tokio::test]
    async fn cmd_agent_status_empty() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();
        let status = agent_status(reg).await.unwrap();
        assert_eq!(status.used_slots, 0);
    }

    #[tokio::test]
    async fn cmd_debug_snapshot_empty() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();
        let snap = debug_snapshot(reg).await.unwrap();
        assert!(snap.agents.is_empty());
    }

    #[tokio::test]
    async fn cmd_set_role_config() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();
        set_role_config(reg.clone(), "developer".into(), Some(2)).await.unwrap();
        set_role_config(reg, "developer".into(), None).await.unwrap();
    }

    #[tokio::test]
    async fn cmd_agent_quota_and_tokens() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();

        let id = reg.spawn("worker", Some("t-1".into()), None, None).unwrap();

        let q = agent_quota(reg.clone(), id.clone()).await.unwrap().unwrap();
        assert_eq!(q.tokens_used, 0);

        agent_report_tokens(reg.clone(), id.clone(), 500).await.unwrap();
        let q2 = agent_quota(reg, id).await.unwrap().unwrap();
        assert_eq!(q2.tokens_used, 500);
    }

    #[tokio::test]
    async fn cmd_agent_yield_flow() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();

        let id = reg.spawn("developer", Some("t-1".into()), None, None).unwrap();

        agent_yield(reg.clone(), id.clone(), YieldPayload {
            status: "ready".into(),
            git_branch: Some("feat/test".into()),
            diff_summary: Some("added tests".into()),
        }).await.unwrap();

        let snap = debug_snapshot(reg).await.unwrap();
        let agent = snap.agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!(agent.state, "Yielded");
    }

    #[tokio::test]
    async fn cmd_agent_message_and_poll() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();

        let a1 = reg.spawn("worker", Some("t-1".into()), None, None).unwrap();
        let a2 = reg.spawn("worker", Some("t-2".into()), None, None).unwrap();

        let sent = agent_message(reg.clone(), a1.clone(), a2.clone(), "hello".into()).await.unwrap();
        assert!(sent);

        let msgs = agent_poll_messages(reg, a2).await.unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].payload, "hello");
    }

    #[tokio::test]
    async fn cmd_validation_submit_accumulates() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();

        let dev_id = reg.spawn("developer", Some("t-1".into()), None, None).unwrap();
        reg.yield_for_review(&dev_id, YieldPayload {
            status: "ready".into(),
            git_branch: None,
            diff_summary: None,
        }).unwrap();
        reg.start_validation(&dev_id, Some("t-1".into())).unwrap();

        let r1 = validation_submit(reg.clone(), ValidationSubmitPayload {
            developer_agent_id: dev_id.clone(),
            validator_role: "v1".into(),
            pass: true,
            reasons: vec![],
        }).await.unwrap();
        assert!(r1.is_none());

        let r2 = validation_submit(reg.clone(), ValidationSubmitPayload {
            developer_agent_id: dev_id.clone(),
            validator_role: "v2".into(),
            pass: true,
            reasons: vec![],
        }).await.unwrap();
        assert!(r2.is_none());

        let r3 = validation_submit(reg, ValidationSubmitPayload {
            developer_agent_id: dev_id,
            validator_role: "v3".into(),
            pass: true,
            reasons: vec![],
        }).await.unwrap();
        assert!(r3.is_some());
        assert!(r3.unwrap().all_passed);
    }

    #[tokio::test]
    async fn cmd_agent_complete_task_worker() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();

        let id = reg.spawn("worker", Some("t-1".into()), None, None).unwrap();
        agent_complete_task(reg, id).await.unwrap();
    }

    #[tokio::test]
    async fn cmd_agent_turn_ended_worker_completes() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();

        let id = reg.spawn("worker", Some("t-1".into()), None, None).unwrap();
        let result = agent_turn_ended(reg, id, "worker".into()).await.unwrap();
        assert_eq!(result, "completed");
    }

    #[tokio::test]
    async fn cmd_agent_turn_ended_nonexistent() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();
        let result = agent_turn_ended(reg, "nonexistent".into(), "worker".into()).await.unwrap();
        assert_eq!(result, "not_found");
    }

    #[tokio::test]
    async fn cmd_agent_force_yield_and_set_summary() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();

        let id = reg.spawn("developer", Some("t-1".into()), None, None).unwrap();
        agent_force_yield(reg.clone(), id.clone()).await.unwrap();

        agent_set_yield_summary(reg.clone(), id.clone(), "force yielded summary".into())
            .await.unwrap();

        let snap = debug_snapshot(reg).await.unwrap();
        let agent = snap.agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!(agent.state, "Yielded");
    }

    #[tokio::test]
    async fn cmd_agent_gate_tool_running() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();

        let id = reg.spawn("worker", Some("t-1".into()), None, None).unwrap();
        agent_gate_tool(reg, id, "terminal_exec".into()).await.unwrap();
    }

    #[tokio::test]
    async fn cmd_agent_gate_tool_nonexistent() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();
        let result = agent_gate_tool(reg, "ghost".into(), "terminal_exec".into()).await;
        assert!(result.is_err());
    }

    // --- Group C: Orchestration commands ---

    #[tokio::test]
    async fn cmd_orch_start_pause_get_state() {
        let app = test_app();
        let state = app.state::<OrchestrationState>();

        let initial = orch_get_state(state.clone()).await.unwrap();
        assert_eq!(initial, 0);

        orch_start(state.clone()).await.unwrap();
        assert_eq!(orch_get_state(state.clone()).await.unwrap(), 1);

        orch_pause(state.clone()).await.unwrap();
        assert_eq!(orch_get_state(state).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn cmd_orch_get_metrics_fresh() {
        let app = test_app();
        let metrics = app.state::<OrchestrationMetrics>();
        let mq = app.state::<MergeQueue>();

        let snap = orch_get_metrics(metrics, mq).await.unwrap();
        assert_eq!(snap.merge_queue_depth, 0);
        assert_eq!(snap.merge_retry_count, 0);
    }

    // --- Group D: File commands with State ---

    #[tokio::test]
    async fn cmd_write_and_read_file_ungated() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("hello.txt");

        write_file(reg.clone(), file_path.to_str().unwrap().into(), "world".into(), None)
            .await.unwrap();

        let content = read_file(reg, file_path.to_str().unwrap().into(), None)
            .await.unwrap();
        assert_eq!(content, "world");
    }

    #[tokio::test]
    async fn cmd_read_file_not_found() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();
        let result = read_file(reg, "/nonexistent/file.txt".into(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[tokio::test]
    async fn cmd_get_kilo_proxy_url_via_state() {
        let app = tauri::test::mock_app();
        let dir = tempfile::tempdir().unwrap();
        crate::manage_state(&app, dir.path(), 8080).unwrap();
        std::mem::forget(dir);

        let port_state = app.state::<crate::KiloProxyPort>();
        let url = get_kilo_proxy_url(port_state);
        assert_eq!(url, "http://127.0.0.1:8080");
    }

    #[tokio::test]
    async fn cmd_get_kilo_proxy_url_zero() {
        let app = test_app();
        let port_state = app.state::<crate::KiloProxyPort>();
        let url = get_kilo_proxy_url(port_state);
        assert_eq!(url, "");
    }

    // --- Group E: Special commands ---

    #[tokio::test]
    async fn cmd_agent_kill_via_registry() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();
        let pool = app.state::<crate::pty_pool::PtyPool>();

        let id = reg.spawn("worker", Some("t-1".into()), None, None).unwrap();

        let killed = agent_kill(pool, reg.clone(), id.clone()).await.unwrap();
        assert!(killed);

        let snap = debug_snapshot(reg).await.unwrap();
        assert!(snap.agents.iter().find(|a| a.id == id).is_none());
    }

    #[tokio::test]
    async fn cmd_agent_kill_nonexistent() {
        let app = test_app();
        let reg = app.state::<AgentRegistry>();
        let pool = app.state::<crate::pty_pool::PtyPool>();

        let killed = agent_kill(pool, reg, "ghost".into()).await.unwrap();
        assert!(!killed);
    }

    #[tokio::test]
    async fn cmd_full_reset_clears_state() {
        let app = test_app();
        let orch = app.state::<OrchestrationState>();
        let reg = app.state::<AgentRegistry>();
        let pool = app.state::<crate::pty_pool::PtyPool>();
        let db = app.state::<crate::storage::MetaDb>();

        orch_start(orch.clone()).await.unwrap();
        reg.spawn("worker", Some("t-1".into()), None, None).unwrap();

        full_reset(orch.clone(), reg.clone(), pool, db).await.unwrap();

        assert_eq!(orch_get_state(orch).await.unwrap(), 2);
        let snap = debug_snapshot(reg).await.unwrap();
        assert!(snap.agents.is_empty());
    }

    #[tokio::test]
    async fn cmd_terminal_exec_echo() {
        let app = test_app();
        let pool = app.state::<crate::pty_pool::PtyPool>();
        let reg = app.state::<AgentRegistry>();

        let result = terminal_exec(pool, reg, TerminalExecPayload {
            session_id: "test".into(),
            command: "echo hello_world".into(),
            timeout_ms: 5_000,
            cwd: None,
            agent_id: None,
        }).await.unwrap();
        assert!(result.contains("hello_world"));
    }

    #[tokio::test]
    async fn cmd_terminal_exec_blocked_destructive() {
        let app = test_app();
        let pool = app.state::<crate::pty_pool::PtyPool>();
        let reg = app.state::<AgentRegistry>();

        let result = terminal_exec(pool, reg, TerminalExecPayload {
            session_id: "test".into(),
            command: "rm -rf /".into(),
            timeout_ms: 5_000,
            cwd: None,
            agent_id: None,
        }).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Blocked"));
    }

    #[tokio::test]
    async fn cmd_terminal_exec_kill_returns_guidance() {
        let app = test_app();
        let pool = app.state::<crate::pty_pool::PtyPool>();
        let reg = app.state::<AgentRegistry>();

        let result = terminal_exec(pool, reg, TerminalExecPayload {
            session_id: "test".into(),
            command: "kill 12345".into(),
            timeout_ms: 5_000,
            cwd: None,
            agent_id: None,
        }).await.unwrap();
        assert!(result.contains("NOT NEEDED"));
    }

    #[tokio::test]
    async fn cmd_terminal_exec_with_cwd() {
        let app = test_app();
        let pool = app.state::<crate::pty_pool::PtyPool>();
        let reg = app.state::<AgentRegistry>();
        let dir = tempfile::tempdir().unwrap();

        let result = terminal_exec(pool, reg, TerminalExecPayload {
            session_id: "test".into(),
            command: "pwd".into(),
            timeout_ms: 5_000,
            cwd: Some(dir.path().to_str().unwrap().into()),
            agent_id: None,
        }).await.unwrap();
        assert!(result.contains(dir.path().to_str().unwrap()));
    }

    #[tokio::test]
    async fn cmd_terminal_exec_interactive_blocked() {
        let app = test_app();
        let pool = app.state::<crate::pty_pool::PtyPool>();
        let reg = app.state::<AgentRegistry>();

        let result = terminal_exec(pool, reg, TerminalExecPayload {
            session_id: "test".into(),
            command: "npm create vite@latest".into(),
            timeout_ms: 5_000,
            cwd: None,
            agent_id: None,
        }).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("interactive"));
    }

    // =====================================================================
    // IPC round-trip tests (full serde contract via invoke handler)
    // =====================================================================

    fn ipc_app() -> (
        tauri::App<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let dir_path = dir.path().to_path_buf();
        let app = tauri::test::mock_builder()
            .invoke_handler(crate::tests::test_invoke_handler())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock app");
        crate::manage_state(&app, &dir_path, 4242).unwrap();
        std::mem::forget(dir);
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        (app, webview)
    }

    fn ipc_req(cmd: &str, body: serde_json::Value) -> tauri::webview::InvokeRequest {
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        }
    }

    #[test]
    fn ipc_load_llm_settings_returns_defaults() {
        let (_app, webview) = ipc_app();
        let res = tauri::test::get_ipc_response(
            &webview,
            ipc_req("load_llm_settings", serde_json::json!({})),
        );
        assert!(res.is_ok(), "IPC failed: {:?}", res.err());
        let val: LlmSettingsPayload = res.unwrap().deserialize().unwrap();
        assert_eq!(val.provider, "anthropic");
    }

    #[test]
    fn ipc_orch_get_state_returns_zero() {
        let (_app, webview) = ipc_app();
        let res = tauri::test::get_ipc_response(
            &webview,
            ipc_req("orch_get_state", serde_json::json!({})),
        );
        assert!(res.is_ok());
        let val: u8 = res.unwrap().deserialize().unwrap();
        assert_eq!(val, 0);
    }

    #[test]
    fn ipc_get_kilo_proxy_url_returns_url() {
        let (_app, webview) = ipc_app();
        let res = tauri::test::get_ipc_response(
            &webview,
            ipc_req("get_kilo_proxy_url", serde_json::json!({})),
        );
        assert!(res.is_ok());
        let val: String = res.unwrap().deserialize().unwrap();
        assert_eq!(val, "http://127.0.0.1:4242");
    }

    #[test]
    fn ipc_agent_status_returns_empty() {
        let (_app, webview) = ipc_app();
        let res = tauri::test::get_ipc_response(
            &webview,
            ipc_req("agent_status", serde_json::json!({})),
        );
        assert!(res.is_ok());
        let val: crate::agent_registry::AgentStatusResponse =
            res.unwrap().deserialize().unwrap();
        assert_eq!(val.used_slots, 0);
    }

    #[test]
    fn ipc_get_safety_mode_default_false() {
        let (_app, webview) = ipc_app();
        let res = tauri::test::get_ipc_response(
            &webview,
            ipc_req("get_safety_mode", serde_json::json!({})),
        );
        assert!(res.is_ok());
        let val: bool = res.unwrap().deserialize().unwrap();
        assert!(!val);
    }

    #[tokio::test]
    async fn cmd_terminal_exec_gated_no_cwd_with_project() {
        let app = test_app();
        let pool = app.state::<crate::pty_pool::PtyPool>();
        let reg = app.state::<AgentRegistry>();

        let dir = tempfile::tempdir().unwrap();
        let id = reg.spawn("worker", Some("t-1".into()), None,
            Some(dir.path().to_str().unwrap().to_string())).unwrap();

        let result = terminal_exec(pool, reg, TerminalExecPayload {
            session_id: "test".into(),
            command: "echo hi".into(),
            timeout_ms: 5_000,
            cwd: None,
            agent_id: Some(id),
        }).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("cwd"));
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

fn format_kilo_proxy_url(port: u16) -> String {
    if port == 0 {
        String::new()
    } else {
        format!("http://127.0.0.1:{}", port)
    }
}

/// Returns the base URL of the local Kilo AI CORS proxy started at launch.
#[tauri::command]
pub fn get_kilo_proxy_url(state: tauri::State<'_, crate::KiloProxyPort>) -> String {
    let port = state.0.load(std::sync::atomic::Ordering::Relaxed);
    format_kilo_proxy_url(port)
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
