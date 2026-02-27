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

    /// Drain all accumulated data since last drain. Returns empty vec if nothing new.
    pub fn drain(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }
}

struct PtySession {
    ring: Arc<Mutex<RingBuffer>>,
    writer: Mutex<Box<dyn Write + Send>>,
    _master: Mutex<Box<dyn MasterPty + Send>>,
    cols: u16,
    rows: u16,
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

    /// Spawn a new PTY for the given session. Returns Err if pool is full or session already exists.
    pub fn spawn(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= MAX_SLOTS {
            return Err(format!("PTY pool full ({MAX_SLOTS} slots)"));
        }
        if sessions.contains_key(session_id) {
            return Err(format!("PTY already exists for session {session_id}"));
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

        pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let ring = Arc::new(Mutex::new(RingBuffer::new()));

        let session = Arc::new(PtySession {
            ring: Arc::clone(&ring),
            writer: Mutex::new(writer),
            _master: Mutex::new(pair.master),
            cols,
            rows,
        });

        sessions.insert(session_id.to_string(), Arc::clone(&session));

        // Reader thread: reads PTY output into ring buffer
        let ring_for_thread = Arc::clone(&ring);
        std::thread::spawn(move || {
            pty_reader_loop(reader, ring_for_thread);
        });

        Ok(())
    }

    /// Write data to a session's PTY (user input).
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

    /// Resize a session's PTY.
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

    /// Drain all ring buffers. Called by the coalescing bus every 16 ms.
    /// Returns session_id → data for sessions that have new output.
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

    /// Kill and remove a session PTY.
    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(session_id);
        Ok(())
    }
}

impl Default for PtyPool {
    fn default() -> Self {
        Self::new()
    }
}

fn pty_reader_loop(mut reader: Box<dyn Read + Send>, ring: Arc<Mutex<RingBuffer>>) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => {
                if let Ok(mut r) = ring.lock() {
                    r.push(&buf[..n]);
                }
            }
            Err(_) => break,
        }
    }
}
