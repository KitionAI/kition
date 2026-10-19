//! The OpenAI Responses wire (`POST {base}/responses`), streaming and not.

use std::collections::HashSet;
use std::time::Instant;

use kition_core::coerce::{as_i64, as_str};
use serde_json::{Map, Value, json};

use super::error::{AiError, AiResult};
use super::transport::{
    MIB, SseLines, chat_headers, credits_exhausted, header, json_request, log_provider_failure,
    network_error, normalize_base_url, read_limited, send, status_error, usage_from,
    validate_endpoint,
};
use super::types::{
    ChatResult, HostedImageGenerationCall, HostedWebSearchCall, HostedWebSearchResult, Message,
    RuntimeModel, StreamEvent, StreamHandler, ToolCall, ToolSpec,
};

pub(crate) fn hosted_web_search_tool() -> Value {
    json!({ "type": "web_search", "external_web_access": true, "search_context_size": "high" })
}

/// The hosted image tool always returns PNG; the model decides when to
/// call it.
pub(crate) fn hosted_image_generation_tool() -> Value {
    json!({ "type": "image_generation", "output_format": "png" })
}

fn text_of(value: Option<&Value>) -> &str {
    value.map(as_str).unwrap_or_default()
}

fn trimmed(value: Option<&Value>) -> String {
    text_of(value).trim().to_owned()
}

/// `input_text`/`input_image` parts, or `None` when the message has no
/// parts and should be sent as plain content.
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
                let mut item = Map::new();
                item.insert("type".into(), "input_image".into());
                item.insert("image_url".into(), url.into());
                if !part.detail.trim().is_empty() {
                    item.insert("detail".into(), part.detail.trim().into());
                }
                parts.push(Value::Object(item));
            }
            "text" | "input_text" | "" => {
                let text = part.text.trim();
                if !text.is_empty() {
                    parts.push(json!({ "type": "input_text", "text": text }));
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
        return Some(vec![json!({ "type": "input_text", "text": content })]);
    }
    let has_text = parts.iter().any(|part| part["type"] == "input_text");
    if !content.is_empty() && !has_text {
        parts.insert(0, json!({ "type": "input_text", "text": content }));
    }
    Some(parts)
}

/// Only Responses input item types replay; items another wire left in
/// `raw_items` (Chat Completions `reasoning_content`, Anthropic `thinking`)
/// are dropped.
fn valid_input_item(item: &Map<String, Value>) -> bool {
    match trimmed(item.get("type")).as_str() {
        "function_call" => {
            !trimmed(item.get("call_id")).is_empty() && !trimmed(item.get("name")).is_empty()
        }
        "function_call_output" => !trimmed(item.get("call_id")).is_empty(),
        "message" | "reasoning" | "web_search_call" => true,
        _ => false,
    }
}

/// System messages become instructions; everything else becomes input
/// items.
pub(crate) fn normalize_input(messages: &[Message]) -> (String, Vec<Value>) {
    let mut instructions = Vec::new();
    let mut items = Vec::new();
    for message in messages {
        let role = message.role.trim();
        let content = message.content.trim();
        if role == "system" {
            if !content.is_empty() {
                instructions.push(content.to_owned());
            }
            continue;
        }
        // Hosted image output (`image_generation_call`) is saved to the
        // workspace before the next turn; with store=false the provider item
        // cannot be referenced again, so it is not a valid input item. When
        // nothing replayable remains, the message is rebuilt from its
        // content and tool calls below.
        let replayable: Vec<&Value> = message
            .raw_items
            .iter()
            .filter(|raw| raw.as_object().is_some_and(valid_input_item))
            .collect();
        if !replayable.is_empty() {
            items.extend(replayable.into_iter().cloned());
            continue;
        }
        if role == "tool" {
            if message.tool_call_id.trim().is_empty() {
                continue;
            }
            items.push(json!({
                "type": "function_call_output",
                "call_id": message.tool_call_id,
                "output": content,
            }));
            continue;
        }
        if role == "assistant" && !message.tool_calls.is_empty() {
            for call in &message.tool_calls {
                if call.name.trim().is_empty() || call.id.trim().is_empty() {
                    continue;
                }
                items.push(json!({
                    "type": "function_call",
                    "call_id": call.id.trim(),
                    "name": call.name.trim(),
                    "arguments": call.input,
                }));
            }
            continue;
        }
        let role = if role == "assistant" || role == "user" {
            role
        } else {
            "user"
        };
        if let Some(parts) = content_parts(message) {
            items.push(json!({ "role": role, "content": parts }));
            continue;
        }
        if content.is_empty() {
            continue;
        }
        items.push(json!({ "role": role, "content": content }));
    }
    if items.is_empty() {
        items.push(json!({
            "role": "user",
            "content": "Please continue the writing based on the current editor context.",
        }));
    }
    (instructions.join("\n\n"), items)
}

