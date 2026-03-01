//! Per-session SQLite storage and meta DB.
//! Rule 3: Each session gets its own .db file. Never a single shared database.

use crate::pty_pool::PtyPool;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct MetaDb {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub name: String,
    pub created_ts_us: i64,
    pub status: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLayoutRow {
    pub session_id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub collapsed: bool,
    #[serde(default)]
    pub node_type: String,
    #[serde(default)]
    pub payload: String,
}

impl MetaDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
            .map_err(|e| e.to_string())?;
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_ts_us INTEGER NOT NULL,
                status TEXT NOT NULL,
                file_path TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS canvas_layout (
                session_id TEXT PRIMARY KEY,
                x REAL NOT NULL,
                y REAL NOT NULL,
                w REAL NOT NULL,
                h REAL NOT NULL,
                collapsed INTEGER NOT NULL,
                node_type TEXT DEFAULT 'agent',
                payload TEXT DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )
        .map_err(|e| e.to_string())?;
        // Migrate existing DBs: add columns if missing
        let has_node_type: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('canvas_layout') WHERE name='node_type'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if has_node_type == 0 {
            let _ = conn.execute(
                "ALTER TABLE canvas_layout ADD COLUMN node_type TEXT DEFAULT 'agent'",
                [],
            );
            let _ = conn.execute(
                "ALTER TABLE canvas_layout ADD COLUMN payload TEXT DEFAULT '{}'",
                [],
            );
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn save_canvas_layouts(&self, layouts: &[SessionLayoutRow]) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM canvas_layout", [])
            .map_err(|e| e.to_string())?;
        for l in layouts {
            tx.execute(
                "INSERT INTO canvas_layout (session_id, x, y, w, h, collapsed, node_type, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    l.session_id,
                    l.x,
                    l.y,
                    l.w,
                    l.h,
                    if l.collapsed { 1 } else { 0 },
                    l.node_type.as_str(),
                    l.payload.as_str(),
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_canvas_layouts(&self) -> Result<Vec<SessionLayoutRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT session_id, x, y, w, h, collapsed, COALESCE(node_type,'agent'), COALESCE(payload,'{}') FROM canvas_layout ORDER BY session_id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SessionLayoutRow {
                    session_id: row.get(0)?,
                    x: row.get(1)?,
                    y: row.get(2)?,
                    w: row.get(3)?,
                    h: row.get(4)?,
                    collapsed: row.get::<_, i64>(5)? != 0,
                    node_type: row.get(6)?,
                    payload: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Ensures sessions dir exists and inserts session into index if not present.
    /// Session DB path convention: `{config_dir}/sessions/{id}.db`.
    pub fn create_session_if_missing(
        &self,
        config_dir: &Path,
        id: &str,
        name: &str,
    ) -> Result<(), String> {
        let sessions_dir = config_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).map_err(|e| e.to_string())?;
        let file_path = format!("sessions/{}.db", id);
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_micros() as i64;
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, name, created_ts_us, status, file_path) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, name, now_us, "active", file_path],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionMeta>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, created_ts_us, status, file_path FROM sessions ORDER BY created_ts_us DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SessionMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_ts_us: row.get(2)?,
                    status: row.get(3)?,
                    file_path: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Get a value from app_settings. Returns None if key is missing.
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(value)
    }

    /// Set a value in app_settings (insert or replace).
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            [key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Per-session SQLite DB: events table + snapshots table.
pub struct SessionDb {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventRow {
    pub id: String,
    pub seq: i64,
    pub ts_us: i64,
    pub type_: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRow {
    pub seq_at: i64,
    pub ts_us: i64,
    pub terminal_buffer: String,
    pub browser_url: String,
    pub browser_screenshot_path: String,
    pub agent_phase: String,
}

impl SessionDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))
            .map_err(|e| e.to_string())?;
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS events (
                id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                ts_us INTEGER NOT NULL,
                type TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (seq)
            );
            CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_us);
            CREATE TABLE IF NOT EXISTS snapshots (
                seq_at INTEGER PRIMARY KEY,
                ts_us INTEGER NOT NULL,
                terminal_buffer TEXT NOT NULL,
                browser_url TEXT NOT NULL,
                browser_screenshot_path TEXT NOT NULL,
                agent_phase TEXT NOT NULL
            );
            ",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn insert_events(&self, events: &[EventRow]) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for e in events {
            tx.execute(
                "INSERT INTO events (id, seq, ts_us, type, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![e.id, e.seq, e.ts_us, e.type_, e.payload],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn insert_snapshot(&self, row: &SnapshotRow) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO snapshots (seq_at, ts_us, terminal_buffer, browser_url, browser_screenshot_path, agent_phase) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                row.seq_at,
                row.ts_us,
                row.terminal_buffer,
                row.browser_url,
                row.browser_screenshot_path,
                row.agent_phase,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn event_count(&self) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        Ok(count)
    }

    /// Max seq in events (0 if empty). Used for snapshot seq_at.
    pub fn max_seq(&self) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let max: Option<i64> = conn
            .query_row("SELECT MAX(seq) FROM events", [], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(max.unwrap_or(0))
    }

    /// Nearest snapshot at or before seq_at.
    pub fn get_snapshot_at(&self, seq_at: i64) -> Result<Option<SnapshotRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT seq_at, ts_us, terminal_buffer, browser_url, browser_screenshot_path, agent_phase FROM snapshots WHERE seq_at <= ?1 ORDER BY seq_at DESC LIMIT 1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params![seq_at])
            .map_err(|e| e.to_string())?;
        if let Ok(Some(row)) = rows.next() {
            return Ok(Some(SnapshotRow {
                seq_at: row.get(0).map_err(|e| e.to_string())?,
                ts_us: row.get(1).map_err(|e| e.to_string())?,
                terminal_buffer: row.get(2).map_err(|e| e.to_string())?,
                browser_url: row.get(3).map_err(|e| e.to_string())?,
                browser_screenshot_path: row.get(4).map_err(|e| e.to_string())?,
                agent_phase: row.get(5).map_err(|e| e.to_string())?,
            }));
        }
        Ok(None)
    }

    /// Events after seq_at, ordered by seq, limit N.
    pub fn events_after(&self, seq_at: i64, limit: usize) -> Result<Vec<EventRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, seq, ts_us, type, payload FROM events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![seq_at, limit as i64], |row| {
                Ok(EventRow {
                    id: row.get(0)?,
                    seq: row.get(1)?,
                    ts_us: row.get(2)?,
                    type_: row.get(3)?,
                    payload: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Log compaction: delete events before oldest retained snapshot. Keep last 20 snapshots (~10 min).
    pub fn compact(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let cutoff: Option<i64> = conn
            .query_row(
                "SELECT seq_at FROM snapshots ORDER BY seq_at DESC LIMIT 1 OFFSET 20",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(seq) = cutoff {
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM events WHERE seq < ?1", rusqlite::params![seq])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            conn.execute("VACUUM", []).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// Write batcher: accumulate events per session, flush every 100 ms as single transaction.
/// Snapshot manager: every 30 s or 500 events (whichever first) per session.
pub struct WriteBatcher {
    config_dir: PathBuf,
    buffers: Mutex<HashMap<String, Vec<EventRow>>>,
    session_dbs: Mutex<HashMap<String, SessionDb>>,
    /// Per session: (last_snapshot_seq, last_snapshot_ts_us)
    snapshot_state: Mutex<HashMap<String, (i64, i64)>>,
}

const FLUSH_INTERVAL_EVENTS: i64 = 500;
const SNAPSHOT_INTERVAL_US: i64 = 30_000_000; // 30 s

impl WriteBatcher {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            buffers: Mutex::new(HashMap::new()),
            session_dbs: Mutex::new(HashMap::new()),
            snapshot_state: Mutex::new(HashMap::new()),
        }
    }

    /// Queue an event for the given session. Session is created in meta if missing on first flush.
    pub fn push(&self, session_id: &str, event: EventRow) -> Result<(), String> {
        let mut buffers = self.buffers.lock().map_err(|e| e.to_string())?;
        buffers
            .entry(session_id.to_string())
            .or_default()
            .push(event);
        Ok(())
    }

    /// Flush all buffered events (one transaction per session) and run snapshot manager.
    pub fn flush(&self, meta_db: &MetaDb, pty_pool: Option<&PtyPool>) -> Result<(), String> {
        let now_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_micros() as i64;
        let mut buffers = self.buffers.lock().map_err(|e| e.to_string())?;
        let mut session_dbs = self.session_dbs.lock().map_err(|e| e.to_string())?;
        let session_ids: Vec<String> = buffers.keys().cloned().collect();
        for session_id in session_ids {
            let batch = match buffers.get_mut(&session_id) {
                Some(b) if !b.is_empty() => std::mem::take(b),
                _ => continue,
            };
            let db = match session_dbs.get_mut(&session_id) {
                Some(d) => d,
                None => {
                    meta_db.create_session_if_missing(
                        &self.config_dir,
                        &session_id,
                        &session_id,
                    )?;
                    let path = self
                        .config_dir
                        .join("sessions")
                        .join(format!("{}.db", session_id));
                    let db = SessionDb::open(&path)?;
                    session_dbs.insert(session_id.clone(), db);
                    session_dbs.get_mut(&session_id).unwrap()
                }
            };
            db.insert_events(&batch).map_err(|e| e.to_string())?;
        }
        drop(buffers);
        drop(session_dbs);

        // Snapshot manager: every 30 s or 500 events (whichever first)
        let mut session_dbs = self.session_dbs.lock().map_err(|e| e.to_string())?;
        let mut snapshot_state = self.snapshot_state.lock().map_err(|e| e.to_string())?;
        for (session_id, db) in session_dbs.iter_mut() {
            let max_seq = db.max_seq()?;
            let (last_seq, last_ts) = snapshot_state.entry(session_id.clone()).or_insert((0, 0));
            let need = (max_seq - *last_seq) >= FLUSH_INTERVAL_EVENTS
                || (now_us - *last_ts) >= SNAPSHOT_INTERVAL_US;
            if need && max_seq > 0 {
                let terminal_buffer = if let Some(pool) = pty_pool {
                    pool.get_buffer(session_id).unwrap_or_default()
                } else {
                    String::new()
                };

                let row = SnapshotRow {
                    seq_at: max_seq,
                    ts_us: now_us,
                    terminal_buffer,
                    browser_url: String::new(),
                    browser_screenshot_path: String::new(),
                    agent_phase: "idle".to_string(),
                };
                db.insert_snapshot(&row)?;
                *last_seq = max_seq;
                *last_ts = now_us;
            }
        }
        Ok(())
    }

    /// Close session: compact and remove from cache.
    pub fn close_session(&self, session_id: &str) -> Result<(), String> {
        let mut buffers = self.buffers.lock().map_err(|e| e.to_string())?;
        buffers.remove(session_id);
        let mut session_dbs = self.session_dbs.lock().map_err(|e| e.to_string())?;
        if let Some(db) = session_dbs.remove(session_id) {
            db.compact()?;
        }
        let mut snapshot_state = self.snapshot_state.lock().map_err(|e| e.to_string())?;
        snapshot_state.remove(session_id);
        Ok(())
    }

    pub fn get_terminal_buffer(&self, session_id: &str) -> Result<String, String> {
        let mut session_dbs = self.session_dbs.lock().map_err(|e| e.to_string())?;
        let db = match session_dbs.get_mut(session_id) {
            Some(d) => d,
            None => {
                let path = self
                    .config_dir
                    .join("sessions")
                    .join(format!("{}.db", session_id));
                if !path.exists() {
                    return Ok(String::new());
                }
                let db = SessionDb::open(&path)?;
                session_dbs.insert(session_id.to_string(), db);
                session_dbs.get_mut(session_id).unwrap()
            }
        };
        let max_seq = db.max_seq()?;
        let snap = db.get_snapshot_at(max_seq)?;
        Ok(snap.map(|s| s.terminal_buffer).unwrap_or_default())
    }
}
