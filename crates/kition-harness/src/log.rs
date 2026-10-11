//! The append-only session log. Sessions are keyed by a string such as
//! `agent:42`, so the harness does not depend on any one table.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use kition_core::now_millis;
use kition_store::Db;
use rusqlite::params;

use crate::events::{EventBody, SessionEvent};

/// Where session events live. Appends are ordered per session.
pub trait SessionLog: Send + Sync {
    /// Appends one event and returns it with its sequence number and time.
    fn append(&self, session: &str, body: EventBody) -> Result<SessionEvent, String>;
    /// Every event of the session in order; empty for an unknown session.
    fn read(&self, session: &str) -> Result<Vec<SessionEvent>, String>;
}

/// A log in memory, for tests and short-lived sessions.
#[derive(Default)]
pub struct MemoryLog {
    sessions: Mutex<HashMap<String, Vec<SessionEvent>>>,
}

impl SessionLog for MemoryLog {
    fn append(&self, session: &str, body: EventBody) -> Result<SessionEvent, String> {
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        let events = sessions.entry(session.to_owned()).or_default();
        let event = SessionEvent {
            seq: events.len() as u64 + 1,
            at: now_millis(),
            body,
        };
        events.push(event.clone());
        Ok(event)
    }

    fn read(&self, session: &str) -> Result<Vec<SessionEvent>, String> {
        let sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        Ok(sessions.get(session).cloned().unwrap_or_default())
    }
}

/// The durable log in the workspace database (`agent_session_events`).
pub struct SqliteLog {
    db: Db,
}

impl SqliteLog {
    pub fn new(db: Db) -> Self {
        Self { db }
    }
}

impl SessionLog for SqliteLog {
    fn append(&self, session: &str, body: EventBody) -> Result<SessionEvent, String> {
        let conn = self.db.conn().map_err(|error| error.to_string())?;
        let text = serde_json::to_string(&body).map_err(|error| error.to_string())?;
        let at = now_millis();
        let seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_session_events WHERE session_key = ?1",
                [session],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        conn.execute(
            "INSERT INTO agent_session_events (session_key, seq, event_type, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session, seq, body.kind(), text, at],
        )
        .map_err(|error| error.to_string())?;
        Ok(SessionEvent {
            seq: u64::try_from(seq).unwrap_or(0),
            at,
            body,
        })
    }

    fn read(&self, session: &str) -> Result<Vec<SessionEvent>, String> {
        let conn = self.db.conn().map_err(|error| error.to_string())?;
        let mut statement = conn
            .prepare("SELECT seq, created_at, body FROM agent_session_events WHERE session_key = ?1 ORDER BY seq")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([session], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut events = Vec::new();
        for row in rows {
            let (seq, at, text) = row.map_err(|error| error.to_string())?;
            let body: EventBody = serde_json::from_str(&text)
                .map_err(|error| format!("session `{session}` event {seq}: {error}"))?;
            events.push(SessionEvent {
                seq: u64::try_from(seq).unwrap_or(0),
                at,
                body,
            });
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_log_numbers_events_per_session() {
        let log = MemoryLog::default();
        let first = log
            .append("a", EventBody::TurnStart { turn: 1 })
            .unwrap_or_else(|error| panic!("{error}"));
        let second = log
            .append("a", EventBody::StepStart { turn: 1, step: 1 })
            .unwrap_or_else(|error| panic!("{error}"));
        let other = log
            .append("b", EventBody::TurnStart { turn: 1 })
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!((first.seq, second.seq, other.seq), (1, 2, 1));
        let events = log.read("a").unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            events
                .iter()
                .map(|event| event.body.kind())
                .collect::<Vec<_>>(),
            ["turn/start", "step/start"]
        );
        assert!(
            log.read("missing")
                .unwrap_or_else(|error| panic!("{error}"))
                .is_empty()
        );
    }

    #[test]
    fn sqlite_log_round_trips_events() {
        let db = kition_store::Db::open_in_memory().unwrap_or_else(|error| panic!("{error}"));
        let log = SqliteLog::new(db);
        log.append("agent:1", EventBody::TurnStart { turn: 1 })
            .unwrap_or_else(|error| panic!("{error}"));
        let body = EventBody::UserMessage {
            content: vec![crate::events::ContentBlock::text("hi")],
        };
        let appended = log
            .append("agent:1", body.clone())
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(appended.seq, 2);
        let events = log
            .read("agent:1")
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].body, body);
        assert!(
            log.read("agent:2")
                .unwrap_or_else(|error| panic!("{error}"))
                .is_empty()
        );
    }
}