/// The text inside a message `content` value.
pub(crate) fn content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

pub(crate) fn prompt_text(items: &[Value]) -> String {
    let mut parts = Vec::new();
    for item in items {
        let content = content_text(item.get("content"));
        if !content.is_empty() {
            parts.push(content);
        }
        let output = trimmed(item.get("output"));
        if !output.is_empty() {
            parts.push(output);
        }
    }
    parts.join("\n\n")
}

fn objects(raw: &[Value]) -> impl Iterator<Item = &Map<String, Value>> {
    raw.iter().filter_map(Value::as_object)
}

pub(crate) fn tool_calls_from_output(raw: &[Value]) -> Vec<ToolCall> {
    objects(raw)
        .filter(|entry| as_str(&entry["type"]) == "function_call")
        .filter_map(|entry| {
            let name = trimmed(entry.get("name"));
            if name.is_empty() {
                return None;
            }
            let input = trimmed(entry.get("arguments"));
            Some(ToolCall {
                id: trimmed(entry.get("call_id")),
                name,
                input: if input.is_empty() { "{}".into() } else { input },
            })
        })
        .collect()
}

pub(crate) fn query_from_action(action: &Map<String, Value>) -> String {
    match text_of(action.get("type")) {
        "search" => {
            let query = trimmed(action.get("query"));
            if !query.is_empty() {
                return query;
            }
            action
                .get("queries")
                .and_then(Value::as_array)
                .and_then(|queries| queries.first())
                .map(|first| as_str(first).trim().to_owned())
                .unwrap_or_default()
        }
        "open_page" => trimmed(action.get("url")),
        "find_in_page" => {
            let pattern = trimmed(action.get("pattern"));
            let url = trimmed(action.get("url"));
            if !pattern.is_empty() && !url.is_empty() {
                format!("'{pattern}' in {url}")
            } else if !pattern.is_empty() {
                pattern
            } else {
                url
            }
        }
        _ => String::new(),
    }
}

pub(crate) fn web_search_calls_from_output(raw: &[Value]) -> Vec<HostedWebSearchCall> {
    objects(raw)
        .filter(|entry| as_str(&entry["type"]) == "web_search_call")
        .map(|entry| {
            let action = entry
                .get("action")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            HostedWebSearchCall {
                id: trimmed(entry.get("id")),
                status: trimmed(entry.get("status")),
                query: query_from_action(&action),
                action: Some(action),
            }
        })
        .collect()
}

pub(crate) fn image_generation_calls_from_output(raw: &[Value]) -> Vec<HostedImageGenerationCall> {
    objects(raw)
        .filter(|entry| as_str(&entry["type"]) == "image_generation_call")
        .map(|entry| HostedImageGenerationCall {
            id: trimmed(entry.get("id")),
            status: trimmed(entry.get("status")),
            result: text_of(entry.get("result")).to_owned(),
            size: trimmed(entry.get("size")),
            revised_prompt: trimmed(entry.get("revised_prompt")),
            mime_type: "image/png".into(),
        })
        .collect()
}

