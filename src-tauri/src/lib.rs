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
                        let _ = batcher.flush(&meta_db);
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
            crate::commands::browser_ensure_started,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Monkeyland");
}

mod browser_pool;
mod coalescing;
mod commands;
mod pty_pool;
mod storage;
