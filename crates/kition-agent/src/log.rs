//! The session event log: its key, the paged reader behind
//! `GET /agent/sessions/{id}/session-events`, the exchanges that do not run
//! a turn, and the one-time backfill of sessions from before the log.

use kition_harness::events::{ContentBlock, EventBody, SessionEvent};
use kition_harness::log::{SessionLog, SqliteLog};
use kition_store::Db;

use crate::run::Agent;
use crate::store::{self, AgentMessage};
use crate::table_plan;

/// The event log key of an agent session. `backfill` builds the same key
/// in SQL.
pub(crate) fn log_key(session_id: i64) -> String {
    format!("agent:{session_id}")
}

/// The most session events one page answers.
const EVENT_PAGE_LIMIT: usize = 500;

/// The most earlier messages a backfilled session keeps.
const BACKFILL_MESSAGES: usize = 16;

/// The session events after `after`, in order, at most one page, and the
/// cursor for the next page (the last seq returned, or `after`). Provider-
/// native items are dropped from `assistant/message`: they exist only to
/// replay the conversation to the provider and are not redacted (they can
/// repeat tool inputs and images verbatim).
pub(crate) fn read_events(
    log: &dyn SessionLog,
    session_id: i64,
    after: u64,
) -> Result<(Vec<SessionEvent>, u64), String> {
    let items: Vec<_> = log
        .read(&log_key(session_id))?
        .into_iter()
        .filter(|event| event.seq > after)
        .take(EVENT_PAGE_LIMIT)
        .map(|mut event| {
            if let EventBody::AssistantMessage { raw_items, .. } = &mut event.body {
                raw_items.clear();
            }
            event
        })
        .collect();
    let next_after = items.last().map_or(after, |event| event.seq);
    Ok((items, next_after))
}

fn user_message(text: &str) -> EventBody {
    EventBody::UserMessage {
        content: vec![ContentBlock::text(text)],
    }
}

fn assistant_message(text: &str) -> EventBody {
    EventBody::AssistantMessage {
        content: text.to_owned(),
        tool_calls: Vec::new(),
        stop_reason: String::new(),
        model: String::new(),
        raw_items: Vec::new(),
    }
}

/// Logs an exchange that ran without a turn (an image request) so later
/// turns see it. A failure is logged and the exchange stays out of history.
pub(crate) async fn record_exchange(agent: &Agent, session_id: i64, request: &str, reply: &str) {
    let log = SqliteLog::new(agent.db().clone());
    let (request, reply) = (request.to_owned(), reply.to_owned());
    let key = log_key(session_id);
    let appended = tokio::task::spawn_blocking(move || {
        log.append(&key, user_message(&request))?;
        log.append(&key, assistant_message(&reply))
    })
    .await;
    if !matches!(appended, Ok(Ok(_))) {
        tracing::warn!(session = session_id, "could not log the exchange");
    }
}

/// The conversation of `history` as the model sees it: user and assistant
/// messages only, with the table plan block stripped from assistant replies.
fn conversation(history: &[AgentMessage]) -> Vec<EventBody> {
    history
        .iter()
        .filter_map(|message| match message.role.as_str() {
            "user" => Some(user_message(&message.content)),
            "assistant" => Some(assistant_message(&table_plan::strip_block(
                &message.content,
            ))),
            _ => None,
        })
        .collect()
}

/// Gives every live session that has messages but no logged events its
/// last 16 messages as conversation, so turns keep their context. Sessions
/// with any event are skipped, so running it again appends nothing. Returns
/// how many sessions were backfilled.
pub(crate) fn backfill(db: &Db) -> Result<usize, String> {
    let histories = {
        let conn = db.conn().map_err(|error| error.to_string())?;
        let mut statement = conn
            .prepare(
                "SELECT s.id, s.user_id FROM agent_sessions s \
                 WHERE s.deleted_at IS NULL \
                 AND EXISTS (SELECT 1 FROM agent_messages m WHERE m.session_id = s.id) \
                 AND NOT EXISTS (SELECT 1 FROM agent_session_events e WHERE e.session_key = 'agent:' || s.id)",
            )
            .map_err(|error| error.to_string())?;
        let sessions = statement
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let mut histories = Vec::new();
        for (id, user) in sessions {
            let history = store::recent_messages(&conn, id, user, BACKFILL_MESSAGES)
                .map_err(|error| error.to_string())?;
            histories.push((id, conversation(&history)));
        }
        histories
    };
    let log = SqliteLog::new(db.clone());
    for (id, bodies) in &histories {
        for body in bodies {
            log.append(&log_key(*id), body.clone())?;
        }
    }
    Ok(histories.len())
}