pub(crate) fn text_from_output(raw: &[Value]) -> String {
    let mut parts = Vec::new();
    for entry in objects(raw).filter(|entry| as_str(&entry["type"]) == "message") {
        let Some(content) = entry.get("content").and_then(Value::as_array) else {
            continue;
        };
        for item in content {
            let text = trimmed(item.get("text"));
            if !text.is_empty() {
                parts.push(text);
            }
        }
    }
    parts.concat()
}

/// Cited sources from hosted web search output, de-duplicated by URL.
pub(crate) fn web_search_results_from_output(
    raw: &[Value],
    fallback_text: &str,
) -> Vec<HostedWebSearchResult> {
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |title: &str, url: &str, snippet: &str| {
        let (title, url, snippet) = (title.trim(), url.trim(), snippet.trim());
        let key = if url.is_empty() {
            format!("{title}\n{snippet}")
        } else {
            url.to_owned()
        };
        if !seen.insert(key) {
            return;
        }
        results.push(HostedWebSearchResult {
            title: if title.is_empty() { "Source" } else { title }.to_owned(),
            url: url.to_owned(),
            snippet: snippet.to_owned(),
        });
    };
    let url_of = |entry: &Map<String, Value>| {
        let url = trimmed(entry.get("url"));
        if url.is_empty() {
            trimmed(entry.get("uri"))
        } else {
            url
        }
    };
    for entry in objects(raw) {
        if as_str(&entry["type"]) == "web_search_call" {
            let sources = entry
                .get("action")
                .and_then(|action| action.get("sources"))
                .and_then(Value::as_array);
            for source in sources.into_iter().flatten().filter_map(Value::as_object) {
                add(text_of(source.get("title")), &url_of(source), fallback_text);
            }
        }
        let content = entry.get("content").and_then(Value::as_array);
        for item in content.into_iter().flatten().filter_map(Value::as_object) {
            let text = text_of(item.get("text"));
            let annotations = item.get("annotations").and_then(Value::as_array);
            for annotation in annotations
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
            {
                add(text_of(annotation.get("title")), &url_of(annotation), text);
            }
        }
    }
    results
}

fn emit_output_item_done(item: &Map<String, Value>, index: i64, stream: Option<&StreamHandler>) {
    let Some(stream) = stream else { return };
    if item.is_empty() {
        return;
    }
    let ready = |id: String, name: String, arguments: String| StreamEvent {
        kind: "tool_call_ready",
        tool_call_index: index,
        tool_call_id: id,
        tool_name: name,
        tool_arguments: arguments,
        ..StreamEvent::default()
    };
    match text_of(item.get("type")) {
        "function_call" => stream(ready(
            trimmed(item.get("call_id")),
            trimmed(item.get("name")),
            trimmed(item.get("arguments")),
        )),
        "web_search_call" => {
            let action = item.get("action").cloned().unwrap_or(Value::Null);
            let arguments = match action {
                Value::Object(_) => action.to_string(),
                _ => "null".into(),
            };
            stream(ready(
                trimmed(item.get("id")),
                "web_search".into(),
                arguments,
            ));
        }
        "image_generation_call" => {
            let arguments = json!({
                "revised_prompt": trimmed(item.get("revised_prompt")),
                "size": trimmed(item.get("size")),
                "status": trimmed(item.get("status")),
            });
            stream(ready(
                trimmed(item.get("id")),
                "image_generation".into(),
                arguments.to_string(),
            ));
        }
        _ => {}
    }
}

fn tool_choice(name: &str) -> Value {
    if name.is_empty() {
        "auto".into()
    } else {
        json!({ "type": "function", "name": name })
    }
}

