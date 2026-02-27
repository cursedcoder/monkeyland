//! Coalescing event bus. Drains PTY ring buffers at 16 ms tick into one batched Tauri event.
//! Rule 5: one IPC call per frame for all sessions.

use crate::pty_pool::PtyPool;
use crate::storage::{EventRow, WriteBatcher};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};

/// Batched payload sent to UI once per frame via Tauri event.
#[derive(Debug, Clone, Default, Serialize)]
pub struct BatchedPayload {
    pub sessions: HashMap<String, SessionBatch>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionBatch {
    pub terminal_chunk: Option<String>,
}

/// Global monotonic sequence counter for events across all sessions.
static GLOBAL_SEQ: AtomicI64 = AtomicI64::new(1);

fn next_seq() -> i64 {
    GLOBAL_SEQ.fetch_add(1, Ordering::Relaxed)
}

fn now_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as i64
}

/// Coalescing bus: drain all ring buffers every 16 ms, build one batched payload.
pub struct CoalescingBus;

impl CoalescingBus {
    pub fn new() -> Self {
        Self
    }

    /// Called every 16 ms. Drains PTY ring buffers, feeds storage, returns payload for UI.
    pub fn tick(
        &self,
        pty_pool: &PtyPool,
        write_batcher: &WriteBatcher,
    ) -> Result<BatchedPayload, String> {
        let drained = pty_pool.drain_all()?;
        if drained.is_empty() {
            return Ok(BatchedPayload::default());
        }

        let ts = now_us();
        let mut sessions = HashMap::new();

        for (session_id, data) in drained {
            let chunk = String::from_utf8_lossy(&data).into_owned();

            let event = EventRow {
                id: ulid::Ulid::new().to_string(),
                seq: next_seq(),
                ts_us: ts,
                type_: "terminal_chunk".to_string(),
                payload: serde_json::json!({ "data": &chunk, "bytes": data.len() }).to_string(),
            };
            let _ = write_batcher.push(&session_id, event);

            sessions.insert(
                session_id,
                SessionBatch {
                    terminal_chunk: Some(chunk),
                },
            );
        }

        Ok(BatchedPayload { sessions })
    }
}

impl Default for CoalescingBus {
    fn default() -> Self {
        Self::new()
    }
}
