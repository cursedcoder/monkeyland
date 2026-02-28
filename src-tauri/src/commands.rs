use crate::agent_registry::{AgentQuota, AgentRegistry, AgentStatusResponse, YieldPayload};
use crate::browser_pool::BrowserPool;
use crate::pty_pool::PtyPool;
use crate::storage::{MetaDb, SessionLayoutRow};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use tauri::State;

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
    registry: State<'_, AgentRegistry>,
    project_path: String,
    agent_id: Option<String>,
) -> Result<(), String> {
    if let Some(ref aid) = agent_id {
        registry.gate_tool(aid, "beads_dolt_start")?;
    }
    let path = Path::new(&project_path);
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", project_path));
    }
    Command::new("bd")
        .args(["dolt", "start"])
        .current_dir(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start bd dolt: {}", e))?;
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
/// If agent_id is provided, the call is gated by the state machine.
#[tauri::command]
pub async fn write_file(
    registry: State<'_, AgentRegistry>,
    path: String,
    content: String,
    agent_id: Option<String>,
) -> Result<(), String> {
    if let Some(ref aid) = agent_id {
        registry.gate_tool(aid, "write_file")?;
    }
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    std::fs::write(p, content.as_bytes()).map_err(|e| format!("write failed: {e}"))
}

/// Execute a command via `bash -c` as a subprocess, capturing clean stdout+stderr.
/// If payload.agent_id is set, gated by the state machine.
#[tauri::command]
pub async fn terminal_exec(
    _pool: State<'_, PtyPool>,
    registry: State<'_, AgentRegistry>,
    payload: TerminalExecPayload,
) -> Result<String, String> {
    if let Some(ref aid) = payload.agent_id {
        registry.gate_tool(aid, "terminal_exec")?;
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
