//! The session event log: its key and the paged reader behind
//! `GET /agent/sessions/{id}/session-events`.

use kition_harness::events::{EventBody, SessionEvent};
use kition_harness::log::SessionLog;

/// The event log key of an agent session.
pub(crate) fn log_key(session_id: i64) -> String {
    format!("agent:{session_id}")
}

/// The most session events one page answers.
const EVENT_PAGE_LIMIT: usize = 500;

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
}
