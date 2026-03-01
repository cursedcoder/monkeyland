//! PTY pool with per-session ring buffers.
//! Rule 1: PTYs live in Rust (portable-pty), never in Node.
//! Rule 5: 64 KB ring buffer per session; coalescing bus drains all buffers every 16 ms.

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

const RING_BUFFER_CAP: usize = 65536; // 64 KB
const MAX_SLOTS: usize = 20;

/// Fixed-size ring buffer that overwrites old data on overflow.
pub struct RingBuffer {
    buf: Vec<u8>,
}

impl RingBuffer {
    fn new() -> Self {
        Self {
            buf: Vec::with_capacity(RING_BUFFER_CAP),
        }
    }

    fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
        if self.buf.len() > RING_BUFFER_CAP {
            let excess = self.buf.len() - RING_BUFFER_CAP;
            self.buf.drain(..excess);
        }
    }

    pub fn drain(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }

    pub fn peek(&self) -> Vec<u8> {
        self.buf.clone()
    }
}

struct PtySession {
    ring: Arc<Mutex<RingBuffer>>,
    /// Accumulator for tool-exec results. Separate from ring buffer so UI
    /// streaming and tool output capture work independently.
    output_acc: Arc<Mutex<Vec<u8>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    _master: Mutex<Box<dyn MasterPty + Send>>,
}

pub struct PtyPool {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl PtyPool {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Spawn a PTY for the given session. If `cwd` is Some, the shell starts in that directory
    /// (e.g. project root or agent worktree with .beads/redirect for Beads CLI).
    pub fn spawn(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        cwd: Option<&std::path::Path>,
    ) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= MAX_SLOTS {
            return Err(format!("PTY pool full ({MAX_SLOTS} slots)"));
        }
        if sessions.contains_key(session_id) {
            return Ok(());
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        if let Some(dir) = cwd {
            if dir.is_dir() {
                cmd.cwd(dir);
            }
        }

        pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let ring = Arc::new(Mutex::new(RingBuffer::new()));
        let output_acc = Arc::new(Mutex::new(Vec::<u8>::new()));

        let session = Arc::new(PtySession {
            ring: Arc::clone(&ring),
            output_acc: Arc::clone(&output_acc),
            writer: Mutex::new(writer),
            _master: Mutex::new(pair.master),
        });

        sessions.insert(session_id.to_string(), Arc::clone(&session));

        let ring_for_thread = Arc::clone(&ring);
        let acc_for_thread = Arc::clone(&output_acc);
        std::thread::spawn(move || {
            pty_reader_loop(reader, ring_for_thread, acc_for_thread);
        });

        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("No PTY for session {session_id}"))?;
        let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
        writer.write_all(data).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("No PTY for session {session_id}"))?;
        let master = session._master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Kill the session: signal the PTY's process group (so all child processes
    /// like dev servers are terminated), then remove the session and drop the master.
    /// On non-Unix we only remove the session (closing the master may still tear down the shell).
    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.remove(session_id);
        if let Some(session) = session {
            if let Ok(master) = session._master.lock() {
                #[cfg(unix)]
                if let Some(pgid) = master.process_group_leader() {
                    let _ = std::process::Command::new("kill")
                        .args(["-9", &format!("-{}", pgid)])
                        .status();
                }
            }
        }
        Ok(())
    }

    /// Clear the output accumulator and write a command, returning the
    /// accumulator Arc so the caller can poll it across await points.
    pub fn exec_command(
        &self,
        session_id: &str,
        command: &str,
    ) -> Result<Arc<Mutex<Vec<u8>>>, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("No PTY for session {session_id}"))?;

        // Clear accumulator
        {
            let mut acc = session.output_acc.lock().map_err(|e| e.to_string())?;
            acc.clear();
        }

        // Write command + newline
        {
            let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
            writer
                .write_all(format!("{command}\n").as_bytes())
                .map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
        }

        Ok(Arc::clone(&session.output_acc))
    }

    pub fn drain_all(&self) -> Result<HashMap<String, Vec<u8>>, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let mut out = HashMap::new();
        for (id, session) in sessions.iter() {
            if let Ok(mut ring) = session.ring.lock() {
                let data = ring.drain();
                if !data.is_empty() {
                    out.insert(id.clone(), data);
                }
            }
        }
        Ok(out)
    }

    pub fn get_buffer(&self, session_id: &str) -> Result<String, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("No PTY for session {session_id}"))?;
        let mut ring = session.ring.lock().map_err(|e| e.to_string())?;
        let data = ring.peek();
        Ok(String::from_utf8_lossy(&data).into_owned())
    }
}

impl Default for PtyPool {
    fn default() -> Self {
        Self::new()
    }
}

fn pty_reader_loop(
    mut reader: Box<dyn Read + Send>,
    ring: Arc<Mutex<RingBuffer>>,
    output_acc: Arc<Mutex<Vec<u8>>>,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                if let Ok(mut r) = ring.lock() {
                    r.push(chunk);
                }
                if let Ok(mut acc) = output_acc.lock() {
                    acc.extend_from_slice(chunk);
                }
            }
            Err(_) => break,
        }
    }
}
