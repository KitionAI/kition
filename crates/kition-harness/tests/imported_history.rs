//! A session restored from the workspace mirror has no provider-native
//! `rawItems` and no `system/message` events. Its derived history must still
//! make a well-formed request on every wire: each tool call answered by its
//! result right after it, and (on the Anthropic wire with thinking on) no
//! thinking block demanded for turns that already ended and a paused
//! approval resumed with thinking off.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex, PoisonError};

use kition_ai::engine::{Engine, RuntimeModel};
use kition_harness::derive::derive_messages_for;
use kition_harness::events::SessionEvent;
use serde_json::{Value, json};

fn numbered(bodies: Vec<Value>) -> Vec<SessionEvent> {
    bodies
        .into_iter()
        .enumerate()
        .map(|(index, mut body)| {
            body["seq"] = json!(index + 1);
            body["at"] = json!(1000 + index);
            serde_json::from_value(body).unwrap_or_else(|err| panic!("{err}"))
        })
        .collect()
}

/// The log as `session-events.jsonl` keeps it, plus the next turn's start,
/// its rebuilt system prompt, and its user message.
fn exported_log() -> Vec<SessionEvent> {
    let call = |id: &str, name: &str| json!({ "callId": id, "name": name, "arguments": { "path": "Notes/a.md" } });
    let result = |id: &str, name: &str| {
        json!({ "type": "tool/result", "turn": 1, "step": 1, "callId": id, "name": name, "value": { "ok": true },
            "content": [{ "type": "text", "text": "ok" }], "isError": false, "hosted": false })
    };
    let bodies = vec![
        json!({ "type": "turn/start", "turn": 1 }),
        json!({ "type": "user/message", "content": [{ "type": "text", "text": "Write a plan" }, { "type": "text", "text": "[image omitted]" }],
            "source": { "kind": "user" } }),
        json!({ "type": "step/start", "turn": 1, "step": 1 }),
        json!({ "type": "assistant/message", "turn": 1, "step": 1, "content": "", "stopReason": "tool_calls",
            "provider": "p", "model": "m", "toolCalls": [call("c1", "document_read"), call("c2", "document_write")] }),
        json!({ "type": "tool/call", "turn": 1, "step": 1, "callId": "c1", "name": "document_read", "arguments": {}, "hosted": false }),
        result("c1", "document_read"),
        json!({ "type": "tool/call", "turn": 1, "step": 1, "callId": "c2", "name": "document_write", "arguments": {}, "hosted": false }),
        result("c2", "document_write"),
        json!({ "type": "step/end", "turn": 1, "step": 1 }),
        json!({ "type": "step/start", "turn": 1, "step": 2 }),
        json!({ "type": "assistant/message", "turn": 1, "step": 2, "content": "Done.", "stopReason": "stop", "provider": "p", "model": "m" }),
        json!({ "type": "step/end", "turn": 1, "step": 2 }),
        json!({ "type": "turn/end", "turn": 1, "reason": "completed" }),
        json!({ "type": "turn/start", "turn": 2 }),
        json!({ "type": "system/message", "turn": 2, "step": 1, "content": "You are Kition." }),
        json!({ "type": "user/message", "content": [{ "type": "text", "text": "Again" }], "source": { "kind": "user" } }),
    ];
    numbered(bodies)
}

/// A restored log that paused on a command approval, resumed by the
/// approval: the next request continues the open tool turn.
fn paused_log() -> Vec<SessionEvent> {
    numbered(vec![
        json!({ "type": "turn/start", "turn": 1 }),
        json!({ "type": "user/message", "content": [{ "type": "text", "text": "List files" }], "source": { "kind": "user" } }),
        json!({ "type": "step/start", "turn": 1, "step": 1 }),
        json!({ "type": "assistant/message", "turn": 1, "step": 1, "content": "", "stopReason": "tool_use", "provider": "p",
            "model": "m", "toolCalls": [{ "callId": "c1", "name": "exec_command", "arguments": { "command": "ls" } }] }),
        json!({ "type": "tool/call", "turn": 1, "step": 1, "callId": "c1", "name": "exec_command", "arguments": { "command": "ls" },
            "hosted": false }),
        json!({ "type": "tool/result", "turn": 1, "step": 1, "callId": "c1", "name": "exec_command",
            "value": { "status": "awaiting_approval" }, "content": [{ "type": "text", "text": "waiting for approval" }],
            "isError": false, "hosted": false }),
        json!({ "type": "approval/asked", "id": "approval:c1", "toolName": "exec_command", "callId": "c1" }),
        json!({ "type": "step/end", "turn": 1, "step": 1 }),
        json!({ "type": "turn/end", "turn": 1, "reason": "awaiting-approval" }),
        json!({ "type": "approval/decided", "id": "approval:c1", "outcome": "allowed-once" }),
        json!({ "type": "turn/start", "turn": 2 }),
        json!({ "type": "system/message", "turn": 2, "step": 1, "content": "You are Kition." }),
        json!({ "type": "user/message", "content": [{ "type": "text", "text": "Approved: ls" }], "source": { "kind": "approval" } }),
    ])
}

