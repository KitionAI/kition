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

/// Who produced a `user/message` (dsh `MessageSource`): `user` is the
/// person; `approval` resumes a turn after an approval decision;
/// `context-action` is a hidden follow-up the client sent; `recovery` is
/// context the driver adds after tool failures; `tool-follow-up` is content
/// a model reply hands to the next step (such as hosted images). Open, as
/// in dsh.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageSource {
    pub kind: String,
}

impl MessageSource {
    pub fn new(kind: impl Into<String>) -> Self {
        Self { kind: kind.into() }
    }

    pub fn user() -> Self {
        Self::new("user")
    }

    /// Whether the client sent this message (the person's own message, an
    /// approval resume, or a hidden follow-up), as opposed to context the
    /// runtime added (`recovery`, `tool-follow-up`).
    pub fn is_client_input(&self) -> bool {
        matches!(self.kind.as_str(), "user" | "approval" | "context-action")
    }
}

/// A message waiting in the session inbox (dsh `UserMessage` in
/// `agent/inbox/spliced`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueuedMessage {
    pub id: String,
    pub content: Vec<ContentBlock>,
    pub source: MessageSource,
}

/// Where an inbox splice lands (dsh `InboxTarget`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InboxTarget {
    NextTurn,
    NextStep,
}

/// How an `approval/asked` was settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalOutcome {
    AllowedOnce,
    Rejected,
    Cancelled,
    Unavailable,
}

/// A file a turn hands to the user (dsh `PresentedFile`); `path` is
/// workspace-relative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresentedFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

/// One entry of the agent's todo list (dsh `TodoItem`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
}

/// How a retry is bounded; Kition retries only up to `maxRetries`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RetryMode {
    Normal,
}

/// Why a model request failed (dsh `LlmFailure`, the fields Kition knows).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LlmFailure {
    pub message: String,
    pub code: String,
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
    SystemMessage {
        turn: u32,
        step: u32,
        content: String,
    },
    /// `id` is the inbox message id for a prompt, else minted by the driver.
    #[serde(rename = "user/message")]
    UserMessage {
        id: String,
        content: Vec<ContentBlock>,
        source: MessageSource,
    },
    /// The inbox changed: `inserted` entered it at `start`, or
    /// `removed_count` entries left it there (claimed by a turn).
    #[serde(rename = "agent/inbox/spliced")]
    InboxSpliced {
        target: InboxTarget,
        start: u32,
        inserted: Vec<QueuedMessage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        removed_count: Option<u32>,
    },
    #[serde(rename = "assistant/message")]
    AssistantMessage {
        turn: u32,
        step: u32,
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<LoggedCall>,
        #[serde(default)]
        stop_reason: String,
        /// The provider route that answered (dsh `message.source.provider`).
        provider: String,
        #[serde(default)]
        model: String,
        /// Provider-native items replayed verbatim on the Responses wire.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        raw_items: Vec<Value>,
    },
    /// A model call that settled without a message: failed, or `aborted`
    /// when the turn was cancelled.
    #[serde(rename = "assistant/attempt")]
    AssistantAttempt {
        turn: u32,
        step: u32,
        error: String,
        aborted: bool,
    },
    /// `hosted`: the provider ran the call itself (not model history).
    #[serde(rename = "tool/call")]
    ToolCall {
        turn: u32,
        step: u32,
        call_id: String,
        name: String,
        arguments: Value,
        hosted: bool,
    },
    #[serde(rename = "tool/result")]
    ToolResult {
        turn: u32,
        step: u32,
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
        hosted: bool,
    },
    /// `id` is `approval:<callId>`; the matching `approval/decided` uses it.
    #[serde(rename = "approval/asked")]
    ApprovalAsked {
        id: String,
        tool_name: String,
        call_id: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        reason: String,
    },
    #[serde(rename = "approval/decided")]
    ApprovalDecided {
        id: String,
        outcome: ApprovalOutcome,
    },
    /// Files a successful tool result hands to the user.
    #[serde(rename = "deliverables/presented")]
    DeliverablesPresented {
        turn: u32,
        call_id: String,
        files: Vec<PresentedFile>,
    },
    /// The whole todo list; the latest write wins. Never model history.
    #[serde(rename = "todo/write")]
    TodoWrite { todos: Vec<TodoItem> },
    /// A failed model request that will be retried after `delay_ms`.
    /// `retry_id` names the retry chain of one model step; `retry` counts
    /// from 1.
    #[serde(rename = "llm/retry")]
    LlmRetry {
        retry_id: String,
        turn: u32,
        step: u32,
        provider: String,
        mode: RetryMode,
        policy_key: String,
        retry: u32,
        max_retries: u32,
        delay_ms: u64,
        failure: LlmFailure,
    },
    /// The wait of `llm/retry` number `retry` is over and the next attempt
    /// starts.
    #[serde(rename = "llm/retry-started")]
    LlmRetryStarted {
        retry_id: String,
        turn: u32,
        step: u32,
        retry: u32,
    },
    /// The permission preset (Kition's execution mode) from this point on.
    #[serde(rename = "permission/preset")]
    PermissionPreset { preset: String },
}

