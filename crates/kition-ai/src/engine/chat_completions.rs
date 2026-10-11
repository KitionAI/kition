//! The OpenAI Chat Completions wire (`POST {base}/chat/completions`),
//! streaming and not. Any OpenAI-compatible provider speaks it. No
//! reasoning parameters are sent: providers disagree on their shape.

use std::collections::BTreeMap;
use std::time::Instant;

use kition_core::coerce::{as_i64, as_str};
use serde_json::{Map, Value, json};

use super::error::{AiError, AiResult};
use super::transport::{
    MIB, SseLines, chat_headers, credits_exhausted, header, log_provider_failure, network_error,
    normalize_base_url, read_limited, send, status_error, usage_from, validate_endpoint,
};
use super::types::{
    ChatResult, Message, RuntimeModel, StreamEvent, StreamHandler, ToolCall, ToolSpec, Usage,
};

const WIRE: &str = "chat_completions";
/// The `raw_items` entry that carries a thinking model's reasoning text
/// back to the provider (DeepSeek and Kimi require it in tool loops).
const REASONING_ITEM: &str = "reasoning_content";

fn text_of(value: Option<&Value>) -> &str {
    value.map(as_str).unwrap_or_default()
}

/// `text`/`image_url` parts, or `None` when the message should be sent as
/// plain string content.
fn content_parts(message: &Message) -> Option<Vec<Value>> {
    if message.parts.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for part in &message.parts {
        match part.kind.trim() {
            "image_url" => {
                let url = part.image_url.trim();
                if url.is_empty() {
                    continue;
                }
                let mut image = Map::new();
                image.insert("url".into(), url.into());
                if !part.detail.trim().is_empty() {
                    image.insert("detail".into(), part.detail.trim().into());
                }
                parts.push(json!({ "type": "image_url", "image_url": image }));
            }
            "text" | "input_text" | "" => {
                let text = part.text.trim();
                if !text.is_empty() {
                    parts.push(json!({ "type": "text", "text": text }));
                }
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        return None;
    }
    let content = message.content.trim();
    let has_text = parts.iter().any(|part| part["type"] == "text");
    if !content.is_empty() && !has_text {
        parts.insert(0, json!({ "type": "text", "text": content }));
    }
    Some(parts)
}

/// The reasoning text a previous response left in `raw_items`.
fn reasoning_of(message: &Message) -> String {
    message
        .raw_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some(REASONING_ITEM))
        .map(|item| text_of(item.get("text")))
        .collect()
}

/// All system messages become one leading system message; tool results
/// become `tool` messages.
pub(crate) fn build_messages(messages: &[Message]) -> Vec<Value> {
    let mut system = Vec::new();
    let mut out = Vec::new();
    for message in messages {
        let role = message.role.trim();
        let content = message.content.trim();
        match role {
            "system" => {
                if !content.is_empty() {
                    system.push(content.to_owned());
                }
            }
            "tool" => {
                let id = message.tool_call_id.trim();
                if !id.is_empty() {
                    out.push(json!({ "role": "tool", "tool_call_id": id, "content": content }));
                }
            }
            "assistant" => {
                let calls: Vec<Value> = message
                    .tool_calls
                    .iter()
                    .filter(|call| !call.id.trim().is_empty() && !call.name.trim().is_empty())
                    .map(|call| {
                        let arguments = if call.input.trim().is_empty() {
                            "{}"
                        } else {
                            call.input.as_str()
                        };
                        json!({
                            "id": call.id.trim(),
                            "type": "function",
                            "function": { "name": call.name.trim(), "arguments": arguments },
                        })
                    })
                    .collect();
                if calls.is_empty() && content.is_empty() {
                    continue;
                }
                let mut entry = Map::new();
                entry.insert("role".into(), "assistant".into());
                entry.insert(
                    "content".into(),
                    if content.is_empty() {
                        Value::Null
                    } else {
                        content.into()
                    },
                );
                let reasoning = reasoning_of(message);
                if !reasoning.is_empty() {
                    entry.insert("reasoning_content".into(), reasoning.into());
                }
                if !calls.is_empty() {
                    entry.insert("tool_calls".into(), Value::Array(calls));
                }
                out.push(Value::Object(entry));
            }
            _ => {
                if let Some(parts) = content_parts(message) {
                    out.push(json!({ "role": "user", "content": parts }));
                } else if !content.is_empty() {
                    out.push(json!({ "role": "user", "content": content }));
                }
            }
        }
    }
    if out.is_empty() {
        out.push(json!({ "role": "user", "content": "Please continue." }));
    }
    if !system.is_empty() {
        out.insert(
            0,
            json!({ "role": "system", "content": system.join("\n\n") }),
        );
    }
    out
}

fn prompt_text(messages: &[Value]) -> String {
    messages
        .iter()
        .map(|message| super::responses::content_text(message.get("content")))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn function_tools(tools: &[ToolSpec]) -> Vec<Value> {
    tools
        .iter()
        .filter(|tool| !tool.name.trim().is_empty())
        .map(|tool| {
            let parameters = tool
                .input_schema
                .clone()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            json!({
                "type": "function",
                "function": {
                    "name": tool.name.trim(),
                    "description": tool.description,
                    "parameters": parameters,
                },
            })
        })
        .collect()
}

pub(crate) fn request_body(
    model: &RuntimeModel,
    messages: Vec<Value>,
    tools: &[ToolSpec],
    choice: &str,
    streaming: bool,
) -> Value {
    let mut payload = Map::new();
    payload.insert("model".into(), model.model_name.trim().into());
    payload.insert("messages".into(), Value::Array(messages));
    payload.insert("stream".into(), streaming.into());
    if streaming {
        payload.insert("stream_options".into(), json!({ "include_usage": true }));
    }
    let tools = function_tools(tools);
    if !tools.is_empty() {
        payload.insert("tools".into(), Value::Array(tools));
    }
    let choice = choice.trim();
    if !choice.is_empty() {
        payload.insert(
            "tool_choice".into(),
            json!({ "type": "function", "function": { "name": choice } }),
        );
    }
    if model.max_output_tokens > 0 {
        payload.insert("max_tokens".into(), model.max_output_tokens.into());
    }
    Value::Object(payload)
}

/// A tool call being assembled from streamed fragments.
#[derive(Default)]
struct PendingCall {
    id: String,
    name: String,
    arguments: String,
}

/// The in-progress result of a streamed (or buffered) completion.
#[derive(Default)]
pub(crate) struct State {
    content: String,
    reasoning: String,
    calls: BTreeMap<i64, PendingCall>,
    stop_reason: String,
    usage: Option<Value>,
    announced: bool,
    chunks: usize,
}

impl State {
    /// Emits `tool_call_ready` for every call, in index order, once.
    fn announce(&mut self, stream: Option<&StreamHandler>) {
        if self.announced {
            return;
        }
        self.announced = true;
        let Some(stream) = stream else { return };
        for (index, call) in &self.calls {
            if call.name.is_empty() {
                continue;
            }
            stream(StreamEvent {
                kind: "tool_call_ready",
                tool_call_index: *index,
                tool_call_id: call_id(*index, call),
                tool_name: call.name.clone(),
                tool_arguments: arguments(call),
                ..StreamEvent::default()
            });
        }
    }

    fn finish(
        mut self,
        stream: Option<&StreamHandler>,
        prompt: &str,
        model_name: &str,
        started: Instant,
    ) -> ChatResult {
        self.announce(stream);
        let content = self.content.trim().to_owned();
        let usage = match self.usage.as_ref() {
            Some(Value::Object(raw)) => {
                let int = |key: &str| as_i64(raw.get(key).unwrap_or(&Value::Null));
                let (prompt_tokens, completion_tokens) =
                    (int("prompt_tokens"), int("completion_tokens"));
                let total = int("total_tokens");
                Usage {
                    prompt_tokens,
                    completion_tokens,
                    total_tokens: if total == 0 {
                        prompt_tokens + completion_tokens
                    } else {
                        total
                    },
                    response_time_ms: super::transport::elapsed_ms(started),
                    ..Usage::default()
                }
            }
            _ => usage_from(None, prompt, &content, started, false),
        };
        let tool_calls = self
            .calls
            .iter()
            .filter(|(_, call)| !call.name.is_empty())
            .map(|(index, call)| ToolCall {
                id: call_id(*index, call),
                name: call.name.clone(),
                input: arguments(call),
            })
            .collect();
        let response_items = if self.reasoning.trim().is_empty() {
            Vec::new()
        } else {
            vec![json!({ "type": REASONING_ITEM, "text": self.reasoning })]
        };
        ChatResult {
            content,
            tool_calls,
            response_items,
            stop_reason: self.stop_reason,
            model: model_name.to_owned(),
            usage,
            ..ChatResult::default()
        }
    }
}

/// Some OpenAI-compatible servers omit call ids; tool results still need
/// one to pair with the call.
fn call_id(index: i64, call: &PendingCall) -> String {
    if call.id.is_empty() {
        format!("call_{index}")
    } else {
        call.id.clone()
    }
}

fn arguments(call: &PendingCall) -> String {
    if call.arguments.trim().is_empty() {
        "{}".to_owned()
    } else {
        call.arguments.clone()
    }
}

/// Applies one decoded stream chunk to the in-progress result.
pub(crate) fn apply_chunk(chunk: &Value, state: &mut State, stream: Option<&StreamHandler>) {
    state.chunks += 1;
    if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
        state.usage = Some(usage.clone());
    }
    let Some(choice) = chunk
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return;
    };
    if let Some(delta) = choice.get("delta") {
        let text = text_of(delta.get("content"));
        if !text.is_empty() {
            state.content.push_str(text);
            if let Some(stream) = stream {
                stream(StreamEvent {
                    kind: "delta",
                    delta: text.to_owned(),
                    ..StreamEvent::default()
                });
            }
        }
        state
            .reasoning
            .push_str(text_of(delta.get("reasoning_content")));
        for fragment in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = as_i64(fragment.get("index").unwrap_or(&Value::Null));
            let call = state.calls.entry(index).or_default();
            let id = text_of(fragment.get("id")).trim();
            if !id.is_empty() {
                call.id = id.to_owned();
            }
            let function = fragment.get("function");
            let name = text_of(function.and_then(|f| f.get("name"))).trim();
            if !name.is_empty() {
                call.name = name.to_owned();
            }
            let piece = text_of(function.and_then(|f| f.get("arguments")));
            call.arguments.push_str(piece);
            if let Some(stream) = stream {
                stream(StreamEvent {
                    kind: "tool_call_delta",
                    tool_call_index: index,
                    tool_call_id: call_id(index, call),
                    tool_name: call.name.clone(),
                    tool_arguments_delta: piece.to_owned(),
                    ..StreamEvent::default()
                });
            }
        }
    }
    let reason = text_of(choice.get("finish_reason")).trim();
    if !reason.is_empty() {
        state.stop_reason = reason.to_owned();
        state.announce(stream);
    }
}

