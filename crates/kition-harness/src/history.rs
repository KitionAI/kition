//! Which logged events a request carries: recent turns in full, older turns
//! as plain conversation, like the original loop's last 16 messages.

use crate::events::{EventBody, SessionEvent};

/// How much history a request carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryBudget {
    /// The newest turns sent in full, the current turn included.
    pub full_turns: usize,
    /// At most this many user messages and assistant text replies from
    /// older turns, newest kept.
    pub older_messages: usize,
}

impl Default for HistoryBudget {
    fn default() -> Self {
        Self {
            full_turns: 3,
            older_messages: 16,
        }
    }
}

/// The events a request is derived from under `budget`. The newest
/// `full_turns` turns are kept whole (`full_turns == 0` keeps everything
/// since the first turn, so the current turn is never dropped). Before them
/// only real conversation survives: the person's message (the first
/// `user/message` after each `turn/start`; later ones are recovery context
/// or hosted follow-ups), assistant text replies without tool calls, and
/// every user message and text reply logged before the first `turn/start`
/// (carried over from the original loop). At most `older_messages` of them
/// are kept, newest first, plus the newest older system message.
pub fn bound_history(events: &[SessionEvent], budget: HistoryBudget) -> Vec<SessionEvent> {
    let starts: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| matches!(event.body, EventBody::TurnStart { .. }))
        .map(|(index, _)| index)
        .collect();
    let first = starts.first().copied().unwrap_or(events.len());
    let full_from = if budget.full_turns == 0 {
        first
    } else {
        starts
            .len()
            .checked_sub(budget.full_turns)
            .and_then(|index| starts.get(index).copied())
            .unwrap_or(first)
    };
    let (older, recent) = events.split_at(full_from);
    // Before any `turn/start` every user message is the person's.
    let mut awaiting_person = true;
    let mut in_turn = false;
    let conversation: Vec<usize> = older
        .iter()
        .enumerate()
        .filter(|(_, event)| match &event.body {
            EventBody::TurnStart { .. } => {
                in_turn = true;
                awaiting_person = true;
                false
            }
            EventBody::UserMessage { .. } => {
                let person = awaiting_person;
                awaiting_person = !in_turn;
                person
            }
            EventBody::AssistantMessage {
                tool_calls,
                content,
                ..
            } => tool_calls.is_empty() && !content.is_empty(),
            _ => false,
        })
        .map(|(index, _)| index)
        .collect();
    let skip = conversation.len().saturating_sub(budget.older_messages);
    let conversation = conversation.get(skip..).unwrap_or_default();
    let system = older
        .iter()
        .rposition(|event| matches!(event.body, EventBody::SystemMessage { .. }));
    // One pass in log order: no re-sorting needed.
    let mut kept: Vec<SessionEvent> = older
        .iter()
        .enumerate()
        .filter(|(index, _)| Some(*index) == system || conversation.binary_search(index).is_ok())
        .map(|(_, event)| event.clone())
        .collect();
    kept.extend(recent.iter().cloned());
    kept
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::events::{ContentBlock, LoggedCall, TurnEndReason};

    fn at(seq: u64, body: EventBody) -> SessionEvent {
        SessionEvent { seq, at: 0, body }
    }

    fn turn(seq: &mut u64, number: u32, text: &str) -> Vec<SessionEvent> {
        let mut next = |body| {
            *seq += 1;
            at(*seq, body)
        };
        vec![
            next(EventBody::TurnStart { turn: number }),
            next(EventBody::UserMessage {
                content: vec![ContentBlock::text(format!("ask {text}"))],
            }),
            next(EventBody::AssistantMessage {
                content: String::new(),
                tool_calls: vec![LoggedCall {
                    call_id: format!("c{number}"),
                    name: "read".into(),
                    arguments: json!({}),
                }],
                stop_reason: "tool_use".into(),
                model: "m".into(),
                raw_items: Vec::new(),
            }),
            next(EventBody::ToolCall {
                call_id: format!("c{number}"),
                name: "read".into(),
                arguments: json!({}),
            }),
            next(EventBody::ToolResult {
                call_id: format!("c{number}"),
                name: "read".into(),
                value: json!({}),
                content: vec![ContentBlock::text("data")],
                is_error: false,
                meta: None,
            }),
            next(EventBody::AssistantMessage {
                content: format!("answer {text}"),
                tool_calls: Vec::new(),
                stop_reason: "stop".into(),
                model: "m".into(),
                raw_items: Vec::new(),
            }),
            next(EventBody::TurnEnd {
                turn: number,
                reason: TurnEndReason::Completed,
                error: String::new(),
            }),
        ]
    }

    #[test]
    fn older_turns_keep_only_their_conversation() {
        let mut seq = 0;
        let mut events = vec![at(
            0,
            EventBody::SystemMessage {
                content: "sys".into(),
            },
        )];
        for number in 1..=4 {
            events.extend(turn(&mut seq, number, &number.to_string()));
        }
        let kept = bound_history(
            &events,
            HistoryBudget {
                full_turns: 2,
                older_messages: 16,
            },
        );
        let kinds: Vec<&str> = kept.iter().map(|event| event.body.kind()).collect();
        assert_eq!(
            kinds.iter().filter(|kind| **kind == "tool/result").count(),
            2
        );
        assert_eq!(
            kinds.iter().filter(|kind| **kind == "turn/start").count(),
            2
        );
        assert_eq!(kinds[0], "system/message");
        let texts: Vec<String> = kept
            .iter()
            .filter_map(|event| match &event.body {
                EventBody::AssistantMessage {
                    content,
                    tool_calls,
                    ..
                } if tool_calls.is_empty() => Some(content.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, ["answer 1", "answer 2", "answer 3", "answer 4"]);
    }

    #[test]
    fn older_conversation_is_capped_newest_first() {
        let mut seq = 0;
        let mut events = Vec::new();
        for number in 1..=10 {
            events.extend(turn(&mut seq, number, &number.to_string()));
        }
        let kept = bound_history(
            &events,
            HistoryBudget {
                full_turns: 1,
                older_messages: 4,
            },
        );
        let older_users: Vec<String> = kept
            .iter()
            .take_while(|event| !matches!(event.body, EventBody::TurnStart { turn: 10 }))
            .filter_map(|event| match &event.body {
                EventBody::UserMessage { content } => match &content[0] {
                    ContentBlock::Text { text } => Some(text.clone()),
                    ContentBlock::Image { .. } => None,
                },
                _ => None,
            })
            .collect();
        assert_eq!(older_users, ["ask 8", "ask 9"]);
    }

    #[test]
    fn older_turns_keep_the_persons_message_not_recovery_context() {
        let user = |text: &str| EventBody::UserMessage {
            content: vec![ContentBlock::text(text)],
        };
        let reply = |text: &str| EventBody::AssistantMessage {
            content: text.into(),
            tool_calls: Vec::new(),
            stop_reason: "stop".into(),
            model: "m".into(),
            raw_items: Vec::new(),
        };
        let bodies = vec![
            EventBody::SystemMessage {
                content: "old sys".into(),
            },
            EventBody::TurnStart { turn: 1 },
            EventBody::SystemMessage {
                content: "newer sys".into(),
            },
            user("ask 1"),
            EventBody::AssistantMessage {
                content: String::new(),
                tool_calls: vec![LoggedCall {
                    call_id: "c1".into(),
                    name: "write".into(),
                    arguments: json!({}),
                }],
                stop_reason: "tool_use".into(),
                model: "m".into(),
                raw_items: Vec::new(),
            },
            EventBody::ToolCall {
                call_id: "c1".into(),
                name: "write".into(),
                arguments: json!({}),
            },
            EventBody::ToolResult {
                call_id: "c1".into(),
                name: "write".into(),
                value: json!(null),
                content: vec![ContentBlock::text("failed")],
                is_error: true,
                meta: None,
            },
            user("[recovery] the write failed; recover now"),
            reply("answer 1"),
            EventBody::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Completed,
                error: String::new(),
            },
            EventBody::TurnStart { turn: 2 },
            user("ask 2"),
        ];
        let events: Vec<SessionEvent> = bodies
            .into_iter()
            .enumerate()
            .map(|(index, body)| at(index as u64 + 1, body))
            .collect();
        let kept = bound_history(
            &events,
            HistoryBudget {
                full_turns: 1,
                older_messages: 16,
            },
        );
        let older: Vec<String> = kept
            .iter()
            .take_while(|event| !matches!(event.body, EventBody::TurnStart { turn: 2 }))
            .map(|event| match &event.body {
                EventBody::SystemMessage { content } => format!("system {content}"),
                EventBody::UserMessage { content } => match &content[0] {
                    ContentBlock::Text { text } => format!("user {text}"),
                    ContentBlock::Image { .. } => "image".into(),
                },
                EventBody::AssistantMessage { content, .. } => format!("assistant {content}"),
                other => other.kind().to_owned(),
            })
            .collect();
        assert_eq!(
            older,
            ["system newer sys", "user ask 1", "assistant answer 1"]
        );
    }

    #[test]
    fn events_before_any_turn_count_as_older() {
        let events = vec![
            at(
                1,
                EventBody::UserMessage {
                    content: vec![ContentBlock::text("carried")],
                },
            ),
            at(
                2,
                EventBody::AssistantMessage {
                    content: "carried reply".into(),
                    tool_calls: Vec::new(),
                    stop_reason: String::new(),
                    model: String::new(),
                    raw_items: Vec::new(),
                },
            ),
            at(3, EventBody::TurnStart { turn: 1 }),
        ];
        assert_eq!(
            bound_history(
                &events,
                HistoryBudget {
                    full_turns: 1,
                    older_messages: 1
                }
            )
            .len(),
            2
        );
    }
}
