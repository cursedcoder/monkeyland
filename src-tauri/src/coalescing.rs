//! Coalescing event bus skeleton. Drains ring buffers at 16 ms tick into one batched payload.
//! Stage 3 will wire PTY ring buffers here; for now no-op.

use serde::Serialize;

/// Batched payload sent to UI (and later to write batcher) once per frame.
#[derive(Debug, Clone, Default, Serialize)]
pub struct BatchedPayload {
    /// Session id -> coalesced terminal/browser data. Empty until Stage 3.
    pub sessions: std::collections::HashMap<String, SessionBatch>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionBatch {
    pub terminal_chunk: Option<String>,
    // Stage 4: browser snapshot, etc.
}

/// Coalescing bus: drain all ring buffers every 16 ms into one batch.
/// Skeleton only — no PTY or ring buffers until Stage 3.
pub struct CoalescingBus;

impl CoalescingBus {
    pub fn new() -> Self {
        Self
    }

    /// Called every 16 ms (frame tick). Returns one batched payload for UI and storage.
    #[allow(clippy::unnecessary_wraps)]
    pub fn tick(&self) -> Result<BatchedPayload, String> {
        Ok(BatchedPayload::default())
    }
}

impl Default for CoalescingBus {
    fn default() -> Self {
        Self::new()
    }
}