/// A buffered completion: the same mapping from `choices[0].message`.
pub(crate) fn parse_json(
    data: &Value,
    prompt: &str,
    model_name: &str,
    started: Instant,
) -> ChatResult {
    let mut state = State::default();
    if let Some(usage) = data.get("usage").filter(|usage| usage.is_object()) {
        state.usage = Some(usage.clone());
    }
    let choice = data
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    if let Some(choice) = choice {
        let message = choice.get("message");
        let field = |key: &str| text_of(message.and_then(|m| m.get(key))).to_owned();
        state.content = field("content");
        state.reasoning = field("reasoning_content");
        let calls = message
            .and_then(|m| m.get("tool_calls"))
            .and_then(Value::as_array);
        for (position, call) in calls.into_iter().flatten().enumerate() {
            let function = call.get("function");
            state.calls.insert(
                position as i64,
                PendingCall {
                    id: text_of(call.get("id")).trim().to_owned(),
                    name: text_of(function.and_then(|f| f.get("name")))
                        .trim()
                        .to_owned(),
                    arguments: text_of(function.and_then(|f| f.get("arguments"))).to_owned(),
                },
            );
        }
        state.stop_reason = text_of(choice.get("finish_reason")).trim().to_owned();
    }
    state.finish(None, prompt, model_name, started)
}