fn function_tools(tools: &[ToolSpec]) -> Vec<Value> {
    let mut payload = Vec::new();
    for tool in tools {
        if tool.name.trim().is_empty() {
            continue;
        }
        match tool.name.as_str() {
            "web_search" => payload.push(hosted_web_search_tool()),
            "image_generation" => payload.push(hosted_image_generation_tool()),
            _ => {
                let mut item = Map::new();
                item.insert("type".into(), "function".into());
                item.insert("name".into(), tool.name.clone().into());
                item.insert("description".into(), tool.description.clone().into());
                if let Some(schema) = &tool.input_schema {
                    item.insert("parameters".into(), schema.clone());
                }
                payload.push(Value::Object(item));
            }
        }
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
    let headers = chat_headers(model)?;
    let base_url = normalize_base_url(&model.provider_type, &model.base_url);
    let model_name = model.model_name.trim().to_owned();
    if base_url.is_empty() || model_name.is_empty() {
        return Err(AiError::msg(
            "runtime provider is missing base_url or model_name",
        ));
    }
    let (instructions, input_items) = normalize_input(messages);
    let payload_tools = function_tools(tools);
    let mut payload = Map::new();
    payload.insert("model".into(), model_name.clone().into());
    payload.insert("input".into(), Value::Array(input_items.clone()));
    payload.insert("store".into(), (!model.disable_storage()).into());
    payload.insert("stream".into(), stream.is_some().into());
    if !instructions.is_empty() {
        payload.insert("instructions".into(), instructions.into());
    }
    if !payload_tools.is_empty() {
        payload.insert("tools".into(), Value::Array(payload_tools));
        payload.insert("tool_choice".into(), tool_choice(choice));
    }
    let effort = model.reasoning_effort.trim();
    if !effort.is_empty() {
        payload.insert("reasoning".into(), json!({ "effort": effort }));
    }

    let endpoint = validate_endpoint(&format!("{base_url}/responses"))?;
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
        log_provider_failure(model, "responses", &endpoint, status, &body);
        return Err(status_error(
            "runtime provider call failed",
            status,
            &retry_after,
            &body,
        ));
    }

    let prompt = prompt_text(&input_items);
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
        let body = read_limited(response, 4 * MIB)
            .await
            .map_err(|_| AiError::msg("failed to read runtime provider response"))?;
        let data: Map<String, Value> = serde_json::from_slice(&body)
            .map_err(|_| AiError::msg("runtime provider returned a non-JSON response"))?;
        let output = data
            .get("output")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut content = trimmed(data.get("output_text"));
        if content.is_empty() {
            content = text_from_output(&output);
        }
        ChatResult {
            usage: usage_from(data.get("usage"), &prompt, &content, started, false),
            tool_calls: tool_calls_from_output(&output),
            hosted_web_search_calls: web_search_calls_from_output(&output),
            hosted_image_generation_calls: image_generation_calls_from_output(&output),
            response_items: output,
            stop_reason: text_of(data.get("status")).to_owned(),
            model: model_name.clone(),
            content,
            ..ChatResult::default()
        }
    };
    result.wire_api = "responses".into();
    Ok(result)
}

/// A failure reported inside a stream that already returned HTTP 200.
fn stream_failure(message: String) -> AiError {
    AiError::Provider {
        message,
        retryable: true,
        reason: "stream_error".into(),
        retry_after: std::time::Duration::ZERO,
    }
}

/// The message of an `error` event or a failed response.
fn stream_error_message(value: &Value) -> String {
    let error = value.get("error").unwrap_or(value);
    let message = trimmed(error.get("message"));
    if message.is_empty() {
        "the model stream reported an error".into()
    } else {
        message
    }
}

fn has_actionable_item(output: &[Value]) -> bool {
    output
        .iter()
        .any(|item| !matches!(text_of(item.get("type")), "" | "reasoning"))
}

