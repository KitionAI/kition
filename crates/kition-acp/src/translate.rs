//! Kition's turn stream as ACP `session/update`s. Each line of a turn's NDJSON stream is a
//! DeepSeek Harness SDK notification (`contracts/runtime/agent-stream.schema.json`):
//!
//! | Kition | ACP `sessionUpdate` |
//! | --- | --- |
//! | `agent/assistant-stream` text deltas | `agent_message_chunk` |
//! | `assistant/message` (when nothing streamed) | `agent_message_chunk` |
//! | `tool/call` | `tool_call` (`in_progress`) |
//! | `tool/result` | `tool_call_update` (`completed` or `failed`) |
//! | `approval/asked` | `tool_call_update` (`pending`), then `session/request_permission` |
//! | `todo/write` | `plan` |
//! | `turn/end` | the prompt's `stopReason` |

use std::collections::HashMap;

use serde_json::{Value, json};

/// How a turn ended, as `session/prompt` answers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ended {
    /// `stopReason`: `end_turn`, `max_turn_requests`, or `cancelled`.
    Stop(&'static str),
    /// The turn waits for the person to allow a command.
    Approval {
        call_id: String,
        tool: String,
        reason: String,
    },
    /// The turn failed: the prompt answers an error.
    Failed(String),
}

/// One turn's projection: what it saw so far.
#[derive(Default)]
pub struct Translator {
    /// Whether text of the current model attempt was streamed already.
    streamed: bool,
    /// Tool calls by id: their name and arguments.
    calls: HashMap<String, (String, Value)>,
    approval: Option<(String, String, String)>,
    ended: Option<Ended>,
}

/// An ACP tool kind for one of Kition's tools.
pub fn tool_kind(name: &str) -> &'static str {
    let suffix = name.rsplit('_').next().unwrap_or(name);
    match name {
        "web_search" => "search",
        "web_fetch" => "fetch",
        "exec_command" => "execute",
        "update_plan" => "think",
        _ if name.ends_with("_read")
            || name.ends_with("_list")
            || name.ends_with("_stat")
            || name.ends_with("_schema")
            || name.ends_with("_records")
            || matches!(suffix, "inspect" | "query" | "commands" | "check") =>
        {
            "read"
        }
        _ if name.ends_with("_search") || name == "file_search" => "search",
        _ if name.ends_with("_write")
            || name == "apply_patch"
            || matches!(suffix, "run" | "batch" | "ready" | "reopen") =>
        {
            "edit"
        }
        _ => "other",
    }
}

fn title(name: &str, arguments: &Value) -> String {
    let path = ["path", "file", "query", "command"]
        .into_iter()
        .find_map(|key| arguments.get(key).and_then(Value::as_str))
        .filter(|text| !text.is_empty());
    match path {
        Some(path) => format!("{name}: {path}"),
        None => name.to_owned(),
    }
}

fn text_content(blocks: &Value) -> Vec<Value> {
    blocks
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .map(|text| json!({ "type": "content", "content": { "type": "text", "text": text } }))
                .collect()
        })
        .unwrap_or_default()
}

fn plan_status(status: &str) -> &'static str {
    match status {
        "completed" => "completed",
        "in_progress" => "in_progress",
        _ => "pending",
    }
}