/// A loopback server that records each request body and answers 500.
fn recording_server() -> (String, Arc<Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|err| panic!("{err}"));
    let address = listener.local_addr().unwrap_or_else(|err| panic!("{err}"));
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let recorded = bodies.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().filter_map(Result::ok) {
            let mut reader = BufReader::new(stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; length];
            if reader.read_exact(&mut body).is_ok() {
                recorded
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(serde_json::from_slice(&body).unwrap_or(Value::Null));
            }
            let _ = reader.get_mut().write_all(
                b"HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
            );
        }
    });
    (format!("http://{address}"), bodies)
}

/// The request body `wire_api` sends for the derived history.
async fn request_on(wire_api: &str) -> Value {
    request_for(wire_api, &exported_log()).await
}

/// The request body `wire_api` sends for the history derived from `log`.
async fn request_for(wire_api: &str, log: &[SessionEvent]) -> Value {
    let (base_url, bodies) = recording_server();
    let engine = Engine::new(std::env::temp_dir(), None);
    let model = RuntimeModel {
        provider_type: "custom".into(),
        model_name: "m".into(),
        base_url,
        api_key: "test-key".into(),
        wire_api: wire_api.into(),
        reasoning_effort: "high".into(),
        ..RuntimeModel::default()
    };
    let messages = derive_messages_for(log, Some("m"));
    // The fake server refuses every call; only the request matters here.
    let _ = engine
        .chat_with_tools(&messages, &[], "", &model, None)
        .await;
    let body = bodies
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .first()
        .cloned();
    body.unwrap_or_else(|| panic!("{wire_api} sent no request"))
}

#[tokio::test]
async fn chat_completions_answers_each_call_right_after_it() {
    let body = request_on("chat_completions").await;
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    let roles: Vec<&str> = messages
        .iter()
        .filter_map(|message| message["role"].as_str())
        .collect();
    assert_eq!(
        roles,
        [
            "system",
            "user",
            "assistant",
            "tool",
            "tool",
            "assistant",
            "user"
        ]
    );
    let ids: Vec<&str> = messages[2]["tool_calls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .filter_map(|call| call["id"].as_str())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(ids, ["c1", "c2"]);
    assert_eq!(messages[3]["tool_call_id"], "c1");
    assert_eq!(messages[4]["tool_call_id"], "c2");
}

#[tokio::test]
async fn responses_pairs_each_function_call_with_its_output() {
    let body = request_on("responses").await;
    let items = body["input"].as_array().cloned().unwrap_or_default();
    let kinds: Vec<String> = items
        .iter()
        .map(|item| {
            item["type"]
                .as_str()
                .or(item["role"].as_str())
                .unwrap_or_default()
                .to_owned()
        })
        .collect();
    let first_call = kinds
        .iter()
        .position(|kind| kind == "function_call")
        .unwrap_or_else(|| panic!("{kinds:?}"));
    assert_eq!(
        kinds[first_call..first_call + 4],
        [
            "function_call",
            "function_call",
            "function_call_output",
            "function_call_output"
        ],
        "{kinds:?}"
    );
    assert_eq!(items[first_call]["call_id"], "c1");
    assert_eq!(items[first_call + 2]["call_id"], "c1");
    assert_eq!(items[first_call + 3]["call_id"], "c2");
    assert!(
        items
            .iter()
            .all(|item| item["type"] != "reasoning" && item.get("id").is_none()),
        "no provider item ids without their reasoning items: {items:?}"
    );
}

#[tokio::test]
async fn anthropic_with_thinking_needs_no_thinking_blocks_for_ended_turns() {
    let body = request_on("anthropic_messages").await;
    assert_eq!(body["thinking"]["type"], "enabled", "{body}");
    assert_eq!(body["system"], "You are Kition.");
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    assert!(!body["messages"].to_string().contains("thinking"), "{body}");
    let tool_use: Vec<&str> = messages[1]["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block["type"] == "tool_use")
                .filter_map(|block| block["id"].as_str())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(tool_use, ["c1", "c2"]);
    let results: Vec<&str> = messages[2..4]
        .iter()
        .map(|message| {
            message["content"][0]["tool_use_id"]
                .as_str()
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(results, ["c1", "c2"], "results follow the tool_use turn");
    // The request ends on the new user turn, not on an assistant tool_use
    // turn, so thinking is not required for any replayed assistant message.
    assert_eq!(
        messages.last().map(|message| message["role"].clone()),
        Some(json!("user"))
    );
    assert_eq!(messages[4]["role"], "assistant");
}

#[tokio::test]
async fn anthropic_resumes_a_paused_approval_with_thinking_off() {
    let body = request_for("anthropic_messages", &paused_log()).await;
    assert_eq!(body["thinking"], json!({ "type": "disabled" }), "{body}");
    assert!(body.get("output_config").is_none(), "{body}");
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    let last_assistant = messages
        .iter()
        .rposition(|message| message["role"] == "assistant")
        .unwrap_or_else(|| panic!("{body}"));
    assert_eq!(
        messages[last_assistant]["content"][0]["type"], "tool_use",
        "{body}"
    );
    assert_eq!(
        messages[last_assistant + 1]["content"][0]["type"],
        "tool_result",
        "{body}"
    );
}