pub(crate) async fn call(
    http: &reqwest::Client,
    messages: &[Message],
    tools: &[ToolSpec],
    choice: &str,
    model: &RuntimeModel,
    stream: Option<&StreamHandler>,
) -> AiResult<ChatResult> {
    let headers = chat_headers(model)?;
    let base_url = normalize_base_url(&model.provider_type, &model.base_url);
    let model_name = model.model_name.trim().to_owned();
    if base_url.is_empty() || model_name.is_empty() {
        return Err(AiError::msg(
            "runtime provider is missing base_url or model_name",
        ));
    }
    let items = build_messages(messages);
    let prompt = prompt_text(&items);
    let payload = request_body(model, items, tools, choice, stream.is_some());

    let endpoint = validate_endpoint(&format!("{base_url}/chat/completions"))?;
    let mut request = http.post(&endpoint).json(&payload);
    for (key, value) in &headers {
        request = request.header(key, value);
    }
    let accept = if stream.is_some() {
        "text/event-stream"
    } else {
        "application/json"
    };
    request = request.header("Accept", accept);
    let started = Instant::now();
    let response = send(request, stream.is_some())
        .await
        .map_err(|failure| network_error("runtime provider call failed", &endpoint, &failure))?;
    let status = response.status().as_u16();
    if status == 402 {
        let body = read_limited(response, 4 * MIB).await.unwrap_or_default();
        return Err(credits_exhausted(&body));
    }
    if status >= 400 {
        let retry_after = header(&response, "Retry-After");
        let body = read_limited(response, 4 * MIB)
            .await
            .map_err(|_| AiError::msg("failed to read runtime provider response"))?;
        log_provider_failure(model, WIRE, &endpoint, status, &body);
        return Err(status_error(
            "runtime provider call failed",
            status,
            &retry_after,
            &body,
        ));
    }

    let content_type = header(&response, "Content-Type").to_lowercase();
    let mut result = if stream.is_some() && content_type.contains("text/event-stream") {
        parse_stream(
            SseLines::new(response),
            &prompt,
            &model_name,
            started,
            stream,
        )
        .await?
    } else {
        let body = read_limited(response, 8 * MIB)
            .await
            .map_err(|_| AiError::msg("failed to read runtime provider response"))?;
        let data: Value = serde_json::from_slice(&body)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| AiError::msg("runtime provider returned a non-JSON response"))?;
        parse_json(&data, &prompt, &model_name, started)
    };
    result.wire_api = WIRE.into();
    Ok(result)
}