#[cfg(test)]
mod tests {
    use kition_harness::log::MemoryLog;
    use serde_json::json;

    use super::*;

    #[test]
    fn session_events_are_paged_after_a_cursor() {
        let log = MemoryLog::default();
        for turn in 0..(EVENT_PAGE_LIMIT as u32 + 3) {
            log.append(&log_key(4), EventBody::TurnStart { turn })
                .unwrap_or_else(|error| panic!("{error}"));
        }
        log.append(&log_key(5), EventBody::TurnStart { turn: 1 })
            .unwrap_or_else(|error| panic!("{error}"));

        let (first, next) = read_events(&log, 4, 0).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(first.len(), EVENT_PAGE_LIMIT);
        assert_eq!(first.first().map(|event| event.seq), Some(1));
        assert_eq!(next, EVENT_PAGE_LIMIT as u64);
        let (rest, last) = read_events(&log, 4, next).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            rest.iter().map(|event| event.seq).collect::<Vec<_>>(),
            [501, 502, 503]
        );
        let (empty, same) = read_events(&log, 4, last).unwrap_or_else(|error| panic!("{error}"));
        assert!(empty.is_empty());
        assert_eq!(same, last);
        let (missing, cursor) = read_events(&log, 6, 0).unwrap_or_else(|error| panic!("{error}"));
        assert!(missing.is_empty());
        assert_eq!(cursor, 0);

        log.append(
            &log_key(6),
            EventBody::AssistantMessage {
                content: "done".into(),
                tool_calls: Vec::new(),
                stop_reason: String::new(),
                model: String::new(),
                raw_items: vec![json!({ "type": "provider_note", "note": "fake-secret" })],
            },
        )
        .unwrap_or_else(|error| panic!("{error}"));
        let (page, _) = read_events(&log, 6, 0).unwrap_or_else(|error| panic!("{error}"));
        assert!(matches!(
            &page[0].body,
            EventBody::AssistantMessage { raw_items, .. } if raw_items.is_empty()
        ));
        assert_eq!(log.read(&log_key(6)).map(|events| events.len()), Ok(1));
    }

    #[test]
    fn sessions_without_events_are_backfilled_once() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        kition_store::seed::run(&conn).unwrap_or_else(|err| panic!("{err}"));
        let mut ids = Vec::new();
        for title in ["old", "empty", "deleted"] {
            let session = store::new_session(1, title, "", "", "");
            ids.push(store::create(&conn, &session).unwrap_or_else(|err| panic!("{err}")));
        }
        let (old, empty, deleted) = (ids[0], ids[1], ids[2]);
        for (session_id, role, content) in [
            (old, "user", "first"),
            (old, "assistant", "reply"),
            (old, "tool", "ignored"),
            (deleted, "user", "gone"),
        ] {
            let session = crate::store::AgentSession {
                id: session_id,
                user_id: 1,
                ..Default::default()
            };
            store::insert_message(
                &conn,
                store::new_message(&session, role, content, json!({})),
            )
            .unwrap_or_else(|err| panic!("{err}"));
        }
        store::delete_session(&conn, deleted).unwrap_or_else(|err| panic!("{err}"));
        drop(conn);

        assert_eq!(backfill(&db), Ok(1));
        let log = SqliteLog::new(db.clone());
        let kinds = |id: i64| -> Vec<&'static str> {
            log.read(&log_key(id))
                .unwrap_or_else(|error| panic!("{error}"))
                .iter()
                .map(|event| event.body.kind())
                .collect()
        };
        assert_eq!(kinds(old), ["user/message", "assistant/message"]);
        assert!(kinds(empty).is_empty());
        assert!(kinds(deleted).is_empty());
        assert_eq!(backfill(&db), Ok(0), "a second backfill appends nothing");
        assert_eq!(kinds(old).len(), 2);
    }
}
