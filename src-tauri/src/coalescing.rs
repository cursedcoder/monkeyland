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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty_pool::PtyPool;
    use crate::storage::WriteBatcher;

    #[test]
    fn new_creates_bus() {
        let _bus = CoalescingBus::new();
    }

    #[test]
    fn default_creates_bus() {
        let _bus = CoalescingBus::default();
    }

    #[test]
    fn tick_empty_pool_returns_empty_payload() {
        let bus = CoalescingBus::new();
        let pool = PtyPool::new();
        let dir = tempfile::tempdir().unwrap();
        let batcher = WriteBatcher::new(dir.path().to_path_buf());

        let result = bus.tick(&pool, &batcher).unwrap();
        assert!(result.sessions.is_empty());
    }

    #[test]
    fn tick_empty_pool_multiple_times() {
        let bus = CoalescingBus::new();
        let pool = PtyPool::new();
        let dir = tempfile::tempdir().unwrap();
        let batcher = WriteBatcher::new(dir.path().to_path_buf());

        for _ in 0..10 {
            let result = bus.tick(&pool, &batcher).unwrap();
            assert!(result.sessions.is_empty());
        }
    }

    #[test]
    fn next_seq_is_monotonic() {
        let a = next_seq();
        let b = next_seq();
        let c = next_seq();
        assert!(b > a);
        assert!(c > b);
    }

    #[test]
    fn next_seq_increments_by_one() {
        let a = next_seq();
        let b = next_seq();
        assert_eq!(b - a, 1);
    }

    #[test]
    fn now_us_returns_positive() {
        let ts = now_us();
        assert!(ts > 0);
    }

    #[test]
    fn now_us_is_monotonic() {
        let a = now_us();
        std::thread::sleep(std::time::Duration::from_millis(1));
        let b = now_us();
        assert!(b >= a);
    }

    #[test]
    fn batched_payload_default_is_empty() {
        let payload = BatchedPayload::default();
        assert!(payload.sessions.is_empty());
    }

    #[test]
    fn session_batch_default_has_no_chunk() {
        let batch = SessionBatch::default();
        assert!(batch.terminal_chunk.is_none());
    }

    #[test]
    fn batched_payload_serializes() {
        let mut sessions = HashMap::new();
        sessions.insert(
            "s1".to_string(),
            SessionBatch {
                terminal_chunk: Some("hello".to_string()),
            },
        );
        let payload = BatchedPayload { sessions };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("hello"));
        assert!(json.contains("s1"));
    }

    #[test]
    fn session_batch_serializes_none_chunk() {
        let batch = SessionBatch {
            terminal_chunk: None,
        };
        let json = serde_json::to_string(&batch).unwrap();
        assert!(json.contains("null"));
    }
}
