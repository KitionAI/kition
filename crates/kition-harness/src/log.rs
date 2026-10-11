//! The append-only session log. Sessions are keyed by a string such as
//! `agent:42`, so the harness does not depend on any one table.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use kition_core::now_millis;

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
}
