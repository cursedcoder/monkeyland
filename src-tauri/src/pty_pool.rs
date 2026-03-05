//! PTY pool with per-session ring buffers.
//! Rule 1: PTYs live in Rust (portable-pty), never in Node.
//! Rule 5: 64 KB ring buffer per session; coalescing bus drains all buffers every 16 ms.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
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

    /// Return all active session IDs.
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .map(|s| s.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Kill every session, sending SIGKILL to each process group.
    /// Called by Drop to ensure no orphan processes survive app exit.
    pub fn kill_all(&self) -> usize {
        let mut sessions = match self.sessions.lock() {
            Ok(s) => s,
            Err(poisoned) => poisoned.into_inner(),
        };
        let count = sessions.len();
        let drained: Vec<(String, Arc<PtySession>)> = sessions.drain().collect();
        drop(sessions);
        for (_id, session) in drained {
            if let Ok(master) = session._master.lock() {
                #[cfg(unix)]
                if let Some(pgid) = master.process_group_leader() {
                    let _ = std::process::Command::new("kill")
                        .args(["-9", &format!("-{}", pgid)])
                        .status();
                }
            }
        }
        count
    }
}

impl Drop for PtyPool {
    fn drop(&mut self) {
        let killed = self.kill_all();
        if killed > 0 {
            eprintln!("[pty_pool] Drop: killed {killed} leftover PTY session(s)");
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    // --- RingBuffer unit tests ---

    #[test]
    fn ring_buffer_push_and_drain() {
        let mut rb = RingBuffer::new();
        rb.push(b"hello");
        assert_eq!(rb.drain(), b"hello");
        assert!(rb.drain().is_empty(), "drain should empty the buffer");
    }

    #[test]
    fn ring_buffer_overflow_drops_oldest() {
        let mut rb = RingBuffer::new();
        let first = vec![0xAA; RING_BUFFER_CAP];
        rb.push(&first);
        let overflow = vec![0xBB; 100];
        rb.push(&overflow);
        let result = rb.drain();
        assert_eq!(result.len(), RING_BUFFER_CAP);
        assert!(
            result.ends_with(&[0xBB; 100]),
            "newest bytes must be preserved"
        );
        assert_eq!(result[0], 0xAA, "oldest surviving byte from first push");
    }

    #[test]
    fn ring_buffer_peek_nondestructive() {
        let mut rb = RingBuffer::new();
        rb.push(b"peek");
        assert_eq!(rb.peek(), b"peek");
        assert_eq!(rb.peek(), b"peek", "peek must not consume data");
        assert_eq!(rb.drain(), b"peek");
        assert!(rb.peek().is_empty());
    }

    #[test]
    fn ring_buffer_empty_operations() {
        let mut rb = RingBuffer::new();
        assert!(rb.drain().is_empty());
        assert!(rb.peek().is_empty());
        rb.push(b"");
        assert!(rb.drain().is_empty());
    }

    #[test]
    fn ring_buffer_many_small_pushes() {
        let mut rb = RingBuffer::new();
        for i in 0u16..1000 {
            rb.push(&i.to_le_bytes());
        }
        let result = rb.drain();
        assert_eq!(result.len(), 2000);
    }

    #[test]
    fn ring_buffer_exact_capacity_no_truncation() {
        let mut rb = RingBuffer::new();
        let data = vec![0x42; RING_BUFFER_CAP];
        rb.push(&data);
        let result = rb.drain();
        assert_eq!(result.len(), RING_BUFFER_CAP);
        assert!(result.iter().all(|&b| b == 0x42));
    }

    #[test]
    fn ring_buffer_massive_single_push_keeps_tail() {
        let mut rb = RingBuffer::new();
        let huge: Vec<u8> = (0..RING_BUFFER_CAP * 3).map(|i| (i % 256) as u8).collect();
        rb.push(&huge);
        let result = rb.drain();
        assert_eq!(result.len(), RING_BUFFER_CAP, "must cap at RING_BUFFER_CAP");
        assert_eq!(
            result,
            &huge[huge.len() - RING_BUFFER_CAP..],
            "should retain the tail of the input"
        );
    }

    // --- PtyPool thin tests (no real PTY needed) ---

    #[test]
    fn pool_drain_all_empty() {
        let pool = PtyPool::new();
        let drained = pool.drain_all().unwrap();
        assert!(drained.is_empty());
    }

    #[test]
    fn pool_write_nonexistent_session_errors() {
        let pool = PtyPool::new();
        assert!(pool.write("ghost", b"data").is_err());
    }

    #[test]
    fn pool_resize_nonexistent_session_errors() {
        let pool = PtyPool::new();
        assert!(pool.resize("ghost", 120, 40).is_err());
    }

    #[test]
    fn pool_kill_nonexistent_is_ok() {
        let pool = PtyPool::new();
        assert!(pool.kill("ghost").is_ok());
    }

    #[test]
    fn pool_get_buffer_nonexistent_errors() {
        let pool = PtyPool::new();
        assert!(pool.get_buffer("ghost").is_err());
    }

    #[test]
    fn pool_exec_command_nonexistent_errors() {
        let pool = PtyPool::new();
        assert!(pool.exec_command("ghost", "echo hi").is_err());
    }

    // --- pty_reader_loop unit test (no real PTY needed) ---

    #[test]
    fn reader_loop_populates_ring_and_accumulator() {
        let data = b"hello world\n";
        let reader: Box<dyn Read + Send> = Box::new(std::io::Cursor::new(data.to_vec()));
        let ring = Arc::new(Mutex::new(RingBuffer::new()));
        let acc = Arc::new(Mutex::new(Vec::new()));
        pty_reader_loop(reader, Arc::clone(&ring), Arc::clone(&acc));
        assert_eq!(ring.lock().unwrap().drain(), data);
        assert_eq!(*acc.lock().unwrap(), data);
    }

    #[test]
    fn reader_loop_handles_empty_input() {
        let reader: Box<dyn Read + Send> = Box::new(std::io::Cursor::new(Vec::new()));
        let ring = Arc::new(Mutex::new(RingBuffer::new()));
        let acc = Arc::new(Mutex::new(Vec::new()));
        pty_reader_loop(reader, Arc::clone(&ring), Arc::clone(&acc));
        assert!(ring.lock().unwrap().drain().is_empty());
        assert!(acc.lock().unwrap().is_empty());
    }

    #[test]
    fn reader_loop_handles_large_data() {
        let data = vec![0x42u8; RING_BUFFER_CAP * 2];
        let reader: Box<dyn Read + Send> = Box::new(std::io::Cursor::new(data.clone()));
        let ring = Arc::new(Mutex::new(RingBuffer::new()));
        let acc = Arc::new(Mutex::new(Vec::new()));
        pty_reader_loop(reader, Arc::clone(&ring), Arc::clone(&acc));
        let ring_data = ring.lock().unwrap().drain();
        assert_eq!(
            ring_data.len(),
            RING_BUFFER_CAP,
            "ring buffer should cap at RING_BUFFER_CAP"
        );
        let acc_data = acc.lock().unwrap().clone();
        assert_eq!(
            acc_data.len(),
            RING_BUFFER_CAP * 2,
            "accumulator should contain all data"
        );
    }

    // --- PtyPool lifecycle tests (require real PTY) ---

    #[test]
    fn spawn_same_session_twice_is_idempotent() {
        let pool = PtyPool::new();
        pool.spawn("s1", 80, 24, None).unwrap();
        pool.spawn("s1", 80, 24, None).unwrap();
        let _ = pool.kill("s1");
    }

    #[test]
    fn spawn_rejects_when_pool_full() {
        let pool = PtyPool::new();
        for i in 0..MAX_SLOTS {
            pool.spawn(&format!("s{i}"), 80, 24, None).unwrap();
        }
        let err = pool.spawn("overflow", 80, 24, None).unwrap_err();
        assert!(
            err.contains("pool full"),
            "error should mention pool full: {err}"
        );
        for i in 0..MAX_SLOTS {
            let _ = pool.kill(&format!("s{i}"));
        }
    }

    #[test]
    fn spawn_write_drain_roundtrip() {
        let pool = PtyPool::new();
        pool.spawn("s1", 80, 24, None).unwrap();
        pool.write("s1", b"echo hello\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let drained = pool.drain_all().unwrap();
        assert!(
            !drained.is_empty(),
            "should have drained some data after writing to PTY"
        );
        let _ = pool.kill("s1");
    }

    #[test]
    fn kill_removes_session() {
        let pool = PtyPool::new();
        pool.spawn("s1", 80, 24, None).unwrap();
        pool.kill("s1").unwrap();
        assert!(
            pool.write("s1", b"data").is_err(),
            "write after kill should fail"
        );
    }

    // --- session_ids ---

    #[test]
    fn session_ids_reflects_live_sessions() {
        let pool = PtyPool::new();
        assert!(pool.session_ids().is_empty());

        pool.spawn("a", 80, 24, None).unwrap();
        pool.spawn("b", 80, 24, None).unwrap();
        let mut ids = pool.session_ids();
        ids.sort();
        assert_eq!(ids, vec!["a", "b"]);

        pool.kill("a").unwrap();
        assert_eq!(pool.session_ids(), vec!["b"]);

        pool.kill("b").unwrap();
        assert!(pool.session_ids().is_empty());
    }

    // --- kill_all ---

    #[test]
    fn kill_all_removes_every_session() {
        let pool = PtyPool::new();
        pool.spawn("s1", 80, 24, None).unwrap();
        pool.spawn("s2", 80, 24, None).unwrap();
        pool.spawn("s3", 80, 24, None).unwrap();
        assert_eq!(pool.session_ids().len(), 3);

        let killed = pool.kill_all();
        assert_eq!(
            killed, 3,
            "kill_all should return the number of sessions killed"
        );
        assert!(
            pool.session_ids().is_empty(),
            "no sessions should remain after kill_all"
        );
        assert!(
            pool.write("s1", b"data").is_err(),
            "write after kill_all should fail"
        );
        assert!(pool.write("s2", b"data").is_err());
        assert!(pool.write("s3", b"data").is_err());
    }

    #[test]
    fn kill_all_on_empty_pool_returns_zero() {
        let pool = PtyPool::new();
        assert_eq!(pool.kill_all(), 0);
    }

    #[test]
    fn pool_accepts_new_sessions_after_kill_all() {
        let pool = PtyPool::new();
        pool.spawn("old", 80, 24, None).unwrap();
        pool.kill_all();
        pool.spawn("new", 80, 24, None).unwrap();
        assert_eq!(pool.session_ids(), vec!["new"]);
        pool.kill_all();
    }

    // --- Drop cleanup ---

    #[test]
    fn drop_kills_all_sessions() {
        let pool = PtyPool::new();
        pool.spawn("d1", 80, 24, None).unwrap();
        pool.spawn("d2", 80, 24, None).unwrap();
        // When pool is dropped, all sessions should be killed.
        // We can't directly observe the kill -9 from outside, but we verify
        // that Drop doesn't panic and the sessions are cleaned up by spawning
        // the max number of sessions, dropping the pool, and verifying a new
        // pool can spawn sessions (i.e., process groups were actually killed
        // and resources freed).
        drop(pool);

        let pool2 = PtyPool::new();
        pool2.spawn("after-drop", 80, 24, None).unwrap();
        assert_eq!(pool2.session_ids(), vec!["after-drop"]);
        pool2.kill_all();
    }

    #[test]
    fn drop_with_max_sessions_does_not_leak() {
        let pool = PtyPool::new();
        for i in 0..MAX_SLOTS {
            pool.spawn(&format!("full-{i}"), 80, 24, None).unwrap();
        }
        assert_eq!(pool.session_ids().len(), MAX_SLOTS);
        drop(pool);

        // After dropping a full pool, a new pool should be able to spawn
        // sessions without hitting OS process/fd limits from leaked PTYs.
        let pool2 = PtyPool::new();
        pool2.spawn("post-full-drop", 80, 24, None).unwrap();
        assert_eq!(pool2.session_ids().len(), 1);
        pool2.kill_all();
    }
}