impl Translator {
    /// The updates one stream line makes (each an ACP `update` object).
    pub fn line(&mut self, line: &Value) -> Vec<Value> {
        match line["method"].as_str() {
            Some("agent/assistant-stream") => {
                let frame = &line["params"]["frame"];
                match frame["type"].as_str() {
                    Some("start") => {
                        self.streamed = false;
                        Vec::new()
                    }
                    Some("chunk") if frame["chunk"]["type"] == "text-delta" => {
                        let text = frame["chunk"]["text"].as_str().unwrap_or_default();
                        if text.is_empty() {
                            return Vec::new();
                        }
                        self.streamed = true;
                        vec![
                            json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } }),
                        ]
                    }
                    _ => Vec::new(),
                }
            }
            Some("session.event") => self.event(&line["params"]["event"]),
            _ => Vec::new(),
        }
    }

    fn event(&mut self, event: &Value) -> Vec<Value> {
        let text = |key: &str| event[key].as_str().unwrap_or_default().to_owned();
        match event["type"].as_str() {
            Some("assistant/message") => {
                let streamed = std::mem::take(&mut self.streamed);
                let content = text("content");
                if streamed || content.is_empty() {
                    return Vec::new();
                }
                vec![
                    json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": content } }),
                ]
            }
            Some("tool/call") => {
                let (id, name) = (text("callId"), text("name"));
                let arguments = event["arguments"].clone();
                let update = json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": id,
                    "title": title(&name, &arguments),
                    "kind": tool_kind(&name),
                    "status": "in_progress",
                    "rawInput": arguments,
                });
                self.calls.insert(id, (name, arguments));
                vec![update]
            }
            Some("tool/result") => {
                let failed = event["isError"] == true;
                vec![json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": text("callId"),
                    "status": if failed { "failed" } else { "completed" },
                    "content": text_content(&event["content"]),
                    "rawOutput": event["value"].clone(),
                })]
            }
            Some("approval/asked") => {
                let call = text("callId");
                self.approval = Some((call.clone(), text("toolName"), text("reason")));
                vec![
                    json!({ "sessionUpdate": "tool_call_update", "toolCallId": call, "status": "pending" }),
                ]
            }
            Some("todo/write") => {
                let entries: Vec<Value> = event["todos"]
                    .as_array()
                    .map(|todos| {
                        todos
                            .iter()
                            .map(|todo| {
                                json!({
                                    "content": todo["content"].as_str().unwrap_or_default(),
                                    "priority": "medium",
                                    "status": plan_status(todo["status"].as_str().unwrap_or_default()),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                vec![json!({ "sessionUpdate": "plan", "entries": entries })]
            }
            Some("turn/end") => {
                self.ended = Some(match event["reason"].as_str() {
                    Some("completed") => Ended::Stop("end_turn"),
                    Some("cancelled") => Ended::Stop("cancelled"),
                    Some("step-limit") => Ended::Stop("max_turn_requests"),
                    Some("awaiting-approval") => match self.approval.take() {
                        Some((call_id, tool, reason)) => Ended::Approval {
                            call_id,
                            tool,
                            reason,
                        },
                        None => Ended::Failed(
                            "the turn waits for an approval it did not ask for".into(),
                        ),
                    },
                    _ => Ended::Failed(match text("error") {
                        error if error.is_empty() => "the agent's turn failed".to_owned(),
                        error => error,
                    }),
                });
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// How the turn ended; `None` while it has not (or when its stream broke off).
    pub fn ended(&self) -> Option<&Ended> {
        self.ended.as_ref()
    }

    /// The tool call an approval is for, as `session/request_permission` names it.
    pub fn tool_call(&self, call_id: &str, tool: &str) -> Value {
        let (name, arguments) = self
            .calls
            .get(call_id)
            .cloned()
            .unwrap_or_else(|| (tool.to_owned(), Value::Null));
        json!({
            "toolCallId": call_id,
            "title": title(&name, &arguments),
            "kind": tool_kind(&name),
            "status": "pending",
            "rawInput": arguments,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(event: Value) -> Value {
        json!({ "jsonrpc": "2.0", "method": "session.event", "params": { "sessionId": "agent:1", "event": event } })
    }

    fn frame(frame: Value) -> Value {
        json!({ "jsonrpc": "2.0", "method": "agent/assistant-stream", "params": { "sessionId": "agent:1", "frame": frame } })
    }

    #[test]
    fn a_turn_becomes_session_updates() {
        let mut turn = Translator::default();
        let mut updates = Vec::new();
        for line in [
            json!({ "jsonrpc": "2.0", "method": "session.status", "params": { "status": "running" } }),
            frame(
                json!({ "type": "start", "attemptId": "a", "revision": 1, "turn": 1, "step": 1 }),
            ),
            frame(
                json!({ "type": "chunk", "attemptId": "a", "revision": 2, "index": 0, "time": 1, "chunk": { "type": "text-delta", "index": 0, "text": "Look" } }),
            ),
            event(
                json!({ "seq": 3, "type": "assistant/message", "turn": 1, "step": 1, "content": "Looking", "stopReason": "tool_use", "provider": "", "model": "" }),
            ),
            event(
                json!({ "seq": 4, "type": "tool/call", "turn": 1, "step": 1, "callId": "c1", "name": "slide_inspect", "arguments": { "path": "talks/a.pptx" }, "hosted": false }),
            ),
            event(
                json!({ "seq": 5, "type": "tool/result", "turn": 1, "step": 1, "callId": "c1", "name": "slide_inspect", "value": { "slides": 3 }, "content": [{ "type": "text", "text": "3 slides" }], "isError": false, "hosted": false }),
            ),
            event(
                json!({ "seq": 6, "type": "todo/write", "todos": [{ "content": "Retitle", "status": "in_progress" }] }),
            ),
            event(
                json!({ "seq": 7, "type": "assistant/message", "turn": 1, "step": 2, "content": "Done.", "stopReason": "end_turn", "provider": "", "model": "" }),
            ),
            event(json!({ "seq": 8, "type": "turn/end", "turn": 1, "reason": "completed" })),
        ] {
            updates.extend(turn.line(&line));
        }
        assert_eq!(
            updates,
            [
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Look" } }),
                json!({ "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "slide_inspect: talks/a.pptx", "kind": "read", "status": "in_progress", "rawInput": { "path": "talks/a.pptx" } }),
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed", "content": [{ "type": "content", "content": { "type": "text", "text": "3 slides" } }], "rawOutput": { "slides": 3 } }),
                json!({ "sessionUpdate": "plan", "entries": [{ "content": "Retitle", "priority": "medium", "status": "in_progress" }] }),
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Done." } }),
            ]
        );
        assert_eq!(turn.ended(), Some(&Ended::Stop("end_turn")));
    }

    #[test]
    fn approvals_failures_and_limits_end_the_prompt() {
        let mut turn = Translator::default();
        turn.line(&event(json!({ "type": "tool/call", "callId": "x", "name": "exec_command", "arguments": { "command": "make" } })));
        assert_eq!(
            turn.line(&event(json!({ "type": "approval/asked", "id": "approval:x", "toolName": "exec_command", "callId": "x", "reason": "runs make" }))),
            [json!({ "sessionUpdate": "tool_call_update", "toolCallId": "x", "status": "pending" })]
        );
        turn.line(&event(
            json!({ "type": "turn/end", "reason": "awaiting-approval" }),
        ));
        assert_eq!(
            turn.ended(),
            Some(&Ended::Approval {
                call_id: "x".into(),
                tool: "exec_command".into(),
                reason: "runs make".into()
            })
        );
        assert_eq!(
            turn.tool_call("x", "exec_command")["title"],
            "exec_command: make"
        );
        assert_eq!(turn.tool_call("x", "exec_command")["kind"], "execute");
        let mut failed = Translator::default();
        failed.line(&event(
            json!({ "type": "turn/end", "reason": "failed", "error": "model unreachable" }),
        ));
        assert_eq!(
            failed.ended(),
            Some(&Ended::Failed("model unreachable".into()))
        );
        let mut limited = Translator::default();
        limited.line(&event(
            json!({ "type": "turn/end", "reason": "step-limit" }),
        ));
        assert_eq!(limited.ended(), Some(&Ended::Stop("max_turn_requests")));
    }

    #[test]
    fn kit_tools_have_acp_kinds() {
        assert_eq!(tool_kind("vector_query"), "read");
        assert_eq!(tool_kind("vector_batch"), "edit");
        assert_eq!(tool_kind("slide_check"), "read");
        assert_eq!(tool_kind("photo_run"), "edit");
        assert_eq!(tool_kind("document_read"), "read");
        assert_eq!(tool_kind("web_search"), "search");
        assert_eq!(tool_kind("mcp__x__y"), "other");
    }
}
