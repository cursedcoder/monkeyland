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

mod commands;
mod storage;
