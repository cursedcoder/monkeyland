use std::sync::atomic::AtomicU16;
use std::time::Duration;
use tauri::{Emitter, Manager};

pub struct KiloProxyPort(pub(crate) AtomicU16);

fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
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
        crate::commands::validator_cleanup_process_tree,
        crate::commands::write_file,
        crate::commands::read_file,
        crate::commands::browser_ensure_started,
        crate::commands::beads_init,
        crate::commands::beads_run,
        crate::commands::get_beads_project_path,
        crate::commands::set_beads_project_path,
        crate::commands::beads_dolt_start,
        crate::commands::agent_spawn,
        crate::commands::agent_restore_batch,
        crate::commands::agent_kill,
        crate::commands::agent_status,
        crate::commands::agent_check_state,
        crate::commands::debug_snapshot,
        crate::commands::set_role_config,
        crate::commands::orch_get_state,
        crate::commands::orch_get_metrics,
        crate::commands::get_safety_mode,
        crate::commands::set_safety_mode,
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
        crate::commands::agent_set_yield_summary,
        crate::commands::agent_gate_tool,
        crate::commands::agent_get_phase,
        crate::commands::agent_transition_phase,
        crate::commands::write_clipboard_text,
        crate::commands::fetch_json,
        crate::commands::get_kilo_proxy_url,
        crate::commands::full_reset,
        crate::commands::worktree_create,
        crate::commands::worktree_remove,
        crate::commands::worktree_diff,
    ]
}

