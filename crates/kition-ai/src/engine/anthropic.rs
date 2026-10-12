//! The Anthropic Messages wire (`POST {base}/v1/messages`), streaming and
//! not.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use kition_core::coerce::{as_i64, as_str};
use serde_json::{Map, Value, json};

use super::error::{AiError, AiResult};
use super::responses::content_text;
use super::transport::{
    MIB, SseLines, chat_headers, credits_exhausted, header, json_request, log_provider_failure,
    network_error, normalize_base_url, read_limited, send, set_header, status_error, usage_from,
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

/// Reasoning request fields. DeepSeek's Messages API takes both
/// `thinking.type = enabled` and `output_config.effort` (`low`, `high`,
/// `max`) together for any non-off effort, and `thinking.type = disabled`
/// alone for off, as DeepSeek Harness's adapter sends them; Anthropic takes
/// a thinking token budget.
pub(crate) fn reasoning_fields(model: &RuntimeModel) -> Vec<(&'static str, Value)> {
    let effort = model.reasoning_effort.trim().to_lowercase();
    if model.provider_type.trim() == "deepseek" {
        let configured = match effort.as_str() {
            "" => return Vec::new(),
            "off" | "none" | "minimal" => return vec![("thinking", json!({ "type": "disabled" }))],
            "low" => "low",
            "max" | "xhigh" => "max",
            _ => "high",
        };
        return vec![
            ("thinking", json!({ "type": "enabled" })),
            ("output_config", json!({ "effort": configured })),
        ];
    }
    if matches!(effort.as_str(), "low" | "medium" | "high") {
        vec![(
            "thinking",
            json!({ "type": "enabled", "budget_tokens": thinking_budget(&effort) }),
        )]
    } else {
        Vec::new()
    }
}

fn has_block(item: &Value, kinds: &[&str]) -> bool {
    item["content"].as_array().is_some_and(|blocks| {
        blocks.iter().any(|block| {
            block["type"]
                .as_str()
                .is_some_and(|kind| kinds.contains(&kind))
        })
    })
}

/// Whether the request continues a tool turn whose assistant message has no
/// thinking block: the last assistant message calls tools without one, and
/// the user content after it answers with a `tool_result`. A log restored
/// without provider-native items (a paused approval) ends like this.
fn open_tool_turn_lacks_thinking(items: &[Value]) -> bool {
    let Some(last) = items.iter().rposition(|item| item["role"] == "assistant") else {
        return false;
    };
    has_block(&items[last], &["tool_use"])
        && !has_block(&items[last], &["thinking", "redacted_thinking"])
        && items
            .get(last + 1)
            .is_some_and(|next| next["role"] == "user" && has_block(next, &["tool_result"]))
}

/// The reasoning fields of one request. With thinking on, the API refuses an
/// open tool turn whose assistant message lacks a thinking block, so that
/// request goes with thinking off.
fn request_reasoning(model: &RuntimeModel, items: &[Value]) -> Vec<(&'static str, Value)> {
    let reasoning = reasoning_fields(model);
    let enabled = reasoning
        .iter()
        .any(|(key, value)| *key == "thinking" && value["type"] == "enabled");
    if enabled && open_tool_turn_lacks_thinking(items) {
        return vec![("thinking", json!({ "type": "disabled" }))];
    }
    reasoning
}

/// `max_tokens` large enough for the configured reasoning budget. Anthropic
/// requires `max_tokens` to exceed `thinking.budget_tokens`, so the budget
/// gets headroom on top; DeepSeek's Messages API needs a generous ceiling
/// whenever thinking is enabled, regardless of effort. An explicit
/// `max_output_tokens` from the model wins when it is already larger.
fn resolve_max_tokens(model: &RuntimeModel, reasoning: &[(&'static str, Value)]) -> i64 {
    let base = if model.max_output_tokens > 0 {
        model.max_output_tokens
    } else {
        DEFAULT_MAX_TOKENS
    };
    if model.provider_type.trim() == "deepseek" {
        let thinking_enabled = reasoning.iter().any(|(key, _)| *key == "output_config");
        return if thinking_enabled {
            base.max(32768)
        } else {
            base
        };
    }
    let budget = reasoning
        .iter()
        .find(|(key, _)| *key == "thinking")
        .and_then(|(_, value)| value.get("budget_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if budget > 0 {
        base.max(budget + 4096)
    } else {
        base
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

/// Reasoning blocks from an earlier response, replayed verbatim before the
/// assistant's text and tool calls (DeepSeek and Anthropic thinking).
fn thinking_blocks(message: &Message) -> Vec<Value> {
    message
        .raw_items
        .iter()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("thinking" | "redacted_thinking")
            )
        })
        .cloned()
        .collect()
}

/// When `raw_items` contain a thinking or redacted-thinking block and every
/// tool call id is present as a `tool_use` block id in `raw_items`, the
/// original item order (thinking interleaved with tool calls, as captured
/// from the provider) is replayed verbatim instead of being reconstructed
/// with thinking first, then text, then tool calls.
fn replay_raw_items_verbatim(message: &Message) -> Option<Vec<Value>> {
    if message.tool_calls.is_empty() {
        return None;
    }
    let has_thinking = message.raw_items.iter().any(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("thinking" | "redacted_thinking")
        )
    });
    if !has_thinking {
        return None;
    }
    let tool_use_ids: HashSet<&str> = message
        .raw_items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect();
    let ids_match = message
        .tool_calls
        .iter()
        .all(|call| tool_use_ids.contains(call.id.trim()));
    if !ids_match {
        return None;
    }
    let blocks: Vec<Value> = message
        .raw_items
        .iter()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("thinking" | "redacted_thinking" | "text" | "tool_use")
            )
        })
        .cloned()
        .collect();
    if blocks.is_empty() {
        None
    } else {
        Some(blocks)
    }
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
            if let Some(blocks) = replay_raw_items_verbatim(message) {
                out.push(json!({ "role": "assistant", "content": blocks }));
                continue;
            }
            let mut blocks = thinking_blocks(message);
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
        if role == "assistant" {
            let thinking = thinking_blocks(message);
            if !thinking.is_empty() {
                let mut blocks = thinking;
                if !content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": content }));
                }
                out.push(json!({ "role": "assistant", "content": blocks }));
                continue;
            }
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
    let reasoning = request_reasoning(model, &items);
    let max_tokens = resolve_max_tokens(model, &reasoning);
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
    for (key, value) in reasoning {
        payload.insert(key.into(), value);
    }

    let endpoint = validate_endpoint(&format!("{base_url}/v1/messages"))?;
    let request = json_request(
        http.post(&endpoint).json(&Value::Object(payload)),
        &headers,
        stream.is_some(),
    );
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
    signature: String,
    start: Map<String, Value>,
}

