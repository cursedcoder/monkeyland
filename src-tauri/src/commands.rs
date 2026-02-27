use crate::storage::{MetaDb, SessionLayoutRow};
use serde::{Deserialize, Serialize};
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
