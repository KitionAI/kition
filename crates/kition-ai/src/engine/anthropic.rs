//! The Anthropic Messages wire (`POST {base}/v1/messages`), streaming and
//! not.

use std::collections::HashMap;
use std::time::Instant;

use kition_core::coerce::{as_i64, as_str};
use serde_json::{Map, Value, json};

use super::error::{AiError, AiResult};
use super::responses::content_text;
use super::transport::{
    MIB, SseLines, chat_headers, credits_exhausted, header, log_provider_failure, network_error,
    normalize_base_url, read_limited, send, set_header, status_error, usage_from,
    validate_endpoint,
};
use super::types::{
    ChatResult, HostedWebSearchCall, HostedWebSearchResult, Message, RuntimeModel, StreamEvent,
    StreamHandler, ToolCall, ToolSpec, raw_json,
};

const DEFAULT_WEB_SEARCH_TYPE: &str = "web_search_20260209";
const LEGACY_WEB_SEARCH_TYPE: &str = "web_search_20250305";
const API_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: i64 = 4096;

fn text_of(value: Option<&Value>) -> &str {
    value.map(as_str).unwrap_or_default()
}

fn trimmed(value: Option<&Value>) -> String {
    text_of(value).trim().to_owned()
}

pub(crate) fn hosted_web_search_tool(version: &str) -> Value {
    let version = version.trim();
    let kind = match version {
        "20250305" | "web_search_20250305" => LEGACY_WEB_SEARCH_TYPE,
        "20260209" | "web_search_20260209" | "" => DEFAULT_WEB_SEARCH_TYPE,
        other if other.starts_with("web_search_") => other,
        _ => DEFAULT_WEB_SEARCH_TYPE,
    };
    json!({ "type": kind, "name": "web_search" })
}

pub(crate) fn thinking_budget(effort: &str) -> i64 {
    match effort.trim().to_lowercase().as_str() {
        "low" => 1024,
        "medium" => 4096,
        "high" => 16384,
        _ => 0,
    }
}

/// A data URL as a base64 image source, or any other URL as a URL source.
fn image_source(raw: &str) -> Option<Value> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let Some(rest) = value.strip_prefix("data:") else {
        return Some(json!({ "type": "url", "url": value }));
    };
    let (header, data) = rest.split_once(',')?;
    let mut media_type = "image/png";
    let mut is_base64 = false;
    for part in header.split(';').map(str::trim) {
        if part == "base64" {
            is_base64 = true;
        } else if part.contains('/') {
            media_type = part;
        }
    }
    is_base64.then(|| json!({ "type": "base64", "media_type": media_type, "data": data }))
}