impl EventBody {
    /// Every event name this crate writes, for the conformance check.
    pub const KINDS: &[&str] = &[
        "agent/inbox/spliced",
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
        "approval/decided",
        "deliverables/presented",
        "todo/write",
        "llm/retry",
        "llm/retry-started",
        "permission/preset",
    ];

    pub fn kind(&self) -> &'static str {
        match self {
            Self::TurnStart { .. } => "turn/start",
            Self::TurnEnd { .. } => "turn/end",
            Self::StepStart { .. } => "step/start",
            Self::StepEnd { .. } => "step/end",
            Self::SystemMessage { .. } => "system/message",
            Self::UserMessage { .. } => "user/message",
            Self::InboxSpliced { .. } => "agent/inbox/spliced",
            Self::AssistantMessage { .. } => "assistant/message",
            Self::AssistantAttempt { .. } => "assistant/attempt",
            Self::ToolCall { .. } => "tool/call",
            Self::ToolResult { .. } => "tool/result",
            Self::ApprovalAsked { .. } => "approval/asked",
            Self::ApprovalDecided { .. } => "approval/decided",
            Self::DeliverablesPresented { .. } => "deliverables/presented",
            Self::TodoWrite { .. } => "todo/write",
            Self::LlmRetry { .. } => "llm/retry",
            Self::LlmRetryStarted { .. } => "llm/retry-started",
            Self::PermissionPreset { .. } => "permission/preset",
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
                turn: 1,
                step: 2,
                call_id: "c1".into(),
                name: "echo".into(),
                arguments: json!({ "text": "hi" }),
                hosted: false,
            },
        };
        let wire = serde_json::to_value(&event).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            wire,
            json!({ "seq": 3, "at": 10, "type": "tool/call", "turn": 1, "step": 2, "callId": "c1", "name": "echo",
                "arguments": { "text": "hi" }, "hosted": false })
        );
        let back: SessionEvent =
            serde_json::from_value(wire).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(back, event);
        assert_eq!(back.body.kind(), "tool/call");
    }

    #[test]
    fn every_event_body_round_trips_and_covers_kinds() {
        let bodies = vec![
            EventBody::TurnStart { turn: 1 },
            EventBody::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Completed,
                error: String::new(),
            },
            EventBody::StepStart { turn: 1, step: 1 },
            EventBody::StepEnd { turn: 1, step: 1 },
            EventBody::SystemMessage {
                turn: 1,
                step: 1,
                content: "be helpful".into(),
            },
            EventBody::UserMessage {
                id: "m1".into(),
                content: vec![ContentBlock::text("hi")],
                source: MessageSource::new("context-action"),
            },
            EventBody::InboxSpliced {
                target: InboxTarget::NextTurn,
                start: 0,
                inserted: vec![QueuedMessage {
                    id: "m1".into(),
                    content: vec![ContentBlock::text("hi")],
                    source: MessageSource::user(),
                }],
                removed_count: Some(1),
            },
            EventBody::AssistantMessage {
                turn: 1,
                step: 1,
                content: String::new(),
                tool_calls: Vec::new(),
                stop_reason: String::new(),
                provider: "deepseek-official".into(),
                model: String::new(),
                raw_items: Vec::new(),
            },
            EventBody::AssistantAttempt {
                turn: 1,
                step: 2,
                error: "timed out".into(),
                aborted: true,
            },
            EventBody::ToolCall {
                turn: 1,
                step: 1,
                call_id: "c1".into(),
                name: "echo".into(),
                arguments: json!({}),
                hosted: true,
            },
            EventBody::ToolResult {
                turn: 1,
                step: 1,
                call_id: "c1".into(),
                name: "echo".into(),
                value: Value::Null,
                content: vec![ContentBlock::text("done")],
                is_error: false,
                meta: None,
                hosted: false,
            },
            EventBody::ApprovalAsked {
                id: "approval:c1".into(),
                tool_name: "exec_command".into(),
                call_id: "c1".into(),
                reason: "writes outside the workspace".into(),
            },
            EventBody::ApprovalDecided {
                id: "approval:c1".into(),
                outcome: ApprovalOutcome::AllowedOnce,
            },
            EventBody::DeliverablesPresented {
                turn: 1,
                call_id: "c1".into(),
                files: vec![PresentedFile {
                    path: "Notes/plan.md".into(),
                    description: "Plan".into(),
                }],
            },
            EventBody::TodoWrite {
                todos: vec![TodoItem {
                    content: "Draft".into(),
                    status: TodoStatus::InProgress,
                }],
            },
            EventBody::LlmRetry {
                retry_id: "agent:1#1.1".into(),
                turn: 1,
                step: 1,
                provider: "openai".into(),
                mode: RetryMode::Normal,
                policy_key: "engine".into(),
                retry: 1,
                max_retries: 5,
                delay_ms: 500,
                failure: LlmFailure {
                    message: "timed out".into(),
                    code: "timeout".into(),
                },
            },
            EventBody::LlmRetryStarted {
                retry_id: "agent:1#1.1".into(),
                turn: 1,
                step: 1,
                retry: 1,
            },
            EventBody::PermissionPreset {
                preset: "preview".into(),
            },
        ];

        let mut kinds = Vec::new();
        for (index, body) in bodies.into_iter().enumerate() {
            let kind = body.kind();
            kinds.push(kind);
            let event = SessionEvent {
                seq: index as u64,
                at: 0,
                body,
            };
            let wire = serde_json::to_value(&event).unwrap_or_else(|error| panic!("{error}"));
            assert_eq!(wire["type"], kind);
            let back: SessionEvent =
                serde_json::from_value(wire).unwrap_or_else(|error| panic!("{error}"));
            assert_eq!(back, event);
        }

        assert_eq!(kinds.len(), EventBody::KINDS.len());
        for kind in &kinds {
            assert!(EventBody::KINDS.contains(kind), "{kind} missing from KINDS");
        }
        let mut deduped = kinds.clone();
        deduped.sort_unstable();
        deduped.dedup();
        assert_eq!(
            deduped.len(),
            kinds.len(),
            "duplicate kind in coverage list"
        );
    }

    #[test]
    fn new_events_use_the_dsh_wire_shapes() {
        let wire = |body: EventBody| serde_json::to_value(&body).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            wire(EventBody::UserMessage {
                id: "m1".into(),
                content: vec![ContentBlock::text("hi")],
                source: MessageSource::user(),
            }),
            json!({ "type": "user/message", "id": "m1", "content": [{ "type": "text", "text": "hi" }], "source": { "kind": "user" } })
        );
        assert!(
            serde_json::from_value::<EventBody>(
                json!({ "type": "user/message", "id": "m1", "content": [] })
            )
            .is_err(),
            "a user message names its source"
        );
        assert!(
            serde_json::from_value::<EventBody>(
                json!({ "type": "user/message", "content": [], "source": { "kind": "user" } })
            )
            .is_err(),
            "a user message has an id"
        );
        assert_eq!(
            wire(EventBody::ApprovalAsked {
                id: "approval:c1".into(),
                tool_name: "exec_command".into(),
                call_id: "c1".into(),
                reason: "outside the policy".into(),
            }),
            json!({ "type": "approval/asked", "id": "approval:c1", "toolName": "exec_command", "callId": "c1", "reason": "outside the policy" })
        );
        for (outcome, name) in [
            (ApprovalOutcome::AllowedOnce, "allowed-once"),
            (ApprovalOutcome::Rejected, "rejected"),
            (ApprovalOutcome::Cancelled, "cancelled"),
            (ApprovalOutcome::Unavailable, "unavailable"),
        ] {
            assert_eq!(
                wire(EventBody::ApprovalDecided {
                    id: "approval:c1".into(),
                    outcome,
                }),
                json!({ "type": "approval/decided", "id": "approval:c1", "outcome": name })
            );
        }
        assert_eq!(
            wire(EventBody::DeliverablesPresented {
                turn: 2,
                call_id: "c1".into(),
                files: vec![
                    PresentedFile {
                        path: "a.md".into(),
                        description: String::new(),
                    },
                    PresentedFile {
                        path: "b.png".into(),
                        description: "Cover".into(),
                    },
                ],
            }),
            json!({ "type": "deliverables/presented", "turn": 2, "callId": "c1", "files": [{ "path": "a.md" }, { "path": "b.png", "description": "Cover" }] })
        );
        assert_eq!(
            wire(EventBody::TodoWrite {
                todos: vec![
                    TodoItem {
                        content: "a".into(),
                        status: TodoStatus::Pending,
                    },
                    TodoItem {
                        content: "b".into(),
                        status: TodoStatus::InProgress,
                    },
                    TodoItem {
                        content: "c".into(),
                        status: TodoStatus::Completed,
                    },
                ],
            }),
            json!({ "type": "todo/write", "todos": [
                { "content": "a", "status": "pending" },
                { "content": "b", "status": "in_progress" },
                { "content": "c", "status": "completed" },
            ] })
        );
        assert_eq!(
            wire(EventBody::LlmRetry {
                retry_id: "agent:1#1.1".into(),
                turn: 1,
                step: 1,
                provider: "openai".into(),
                mode: RetryMode::Normal,
                policy_key: "engine".into(),
                retry: 2,
                max_retries: 5,
                delay_ms: 1000,
                failure: LlmFailure {
                    message: "rate limited".into(),
                    code: "429".into(),
                },
            }),
            json!({
                "type": "llm/retry", "retryId": "agent:1#1.1", "turn": 1, "step": 1,
                "provider": "openai", "mode": "normal", "policyKey": "engine", "retry": 2,
                "maxRetries": 5, "delayMs": 1000,
                "failure": { "message": "rate limited", "code": "429" },
            })
        );
        assert_eq!(
            wire(EventBody::LlmRetryStarted {
                retry_id: "agent:1#1.1".into(),
                turn: 1,
                step: 1,
                retry: 2,
            }),
            json!({ "type": "llm/retry-started", "retryId": "agent:1#1.1", "turn": 1, "step": 1, "retry": 2 })
        );
        assert_eq!(
            wire(EventBody::PermissionPreset {
                preset: "apply".into(),
            }),
            json!({ "type": "permission/preset", "preset": "apply" })
        );
    }

    #[test]
    fn step_scoped_events_require_their_new_fields() {
        for event in [
            json!({ "type": "system/message", "content": "x" }),
            json!({ "type": "assistant/message", "turn": 1, "step": 1, "content": "", "model": "m" }),
            json!({ "type": "assistant/attempt", "turn": 1, "step": 1, "error": "x" }),
            json!({ "type": "tool/call", "turn": 1, "step": 1, "callId": "c", "name": "n", "arguments": {} }),
            json!({ "type": "tool/result", "turn": 1, "step": 1, "callId": "c", "name": "n", "value": null,
                "content": [], "isError": false }),
        ] {
            assert!(
                serde_json::from_value::<EventBody>(event.clone()).is_err(),
                "{event}"
            );
        }
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
