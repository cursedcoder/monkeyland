use std::time::Duration;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
            let meta_path = config_dir.join("meta.db");
            let meta_db = storage::MetaDb::open(&meta_path).map_err(|e| e.to_string())?;
            app.manage(meta_db);
            let batcher = storage::WriteBatcher::new(config_dir.clone());
            app.manage(batcher);
            app.manage(coalescing::CoalescingBus::new());
            app.manage(pty_pool::PtyPool::new());
            app.manage(browser_pool::BrowserPool::new());
            app.manage(agent_registry::AgentRegistry::new());
            app.manage(orchestration::OrchestrationState::new());

            // Orchestration loop: every 5 s, poll bd ready, spawn agents, claim tasks, kill expired
            let handle_orch = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(5));
                loop {
                    interval.tick().await;
                    let orch_state = handle_orch.try_state::<orchestration::OrchestrationState>();
                    if orch_state.as_deref().map_or(true, |s| !s.is_running()) {
                        continue;
                    }
                    if let (Some(meta_db), Some(registry), Some(pool)) = (
                        handle_orch.try_state::<storage::MetaDb>(),
                        handle_orch.try_state::<agent_registry::AgentRegistry>(),
                        handle_orch.try_state::<pty_pool::PtyPool>(),
                    ) {
                        let _ = orchestration::tick(&handle_orch, &meta_db, &registry, &pool).await;
                    }
                }
            });

            // Write batcher flush: every 100 ms
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(100));
                loop {
                    interval.tick().await;
                    if let (Some(batcher), Some(meta_db)) = (
                        handle.try_state::<storage::WriteBatcher>(),
                        handle.try_state::<storage::MetaDb>(),
                    ) {
                        let pool = handle.try_state::<pty_pool::PtyPool>();
                        let _ = batcher.flush(&meta_db, pool.as_deref());
                    }
                }
            });

            // Coalescing bus: drain ring buffers every 16 ms, emit Tauri event
            let handle_bus = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(16));
                loop {
                    interval.tick().await;
                    let payload = {
                        let bus = match handle_bus.try_state::<coalescing::CoalescingBus>() {
                            Some(b) => b,
                            None => continue,
                        };
                        let pool = match handle_bus.try_state::<pty_pool::PtyPool>() {
                            Some(p) => p,
                            None => continue,
                        };
                        let batcher = match handle_bus.try_state::<storage::WriteBatcher>() {
                            Some(b) => b,
                            None => continue,
                        };
                        bus.tick(&pool, &batcher).ok()
                    };
                    if let Some(p) = payload {
                        if !p.sessions.is_empty() {
                            let _ = handle_bus.emit("terminal_batch", &p);
                        }
                    }
                }
            });

            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::commands::save_canvas_layout,
            crate::commands::load_canvas_layout,
            crate::commands::load_llm_settings,
            crate::commands::save_llm_settings,
            crate::commands::get_llm_api_key,
            crate::commands::set_llm_api_key,
            crate::commands::get_llm_setup_done,
            crate::commands::set_llm_setup_done,
            crate::commands::terminal_spawn,
            crate::commands::terminal_write,
            crate::commands::terminal_resize,
            crate::commands::terminal_exec,
            crate::commands::write_file,
            crate::commands::read_file,
            crate::commands::browser_ensure_started,
            crate::commands::beads_init,
            crate::commands::beads_run,
            crate::commands::get_beads_project_path,
            crate::commands::set_beads_project_path,
            crate::commands::beads_dolt_start,
            crate::commands::agent_spawn,
            crate::commands::agent_kill,
            crate::commands::agent_status,
            crate::commands::set_role_config,
            crate::commands::orch_get_state,
            crate::commands::orch_start,
            crate::commands::orch_pause,
            crate::commands::agent_quota,
            crate::commands::agent_report_tokens,
            crate::commands::agent_yield,
            crate::commands::agent_message,
            crate::commands::agent_poll_messages,
            crate::commands::validation_submit,
            crate::commands::agent_complete_task,
            crate::commands::agent_turn_ended,
            crate::commands::agent_force_yield,
            crate::commands::agent_gate_tool,
            crate::commands::write_clipboard_text,
            crate::commands::full_reset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Monkeyland");
}

mod agent_registry;
mod agent_state_machine;
mod browser_pool;
mod coalescing;
mod commands;
mod orchestration;
mod pty_pool;
mod storage;