fn content_parts(message: &Message) -> Option<Vec<Value>> {
    if message.parts.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for part in &message.parts {
        match part.kind.trim() {
            "image_url" => {
                if let Some(source) = image_source(&part.image_url) {
                    parts.push(json!({ "type": "image", "source": source }));
                }
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
    let content = message.content.trim();
    if parts.is_empty() {
        if content.is_empty() {
            return None;
        }
        return Some(vec![json!({ "type": "text", "text": content })]);
    }
    let has_text = parts.iter().any(|part| part["type"] == "text");
    if !content.is_empty() && !has_text {
        parts.insert(0, json!({ "type": "text", "text": content }));
    }
    Some(parts)
}

/// System messages become the system prompt; tool results become user
/// turns.
pub(crate) fn normalize_messages(messages: &[Message]) -> (String, Vec<Value>) {
    let mut system = Vec::new();
    let mut out = Vec::new();
    for message in messages {
        let role = message.role.trim();
        let content = message.content.trim();
        if role == "system" {
            if !content.is_empty() {
                system.push(content.to_owned());
            }
            continue;
        }
        if role == "tool" {
            let call_id = message.tool_call_id.trim();
            if call_id.is_empty() {
                continue;
            }
            out.push(json!({
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": call_id, "content": content }],
            }));
            continue;
        }
        if role == "assistant" && !message.tool_calls.is_empty() {
            let mut blocks = Vec::new();
            if !content.is_empty() {
                blocks.push(json!({ "type": "text", "text": content }));
            }
            for call in &message.tool_calls {
                let (name, id) = (call.name.trim(), call.id.trim());
                if name.is_empty() || id.is_empty() {
                    continue;
                }
                let input = match serde_json::from_str::<Value>(&call.input) {
                    Ok(value) if !value.is_null() => value,
                    _ => json!({}),
                };
                blocks.push(json!({ "type": "tool_use", "id": id, "name": name, "input": input }));
            }
            if !blocks.is_empty() {
                out.push(json!({ "role": "assistant", "content": blocks }));
            }
            continue;
        }
        let role = if role == "user" || role == "assistant" {
            role
        } else {
            "user"
        };
        if let Some(parts) = content_parts(message) {
            out.push(json!({ "role": role, "content": parts }));
            continue;
        }
        if content.is_empty() {
            continue;
        }
        out.push(json!({ "role": role, "content": content }));
    }
    if out.is_empty() {
        out.push(json!({ "role": "user", "content": "Please continue." }));
    }
    (system.join("\n\n"), out)
}

fn prompt_text(items: &[Value], system: &str) -> String {
    let mut parts = Vec::new();
    if !system.is_empty() {
        parts.push(system.to_owned());
    }
    for item in items {
        let content = content_text(item.get("content"));
        if !content.is_empty() {
            parts.push(content);
        }
    }
    parts.join("\n\n")
}

fn search_results(content: Option<&Value>) -> Vec<HostedWebSearchResult> {
    content
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|entry| trimmed(entry.get("type")) == "web_search_result")
        .map(|entry| HostedWebSearchResult {
            title: trimmed(entry.get("title")),
            url: trimmed(entry.get("url")),
            snippet: trimmed(entry.get("encrypted_content")),
        })
        .collect()
}

#[derive(Default)]
struct ResultState {
    content: String,
    tool_calls: Vec<ToolCall>,
    search_calls: Vec<HostedWebSearchCall>,
    search_results: Vec<HostedWebSearchResult>,
    blocks: Vec<Value>,
}

impl ResultState {
    fn consume_block(&mut self, block: &Map<String, Value>) {
        if block.is_empty() {
            return;
        }
        self.blocks.push(Value::Object(block.clone()));
        match trimmed(block.get("type")).as_str() {
            "text" => self.content.push_str(text_of(block.get("text"))),
            "tool_use" => {
                let name = trimmed(block.get("name"));
                if name.is_empty() {
                    return;
                }
                let input = match block.get("input") {
                    Some(value) if !value.is_null() => value.to_string(),
                    _ => "{}".to_owned(),
                };
                self.tool_calls.push(ToolCall {
                    id: trimmed(block.get("id")),
                    name,
                    input,
                });
            }
            "server_tool_use" => {
                let input = block.get("input").and_then(Value::as_object).cloned();
                let query = input
                    .as_ref()
                    .map(|input| trimmed(input.get("query")))
                    .unwrap_or_default();
                self.search_calls.push(HostedWebSearchCall {
                    id: trimmed(block.get("id")),
                    status: "completed".into(),
                    query,
                    action: input,
                });
            }
            "web_search_tool_result" => {
                self.search_results
                    .extend(search_results(block.get("content")));
            }
            _ => {}
        }
    }

    fn finish(
        self,
        stop_reason: String,
        model: &str,
        usage_raw: Option<&Value>,
        prompt: &str,
        started: Instant,
    ) -> ChatResult {
        ChatResult {
            usage: usage_from(usage_raw, prompt, &self.content, started, true),
            content: self.content.trim().to_owned(),
            tool_calls: self.tool_calls,
            hosted_web_search_calls: self.search_calls,
            hosted_web_search_results: self.search_results,
            response_items: self.blocks,
            stop_reason,
            model: model.to_owned(),
            ..ChatResult::default()
        }
    }
}

fn tools_payload(tools: &[ToolSpec], search_version: &str) -> Vec<Value> {
    let mut payload = Vec::new();
    for tool in tools {
        if tool.name.trim().is_empty() {
            continue;
        }
        if tool.name == "web_search" {
            payload.push(hosted_web_search_tool(search_version));
            continue;
        }
        let schema = tool
            .input_schema
            .clone()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        payload.push(json!({
            "name": tool.name,
            "description": tool.description,
            "input_schema": schema,
        }));
    }
    payload
}

pub(crate) async fn call(
    http: &reqwest::Client,
    messages: &[Message],
    tools: &[ToolSpec],
    choice: &str,
    model: &RuntimeModel,
    stream: Option<&StreamHandler>,
) -> AiResult<ChatResult> {
    let mut headers = chat_headers(model)?;
    let version = model.anthropic_version_header.trim();
    set_header(
        &mut headers,
        "anthropic-version",
        if version.is_empty() {
            API_VERSION
        } else {
            version
        },
    );
    let base_url = normalize_base_url(&model.provider_type, &model.base_url);
    let model_name = model.model_name.trim().to_owned();
    if base_url.is_empty() || model_name.is_empty() {
        return Err(AiError::msg(
            "runtime provider is missing base_url or model_name",
        ));
    }
    let (system, items) = normalize_messages(messages);
    let payload_tools = tools_payload(tools, &model.hosted_web_search_version);
    let max_tokens = if model.max_output_tokens > 0 {
        model.max_output_tokens
    } else {
        DEFAULT_MAX_TOKENS
    };
    let mut payload = Map::new();
    payload.insert("model".into(), model_name.clone().into());
    payload.insert("messages".into(), Value::Array(items.clone()));
    payload.insert("max_tokens".into(), max_tokens.into());
    payload.insert("stream".into(), stream.is_some().into());
    if !system.is_empty() {
        payload.insert("system".into(), system.clone().into());
    }
    if !payload_tools.is_empty() {
        payload.insert("tools".into(), Value::Array(payload_tools));
    }
    if !choice.is_empty() {
        payload.insert(
            "tool_choice".into(),
            json!({ "type": "tool", "name": choice }),
        );
    }
    let effort = model.reasoning_effort.trim();
    if matches!(effort.to_lowercase().as_str(), "low" | "medium" | "high") {
        payload.insert(
            "thinking".into(),
            json!({ "type": "enabled", "budget_tokens": thinking_budget(effort) }),
        );
    }

    let endpoint = validate_endpoint(&format!("{base_url}/v1/messages"))?;
    let mut request = http.post(&endpoint).json(&Value::Object(payload));
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
        log_provider_failure(model, "anthropic_messages", &endpoint, status, &body);
        return Err(status_error(
            "runtime provider call failed",
            status,
            &retry_after,
            &body,
        ));
    }

    let prompt = prompt_text(&items, &system);
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
        let data: Map<String, Value> = serde_json::from_slice(&body)
            .map_err(|_| AiError::msg("runtime provider returned a non-JSON response"))?;
        parse_json(&data, &prompt, &model_name, started)
    };
    result.wire_api = "anthropic_messages".into();
    Ok(result)
}

