//! Durable session events, named after DeepSeek Harness's (`turn/start`,
//! `tool/call`, ...). Model-visible means logged: every model request is
//! derived from these events.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One piece of user, tool, or context content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    /// An image the model sees, as a `data:` URL or a workspace URL.
    Image {
        url: String,
    },
}

impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }
}

/// Why a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnEndReason {
    Completed,
    Cancelled,
    Failed,
    AwaitingApproval,
    StepLimit,
}

/// A tool call as the model asked for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedCall {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
}

/// The payload of one durable event; `type` carries the DeepSeek Harness name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum EventBody {
    #[serde(rename = "turn/start")]
    TurnStart { turn: u32 },
    #[serde(rename = "turn/end")]
    TurnEnd {
        turn: u32,
        reason: TurnEndReason,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        error: String,
    },
    #[serde(rename = "step/start")]
    StepStart { turn: u32, step: u32 },
    #[serde(rename = "step/end")]
    StepEnd { turn: u32, step: u32 },
    #[serde(rename = "system/message")]
    SystemMessage { content: String },
    #[serde(rename = "user/message")]
    UserMessage { content: Vec<ContentBlock> },
    #[serde(rename = "assistant/message")]
    AssistantMessage {
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<LoggedCall>,
        #[serde(default)]
        stop_reason: String,
        #[serde(default)]
        model: String,
        /// Provider-native items replayed verbatim on the Responses wire.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        raw_items: Vec<Value>,
    },
    /// A model call that settled without a message: failed or cancelled.
    #[serde(rename = "assistant/attempt")]
    AssistantAttempt { error: String },
    #[serde(rename = "tool/call")]
    ToolCall {
        call_id: String,
        name: String,
        arguments: Value,
    },
    #[serde(rename = "tool/result")]
    ToolResult {
        call_id: String,
        name: String,
        /// The canonical output value (standard A4); `null` on failure.
        value: Value,
        /// What the model sees.
        content: Vec<ContentBlock>,
        is_error: bool,
        /// Display-only data derived from arguments and value.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    #[serde(rename = "approval/asked")]
    ApprovalAsked { call_id: String, reason: String },
}

impl EventBody {
    /// Every event name this crate writes, for the conformance check.
    pub const KINDS: &[&str] = &[
        "turn/start",
        "turn/end",
        "step/start",
        "step/end",
        "system/message",
        "user/message",
        "assistant/message",
        "assistant/attempt",
        "tool/call",
        "tool/result",
        "approval/asked",
    ];

    pub fn kind(&self) -> &'static str {
        match self {
            Self::TurnStart { .. } => "turn/start",
            Self::TurnEnd { .. } => "turn/end",
            Self::StepStart { .. } => "step/start",
            Self::StepEnd { .. } => "step/end",
            Self::SystemMessage { .. } => "system/message",
            Self::UserMessage { .. } => "user/message",
            Self::AssistantMessage { .. } => "assistant/message",
            Self::AssistantAttempt { .. } => "assistant/attempt",
            Self::ToolCall { .. } => "tool/call",
            Self::ToolResult { .. } => "tool/result",
            Self::ApprovalAsked { .. } => "approval/asked",
        }
    }
}

/// One appended event: its position in the session, its time, its payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionEvent {
    pub seq: u64,
    /// Unix milliseconds.
    pub at: i64,
    #[serde(flatten)]
    pub body: EventBody,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn events_use_dsh_names_and_camel_case() {
        let event = SessionEvent {
            seq: 3,
            at: 10,
            body: EventBody::ToolCall {
                call_id: "c1".into(),
                name: "echo".into(),
                arguments: json!({ "text": "hi" }),
            },
        };
        let wire = serde_json::to_value(&event).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            wire,
            json!({ "seq": 3, "at": 10, "type": "tool/call", "callId": "c1", "name": "echo", "arguments": { "text": "hi" } })
        );
        let back: SessionEvent =
            serde_json::from_value(wire).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(back, event);
        assert_eq!(back.body.kind(), "tool/call");
    }

    #[test]
    fn turn_end_reason_is_kebab_case() {
        let body = EventBody::TurnEnd {
            turn: 1,
            reason: TurnEndReason::AwaitingApproval,
            error: String::new(),
        };
        let wire = serde_json::to_value(&body).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            wire,
            serde_json::json!({ "type": "turn/end", "turn": 1, "reason": "awaiting-approval" })
        );
    }
}