/// Applies one decoded SSE event to the in-progress result. Pulled out of
/// `parse_stream` so the block-accumulation logic (thinking, text, tool use)
/// can be exercised directly in tests without a live HTTP stream.
fn apply_stream_event(
    payload: &Map<String, Value>,
    state: &mut ResultState,
    pending: &mut HashMap<i64, PendingBlock>,
    stop_reason: &mut String,
    usage_raw: &mut Option<Value>,
    emit: &dyn Fn(StreamEvent),
) {
    let index = as_i64(payload.get("index").unwrap_or(&Value::Null));
    match trimmed(payload.get("type")).as_str() {
        "message_start" => {
            if let Some(usage) = payload
                .get("message")
                .and_then(|message| message.get("usage"))
            {
                *usage_raw = Some(usage.clone());
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
                        return;
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
                "thinking_delta" => {
                    let text = text_of(delta.get("thinking"));
                    if text.is_empty() {
                        return;
                    }
                    if let Some(entry) = entry {
                        entry.text.push_str(text);
                    }
                }
                "signature_delta" => {
                    let signature = text_of(delta.get("signature"));
                    if signature.is_empty() {
                        return;
                    }
                    if let Some(entry) = entry {
                        entry.signature.push_str(signature);
                    }
                }
                "input_json_delta" => {
                    let partial = text_of(delta.get("partial_json"));
                    let Some(entry) = entry else { return };
                    if partial.is_empty() {
                        return;
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
                return;
            };
            match entry.kind.as_str() {
                "text" => {
                    if !entry.text.is_empty() {
                        state
                            .blocks
                            .push(json!({ "type": "text", "text": entry.text }));
                    }
                }
                "thinking" => {
                    if !entry.text.is_empty() || !entry.signature.is_empty() {
                        let mut block = json!({ "type": "thinking", "thinking": entry.text });
                        if !entry.signature.is_empty() {
                            block["signature"] = Value::String(entry.signature);
                        }
                        state.blocks.push(block);
                    }
                }
                "redacted_thinking" => {
                    state.blocks.push(Value::Object(entry.start));
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
                *stop_reason = reason;
            }
            if let Some(usage) = payload.get("usage") {
                *usage_raw = Some(usage.clone());
            }
        }
        _ => {}
    }
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
        apply_stream_event(
            &payload,
            &mut state,
            &mut pending,
            &mut stop_reason,
            &mut usage_raw,
            &emit,
        );
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

    #[test]
    fn replays_thinking_blocks_before_text_and_tool_use() {
        let thinking = json!({ "type": "thinking", "thinking": "plan", "signature": "sig" });
        let messages = vec![
            Message::new("user", "go"),
            Message {
                role: "assistant".into(),
                content: "Calling".into(),
                tool_calls: vec![ToolCall {
                    id: "t1".into(),
                    name: "read".into(),
                    input: "{}".into(),
                }],
                raw_items: vec![
                    thinking.clone(),
                    json!({ "type": "text", "text": "Calling" }),
                ],
                ..Message::default()
            },
            Message {
                role: "tool".into(),
                tool_call_id: "t1".into(),
                content: "ok".into(),
                ..Message::default()
            },
            Message {
                role: "assistant".into(),
                content: "Done".into(),
                raw_items: vec![json!({ "type": "redacted_thinking", "data": "x" })],
                ..Message::default()
            },
        ];
        let (_, items) = normalize_messages(&messages);
        assert_eq!(items[1]["content"][0], thinking);
        assert_eq!(items[1]["content"][1]["type"], "text");
        assert_eq!(items[1]["content"][2]["type"], "tool_use");
        assert_eq!(items[3]["content"][0]["type"], "redacted_thinking");
        assert_eq!(
            items[3]["content"][1],
            json!({ "type": "text", "text": "Done" })
        );
    }

    #[test]
    fn deepseek_reasoning_uses_output_config_effort() {
        let model = |provider: &str, effort: &str| RuntimeModel {
            provider_type: provider.into(),
            reasoning_effort: effort.into(),
            ..RuntimeModel::default()
        };
        assert_eq!(
            reasoning_fields(&model("deepseek", "medium")),
            vec![
                ("thinking", json!({ "type": "enabled" })),
                ("output_config", json!({ "effort": "high" })),
            ]
        );
        assert_eq!(
            reasoning_fields(&model("deepseek", "low")),
            vec![
                ("thinking", json!({ "type": "enabled" })),
                ("output_config", json!({ "effort": "low" })),
            ]
        );
        assert_eq!(
            reasoning_fields(&model("deepseek", "max")),
            vec![
                ("thinking", json!({ "type": "enabled" })),
                ("output_config", json!({ "effort": "max" })),
            ]
        );
        assert_eq!(
            reasoning_fields(&model("deepseek", "off")),
            vec![("thinking", json!({ "type": "disabled" }))]
        );
        assert!(reasoning_fields(&model("deepseek", "")).is_empty());
        assert_eq!(
            reasoning_fields(&model("anthropic", "high")),
            vec![(
                "thinking",
                json!({ "type": "enabled", "budget_tokens": 16384 })
            )]
        );
        assert!(reasoning_fields(&model("anthropic", "off")).is_empty());
    }

    #[test]
    fn replays_interleaved_thinking_and_tool_use_in_original_order() {
        let raw_items = vec![
            json!({ "type": "thinking", "thinking": "first", "signature": "s1" }),
            json!({ "type": "tool_use", "id": "t1", "name": "read", "input": {} }),
            json!({ "type": "thinking", "thinking": "second", "signature": "s2" }),
            json!({ "type": "tool_use", "id": "t2", "name": "write", "input": {} }),
        ];
        let messages = vec![Message {
            role: "assistant".into(),
            content: String::new(),
            tool_calls: vec![
                ToolCall {
                    id: "t1".into(),
                    name: "read".into(),
                    input: "{}".into(),
                },
                ToolCall {
                    id: "t2".into(),
                    name: "write".into(),
                    input: "{}".into(),
                },
            ],
            raw_items: raw_items.clone(),
            ..Message::default()
        }];
        let (_, items) = normalize_messages(&messages);
        assert_eq!(items[0]["content"], Value::Array(raw_items));
    }

    #[test]
    fn falls_back_when_raw_items_tool_use_ids_do_not_match_tool_calls() {
        let messages = vec![Message {
            role: "assistant".into(),
            content: "Calling".into(),
            tool_calls: vec![ToolCall {
                id: "t1".into(),
                name: "read".into(),
                input: "{}".into(),
            }],
            raw_items: vec![
                json!({ "type": "thinking", "thinking": "plan", "signature": "sig" }),
                json!({ "type": "tool_use", "id": "other", "name": "read", "input": {} }),
            ],
            ..Message::default()
        }];
        let (_, items) = normalize_messages(&messages);
        assert_eq!(items[0]["content"][0]["type"], "thinking");
        assert_eq!(items[0]["content"][1]["type"], "text");
        assert_eq!(items[0]["content"][1]["text"], "Calling");
        assert_eq!(items[0]["content"][2]["type"], "tool_use");
        assert_eq!(items[0]["content"][2]["id"], "t1");
    }

    fn tool_turn(assistant: Vec<Value>) -> Vec<Value> {
        vec![
            json!({ "role": "user", "content": "Run it" }),
            json!({ "role": "assistant", "content": assistant }),
            json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": "ok" }] }),
            json!({ "role": "user", "content": "approved" }),
        ]
    }

    fn tool_use() -> Value {
        json!({ "type": "tool_use", "id": "c1", "name": "exec_command", "input": {} })
    }

    fn thinking_model(provider: &str) -> RuntimeModel {
        RuntimeModel {
            provider_type: provider.into(),
            reasoning_effort: "high".into(),
            ..RuntimeModel::default()
        }
    }

    #[test]
    fn open_tool_turn_without_thinking_disables_thinking() {
        let items = tool_turn(vec![tool_use()]);
        assert!(open_tool_turn_lacks_thinking(&items));
        for provider in ["deepseek", "anthropic"] {
            let model = thinking_model(provider);
            let reasoning = request_reasoning(&model, &items);
            assert_eq!(
                reasoning,
                vec![("thinking", json!({ "type": "disabled" }))],
                "{provider}"
            );
            assert_eq!(
                resolve_max_tokens(&model, &reasoning),
                DEFAULT_MAX_TOKENS,
                "{provider}"
            );
        }
        // Thinking off stays off: nothing to disable.
        let off = RuntimeModel {
            reasoning_effort: String::new(),
            ..thinking_model("anthropic")
        };
        assert!(request_reasoning(&off, &items).is_empty());
    }

    #[test]
    fn open_tool_turn_with_thinking_keeps_it() {
        let thinking = json!({ "type": "thinking", "thinking": "plan", "signature": "sig" });
        let items = tool_turn(vec![thinking, tool_use()]);
        assert!(!open_tool_turn_lacks_thinking(&items));
        let model = thinking_model("deepseek");
        assert_eq!(request_reasoning(&model, &items), reasoning_fields(&model));
    }

    #[test]
    fn ended_turn_keeps_thinking() {
        let mut items = tool_turn(vec![tool_use()]);
        items.truncate(3);
        items
            .push(json!({ "role": "assistant", "content": [{ "type": "text", "text": "Done." }] }));
        items.push(json!({ "role": "user", "content": "Again" }));
        assert!(!open_tool_turn_lacks_thinking(&items));
        let model = thinking_model("anthropic");
        assert_eq!(request_reasoning(&model, &items), reasoning_fields(&model));
        assert!(!open_tool_turn_lacks_thinking(&[]));
    }

    #[test]
    fn resolves_max_tokens_for_reasoning_budgets() {
        let model = |provider: &str, effort: &str, explicit: i64| RuntimeModel {
            provider_type: provider.into(),
            reasoning_effort: effort.into(),
            max_output_tokens: explicit,
            ..RuntimeModel::default()
        };
        let resolved = |provider: &str, effort: &str, explicit: i64| {
            let model = model(provider, effort, explicit);
            let reasoning = reasoning_fields(&model);
            resolve_max_tokens(&model, &reasoning)
        };
        assert_eq!(resolved("anthropic", "medium", 0), 8192);
        assert_eq!(resolved("anthropic", "high", 0), 20480);
        assert_eq!(resolved("deepseek", "high", 0), 32768);
        assert_eq!(resolved("deepseek", "off", 0), DEFAULT_MAX_TOKENS);
        assert_eq!(resolved("anthropic", "high", 50000), 50000);
    }

    #[test]
    fn captures_streamed_thinking_blocks_in_order() {
        let mut state = ResultState::default();
        let mut pending: HashMap<i64, PendingBlock> = HashMap::new();
        let mut stop_reason = String::new();
        let mut usage_raw: Option<Value> = None;
        let emit = |_: StreamEvent| {};
        let events = [
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "Let me " } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "think." } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig-abc" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "Hello" } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "tool_use", "id": "t1", "name": "read" } }),
            json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{}" } }),
            json!({ "type": "content_block_stop", "index": 2 }),
            json!({ "type": "content_block_start", "index": 3, "content_block": { "type": "redacted_thinking", "data": "x" } }),
            json!({ "type": "content_block_stop", "index": 3 }),
        ];
        for event in &events {
            let payload = event
                .as_object()
                .unwrap_or_else(|| panic!("event is not an object"));
            apply_stream_event(
                payload,
                &mut state,
                &mut pending,
                &mut stop_reason,
                &mut usage_raw,
                &emit,
            );
        }
        assert_eq!(
            state.blocks[0],
            json!({ "type": "thinking", "thinking": "Let me think.", "signature": "sig-abc" })
        );
        assert_eq!(state.blocks[1], json!({ "type": "text", "text": "Hello" }));
        assert_eq!(state.blocks[2]["type"], "tool_use");
        assert_eq!(
            state.blocks[3],
            json!({ "type": "redacted_thinking", "data": "x" })
        );
        assert_eq!(state.content, "Hello");
        assert_eq!(state.tool_calls[0].name, "read");
    }
}