async fn parse_stream(
    mut lines: SseLines,
    prompt: &str,
    model_name: &str,
    started: Instant,
    stream: Option<&StreamHandler>,
) -> AiResult<ChatResult> {
    let mut content = String::new();
    let mut output: Vec<Value> = Vec::new();
    let mut usage_raw: Option<Value> = None;
    let mut status = String::new();
    let mut events = 0;
    let mut finished = false;
    // Argument deltas name their output item; the call is logged under its
    // `call_id`, so each function call item maps one to the other.
    let mut calls: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();
    while let Some(data) = lines.next_data().await? {
        if data == "[DONE]" {
            break;
        }
        let Ok(Value::Object(payload)) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        events += 1;
        match text_of(payload.get("type")) {
            "response.output_text.delta" => {
                let delta = text_of(payload.get("delta"));
                if !delta.is_empty() {
                    content.push_str(delta);
                    if let Some(stream) = stream {
                        stream(StreamEvent {
                            kind: "delta",
                            delta: delta.to_owned(),
                            ..StreamEvent::default()
                        });
                    }
                }
            }
            "response.output_item.added" => {
                if let Some(Value::Object(item)) = payload.get("item")
                    && text_of(item.get("type")) == "function_call"
                {
                    calls.insert(
                        trimmed(item.get("id")),
                        (trimmed(item.get("call_id")), trimmed(item.get("name"))),
                    );
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(stream) = stream {
                    let item_id = text_of(payload.get("item_id")).trim();
                    let (call_id, name) = calls.get(item_id).cloned().unwrap_or_default();
                    let id = [
                        text_of(payload.get("call_id")).trim(),
                        call_id.as_str(),
                        item_id,
                    ]
                    .into_iter()
                    .find(|id| !id.is_empty())
                    .unwrap_or_default();
                    stream(StreamEvent {
                        kind: "tool_call_delta",
                        tool_call_index: as_i64(
                            payload.get("output_index").unwrap_or(&Value::Null),
                        ),
                        tool_call_id: id.to_owned(),
                        tool_name: name,
                        tool_arguments_delta: text_of(payload.get("delta")).to_owned(),
                        ..StreamEvent::default()
                    });
                }
            }
            "response.output_item.done" => {
                if let Some(Value::Object(item)) = payload.get("item")
                    && !item.is_empty()
                {
                    output.push(Value::Object(item.clone()));
                    let index = as_i64(payload.get("output_index").unwrap_or(&Value::Null));
                    emit_output_item_done(item, index, stream);
                }
            }
            "error" => {
                let event = Value::Object(payload);
                return Err(stream_failure(stream_error_message(&event)));
            }
            "response.failed" => {
                let response = payload.get("response").unwrap_or(&Value::Null);
                return Err(stream_failure(stream_error_message(response)));
            }
            "response.completed" | "response.incomplete" => {
                let Some(Value::Object(response)) = payload.get("response") else {
                    continue;
                };
                if response.is_empty() {
                    continue;
                }
                finished = true;
                if let Some(Value::Array(items)) = response.get("output") {
                    output = items.clone();
                    for (index, item) in items.iter().enumerate() {
                        if let Value::Object(entry) = item {
                            emit_output_item_done(entry, index as i64, stream);
                        }
                    }
                }
                if let Some(usage) = response.get("usage").filter(|usage| !usage.is_null()) {
                    usage_raw = Some(usage.clone());
                }
                status = text_of(response.get("status")).to_owned();
                let text = text_of(response.get("output_text"));
                if !text.is_empty() && content.is_empty() {
                    content.push_str(text);
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
    let mut content = content.trim().to_owned();
    if content.is_empty() {
        content = text_from_output(&output);
    }
    // A stream that stops before its final event, with nothing usable, was
    // cut off upstream; retrying beats reporting an empty reply.
    if !finished && content.is_empty() && !has_actionable_item(&output) {
        return Err(stream_failure(
            "the model stream ended before the response completed".into(),
        ));
    }
    Ok(ChatResult {
        usage: usage_from(usage_raw.as_ref(), prompt, &content, started, false),
        tool_calls: tool_calls_from_output(&output),
        hosted_web_search_calls: web_search_calls_from_output(&output),
        hosted_image_generation_calls: image_generation_calls_from_output(&output),
        response_items: output,
        stop_reason: status,
        model: model_name.to_owned(),
        content,
        ..ChatResult::default()
    })
}

#[cfg(test)]
mod tests {
    use super::super::types::MessagePart;
    use super::*;

    #[tokio::test]
    async fn tool_call_deltas_carry_the_logged_call_id() {
        let events = [
            json!({ "type": "response.output_item.added", "output_index": 0,
                "item": { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "document_write", "arguments": "" } }),
            json!({ "type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 0, "delta": "{\"path\"" }),
            json!({ "type": "response.function_call_arguments.delta", "item_id": "fc_2", "output_index": 1, "delta": "{}" }),
            json!({ "type": "response.completed", "response": { "status": "completed", "output": [] } }),
        ];
        let body: String = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
        let sink = seen.clone();
        let handler: StreamHandler = std::sync::Arc::new(move |event: StreamEvent| {
            if event.kind == "tool_call_delta" {
                sink.lock()
                    .map(|mut seen| seen.push((event.tool_call_id, event.tool_name)))
                    .ok();
            }
        });
        parse_stream(
            SseLines::from_text(&body),
            "",
            "m",
            Instant::now(),
            Some(&handler),
        )
        .await
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            *seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            [
                ("call_1".to_owned(), "document_write".to_owned()),
                ("fc_2".to_owned(), String::new()),
            ]
        );
    }

    async fn parse_events(events: &[Value]) -> AiResult<ChatResult> {
        let body: String = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect();
        parse_stream(SseLines::from_text(&body), "", "m", Instant::now(), None).await
    }

    fn reasoning_done() -> Value {
        json!({ "type": "response.output_item.done", "output_index": 0,
            "item": { "type": "reasoning", "id": "rs_1", "summary": [] } })
    }

    #[tokio::test]
    async fn a_stream_cut_off_after_reasoning_is_a_retryable_error() {
        let error = parse_events(&[reasoning_done()]).await.err();
        let error = error.unwrap_or_else(|| panic!("a cut-off stream must fail"));
        assert!(error.retry_info().0, "{error}");
        assert!(error.to_string().contains("ended before"), "{error}");
    }

    #[tokio::test]
    async fn stream_error_events_carry_the_provider_message() {
        for event in [
            json!({ "type": "error", "message": "upstream overloaded" }),
            json!({ "type": "response.failed",
                "response": { "status": "failed", "error": { "message": "upstream overloaded" } } }),
        ] {
            let error = parse_events(&[reasoning_done(), event]).await.err();
            let error = error.unwrap_or_else(|| panic!("a failed stream must fail"));
            assert_eq!(error.to_string(), "upstream overloaded");
            assert!(error.retry_info().0);
        }
    }

    #[tokio::test]
    async fn an_incomplete_response_keeps_its_output_and_status() {
        let result = parse_events(&[json!({ "type": "response.incomplete", "response": {
            "status": "incomplete",
            "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "partial" }] }],
        } })])
        .await
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(result.stop_reason, "incomplete");
        assert_eq!(result.content, "partial");
    }

    #[tokio::test]
    async fn a_stream_with_output_but_no_final_event_still_succeeds() {
        let result =
            parse_events(&[json!({ "type": "response.output_text.delta", "delta": "hi" })])
                .await
                .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(result.content, "hi");
    }

    #[test]
    fn normalizes_messages_into_input_items() {
        let messages = vec![
            Message::new("system", " be brief "),
            Message::new("user", "hello"),
            Message {
                role: "assistant".into(),
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    name: "read".into(),
                    input: r#"{"p":1}"#.into(),
                }],
                ..Message::default()
            },
            Message {
                role: "tool".into(),
                tool_call_id: "c1".into(),
                content: "result".into(),
                ..Message::default()
            },
            Message {
                role: "assistant".into(),
                raw_items: vec![
                    json!({ "type": "image_generation_call", "id": "ig" }),
                    json!({ "type": "function_call", "call_id": "", "name": "x" }),
                    json!({ "type": "reasoning", "id": "r" }),
                ],
                ..Message::default()
            },
            Message {
                role: "developer".into(),
                content: "see".into(),
                parts: vec![MessagePart {
                    kind: "image_url".into(),
                    image_url: "data:image/png;base64,AA".into(),
                    ..MessagePart::default()
                }],
                ..Message::default()
            },
        ];
        let (instructions, items) = normalize_input(&messages);
        assert_eq!(instructions, "be brief");
        assert_eq!(
            items,
            vec![
                json!({ "role": "user", "content": "hello" }),
                json!({ "type": "function_call", "call_id": "c1", "name": "read", "arguments": r#"{"p":1}"# }),
                json!({ "type": "function_call_output", "call_id": "c1", "output": "result" }),
                json!({ "type": "reasoning", "id": "r" }),
                json!({ "role": "user", "content": [
                    { "type": "input_text", "text": "see" },
                    { "type": "input_image", "image_url": "data:image/png;base64,AA" },
                ] }),
            ]
        );
        let (_, fallback) = normalize_input(&[]);
        assert_eq!(fallback.len(), 1);
    }

    #[test]
    fn drops_raw_items_from_other_wires() {
        let messages = vec![
            Message::new("user", "go"),
            Message {
                role: "assistant".into(),
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    name: "read".into(),
                    input: "{}".into(),
                }],
                raw_items: vec![json!({ "type": "reasoning_content", "text": "x" })],
                ..Message::default()
            },
            Message {
                role: "assistant".into(),
                content: "kept".into(),
                raw_items: vec![
                    json!({ "type": "thinking", "thinking": "t" }),
                    json!({ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "kept" }] }),
                ],
                ..Message::default()
            },
        ];
        let (_, items) = normalize_input(&messages);
        assert_eq!(
            items,
            vec![
                json!({ "role": "user", "content": "go" }),
                json!({ "type": "function_call", "call_id": "c1", "name": "read", "arguments": "{}" }),
                json!({ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "kept" }] }),
            ]
        );
    }

    #[test]
    fn reads_output_items() {
        let output = vec![
            json!({ "type": "message", "content": [{ "type": "output_text", "text": "Hi ", "annotations": [
                { "title": "Doc", "url": "https://a.test" },
                { "title": "Dup", "url": "https://a.test" },
            ] }] }),
            json!({ "type": "function_call", "call_id": "c", "name": "f", "arguments": "" }),
            json!({ "type": "web_search_call", "id": "w", "status": "completed",
                    "action": { "type": "search", "queries": ["rust"], "sources": [{ "url": "https://b.test" }] } }),
            json!({ "type": "image_generation_call", "id": "i", "result": "AAAA", "size": "1024x1024" }),
        ];
        assert_eq!(text_from_output(&output), "Hi");
        let calls = tool_calls_from_output(&output);
        assert_eq!(calls[0].input, "{}");
        assert_eq!(web_search_calls_from_output(&output)[0].query, "rust");
        assert_eq!(
            image_generation_calls_from_output(&output)[0].mime_type,
            "image/png"
        );
        let results = web_search_results_from_output(&output, "summary");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Doc");
        assert_eq!(results[0].url, "https://a.test");
        assert_eq!(results[1].title, "Source");
        assert_eq!(results[1].snippet, "summary");
    }

    #[test]
    fn describes_hosted_search_actions() {
        let action = |value: Value| value.as_object().cloned().unwrap_or_default();
        assert_eq!(
            query_from_action(&action(json!({ "type": "open_page", "url": "u" }))),
            "u"
        );
        assert_eq!(
            query_from_action(&action(
                json!({ "type": "find_in_page", "pattern": "p", "url": "u" })
            )),
            "'p' in u"
        );
    }
}
