//! Model history derived from the session log (DeepSeek Harness
//! `deriveMessages`). Lifecycle events and failed attempts are not model
//! history; the newest system message leads.
//!
//! Every provider wire (OpenAI/DeepSeek, Responses, Anthropic) rejects a
//! request where an assistant tool call has no matching tool result, so a
//! call left open by a crash, cancellation, or a pending approval is
//! repaired at the next boundary with a synthetic `tool` message.

use std::collections::HashSet;

use kition_ai::engine::{Message, MessagePart, ToolCall};

use crate::events::{ContentBlock, EventBody, SessionEvent};

/// Events after which any still-open tool call is no longer allowed to
/// dangle, and after which pending tool-result images are flushed.
fn is_boundary(body: &EventBody) -> bool {
    matches!(
        body,
        EventBody::UserMessage { .. }
            | EventBody::AssistantMessage { .. }
            | EventBody::StepEnd { .. }
            | EventBody::TurnStart { .. }
            | EventBody::TurnEnd { .. }
    )
}

/// The messages a model request carries, rebuilt from the log. Images in
/// tool results follow all results of their step as one user message, so
/// tool messages stay adjacent to the assistant message that called them.
/// Equivalent to [`derive_messages_for`] with `model: None`.
pub fn derive_messages(events: &[SessionEvent]) -> Vec<Message> {
    derive_messages_for(events, None)
}

/// Like [`derive_messages`], but an assistant message's `raw_items` replay
/// only when `model` is `None` or matches the message's own `model`
/// (trimmed, case-sensitive): a provider-native item (such as an Anthropic
/// thinking block's signature) is only ever valid for the model that
/// produced it.
pub fn derive_messages_for(events: &[SessionEvent], model: Option<&str>) -> Vec<Message> {
    let mut system = String::new();
    let mut history = Vec::new();
    let mut pending_images: Vec<MessagePart> = Vec::new();
    let mut open_calls: Vec<(String, String)> = Vec::new();
    let mut awaiting_approval: HashSet<String> = HashSet::new();
    let mut started: HashSet<String> = HashSet::new();

    for event in events {
        if is_boundary(&event.body) {
            repair_dangling_calls(
                &mut open_calls,
                &mut awaiting_approval,
                &mut started,
                &mut history,
            );
            flush_images(&mut pending_images, &mut history);
        }
        match &event.body {
            EventBody::SystemMessage { content } => system.clone_from(content),
            EventBody::UserMessage { content } => history.push(user_message(content)),
            EventBody::AssistantMessage {
                content,
                tool_calls,
                raw_items,
                model: event_model,
                ..
            } => {
                if content.is_empty() && tool_calls.is_empty() {
                    continue;
                }
                let replays_to_this_model = match model {
                    None => true,
                    Some(requested) => event_model.trim() == requested,
                };
                history.push(Message {
                    role: "assistant".into(),
                    content: content.clone(),
                    tool_calls: tool_calls
                        .iter()
                        .map(|call| ToolCall {
                            id: call.call_id.clone(),
                            name: call.name.clone(),
                            input: call.arguments.to_string(),
                        })
                        .collect(),
                    raw_items: if replays_to_this_model {
                        raw_items.clone()
                    } else {
                        Vec::new()
                    },
                    ..Message::default()
                });
                open_calls = tool_calls
                    .iter()
                    .map(|call| (call.call_id.clone(), call.name.clone()))
                    .collect();
            }
            EventBody::ToolCall { call_id, .. } => {
                started.insert(call_id.clone());
            }
            EventBody::ApprovalAsked { call_id, .. } => {
                awaiting_approval.insert(call_id.clone());
            }
            EventBody::ToolResult {
                call_id,
                name,
                content,
                ..
            } => {
                let (mut text, images) = split(content);
                if text.is_empty() && !images.is_empty() {
                    text = "(image attached below)".into();
                }
                history.push(Message {
                    role: "tool".into(),
                    name: name.clone(),
                    tool_call_id: call_id.clone(),
                    content: text,
                    ..Message::default()
                });
                pending_images.extend(images);
                open_calls.retain(|(id, _)| id != call_id);
                awaiting_approval.remove(call_id);
                started.remove(call_id);
            }
            _ => {}
        }
    }
    repair_dangling_calls(
        &mut open_calls,
        &mut awaiting_approval,
        &mut started,
        &mut history,
    );
    flush_images(&mut pending_images, &mut history);
    if !system.is_empty() {
        history.insert(0, Message::new("system", system));
    }
    history
}