async fn parse_stream(
    mut lines: SseLines,
    prompt: &str,
    model_name: &str,
    started: Instant,
    stream: Option<&StreamHandler>,
) -> AiResult<ChatResult> {
    let mut state = State::default();
    while let Some(data) = lines.next_data().await? {
        if data == "[DONE]" {
            break;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if !chunk.is_object() {
            continue;
        }
        if let Some(error) = chunk.get("error").filter(|error| !error.is_null()) {
            let body = json!({ "error": error }).to_string();
            return Err(status_error(
                "runtime provider stream failed",
                0,
                "",
                body.as_bytes(),
            ));
        }
        apply_chunk(&chunk, &mut state, stream);
    }
    if state.chunks == 0 {
        return Err(AiError::msg(
            "runtime provider did not return any valid stream data",
        ));
    }
    Ok(state.finish(stream, prompt, model_name, started))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::super::types::{MessagePart, StreamEvent, ToolCall};
    use super::*;

    #[test]
    fn builds_chat_messages() {
        let messages = vec![
            Message::new("system", " be brief "),
            Message::new("system", "use tools"),
            Message::new("user", "hello"),
            Message {
                role: "user".into(),
                content: "see".into(),
                parts: vec![
                    MessagePart {
                        kind: "text".into(),
                        text: "look at this".into(),
                        ..MessagePart::default()
                    },
                    MessagePart {
                        kind: "image_url".into(),
                        image_url: "data:image/png;base64,AA".into(),
                        ..MessagePart::default()
                    },
                ],
                ..Message::default()
            },
            Message {
                role: "assistant".into(),
                tool_calls: vec![
                    ToolCall {
                        id: "c1".into(),
                        name: "read".into(),
                        input: r#"{"p":1}"#.into(),
                    },
                    ToolCall {
                        id: "c2".into(),
                        name: "list".into(),
                        input: String::new(),
                    },
                ],
                raw_items: vec![json!({ "type": "reasoning_content", "text": "plan it" })],
                ..Message::default()
            },
            Message {
                role: "tool".into(),
                tool_call_id: "c1".into(),
                content: "result".into(),
                ..Message::default()
            },
            Message {
                role: "tool".into(),
                tool_call_id: " ".into(),
                content: "orphan".into(),
                ..Message::default()
            },
            Message::new("assistant", "Done."),
        ];
        assert_eq!(
            build_messages(&messages),
            vec![
                json!({ "role": "system", "content": "be brief\n\nuse tools" }),
                json!({ "role": "user", "content": "hello" }),
                json!({ "role": "user", "content": [
                    { "type": "text", "text": "look at this" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AA" } },
                ] }),
                json!({
                    "role": "assistant",
                    "content": null,
                    "reasoning_content": "plan it",
                    "tool_calls": [
                        { "id": "c1", "type": "function", "function": { "name": "read", "arguments": r#"{"p":1}"# } },
                        { "id": "c2", "type": "function", "function": { "name": "list", "arguments": "{}" } },
                    ],
                }),
                json!({ "role": "tool", "tool_call_id": "c1", "content": "result" }),
                json!({ "role": "assistant", "content": "Done." }),
            ]
        );
    }

    fn recorder() -> (StreamHandler, Arc<Mutex<Vec<StreamEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let handler: StreamHandler = Arc::new(move |event| {
            sink.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(event);
        });
        (handler, events)
    }

    #[test]
    fn accumulates_streamed_chunks() {
        let chunks = [
            json!({ "choices": [{ "index": 0, "delta": { "role": "assistant", "reasoning_content": "Think " } }] }),
            json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": "hard." } }] }),
            json!({ "choices": [{ "index": 0, "delta": { "content": "Hel" } }] }),
            json!({ "choices": [{ "index": 0, "delta": { "content": "lo" } }] }),
            json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
                { "index": 0, "id": "call_a", "type": "function", "function": { "name": "read", "arguments": "" } },
            ] } }] }),
            json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
                { "index": 0, "function": { "arguments": "{\"pa" } },
            ] } }] }),
            json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
                { "index": 1, "id": "call_b", "type": "function", "function": { "name": "write", "arguments": "{\"x\":" } },
            ] } }] }),
            json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
                { "index": 0, "function": { "arguments": "th\":1}" } },
                { "index": 1, "function": { "arguments": "2}" } },
            ] } }] }),
            json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }] }),
            json!({ "choices": [], "usage": { "prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18 } }),
        ];
        let (handler, events) = recorder();
        let mut state = State::default();
        for chunk in &chunks {
            apply_chunk(chunk, &mut state, Some(&handler));
        }
        let result = state.finish(Some(&handler), "prompt", "kimi", Instant::now());
        assert_eq!(result.content, "Hello");
        assert_eq!(
            result.tool_calls,
            vec![
                ToolCall {
                    id: "call_a".into(),
                    name: "read".into(),
                    input: r#"{"path":1}"#.into(),
                },
                ToolCall {
                    id: "call_b".into(),
                    name: "write".into(),
                    input: r#"{"x":2}"#.into(),
                },
            ]
        );
        assert_eq!(result.stop_reason, "tool_calls");
        assert_eq!(result.model, "kimi");
        assert_eq!(
            (
                result.usage.prompt_tokens,
                result.usage.completion_tokens,
                result.usage.total_tokens
            ),
            (11, 7, 18)
        );
        assert_eq!(
            result.response_items,
            vec![json!({ "type": "reasoning_content", "text": "Think hard." })]
        );
        let events = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let kinds: Vec<&str> = events.iter().map(|event| event.kind).collect();
        assert_eq!(
            kinds,
            vec![
                "delta",
                "delta",
                "tool_call_delta",
                "tool_call_delta",
                "tool_call_delta",
                "tool_call_delta",
                "tool_call_delta",
                "tool_call_ready",
                "tool_call_ready",
            ]
        );
        let ready: Vec<(i64, &str, &str, &str)> = events
            .iter()
            .filter(|event| event.kind == "tool_call_ready")
            .map(|event| {
                (
                    event.tool_call_index,
                    event.tool_call_id.as_str(),
                    event.tool_name.as_str(),
                    event.tool_arguments.as_str(),
                )
            })
            .collect();
        assert_eq!(
            ready,
            vec![
                (0, "call_a", "read", r#"{"path":1}"#),
                (1, "call_b", "write", r#"{"x":2}"#),
            ]
        );
        assert_eq!(events[4].tool_call_id, "call_b");
        assert_eq!(events[4].tool_arguments_delta, "{\"x\":");
    }

    #[test]
    fn estimates_usage_and_skips_reasoning_items_when_absent() {
        let mut state = State::default();
        apply_chunk(
            &json!({ "choices": [{ "delta": { "content": "Hi" }, "finish_reason": "stop" }] }),
            &mut state,
            None,
        );
        let result = state.finish(None, "prompt", "m", Instant::now());
        assert_eq!(result.content, "Hi");
        assert_eq!(result.stop_reason, "stop");
        assert!(result.response_items.is_empty());
        assert!(result.tool_calls.is_empty());
        assert_eq!(result.usage.total_tokens, 8 + 16);
    }

    #[test]
    fn parses_json_responses() {
        let data = json!({
            "id": "x",
            "choices": [{
                "index": 0,
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": " Calling ",
                    "reasoning_content": "Need data.",
                    "tool_calls": [
                        { "id": "c1", "type": "function", "function": { "name": "read", "arguments": "{\"a\":1}" } },
                        { "id": "c2", "type": "function", "function": { "name": "list", "arguments": "" } },
                    ],
                },
            }],
            "usage": { "prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8 },
        });
        let result = parse_json(&data, "prompt", "kimi", Instant::now());
        assert_eq!(result.content, "Calling");
        assert_eq!(result.stop_reason, "tool_calls");
        assert_eq!(result.tool_calls.len(), 2);
        assert_eq!(result.tool_calls[0].input, r#"{"a":1}"#);
        assert_eq!(result.tool_calls[1].input, "{}");
        assert_eq!(result.usage.total_tokens, 8);
        assert_eq!(
            result.response_items,
            vec![json!({ "type": "reasoning_content", "text": "Need data." })]
        );
    }

    #[test]
    fn builds_the_request_body() {
        let model = RuntimeModel {
            model_name: "kimi-k2".into(),
            max_output_tokens: 2048,
            reasoning_effort: "high".into(),
            ..RuntimeModel::default()
        };
        let tools = vec![
            ToolSpec {
                name: "read".into(),
                description: "Read a file".into(),
                input_schema: Some(
                    json!({ "type": "object", "properties": { "p": { "type": "string" } } }),
                ),
            },
            ToolSpec {
                name: "list".into(),
                description: "List".into(),
                input_schema: None,
            },
        ];
        let body = request_body(&model, vec![], &tools, "read", true);
        assert_eq!(body["model"], "kimi-k2");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"], json!({ "include_usage": true }));
        assert_eq!(body["max_tokens"], 2048);
        assert_eq!(
            body["tool_choice"],
            json!({ "type": "function", "function": { "name": "read" } })
        );
        assert_eq!(
            body["tools"][1],
            json!({ "type": "function", "function": {
                "name": "list", "description": "List",
                "parameters": { "type": "object", "properties": {} },
            } })
        );
        assert!(body.get("reasoning").is_none());
        assert!(body.get("reasoning_effort").is_none());
        let plain = request_body(&RuntimeModel::default(), vec![], &[], "", false);
        assert_eq!(plain["stream"], false);
        for absent in ["stream_options", "tools", "tool_choice", "max_tokens"] {
            assert!(plain.get(absent).is_none(), "{absent} should be omitted");
        }
    }
}