/// Manage all app state onto the given app handle. Usable from both real setup and tests.
pub(crate) fn manage_state<M: Manager<impl tauri::Runtime>>(
    m: &M,
    config_dir: &std::path::Path,
    kilo_port: u16,
) -> Result<(), String> {
    let meta_path = config_dir.join("meta.db");
    let meta_db = storage::MetaDb::open(&meta_path).map_err(|e| e.to_string())?;
    m.manage(meta_db);
    m.manage(storage::WriteBatcher::new(config_dir.to_path_buf()));
    m.manage(coalescing::CoalescingBus::new());
    m.manage(KiloProxyPort(AtomicU16::new(kilo_port)));
    m.manage(pty_pool::PtyPool::new());
    m.manage(browser_pool::BrowserPool::new());
    m.manage(agent_registry::AgentRegistry::new());
    m.manage(orchestration::OrchestrationState::new());
    m.manage(orchestration::MergeQueue::new());
    m.manage(orchestration::OrchestrationMetrics::new());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;

            let kilo_port = tauri::async_runtime::block_on(local_proxy::start(
                "https://api.kilo.ai/api/gateway".to_string(),
            ))
            .unwrap_or(0);

            manage_state(app, &config_dir, kilo_port)?;

            // Prune stale git worktrees from any previous session
            if let Some(db) = app.try_state::<storage::MetaDb>() {
                if let Ok(Some(pp)) = db.get_setting("beads_project_path") {
                    if !pp.is_empty() {
                        let path = std::path::Path::new(&pp).to_path_buf();
                        if path.join(".git").exists() {
                            let _ = worktree::prune(&path);
                        }
                    }
                }
            }

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
                    if let (
                        Some(meta_db),
                        Some(registry),
                        Some(pool),
                        Some(merge_q),
                        Some(metrics),
                    ) = (
                        handle_orch.try_state::<storage::MetaDb>(),
                        handle_orch.try_state::<agent_registry::AgentRegistry>(),
                        handle_orch.try_state::<pty_pool::PtyPool>(),
                        handle_orch.try_state::<orchestration::MergeQueue>(),
                        handle_orch.try_state::<orchestration::OrchestrationMetrics>(),
                    ) {
                        let env = orchestration::TauriOrchEnv {
                            app_handle: &handle_orch,
                            pool: &pool,
                        };
                        let _ = orchestration::tick(&env, &meta_db, &registry, &merge_q, &metrics)
                            .await;
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
        .invoke_handler(invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running Monkeyland");
}

mod agent_registry;
mod agent_state_machine;
mod browser_pool;
mod developer_phases;
mod coalescing;
mod commands;
mod local_proxy;
mod orchestration;
mod pty_pool;
mod storage;
mod worktree;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn kilo_proxy_port_default_is_zero() {
        let kpp = KiloProxyPort(std::sync::atomic::AtomicU16::new(0));
        assert_eq!(kpp.0.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn kilo_proxy_port_stores_value() {
        let kpp = KiloProxyPort(std::sync::atomic::AtomicU16::new(8080));
        assert_eq!(kpp.0.load(Ordering::Relaxed), 8080);
    }

    #[test]
    fn kilo_proxy_port_atomic_store() {
        let kpp = KiloProxyPort(std::sync::atomic::AtomicU16::new(0));
        kpp.0.store(3000, Ordering::Relaxed);
        assert_eq!(kpp.0.load(Ordering::Relaxed), 3000);
    }

    #[test]
    fn manage_state_registers_all_resources() {
        let app = tauri::test::mock_app();
        let dir = tempfile::tempdir().unwrap();
        manage_state(&app, dir.path(), 0).unwrap();

        assert!(app.try_state::<storage::MetaDb>().is_some());
        assert!(app.try_state::<storage::WriteBatcher>().is_some());
        assert!(app.try_state::<coalescing::CoalescingBus>().is_some());
        assert!(app.try_state::<KiloProxyPort>().is_some());
        assert!(app.try_state::<pty_pool::PtyPool>().is_some());
        assert!(app.try_state::<browser_pool::BrowserPool>().is_some());
        assert!(app.try_state::<agent_registry::AgentRegistry>().is_some());
        assert!(app
            .try_state::<orchestration::OrchestrationState>()
            .is_some());
        assert!(app.try_state::<orchestration::MergeQueue>().is_some());
        assert!(app
            .try_state::<orchestration::OrchestrationMetrics>()
            .is_some());
    }

    #[test]
    fn manage_state_sets_kilo_port() {
        let app = tauri::test::mock_app();
        let dir = tempfile::tempdir().unwrap();
        manage_state(&app, dir.path(), 9999).unwrap();

        let port_state = app.state::<KiloProxyPort>();
        assert_eq!(port_state.0.load(Ordering::Relaxed), 9999);
    }

    #[test]
    fn manage_state_creates_meta_db() {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        manage_state(&app, dir.path(), 0).unwrap();

        let db = app.state::<storage::MetaDb>();
        db.set_setting("test_key", "test_val").unwrap();
        assert_eq!(
            db.get_setting("test_key").unwrap(),
            Some("test_val".to_string())
        );
    }

    #[test]
    fn invoke_handler_returns_closure() {
        let _handler = invoke_handler();
    }

    /// Test-only invoke handler excluding commands that take AppHandle directly
    /// (beads_dolt_start), which doesn't work with MockRuntime.
    pub(crate) fn test_invoke_handler(
    ) -> impl Fn(tauri::ipc::Invoke<tauri::test::MockRuntime>) -> bool + Send + Sync + 'static {
        tauri::generate_handler![
            crate::commands::save_canvas_layout,
            crate::commands::load_canvas_layout,
            crate::commands::load_llm_settings,
            crate::commands::save_llm_settings,
            crate::commands::get_llm_api_key,
            crate::commands::set_llm_api_key,
            crate::commands::get_llm_setup_done,
            crate::commands::set_llm_setup_done,
            crate::commands::terminal_exec,
            crate::commands::validator_cleanup_process_tree,
            crate::commands::write_file,
            crate::commands::read_file,
            crate::commands::get_beads_project_path,
            crate::commands::set_beads_project_path,
            crate::commands::agent_spawn,
            crate::commands::agent_kill,
            crate::commands::agent_status,
            crate::commands::agent_check_state,
            crate::commands::debug_snapshot,
            crate::commands::set_role_config,
            crate::commands::orch_get_state,
            crate::commands::orch_get_metrics,
            crate::commands::get_safety_mode,
            crate::commands::set_safety_mode,
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
            crate::commands::agent_set_yield_summary,
            crate::commands::agent_gate_tool,
            crate::commands::get_kilo_proxy_url,
            crate::commands::full_reset,
        ]
    }
}
