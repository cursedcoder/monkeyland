use std::time::Duration;
use tauri::Manager;

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
            let handle_bus = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(16));
                loop {
                    interval.tick().await;
                    if let Some(bus) = handle_bus.try_state::<coalescing::CoalescingBus>() {
                        let _ = bus.tick();
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Monkeyland");
}

mod coalescing;
mod commands;
mod storage;