/// Closes every still-open call with a synthetic `tool` message, in the
/// order the calls were made, then clears them. A call awaiting approval
/// keeps the approval-pending message; otherwise dsh tells the model whether
/// the call was durably recorded as started (`tool/call`), since that
/// changes whether retrying is safe (dsh marks `isError` for these
/// separately, so the text itself carries no "Error: " prefix).
fn repair_dangling_calls(
    open_calls: &mut Vec<(String, String)>,
    awaiting_approval: &mut HashSet<String>,
    started: &mut HashSet<String>,
    history: &mut Vec<Message>,
) {
    for (call_id, name) in open_calls.drain(..) {
        let content = if awaiting_approval.remove(&call_id) {
            "Error: this call is waiting for the person's approval and has not run."
        } else if started.remove(&call_id) {
            "The tool call was interrupted after it was recorded, but no result was durably \
             recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: \
             retry only if the operation is read-only or idempotent; if it may have side \
             effects, first verify external state or ask the user. Do not retry blindly."
        } else {
            "The tool call was interrupted before the Harness recorded it as started. Retry it \
             if it is still needed."
        };
        history.push(Message {
            role: "tool".into(),
            name,
            tool_call_id: call_id,
            content: content.into(),
            ..Message::default()
        });
    }
}

/// Pushes every pending tool-result image as one `user` message.
fn flush_images(pending_images: &mut Vec<MessagePart>, history: &mut Vec<Message>) {
    if !pending_images.is_empty() {
        history.push(Message {
            role: "user".into(),
            parts: std::mem::take(pending_images),
            ..Message::default()
        });
    }
}

fn user_message(content: &[ContentBlock]) -> Message {
    let (text, images) = split(content);
    if images.is_empty() {
        return Message::new("user", text);
    }
    let mut parts = Vec::new();
    if !text.is_empty() {
        parts.push(MessagePart {
            kind: "text".into(),
            text,
            ..MessagePart::default()
        });
    }
    parts.extend(images);
    Message {
        role: "user".into(),
        parts,
        ..Message::default()
    }
}

