use crate::agent_registry::{AgentQuota, AgentRegistry, AgentStatusResponse, YieldPayload};
use crate::browser_pool::BrowserPool;
use crate::orchestration::OrchestrationState;
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
pub async fn get_llm_api_key(meta_db: State<'_, MetaDb>, provider: String) -> Result<Option<String>, String> {
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
pub async fn agent_status(registry: State<'_, AgentRegistry>) -> Result<AgentStatusResponse, String> {
    registry.status()
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
pub async fn orch_start(state: State<'_, OrchestrationState>) -> Result<(), String> {
    state.set_running();
    Ok(())
}

#[tauri::command]
pub async fn orch_pause(state: State<'_, OrchestrationState>) -> Result<(), String> {
    state.set_paused();
    Ok(())
}

/// Full reset: pause orchestration, clear all agents, clear beads project path.
#[tauri::command]
pub async fn full_reset(
    orch_state: State<'_, OrchestrationState>,
    registry: State<'_, AgentRegistry>,
    pool: State<'_, PtyPool>,
    meta_db: State<'_, MetaDb>,
) -> Result<(), String> {
    orch_state.set_paused();
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
) -> Result<Option<bool>, String> {
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

/// Check if a command contains dangerous patterns that could harm the system.
fn is_dangerous_command(cmd: &str) -> Option<&'static str> {
    let cmd_lower = cmd.to_lowercase();
    
    // Process killing commands (can kill dev server, system processes)
    if cmd_lower.contains("pkill") || cmd_lower.contains("killall") {
        return Some("pkill/killall commands are blocked - they can kill system processes");
    }
    if cmd_lower.contains("kill -9") || cmd_lower.contains("kill -kill") || cmd_lower.contains("kill -sigkill") {
        return Some("kill -9 is blocked - use gentler termination signals");
    }
    
    // Destructive file operations outside project
    if cmd_lower.contains("rm -rf /") || cmd_lower.contains("rm -rf ~") || cmd_lower.contains("rm -rf $home") {
        return Some("Recursive delete of root or home directory is blocked");
    }
    
    // System commands
    if cmd_lower.contains("shutdown") || cmd_lower.contains("reboot") || cmd_lower.contains("halt") {
        return Some("System shutdown/reboot commands are blocked");
    }
    if cmd_lower.contains("mkfs") || cmd_lower.contains("fdisk") || cmd_lower.contains("parted") {
        return Some("Disk formatting commands are blocked");
    }
    
    // Fork bomb pattern
    if cmd.contains(":(){ :|:&") || cmd.contains(":(){") {
        return Some("Fork bomb pattern detected and blocked");
    }
    
    // Dangerous dd operations
    if cmd_lower.contains("dd ") && (cmd_lower.contains("of=/dev") || cmd_lower.contains("of=/")) {
        return Some("dd writing to devices/root is blocked");
    }
    
    // Prevent modifying shell configs outside project
    if (cmd_lower.contains(">>") || cmd_lower.contains(">")) 
        && (cmd_lower.contains(".bashrc") || cmd_lower.contains(".zshrc") || cmd_lower.contains(".profile")) {
        return Some("Modifying shell config files is blocked");
    }
    
    None
}

/// Execute a command via `bash -c` as a subprocess, capturing clean stdout+stderr.
/// If payload.agent_id is set, gated by the state machine and cwd is validated against sandbox.
#[tauri::command]
pub async fn terminal_exec(
    _pool: State<'_, PtyPool>,
    registry: State<'_, AgentRegistry>,
    payload: TerminalExecPayload,
) -> Result<String, String> {
    // Check for dangerous commands (always, even without agent_id)
    if let Some(reason) = is_dangerous_command(&payload.command) {
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
                return Err("Terminal command requires 'cwd' parameter within project directory".to_string());
            }
        }
    }
    let timeout = Duration::from_millis(payload.timeout_ms);
    let cmd = payload.command.clone();
    let cwd = payload.cwd.clone();

    let result = tokio::time::timeout(timeout, tokio::task::spawn_blocking(move || {
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
    }))
    .await;

    let output = match result {
        Ok(Ok(s)) => s?,
        Ok(Err(e)) => return Err(format!("Task join error: {e}")),
        Err(_) => return Err("Command timed out".to_string()),
    };

    const MAX_OUTPUT: usize = 16_000;
    if output.len() > MAX_OUTPUT {
        let truncated = &output[output.len() - MAX_OUTPUT..];
        Ok(format!("[...truncated...]\n{truncated}"))
    } else {
        Ok(output)
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
    let content = std::fs::read_to_string(p)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    const MAX_FILE: usize = 32_000;
    if content.len() > MAX_FILE {
        let truncated = &content[..MAX_FILE];
        Ok(format!("{truncated}\n[...truncated at {MAX_FILE} chars...]"))
    } else {
        Ok(content)
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

/// Write text to the system clipboard. Used by the debug panel so copy works in the Tauri webview.
#[tauri::command]
pub fn write_clipboard_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())?;
    Ok(())
}
