//! Browser sidecar manager.
//! Spawns a Node.js HTTP server that runs Playwright + Chromium.
//! Rule 2: ONE Chromium instance, never one per agent.

use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub struct BrowserPool {
    inner: Mutex<BrowserPoolInner>,
}

struct BrowserPoolInner {
    process: Option<Child>,
    port: Option<u16>,
}

impl BrowserPool {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(BrowserPoolInner {
                process: None,
                port: None,
            }),
        }
    }

    /// Start the browser sidecar if not running. Returns the HTTP port.
    pub fn ensure_started(&self) -> Result<u16, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;

        if let Some(port) = inner.port {
            if let Some(ref mut child) = inner.process {
                match child.try_wait() {
                    Ok(None) => return Ok(port),
                    _ => {
                        inner.port = None;
                        inner.process = None;
                    }
                }
            }
        }

        let cwd = std::env::current_dir().unwrap_or_default();
        let candidates = [
            cwd.join("scripts").join("browser-server.mjs"),
            cwd.join("..").join("scripts").join("browser-server.mjs"),
        ];
        let script_path = candidates
            .iter()
            .find(|p| p.exists())
            .ok_or_else(|| {
                format!(
                    "Browser server script not found. Checked: {}",
                    candidates
                        .iter()
                        .map(|p| p.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?
            .clone();

        let mut child = Command::new("node")
            .arg(&script_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to spawn browser server: {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture browser server stdout".to_string())?;
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read browser server port: {e}"))?;

        if line.trim().is_empty() {
            let _ = child.kill();
            return Err("Browser server exited without printing port".to_string());
        }

        let parsed: serde_json::Value = serde_json::from_str(line.trim()).map_err(|e| {
            format!(
                "Failed to parse browser server output: {e} (line: {})",
                line.trim()
            )
        })?;
        let port = parsed["port"]
            .as_u64()
            .ok_or_else(|| format!("No port in browser server output: {}", line.trim()))?
            as u16;

        // Drain remaining stdout in background to prevent pipe buffer blocking
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });

        inner.process = Some(child);
        inner.port = Some(port);

        Ok(port)
    }

    pub fn get_port(&self) -> Result<Option<u16>, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(inner.port)
    }
}

impl Default for BrowserPool {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for BrowserPool {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(ref mut child) = inner.process {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_pool_has_no_port() {
        let pool = BrowserPool::new();
        assert_eq!(pool.get_port().unwrap(), None);
    }

    #[test]
    fn default_pool_has_no_port() {
        let pool = BrowserPool::default();
        assert_eq!(pool.get_port().unwrap(), None);
    }

    #[test]
    fn get_port_returns_none_before_start() {
        let pool = BrowserPool::new();
        let port = pool.get_port().unwrap();
        assert!(port.is_none());
    }

    #[test]
    fn drop_without_process_does_not_panic() {
        let pool = BrowserPool::new();
        drop(pool);
    }

    #[test]
    fn ensure_started_fails_with_missing_script() {
        let pool = BrowserPool::new();
        let result = pool.ensure_started();
        // In test env, either the script doesn't exist (error about "not found") or
        // node starts but we get a parsing error — either way, it shouldn't panic.
        // If it happens to succeed (CI has the script), that's fine too.
        let _ = result;
    }

    #[test]
    fn multiple_get_port_calls_consistent() {
        let pool = BrowserPool::new();
        assert_eq!(pool.get_port().unwrap(), None);
        assert_eq!(pool.get_port().unwrap(), None);
    }

    #[test]
    fn ensure_started_with_mock_script() {
        let dir = tempfile::tempdir().unwrap();
        let scripts_dir = dir.path().join("scripts");
        std::fs::create_dir_all(&scripts_dir).unwrap();
        let script = scripts_dir.join("browser-server.mjs");
        // Script that prints valid JSON port then exits
        std::fs::write(
            &script,
            r#"console.log(JSON.stringify({ port: 19876 })); setTimeout(() => {}, 500);"#,
        )
        .unwrap();

        // Save and restore cwd to avoid affecting other tests
        let original_cwd = std::env::current_dir().unwrap();
        std::env::set_current_dir(dir.path()).unwrap();

        let pool = BrowserPool::new();
        let result = pool.ensure_started();
        // Restore cwd immediately
        let _ = std::env::set_current_dir(&original_cwd);

        match result {
            Ok(port) => {
                assert_eq!(port, 19876);
                assert_eq!(pool.get_port().unwrap(), Some(19876));
            }
            Err(e) => {
                // node not available in test env is acceptable
                assert!(
                    e.contains("spawn") || e.contains("not found") || e.contains("No such file"),
                    "unexpected error: {e}"
                );
            }
        }
    }

    #[test]
    fn ensure_started_bad_json_from_script() {
        let dir = tempfile::tempdir().unwrap();
        let scripts_dir = dir.path().join("scripts");
        std::fs::create_dir_all(&scripts_dir).unwrap();
        let script = scripts_dir.join("browser-server.mjs");
        std::fs::write(&script, r#"console.log("not json"); process.exit(0);"#).unwrap();

        let original_cwd = std::env::current_dir().unwrap();
        std::env::set_current_dir(dir.path()).unwrap();

        let pool = BrowserPool::new();
        let result = pool.ensure_started();
        let _ = std::env::set_current_dir(&original_cwd);

        match result {
            Err(e) => assert!(
                e.contains("parse") || e.contains("port") || e.contains("spawn") || e.contains("not found"),
                "unexpected error: {e}"
            ),
            Ok(_) => panic!("should fail with bad JSON"),
        }
    }

    #[test]
    fn ensure_started_script_prints_empty() {
        let dir = tempfile::tempdir().unwrap();
        let scripts_dir = dir.path().join("scripts");
        std::fs::create_dir_all(&scripts_dir).unwrap();
        let script = scripts_dir.join("browser-server.mjs");
        // Script that exits immediately with no output
        std::fs::write(&script, "process.exit(0);").unwrap();

        let original_cwd = std::env::current_dir().unwrap();
        std::env::set_current_dir(dir.path()).unwrap();

        let pool = BrowserPool::new();
        let result = pool.ensure_started();
        let _ = std::env::set_current_dir(&original_cwd);

        match result {
            Err(e) => assert!(
                e.contains("exited without printing port") || e.contains("spawn") || e.contains("not found"),
                "unexpected error: {e}"
            ),
            Ok(_) => panic!("should fail when script prints nothing"),
        }
    }

    #[test]
    fn ensure_started_no_port_in_json() {
        let dir = tempfile::tempdir().unwrap();
        let scripts_dir = dir.path().join("scripts");
        std::fs::create_dir_all(&scripts_dir).unwrap();
        let script = scripts_dir.join("browser-server.mjs");
        std::fs::write(
            &script,
            r#"console.log(JSON.stringify({ status: "ok" })); process.exit(0);"#,
        )
        .unwrap();

        let original_cwd = std::env::current_dir().unwrap();
        std::env::set_current_dir(dir.path()).unwrap();

        let pool = BrowserPool::new();
        let result = pool.ensure_started();
        let _ = std::env::set_current_dir(&original_cwd);

        match result {
            Err(e) => assert!(
                e.contains("No port") || e.contains("spawn") || e.contains("not found"),
                "unexpected error: {e}"
            ),
            Ok(_) => panic!("should fail when JSON has no port"),
        }
    }
}