fn split(content: &[ContentBlock]) -> (String, Vec<MessagePart>) {
    let mut texts = Vec::new();
    let mut images = Vec::new();
    for block in content {
        match block {
            ContentBlock::Text { text } => texts.push(text.as_str()),
            ContentBlock::Image { url } => images.push(MessagePart {
                kind: "image_url".into(),
                image_url: url.clone(),
                ..MessagePart::default()
            }),
        }
    }
    (texts.join("\n"), images)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::events::{LoggedCall, TurnEndReason};

    fn at(seq: u64, body: EventBody) -> SessionEvent {
        SessionEvent { seq, at: 0, body }
    }

    fn assistant_with_calls(calls: Vec<LoggedCall>) -> EventBody {
        EventBody::AssistantMessage {
            content: String::new(),
            tool_calls: calls,
            stop_reason: "tool_use".into(),
            model: "m".into(),
            raw_items: Vec::new(),
        }
    }

    #[test]
    fn derives_history_with_tool_images_after_the_results() {
        let events = vec![
            at(1, EventBody::TurnStart { turn: 1 }),
            at(2, EventBody::StepStart { turn: 1, step: 1 }),
            at(
                3,
                EventBody::SystemMessage {
                    content: "old".into(),
                },
            ),
            at(
                4,
                EventBody::SystemMessage {
                    content: "You are Kition.".into(),
                },
            ),
            at(
                5,
                EventBody::UserMessage {
                    content: vec![ContentBlock::text("Brighten it")],
                },
            ),
            at(
                6,
                EventBody::AssistantAttempt {
                    error: "timeout".into(),
                },
            ),
            at(
                7,
                assistant_with_calls(vec![LoggedCall {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    arguments: json!({ "path": "a.psd" }),
                }]),
            ),
            at(
                8,
                EventBody::ToolCall {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    arguments: json!({ "path": "a.psd" }),
                },
            ),
            at(
                9,
                EventBody::ToolResult {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    value: json!({}),
                    content: vec![
                        ContentBlock::text("Ran 1 command"),
                        ContentBlock::Image {
                            url: "data:image/png;base64,AA==".into(),
                        },
                    ],
                    is_error: false,
                    meta: None,
                },
            ),
            at(10, EventBody::StepEnd { turn: 1, step: 1 }),
            at(
                11,
                EventBody::AssistantMessage {
                    content: "Done.".into(),
                    tool_calls: Vec::new(),
                    stop_reason: "stop".into(),
                    model: "m".into(),
                    raw_items: Vec::new(),
                },
            ),
        ];
        let messages = derive_messages(&events);
        let roles: Vec<&str> = messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(
            roles,
            ["system", "user", "assistant", "tool", "user", "assistant"]
        );
        assert_eq!(messages[0].content, "You are Kition.");
        assert_eq!(messages[2].tool_calls[0].input, r#"{"path":"a.psd"}"#);
        assert_eq!(messages[3].tool_call_id, "c1");
        assert_eq!(messages[3].content, "Ran 1 command");
        assert_eq!(messages[4].parts[0].kind, "image_url");
    }

    #[test]
    fn an_unanswered_call_is_repaired_as_interrupted_at_the_next_boundary() {
        let events = vec![
            at(
                1,
                assistant_with_calls(vec![
                    LoggedCall {
                        call_id: "c1".into(),
                        name: "photo_run".into(),
                        arguments: json!({}),
                    },
                    LoggedCall {
                        call_id: "c2".into(),
                        name: "photo_run".into(),
                        arguments: json!({}),
                    },
                ]),
            ),
            at(
                2,
                EventBody::ToolCall {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    arguments: json!({}),
                },
            ),
            at(
                3,
                EventBody::ToolResult {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    value: json!({}),
                    content: vec![ContentBlock::text("ok")],
                    is_error: false,
                    meta: None,
                },
            ),
            at(
                4,
                EventBody::UserMessage {
                    content: vec![ContentBlock::text("next")],
                },
            ),
        ];
        let messages = derive_messages(&events);
        let roles: Vec<&str> = messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, ["assistant", "tool", "tool", "user"]);
        assert_eq!(messages[1].tool_call_id, "c1");
        assert_eq!(messages[1].content, "ok");
        assert_eq!(messages[2].tool_call_id, "c2");
        assert_eq!(
            messages[2].content,
            "The tool call was interrupted before the Harness recorded it as started. \
             Retry it if it is still needed."
        );
    }

    #[test]
    fn a_call_awaiting_approval_is_repaired_with_the_approval_message() {
        let events = vec![
            at(1, EventBody::TurnStart { turn: 1 }),
            at(
                2,
                assistant_with_calls(vec![LoggedCall {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    arguments: json!({}),
                }]),
            ),
            at(
                3,
                EventBody::ToolCall {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    arguments: json!({}),
                },
            ),
            at(
                4,
                EventBody::ApprovalAsked {
                    call_id: "c1".into(),
                    reason: "writes outside the workspace".into(),
                },
            ),
            at(
                5,
                EventBody::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::AwaitingApproval,
                    error: String::new(),
                },
            ),
        ];
        let messages = derive_messages(&events);
        let roles: Vec<&str> = messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, ["assistant", "tool"]);
        assert_eq!(messages[1].tool_call_id, "c1");
        assert_eq!(
            messages[1].content,
            "Error: this call is waiting for the person's approval and has not run."
        );
    }

    #[test]
    fn images_from_two_results_in_one_step_land_in_one_trailing_user_message() {
        let events = vec![
            at(
                1,
                assistant_with_calls(vec![
                    LoggedCall {
                        call_id: "c1".into(),
                        name: "photo_run".into(),
                        arguments: json!({}),
                    },
                    LoggedCall {
                        call_id: "c2".into(),
                        name: "photo_run".into(),
                        arguments: json!({}),
                    },
                ]),
            ),
            at(
                2,
                EventBody::ToolCall {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    arguments: json!({}),
                },
            ),
            at(
                3,
                EventBody::ToolResult {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    value: json!({}),
                    content: vec![ContentBlock::Image {
                        url: "data:image/png;base64,AAA=".into(),
                    }],
                    is_error: false,
                    meta: None,
                },
            ),
            at(
                4,
                EventBody::ToolCall {
                    call_id: "c2".into(),
                    name: "photo_run".into(),
                    arguments: json!({}),
                },
            ),
            at(
                5,
                EventBody::ToolResult {
                    call_id: "c2".into(),
                    name: "photo_run".into(),
                    value: json!({}),
                    content: vec![ContentBlock::Image {
                        url: "data:image/png;base64,BBB=".into(),
                    }],
                    is_error: false,
                    meta: None,
                },
            ),
            at(6, EventBody::StepEnd { turn: 1, step: 1 }),
        ];
        let messages = derive_messages(&events);
        let roles: Vec<&str> = messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, ["assistant", "tool", "tool", "user"]);
        // Both results had only an image: the text falls back per rule 3.
        assert_eq!(messages[1].content, "(image attached below)");
        assert_eq!(messages[2].content, "(image attached below)");
        assert_eq!(messages[3].parts.len(), 2);
        assert_eq!(messages[3].parts[0].image_url, "data:image/png;base64,AAA=");
        assert_eq!(messages[3].parts[1].image_url, "data:image/png;base64,BBB=");
    }

    #[test]
    fn a_dangling_call_at_the_end_of_the_log_is_closed() {
        let events = vec![
            at(
                1,
                assistant_with_calls(vec![LoggedCall {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    arguments: json!({}),
                }]),
            ),
            at(
                2,
                EventBody::ToolCall {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    arguments: json!({}),
                },
            ),
        ];
        let messages = derive_messages(&events);
        let roles: Vec<&str> = messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, ["assistant", "tool"]);
        assert_eq!(messages[1].tool_call_id, "c1");
        assert_eq!(
            messages[1].content,
            "The tool call was interrupted after it was recorded, but no result was durably \
             recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: \
             retry only if the operation is read-only or idempotent; if it may have side \
             effects, first verify external state or ask the user. Do not retry blindly."
        );
    }

    #[test]
    fn raw_items_replay_only_to_the_model_that_produced_them() {
        let events = vec![
            at(
                1,
                EventBody::UserMessage {
                    content: vec![ContentBlock::text("draw")],
                },
            ),
            at(
                2,
                EventBody::AssistantMessage {
                    content: "hi".into(),
                    tool_calls: Vec::new(),
                    stop_reason: "stop".into(),
                    model: "deepseek-chat".into(),
                    raw_items: vec![
                        json!({ "type": "thinking", "thinking": "t", "signature": "s" }),
                    ],
                },
            ),
            at(
                3,
                EventBody::UserMessage {
                    content: vec![ContentBlock::text("continue")],
                },
            ),
        ];
        assert_eq!(
            derive_messages_for(&events, Some("deepseek-chat"))[1]
                .raw_items
                .len(),
            1
        );
        assert!(
            derive_messages_for(&events, Some("claude-x"))[1]
                .raw_items
                .is_empty()
        );
        assert_eq!(derive_messages(&events)[1].raw_items.len(), 1);
    }

    #[test]
    fn an_open_call_is_repaired_differently_depending_on_whether_it_was_recorded_as_started() {
        let events = vec![
            at(
                1,
                assistant_with_calls(vec![
                    LoggedCall {
                        call_id: "c1".into(),
                        name: "photo_run".into(),
                        arguments: json!({}),
                    },
                    LoggedCall {
                        call_id: "c2".into(),
                        name: "photo_run".into(),
                        arguments: json!({}),
                    },
                ]),
            ),
            // Only c1 gets a `tool/call`: c2 never started.
            at(
                2,
                EventBody::ToolCall {
                    call_id: "c1".into(),
                    name: "photo_run".into(),
                    arguments: json!({}),
                },
            ),
            at(3, EventBody::StepEnd { turn: 1, step: 1 }),
        ];
        let messages = derive_messages(&events);
        let roles: Vec<&str> = messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, ["assistant", "tool", "tool"]);
        assert_eq!(messages[1].tool_call_id, "c1");
        assert_eq!(
            messages[1].content,
            "The tool call was interrupted after it was recorded, but no result was durably \
             recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: \
             retry only if the operation is read-only or idempotent; if it may have side \
             effects, first verify external state or ask the user. Do not retry blindly."
        );
        assert_eq!(messages[2].tool_call_id, "c2");
        assert_eq!(
            messages[2].content,
            "The tool call was interrupted before the Harness recorded it as started. \
             Retry it if it is still needed."
        );
    }
}
