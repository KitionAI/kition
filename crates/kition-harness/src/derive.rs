//! Model history derived from the session log (DeepSeek Harness
//! `deriveMessages`). Lifecycle events and failed attempts are not model
//! history; the newest system message leads.

use kition_ai::engine::{Message, MessagePart, ToolCall};

use crate::events::{ContentBlock, EventBody, SessionEvent};

/// The messages a model request carries, rebuilt from the log. Images in
/// tool results follow all results of their step as one user message, so
/// tool messages stay adjacent to the assistant message that called them.
pub fn derive_messages(events: &[SessionEvent]) -> Vec<Message> {
    let mut system = String::new();
    let mut history = Vec::new();
    let mut pending_images: Vec<MessagePart> = Vec::new();
    for event in events {
        let flush = !matches!(
            event.body,
            EventBody::ToolResult { .. } | EventBody::ToolCall { .. }
        );
        if flush && !pending_images.is_empty() {
            history.push(Message {
                role: "user".into(),
                parts: std::mem::take(&mut pending_images),
                ..Message::default()
            });
        }
        match &event.body {
            EventBody::SystemMessage { content } => system.clone_from(content),
            EventBody::UserMessage { content } => history.push(user_message(content)),
            EventBody::AssistantMessage {
                content,
                tool_calls,
                raw_items,
                ..
            } => {
                if content.is_empty() && tool_calls.is_empty() {
                    continue;
                }
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
                    raw_items: raw_items.clone(),
                    ..Message::default()
                });
            }
            EventBody::ToolResult {
                call_id,
                name,
                content,
                ..
            } => {
                let (text, images) = split(content);
                history.push(Message {
                    role: "tool".into(),
                    name: name.clone(),
                    tool_call_id: call_id.clone(),
                    content: text,
                    ..Message::default()
                });
                pending_images.extend(images);
            }
            _ => {}
        }
    }
    if !pending_images.is_empty() {
        history.push(Message {
            role: "user".into(),
            parts: pending_images,
            ..Message::default()
        });
    }
    if !system.is_empty() {
        history.insert(0, Message::new("system", system));
    }
    history
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
    use crate::events::LoggedCall;

    fn at(seq: u64, body: EventBody) -> SessionEvent {
        SessionEvent { seq, at: 0, body }
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
                EventBody::AssistantMessage {
                    content: String::new(),
                    tool_calls: vec![LoggedCall {
                        call_id: "c1".into(),
                        name: "photo_run".into(),
                        arguments: json!({ "path": "a.psd" }),
                    }],
                    stop_reason: "tool_use".into(),
                    model: "m".into(),
                    raw_items: Vec::new(),
                },
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
}