pub(crate) fn parse_json(
    data: &Map<String, Value>,
    prompt: &str,
    model_name: &str,
    started: Instant,
) -> ChatResult {
    let mut state = ResultState::default();
    for block in data
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
    {
        state.consume_block(block);
    }
    state.finish(
        trimmed(data.get("stop_reason")),
        model_name,
        data.get("usage"),
        prompt,
        started,
    )
}

#[derive(Default)]
struct PendingBlock {
    kind: String,
    tool_id: String,
    tool_name: String,
    json: String,
    text: String,
    start: Map<String, Value>,
}

async fn parse_stream(
    mut lines: SseLines,
    prompt: &str,
    model_name: &str,
    started: Instant,
    stream: Option<&StreamHandler>,
) -> AiResult<ChatResult> {
    let mut state = ResultState::default();
    let mut pending: HashMap<i64, PendingBlock> = HashMap::new();
    let mut stop_reason = String::new();
    let mut usage_raw: Option<Value> = None;
    let mut events = 0;
    let emit = |event: StreamEvent| {
        if let Some(stream) = stream {
            stream(event);
        }
    };
    while let Some(data) = lines.next_data().await? {
        if data == "[DONE]" {
            continue;
        }
        let Ok(Value::Object(payload)) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        events += 1;
        let index = as_i64(payload.get("index").unwrap_or(&Value::Null));
        match trimmed(payload.get("type")).as_str() {
            "message_start" => {
                if let Some(usage) = payload
                    .get("message")
                    .and_then(|message| message.get("usage"))
                {
                    usage_raw = Some(usage.clone());
                }
            }
            "content_block_start" => {
                let block = payload
                    .get("content_block")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let mut entry = PendingBlock {
                    kind: trimmed(block.get("type")),
                    ..PendingBlock::default()
                };
                match entry.kind.as_str() {
                    "tool_use" => {
                        entry.tool_id = trimmed(block.get("id"));
                        entry.tool_name = trimmed(block.get("name"));
                        emit(StreamEvent {
                            kind: "tool_call_delta",
                            tool_call_index: index,
                            tool_call_id: entry.tool_id.clone(),
                            tool_name: entry.tool_name.clone(),
                            ..StreamEvent::default()
                        });
                    }
                    "server_tool_use" => {
                        entry.tool_id = trimmed(block.get("id"));
                        entry.tool_name = trimmed(block.get("name"));
                    }
                    "web_search_tool_result" => {
                        state
                            .search_results
                            .extend(search_results(block.get("content")));
                    }
                    _ => {}
                }
                entry.start = block;
                pending.insert(index, entry);
            }
            "content_block_delta" => {
                let delta = payload
                    .get("delta")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let entry = pending.get_mut(&index);
                match trimmed(delta.get("type")).as_str() {
                    "text_delta" => {
                        let text = text_of(delta.get("text"));
                        if text.is_empty() {
                            continue;
                        }
                        state.content.push_str(text);
                        if let Some(entry) = entry {
                            entry.text.push_str(text);
                        }
                        emit(StreamEvent {
                            kind: "delta",
                            delta: text.to_owned(),
                            ..StreamEvent::default()
                        });
                    }
                    "input_json_delta" => {
                        let partial = text_of(delta.get("partial_json"));
                        let Some(entry) = entry else { continue };
                        if partial.is_empty() {
                            continue;
                        }
                        entry.json.push_str(partial);
                        if entry.kind == "tool_use" {
                            emit(StreamEvent {
                                kind: "tool_call_delta",
                                tool_call_index: index,
                                tool_call_id: entry.tool_id.clone(),
                                tool_name: entry.tool_name.clone(),
                                tool_arguments_delta: partial.to_owned(),
                                ..StreamEvent::default()
                            });
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let Some(entry) = pending.remove(&index) else {
                    continue;
                };
                match entry.kind.as_str() {
                    "text" => {
                        if !entry.text.is_empty() {
                            state
                                .blocks
                                .push(json!({ "type": "text", "text": entry.text }));
                        }
                    }
                    "tool_use" => {
                        let args = if entry.json.is_empty() {
                            "{}".to_owned()
                        } else {
                            entry.json
                        };
                        state.tool_calls.push(ToolCall {
                            id: entry.tool_id.clone(),
                            name: entry.tool_name.clone(),
                            input: args.clone(),
                        });
                        state.blocks.push(json!({
                            "type": "tool_use",
                            "id": entry.tool_id,
                            "name": entry.tool_name,
                            "input": raw_json(&args),
                        }));
                        emit(StreamEvent {
                            kind: "tool_call_ready",
                            tool_call_index: index,
                            tool_call_id: entry.tool_id,
                            tool_name: entry.tool_name,
                            tool_arguments: args,
                            ..StreamEvent::default()
                        });
                    }
                    "server_tool_use" => {
                        let input = if entry.json.is_empty() {
                            None
                        } else {
                            serde_json::from_str::<Map<String, Value>>(&entry.json).ok()
                        };
                        let query = input
                            .as_ref()
                            .map(|input| trimmed(input.get("query")))
                            .unwrap_or_default();
                        state.search_calls.push(HostedWebSearchCall {
                            id: entry.tool_id.clone(),
                            status: "completed".into(),
                            query,
                            action: input.clone(),
                        });
                        state.blocks.push(json!({
                            "type": "server_tool_use",
                            "id": entry.tool_id,
                            "name": entry.tool_name,
                            "input": input.map(Value::Object).unwrap_or(Value::Null),
                        }));
                        emit(StreamEvent {
                            kind: "tool_call_ready",
                            tool_call_index: index,
                            tool_call_id: entry.tool_id,
                            tool_name: "web_search".into(),
                            tool_arguments: entry.json,
                            ..StreamEvent::default()
                        });
                    }
                    "web_search_tool_result" => {
                        state.blocks.push(Value::Object(entry.start));
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                let reason = payload
                    .get("delta")
                    .map(|delta| trimmed(delta.get("stop_reason")))
                    .unwrap_or_default();
                if !reason.is_empty() {
                    stop_reason = reason;
                }
                if let Some(usage) = payload.get("usage") {
                    usage_raw = Some(usage.clone());
                }
            }
            _ => {}
        }
    }
    if events == 0 {
        return Err(AiError::msg(
            "runtime provider did not return any valid stream data",
        ));
    }
    Ok(state.finish(stop_reason, model_name, usage_raw.as_ref(), prompt, started))
}

#[cfg(test)]
mod tests {
    use super::super::types::MessagePart;
    use super::*;

    #[test]
    fn normalizes_messages() {
        let messages = vec![
            Message::new("system", "sys"),
            Message {
                role: "assistant".into(),
                content: "thinking".into(),
                tool_calls: vec![ToolCall {
                    id: "t1".into(),
                    name: "read".into(),
                    input: "not json".into(),
                }],
                ..Message::default()
            },
            Message {
                role: "tool".into(),
                tool_call_id: "t1".into(),
                content: "ok".into(),
                ..Message::default()
            },
            Message {
                role: "user".into(),
                parts: vec![MessagePart {
                    kind: "image_url".into(),
                    image_url: "data:image/jpeg;base64,QQ==".into(),
                    ..MessagePart::default()
                }],
                ..Message::default()
            },
        ];
        let (system, items) = normalize_messages(&messages);
        assert_eq!(system, "sys");
        assert_eq!(items[0]["content"][1]["input"], json!({}));
        assert_eq!(items[1]["content"][0]["type"], "tool_result");
        assert_eq!(
            items[2]["content"][0]["source"],
            json!({ "type": "base64", "media_type": "image/jpeg", "data": "QQ==" })
        );
        assert!(image_source("data:image/png,raw").is_none());
    }

    #[test]
    fn parses_message_blocks() {
        let data = json!({
            "content": [
                { "type": "text", "text": "Hello " },
                { "type": "tool_use", "id": "t", "name": "f", "input": { "a": 1 } },
                { "type": "server_tool_use", "id": "s", "input": { "query": "q" } },
                { "type": "web_search_tool_result", "content": [
                    { "type": "web_search_result", "title": "T", "url": "U", "encrypted_content": "E" }
                ] },
            ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 3, "output_tokens": 4, "cache_read_input_tokens": 5 },
        });
        let result = parse_json(
            data.as_object().unwrap_or(&Map::new()),
            "p",
            "claude",
            Instant::now(),
        );
        assert_eq!(result.content, "Hello");
        assert_eq!(result.tool_calls[0].input, r#"{"a":1}"#);
        assert_eq!(result.hosted_web_search_calls[0].query, "q");
        assert_eq!(result.hosted_web_search_results[0].snippet, "E");
        assert_eq!(result.usage.total_tokens, 12);
        assert_eq!(result.response_items.len(), 4);
    }

    #[test]
    fn picks_web_search_tool_versions() {
        assert_eq!(
            hosted_web_search_tool("20250305")["type"],
            LEGACY_WEB_SEARCH_TYPE
        );
        assert_eq!(
            hosted_web_search_tool("web_search_29990101")["type"],
            "web_search_29990101"
        );
        assert_eq!(
            hosted_web_search_tool("bogus")["type"],
            DEFAULT_WEB_SEARCH_TYPE
        );
        assert_eq!(thinking_budget("HIGH"), 16384);
    }
}
