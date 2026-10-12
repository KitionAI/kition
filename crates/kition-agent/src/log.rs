//! The session event log: its key, the paged reader behind
//! `GET /agent/sessions/{id}/session-events`, and what the agent reads back
//! from it (deliverables).

use kition_harness::events::{EventBody, SessionEvent};
use kition_harness::log::SessionLog;

/// The event log key of an agent session.
pub(crate) fn log_key(session_id: i64) -> String {
    format!("agent:{session_id}")
}

/// The whole log of a session, read off the async executor.
pub(crate) async fn read_session(
    agent: &crate::run::Agent,
    session_id: i64,
) -> Result<Vec<SessionEvent>, String> {
    let log = kition_harness::log::SqliteLog::new(agent.db().clone());
    let key = log_key(session_id);
    tokio::task::spawn_blocking(move || log.read(&key))
        .await
        .map_err(|_| "failed to read the session log".to_owned())?
}

/// The most session events one page answers.
const EVENT_PAGE_LIMIT: usize = 500;

/// An event as clients see it: provider-native items are dropped from
/// `assistant/message`. They exist only to replay the conversation to the
/// provider and are not redacted (they can repeat tool inputs and images
/// verbatim).
pub(crate) fn public(mut event: SessionEvent) -> SessionEvent {
    if let EventBody::AssistantMessage { raw_items, .. } = &mut event.body {
        raw_items.clear();
    }
    event
}

/// The session events after `after`, in order, at most one page, and the
/// cursor for the next page (the last seq returned, or `after`), as
/// `public` shows them.
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
        .map(public)
        .collect();
    let next_after = items.last().map_or(after, |event| event.seq);
    Ok((items, next_after))
}

/// Whether `path` names an image by its extension.
pub(crate) fn is_image_path(path: &str) -> bool {
    matches!(
        crate::workspace::extension(path).as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg")
    )
}

/// The paths of the newest `limit` delivered files that pass `keep`, newest
/// first and without repeats; `since_turn` limits them to that turn and
/// later.
pub(crate) fn recent_deliverables(
    events: &[SessionEvent],
    since_turn: u32,
    limit: usize,
    keep: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for event in events.iter().rev() {
        let EventBody::DeliverablesPresented { turn, files, .. } = &event.body else {
            continue;
        };
        if *turn < since_turn {
            continue;
        }
        for file in files.iter().rev() {
            if paths.len() < limit && keep(&file.path) && !paths.contains(&file.path) {
                paths.push(file.path.clone());
            }
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use kition_harness::events::PresentedFile;
    use kition_harness::log::MemoryLog;
    use serde_json::json;

    use super::*;

    fn presented(seq: u64, turn: u32, paths: &[&str]) -> SessionEvent {
        SessionEvent {
            seq,
            at: 0,
            body: EventBody::DeliverablesPresented {
                turn,
                call_id: format!("c{seq}"),
                files: paths
                    .iter()
                    .map(|path| PresentedFile {
                        path: (*path).to_owned(),
                        description: String::new(),
                    })
                    .collect(),
            },
        }
    }

    #[test]
    fn recent_deliverables_are_newest_first_and_filtered() {
        let events = [
            presented(1, 1, &["a.png", "Notes/a.md"]),
            presented(2, 2, &["b.png", "c.jpg"]),
            presented(3, 3, &["b.png", "Notes/b.md"]),
        ];
        assert_eq!(
            recent_deliverables(&events, 0, 3, is_image_path),
            ["b.png", "c.jpg", "a.png"]
        );
        assert_eq!(
            recent_deliverables(&events, 0, 2, is_image_path),
            ["b.png", "c.jpg"]
        );
        let editable = |path: &str| crate::tools::documents::is_editable_document(path);
        assert_eq!(recent_deliverables(&events, 0, 1, editable), ["Notes/b.md"]);
        assert_eq!(
            recent_deliverables(&events, 2, 5, editable),
            ["Notes/b.md"],
            "only turns from 2 on"
        );
        assert!(recent_deliverables(&events[..2], 2, 1, editable).is_empty());
        assert!(is_image_path("x/Y.PNG"));
        assert!(!is_image_path("x/y.md"));
    }

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
