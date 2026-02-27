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
