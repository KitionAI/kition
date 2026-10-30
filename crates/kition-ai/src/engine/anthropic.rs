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
/// `max_tokens` with adaptive thinking on: room for the reasoning and the
/// answer (the claude-api skill's defaults for non-streaming and streaming).
const THINKING_MAX_TOKENS: i64 = 16_000;
const THINKING_STREAM_MAX_TOKENS: i64 = 64_000;
/// The budget for `xhigh`/`max` on models that still take `budget_tokens`.
const DEEP_THINKING_BUDGET: i64 = 32_000;
/// Server-side compaction at a token threshold (beta).
const COMPACTION_BETA: &str = "compact-2026-01-12";
/// How many times a `pause_turn` is continued within one call.
const MAX_PAUSE_CONTINUATIONS: usize = 4;

/// Whether thinking can be turned off on a Claude model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThinkingOff {
    /// `thinking: {type: "disabled"}` is accepted.
    Allowed,
    /// Accepted only at effort `high` or below (Claude Opus 5).
    UpToHigh,
    /// Never: the request omits `thinking` and lowers the effort (Claude Opus
    /// 5.5, Fable 5 and 5.1, Mythos 5 and 5.1).
    Never,
}

/// What one Claude model takes on the Messages API (claude-api skill, model
/// table of 2026-06-24). Names are matched case-insensitively from the
/// first `claude-`, so gateway names (`anthropic.claude-opus-5`) match too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Claude {
    /// `thinking: {type: "adaptive"}` with `output_config.effort`; otherwise
    /// `thinking: {type: "enabled", budget_tokens}`.
    pub adaptive: bool,
    pub thinking_off: ThinkingOff,
    /// Effort `xhigh` is accepted (otherwise it is sent as `high`).
    pub xhigh: bool,
    /// `tool_choice` `{type: "tool"}` is accepted.
    pub forced_tool_choice: bool,
    /// Server-side compaction at a token threshold.
    pub compaction: bool,
    /// `{role: "system"}` messages inside `messages`.
    pub system_messages: bool,
    /// A request without `thinking` runs adaptive thinking (Claude Opus 5
    /// and later, Sonnet 5, Fable); on Opus 4.6 to 4.8 it runs without.
    pub thinks_by_default: bool,
}

const fn adaptive(
    thinking_off: ThinkingOff,
    xhigh: bool,
    forced_tool_choice: bool,
    system_messages: bool,
    thinks_by_default: bool,
) -> Claude {
    Claude {
        adaptive: true,
        thinking_off,
        xhigh,
        forced_tool_choice,
        compaction: true,
        system_messages,
        thinks_by_default,
    }
}

/// Families by name prefix, the longer names first.
const CLAUDE_FAMILIES: &[(&str, Claude)] = &[
    (
        "claude-fable-5-1",
        adaptive(ThinkingOff::Never, true, false, true, true),
    ),
    (
        "claude-mythos-5-1",
        adaptive(ThinkingOff::Never, true, false, true, true),
    ),
    (
        "claude-opus-5-5",
        adaptive(ThinkingOff::Never, true, false, true, true),
    ),
    (
        "claude-fable-5",
        adaptive(ThinkingOff::Never, true, true, true, true),
    ),
    (
        "claude-mythos-5",
        adaptive(ThinkingOff::Never, true, true, true, true),
    ),
    (
        "claude-opus-5",
        adaptive(ThinkingOff::UpToHigh, true, true, true, true),
    ),
    (
        "claude-sonnet-5",
        adaptive(ThinkingOff::Allowed, true, true, false, true),
    ),
    (
        "claude-opus-4-8",
        adaptive(ThinkingOff::Allowed, true, true, true, false),
    ),
    (
        "claude-opus-4-7",
        adaptive(ThinkingOff::Allowed, true, true, false, false),
    ),
    (
        "claude-opus-4-6",
        adaptive(ThinkingOff::Allowed, false, true, false, false),
    ),
    (
        "claude-sonnet-4-6",
        adaptive(ThinkingOff::Allowed, false, true, false, false),
    ),
];

/// Earlier models: thinking takes `budget_tokens`, effort is not sent.
const BUDGET_CLAUDE: Claude = Claude {
    adaptive: false,
    thinking_off: ThinkingOff::Allowed,
    xhigh: false,
    forced_tool_choice: true,
    compaction: false,
    system_messages: false,
    thinks_by_default: false,
};

/// A newer Claude this table does not know yet: the newest request surface
/// (adaptive, never off, no forced tool choice), without beta features.
const UNKNOWN_CLAUDE: Claude = Claude {
    adaptive: true,
    thinking_off: ThinkingOff::Never,
    xhigh: true,
    forced_tool_choice: false,
    compaction: false,
    system_messages: false,
    thinks_by_default: true,
};

/// The Claude model a name stands for, or `None` for another model on the
/// Messages wire (a DeepSeek or other compatible endpoint).
pub(crate) fn claude(model_name: &str) -> Option<Claude> {
    let lower = model_name.trim().to_lowercase();
    let name = &lower[lower.find("claude-")?..];
    if let Some((_, caps)) = CLAUDE_FAMILIES
        .iter()
        .find(|(prefix, _)| name.starts_with(prefix))
    {
        return Some(*caps);
    }
    let earlier = name.starts_with("claude-3")
        || name.starts_with("claude-haiku-4")
        || ["claude-opus-4", "claude-sonnet-4"].iter().any(|family| {
            name.strip_prefix(family).is_some_and(|rest| {
                rest.is_empty()
                    || ["-0", "-1", "-5", "-2"]
                        .iter()
                        .any(|minor| rest.starts_with(minor))
            })
        });
    Some(if earlier {
        BUDGET_CLAUDE
    } else {
        UNKNOWN_CLAUDE
    })
}

/// Whether requests to `model` must keep their history append-only: an
/// adaptive Claude model on the Messages wire, whose thinking blocks are
/// bound to the conversation before them (preserved thinking) and whose
/// context is kept in bounds by server-side compaction instead.
pub fn appends_only(model: &RuntimeModel) -> bool {
    model.wire_api.trim() == "anthropic_messages"
        && model.provider_type.trim() != "deepseek"
        && claude(&model.model_name).is_some_and(|caps| caps.adaptive && caps.compaction)
}

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
        "xhigh" | "max" => DEEP_THINKING_BUDGET,
        _ => 0,
    }
}

/// Reasoning request fields. DeepSeek's Messages API takes both
/// `thinking.type = enabled` and `output_config.effort` (`low`, `high`,
/// `max`) together for any non-off effort, and `thinking.type = disabled`
/// alone for off, as DeepSeek Harness's adapter sends them. Adaptive Claude
/// models take `thinking: {type: "adaptive"}` with `output_config.effort`
/// (`display: "summarized"`, so the reasoning reads as a summary); earlier
/// Claude models and other Messages endpoints take a thinking token budget.
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
    if let Some(caps) = claude(&model.model_name).filter(|caps| caps.adaptive) {
        return adaptive_fields(caps, &effort);
    }
    if matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
        vec![(
            "thinking",
            json!({ "type": "enabled", "budget_tokens": thinking_budget(&effort) }),
        )]
    } else {
        Vec::new()
    }
}

/// Kition's effort setting on an adaptive Claude model. No setting sends
/// nothing (the model's default); off turns thinking off where the model
/// allows it, and otherwise runs at the lowest effort.
fn adaptive_fields(caps: Claude, effort: &str) -> Vec<(&'static str, Value)> {
    let level = match effort {
        "" => return Vec::new(),
        "off" | "none" | "minimal" => {
            return match caps.thinking_off {
                ThinkingOff::Allowed | ThinkingOff::UpToHigh => {
                    vec![("thinking", json!({ "type": "disabled" }))]
                }
                ThinkingOff::Never => vec![("output_config", json!({ "effort": "low" }))],
            };
        }
        "low" | "medium" | "high" | "max" => effort,
        "xhigh" if caps.xhigh => "xhigh",
        _ => "high",
    };
    vec![
        (
            "thinking",
            json!({ "type": "adaptive", "display": "summarized" }),
        ),
        ("output_config", json!({ "effort": level })),
    ]
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
    let enabled = reasoning.iter().any(|(key, value)| {
        *key == "thinking" && matches!(value["type"].as_str(), Some("enabled" | "adaptive"))
    });
    // A model that cannot turn thinking off keeps it: there is no request
    // that would be accepted otherwise.
    let can_turn_off =
        claude(&model.model_name).is_none_or(|caps| caps.thinking_off != ThinkingOff::Never);
    if enabled && can_turn_off && open_tool_turn_lacks_thinking(items) {
        return vec![("thinking", json!({ "type": "disabled" }))];
    }
    reasoning
}

/// `max_tokens` large enough for the configured reasoning. Anthropic
/// requires `max_tokens` to exceed `thinking.budget_tokens`, so the budget
/// gets headroom on top; adaptive thinking gets the skill's defaults
/// (16,000, or 64,000 when streaming); DeepSeek's Messages API needs a
/// generous ceiling whenever thinking is enabled, regardless of effort. An
/// explicit `max_output_tokens` from the model wins when it is already
/// larger.
fn resolve_max_tokens(
    model: &RuntimeModel,
    reasoning: &[(&'static str, Value)],
    streaming: bool,
) -> i64 {
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
    let thinking = reasoning
        .iter()
        .find(|(key, _)| *key == "thinking")
        .map(|(_, value)| value["type"].as_str().unwrap_or_default());
    let thinks = model.provider_type.trim() != "deepseek"
        && claude(&model.model_name).is_some_and(|caps| {
            caps.adaptive
                && match thinking {
                    Some(kind) => kind == "adaptive",
                    None => caps.thinks_by_default,
                }
        });
    if thinks {
        let floor = if streaming {
            THINKING_STREAM_MAX_TOKENS
        } else {
            THINKING_MAX_TOKENS
        };
        return base.max(floor);
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

/// Blocks from an earlier response that are replayed verbatim, in their
/// order, before the assistant's text and tool calls: reasoning (DeepSeek
/// and Anthropic thinking) and server-side compaction summaries, which the
/// API needs back to drop what they summarize.
fn thinking_blocks(message: &Message) -> Vec<Value> {
    message
        .raw_items
        .iter()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("thinking" | "redacted_thinking" | "compaction")
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
            Some("thinking" | "redacted_thinking" | "compaction")
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
                Some("thinking" | "redacted_thinking" | "compaction" | "text" | "tool_use")
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
            // Images a tool returned travel inside its result, so the tool
            // result stays where the call was answered (append-only history).
            let result = match content_parts(message) {
                Some(parts) if parts.iter().any(|part| part["type"] == "image") => {
                    Value::Array(parts)
                }
                _ => Value::String(content.to_owned()),
            };
            out.push(json!({
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": call_id, "content": result }],
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
    /// `stop_details` of a refusal: `{category, explanation}`.
    stop_details: Option<Value>,
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
        mut self,
        stop_reason: String,
        model: &str,
        usage_raw: Option<&Value>,
        prompt: &str,
        started: Instant,
    ) -> ChatResult {
        if stop_reason == "refusal" {
            // A declined request runs no tools; the person reads why.
            self.tool_calls.clear();
            if self.content.trim().is_empty() {
                self.content = refusal_text(self.stop_details.as_ref());
            }
        }
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

/// What a refusal says when the model wrote nothing: its explanation and
/// category from `stop_details`.
fn refusal_text(details: Option<&Value>) -> String {
    let explanation = details
        .map(|details| trimmed(details.get("explanation")))
        .unwrap_or_default();
    let category = details
        .map(|details| trimmed(details.get("category")))
        .unwrap_or_default();
    let mut text = "The model declined this request.".to_owned();
    if !explanation.is_empty() {
        text.push(' ');
        text.push_str(&explanation);
    }
    if !category.is_empty() {
        text.push_str(&format!(" (category: {category})"));
    }
    text
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

/// Whether a tool schema meets strict tool use: every object closes its
/// properties (`additionalProperties: false`) and requires all of them.
fn strict_compatible(schema: &Value) -> bool {
    let Some(object) = schema.as_object() else {
        return true;
    };
    if object.get("type").and_then(Value::as_str) == Some("object") {
        let properties = object
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let required: HashSet<&str> = object
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if object.get("additionalProperties") != Some(&Value::Bool(false))
            || !properties.keys().all(|key| required.contains(key.as_str()))
        {
            return false;
        }
        return properties.values().all(strict_compatible);
    }
    object.get("items").is_none_or(strict_compatible)
}

/// How a forced tool is asked for. A model that refuses forced
/// `tool_choice` (Claude Opus 5.5, Fable 5.1, Mythos 5.1) gets `auto`, the
/// tool marked `strict` when its schema allows it, and an instruction naming
/// it: a `system` message at the end of `messages` where the model takes
/// one, else a line of the system prompt (a one-off request, so no history
/// is edited).
fn apply_tool_choice(
    payload: &mut Map<String, Value>,
    tools: &mut [Value],
    items: &mut Vec<Value>,
    system: &mut String,
    choice: &str,
    caps: Option<Claude>,
) {
    if choice.is_empty() {
        return;
    }
    if caps.is_none_or(|caps| caps.forced_tool_choice) {
        payload.insert(
            "tool_choice".into(),
            json!({ "type": "tool", "name": choice }),
        );
        return;
    }
    payload.insert("tool_choice".into(), json!({ "type": "auto" }));
    if let Some(tool) = tools.iter_mut().find(|tool| tool["name"] == choice)
        && strict_compatible(&tool["input_schema"])
    {
        tool["strict"] = Value::Bool(true);
    }
    let instruction = format!("Answer this request by calling the `{choice}` tool.");
    let last_is_user = items.last().is_some_and(|item| item["role"] == "user");
    if caps.is_some_and(|caps| caps.system_messages) && last_is_user {
        items.push(json!({ "role": "system", "content": instruction }));
    } else if system.is_empty() {
        *system = instruction;
    } else {
        system.push_str("\n\n");
        system.push_str(&instruction);
    }
}

/// One call's results, a `pause_turn` continuation appended to the first.
fn merge_results(mut first: ChatResult, next: ChatResult) -> ChatResult {
    first.content.push_str(&next.content);
    first.tool_calls.extend(next.tool_calls);
    first
        .hosted_web_search_calls
        .extend(next.hosted_web_search_calls);
    first
        .hosted_web_search_results
        .extend(next.hosted_web_search_results);
    first.response_items.extend(next.response_items);
    first.stop_reason = next.stop_reason;
    let (a, b) = (&mut first.usage, next.usage);
    a.prompt_tokens += b.prompt_tokens;
    a.completion_tokens += b.completion_tokens;
    a.total_tokens += b.total_tokens;
    a.cache_creation_input_tokens += b.cache_creation_input_tokens;
    a.cache_read_input_tokens += b.cache_read_input_tokens;
    a.response_time_ms += b.response_time_ms;
    first
}

/// The request body of one call, without `messages` (each `pause_turn`
/// continuation sends its own).
pub(crate) fn request_body(
    messages: &[Message],
    tools: &[ToolSpec],
    choice: &str,
    model: &RuntimeModel,
    streaming: bool,
) -> (Map<String, Value>, Vec<Value>, String) {
    let caps = (model.provider_type.trim() != "deepseek")
        .then(|| claude(&model.model_name))
        .flatten();
    let (mut system, mut items) = normalize_messages(messages);
    let mut payload_tools = tools_payload(tools, &model.hosted_web_search_version);
    let reasoning = request_reasoning(model, &items);
    let max_tokens = resolve_max_tokens(model, &reasoning, streaming);
    let mut payload = Map::new();
    apply_tool_choice(
        &mut payload,
        &mut payload_tools,
        &mut items,
        &mut system,
        choice,
        caps,
    );
    payload.insert("model".into(), model.model_name.trim().into());
    payload.insert("max_tokens".into(), max_tokens.into());
    payload.insert("stream".into(), streaming.into());
    if !system.is_empty() {
        // On Claude the system prompt is its own cache breakpoint, so the
        // tools and the system prompt stay cached as the conversation grows.
        let value = if caps.is_some() {
            json!([{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }])
        } else {
            system.clone().into()
        };
        payload.insert("system".into(), value);
    }
    if !payload_tools.is_empty() {
        payload.insert("tools".into(), Value::Array(payload_tools));
    }
    if caps.is_some() {
        // Automatic caching of the conversation up to its last block.
        payload.insert("cache_control".into(), json!({ "type": "ephemeral" }));
    }
    if appends_only(model) {
        payload.insert(
            "context_management".into(),
            json!({ "edits": [{ "type": "compact_20260112" }] }),
        );
    }
    for (key, value) in reasoning {
        payload.insert(key.into(), value);
    }
    (payload, items, system)
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
    if appends_only(model) {
        set_header(&mut headers, "anthropic-beta", COMPACTION_BETA);
    }
    let base_url = normalize_base_url(&model.provider_type, &model.base_url);
    let model_name = model.model_name.trim().to_owned();
    if base_url.is_empty() || model_name.is_empty() {
        return Err(AiError::msg(
            "runtime provider is missing base_url or model_name",
        ));
    }
    let (mut payload, mut items, system) =
        request_body(messages, tools, choice, model, stream.is_some());
    let endpoint = validate_endpoint(&format!("{base_url}/v1/messages"))?;
    let mut combined: Option<ChatResult> = None;
    for continuation in 0..=MAX_PAUSE_CONTINUATIONS {
        payload.insert("messages".into(), Value::Array(items.clone()));
        let result = send_once(
            http,
            &endpoint,
            &headers,
            &payload,
            (&items, &system),
            model,
            stream,
        )
        .await?;
        let paused = result.stop_reason == "pause_turn";
        let blocks = result.response_items.clone();
        combined = Some(match combined {
            None => result,
            Some(first) => merge_results(first, result),
        });
        if !paused || continuation == MAX_PAUSE_CONTINUATIONS {
            break;
        }
        // A paused turn (a long server-tool run) continues by sending its
        // own content back.
        items.push(json!({ "role": "assistant", "content": blocks }));
    }
    let mut result = combined.unwrap_or_default();
    result.wire_api = "anthropic_messages".into();
    Ok(result)
}

async fn send_once(
    http: &reqwest::Client,
    endpoint: &str,
    headers: &[(String, String)],
    payload: &Map<String, Value>,
    (items, system): (&[Value], &str),
    model: &RuntimeModel,
    stream: Option<&StreamHandler>,
) -> AiResult<ChatResult> {
    let model_name = model.model_name.trim();
    let request = json_request(
        http.post(endpoint).json(&Value::Object(payload.clone())),
        headers,
        stream.is_some(),
    );
    let started = Instant::now();
    let response = send(request, stream.is_some())
        .await
        .map_err(|failure| network_error("runtime provider call failed", endpoint, &failure))?;
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
        log_provider_failure(model, "anthropic_messages", endpoint, status, &body);
        return Err(status_error(
            "runtime provider call failed",
            status,
            &retry_after,
            &body,
        ));
    }
    let prompt = prompt_text(items, system);
    let content_type = header(&response, "Content-Type").to_lowercase();
    if stream.is_some() && content_type.contains("text/event-stream") {
        parse_stream(
            SseLines::new(response),
            &prompt,
            model_name,
            started,
            stream,
        )
        .await
    } else {
        let body = read_limited(response, 8 * MIB)
            .await
            .map_err(|_| AiError::msg("failed to read runtime provider response"))?;
        let data: Map<String, Value> = serde_json::from_slice(&body)
            .map_err(|_| AiError::msg("runtime provider returned a non-JSON response"))?;
        Ok(parse_json(&data, &prompt, model_name, started))
    }
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
    state.stop_details = data
        .get("stop_details")
        .filter(|value| !value.is_null())
        .cloned();
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
                "compaction_delta" => {
                    if let Some(entry) = entry {
                        entry.text.push_str(text_of(delta.get("content")));
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
                "compaction" => {
                    let mut block = entry.start;
                    block.insert("content".into(), Value::String(entry.text));
                    state.blocks.push(Value::Object(block));
                }
                _ => {}
            }
        }
        "message_delta" => {
            let delta = payload.get("delta");
            let reason = delta
                .map(|delta| trimmed(delta.get("stop_reason")))
                .unwrap_or_default();
            if !reason.is_empty() {
                *stop_reason = reason;
            }
            if let Some(details) = delta
                .and_then(|delta| delta.get("stop_details"))
                .filter(|value| !value.is_null())
            {
                state.stop_details = Some(details.clone());
            }
            // The final usage adds output counts to `message_start`'s input
            // and cache counts; keep both.
            if let Some(Value::Object(usage)) = payload.get("usage") {
                let mut merged = match usage_raw.take() {
                    Some(Value::Object(start)) => start,
                    _ => Map::new(),
                };
                merged.extend(usage.clone());
                *usage_raw = Some(Value::Object(merged));
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
                resolve_max_tokens(&model, &reasoning, false),
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
            resolve_max_tokens(&model, &reasoning, false)
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

    fn claude_model(name: &str, effort: &str) -> RuntimeModel {
        RuntimeModel {
            provider_type: "anthropic".into(),
            model_name: name.into(),
            wire_api: "anthropic_messages".into(),
            reasoning_effort: effort.into(),
            ..RuntimeModel::default()
        }
    }

    fn body(messages: &[Message], choice: &str, model: &RuntimeModel, streaming: bool) -> Value {
        let tools = [ToolSpec {
            name: "report".into(),
            description: "Report the result.".into(),
            input_schema: Some(json!({
                "type": "object",
                "additionalProperties": false,
                "properties": { "answer": { "type": "string" } },
                "required": ["answer"],
            })),
        }];
        let (mut payload, items, _) = request_body(messages, &tools, choice, model, streaming);
        payload.insert("messages".into(), Value::Array(items));
        Value::Object(payload)
    }

    fn ask(text: &str) -> Vec<Message> {
        vec![
            Message::new("system", "You are Kition."),
            Message::new("user", text),
        ]
    }

    #[test]
    fn knows_each_claude_family() {
        let caps = |name: &str| claude(name).unwrap_or(UNKNOWN_CLAUDE);
        assert!(caps("claude-opus-5").adaptive);
        assert_eq!(caps("claude-opus-5").thinking_off, ThinkingOff::UpToHigh);
        assert_eq!(caps("claude-opus-5-5").thinking_off, ThinkingOff::Never);
        assert!(!caps("claude-opus-5-5").forced_tool_choice);
        assert!(caps("claude-opus-5").forced_tool_choice);
        assert!(!caps("claude-fable-5-1").forced_tool_choice);
        assert!(caps("claude-fable-5").forced_tool_choice);
        assert!(!caps("claude-opus-4-6").xhigh);
        assert!(!caps("claude-sonnet-5").system_messages);
        assert!(
            !caps("claude-haiku-4-5").adaptive,
            "Haiku 4.5 still takes budget_tokens"
        );
        assert!(!caps("claude-sonnet-4-5").adaptive);
        assert!(!caps("claude-3-7-sonnet").adaptive);
        assert!(caps("anthropic.Claude-Opus-5").adaptive, "a gateway name");
        assert_eq!(claude("deepseek-chat"), None);
        assert_eq!(
            caps("claude-opus-7"),
            UNKNOWN_CLAUDE,
            "a newer model gets the newest surface"
        );
    }

    #[test]
    fn adaptive_models_take_adaptive_thinking_and_effort() {
        let request = body(
            &ask("Hi"),
            "",
            &claude_model("claude-opus-5", "high"),
            false,
        );
        assert_eq!(
            request["thinking"],
            json!({ "type": "adaptive", "display": "summarized" })
        );
        assert_eq!(request["output_config"], json!({ "effort": "high" }));
        assert!(request["thinking"].get("budget_tokens").is_none());
        assert_eq!(request["max_tokens"], 16_000);
        let streamed = body(&ask("Hi"), "", &claude_model("claude-opus-5", "max"), true);
        assert_eq!(streamed["output_config"]["effort"], "max");
        assert_eq!(streamed["max_tokens"], 64_000);
        let older = body(
            &ask("Hi"),
            "",
            &claude_model("claude-opus-4-6", "xhigh"),
            false,
        );
        assert_eq!(
            older["output_config"]["effort"], "high",
            "Opus 4.6 has no xhigh"
        );
        let newer = body(
            &ask("Hi"),
            "",
            &claude_model("claude-sonnet-5", "xhigh"),
            false,
        );
        assert_eq!(newer["output_config"]["effort"], "xhigh");
        // Off: disabled where allowed, the lowest effort where it is not.
        let off = body(&ask("Hi"), "", &claude_model("claude-opus-5", "off"), false);
        assert_eq!(off["thinking"], json!({ "type": "disabled" }));
        assert!(off.get("output_config").is_none());
        let never = body(
            &ask("Hi"),
            "",
            &claude_model("claude-opus-5-5", "off"),
            false,
        );
        assert!(
            never.get("thinking").is_none(),
            "Opus 5.5 cannot turn thinking off"
        );
        assert_eq!(never["output_config"], json!({ "effort": "low" }));
        // No setting: the model's default, with room for its thinking.
        let default = body(&ask("Hi"), "", &claude_model("claude-fable-5-1", ""), true);
        assert!(default.get("thinking").is_none() && default.get("output_config").is_none());
        assert_eq!(default["max_tokens"], 64_000);
    }

    #[test]
    fn earlier_models_take_a_budget_and_no_effort() {
        let request = body(
            &ask("Hi"),
            "",
            &claude_model("claude-haiku-4-5", "medium"),
            false,
        );
        assert_eq!(
            request["thinking"],
            json!({ "type": "enabled", "budget_tokens": 4096 })
        );
        assert!(
            request.get("output_config").is_none(),
            "effort errors on Haiku 4.5"
        );
        let deep = body(
            &ask("Hi"),
            "",
            &claude_model("claude-haiku-4-5", "max"),
            false,
        );
        assert_eq!(deep["thinking"]["budget_tokens"], DEEP_THINKING_BUDGET);
        assert!(deep["max_tokens"].as_i64().unwrap_or(0) > DEEP_THINKING_BUDGET);
    }

    #[test]
    fn an_open_tool_turn_without_thinking_keeps_it_where_it_cannot_turn_off() {
        let items = tool_turn(vec![tool_use()]);
        let off = request_reasoning(&claude_model("claude-opus-5", "high"), &items);
        assert_eq!(off, vec![("thinking", json!({ "type": "disabled" }))]);
        let kept = request_reasoning(&claude_model("claude-opus-5-5", "high"), &items);
        assert_eq!(kept[0].1["type"], "adaptive");
    }

    #[test]
    fn caches_the_system_prompt_and_the_conversation_on_claude_only() {
        let request = body(
            &ask("Hi"),
            "",
            &claude_model("claude-opus-5", "high"),
            false,
        );
        assert_eq!(
            request["system"],
            json!([{ "type": "text", "text": "You are Kition.", "cache_control": { "type": "ephemeral" } }])
        );
        assert_eq!(request["cache_control"], json!({ "type": "ephemeral" }));
        let other = RuntimeModel {
            provider_type: "custom".into(),
            model_name: "kimi-k2".into(),
            ..RuntimeModel::default()
        };
        let plain = body(&ask("Hi"), "", &other, false);
        assert_eq!(plain["system"], "You are Kition.");
        assert!(plain.get("cache_control").is_none());
        let deepseek = RuntimeModel {
            provider_type: "deepseek".into(),
            model_name: "deepseek-chat".into(),
            ..RuntimeModel::default()
        };
        assert!(
            body(&ask("Hi"), "", &deepseek, false)
                .get("cache_control")
                .is_none()
        );
    }

    #[test]
    fn compacts_on_the_server_for_append_only_models() {
        let model = claude_model("claude-opus-5", "high");
        assert!(appends_only(&model));
        let request = body(&ask("Hi"), "", &model, true);
        assert_eq!(
            request["context_management"],
            json!({ "edits": [{ "type": "compact_20260112" }] })
        );
        let haiku = claude_model("claude-haiku-4-5", "high");
        assert!(!appends_only(&haiku));
        assert!(
            body(&ask("Hi"), "", &haiku, true)
                .get("context_management")
                .is_none()
        );
    }

    #[test]
    fn forces_a_tool_only_where_the_model_takes_it() {
        let forced = body(
            &ask("Go"),
            "report",
            &claude_model("claude-opus-5", "high"),
            false,
        );
        assert_eq!(
            forced["tool_choice"],
            json!({ "type": "tool", "name": "report" })
        );
        let auto = body(
            &ask("Go"),
            "report",
            &claude_model("claude-opus-5-5", "high"),
            false,
        );
        assert_eq!(auto["tool_choice"], json!({ "type": "auto" }));
        assert_eq!(auto["tools"][0]["strict"], true);
        let last = auto["messages"]
            .as_array()
            .and_then(|items| items.last())
            .cloned();
        assert_eq!(
            last,
            Some(
                json!({ "role": "system", "content": "Answer this request by calling the `report` tool." })
            )
        );
        assert_eq!(
            auto["system"][0]["text"], "You are Kition.",
            "the system prompt is not edited"
        );
        let unknown = body(
            &ask("Go"),
            "report",
            &claude_model("claude-opus-7", "high"),
            false,
        );
        assert_eq!(unknown["tool_choice"], json!({ "type": "auto" }));
        assert!(
            unknown["system"][0]["text"]
                .as_str()
                .is_some_and(|text| text.ends_with("calling the `report` tool."))
        );
    }

    #[test]
    fn strict_needs_closed_objects_that_require_every_property() {
        assert!(strict_compatible(&json!({
            "type": "object", "additionalProperties": false, "required": ["a"],
            "properties": { "a": { "type": "array", "items": { "type": "string" } } },
        })));
        assert!(!strict_compatible(
            &json!({ "type": "object", "properties": { "a": {} } })
        ));
        assert!(!strict_compatible(&json!({
            "type": "object", "additionalProperties": false, "required": [],
            "properties": { "a": { "type": "string" } },
        })));
    }

    #[test]
    fn tool_images_travel_inside_the_tool_result() {
        let messages = vec![
            Message::new("user", "Look"),
            Message {
                role: "assistant".into(),
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    name: "look".into(),
                    input: "{}".into(),
                }],
                ..Message::default()
            },
            Message {
                role: "tool".into(),
                tool_call_id: "c1".into(),
                content: "The preview".into(),
                parts: vec![MessagePart {
                    kind: "image_url".into(),
                    image_url: "data:image/png;base64,AAA=".into(),
                    ..MessagePart::default()
                }],
                ..Message::default()
            },
        ];
        let (_, items) = normalize_messages(&messages);
        assert_eq!(items.len(), 3, "no user message is added after the result");
        assert_eq!(
            items[2]["content"][0]["content"],
            json!([
                { "type": "text", "text": "The preview" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAA=" } },
            ])
        );
    }

    #[test]
    fn appended_messages_keep_the_earlier_request_as_a_prefix() {
        let model = claude_model("claude-opus-5", "high");
        let first = ask("Hi");
        let mut second = first.clone();
        second.push(Message {
            role: "assistant".into(),
            content: "Hello".into(),
            raw_items: vec![json!({ "type": "thinking", "thinking": "", "signature": "s1" })],
            ..Message::default()
        });
        second.push(Message::new("user", "Again"));
        let (one, two) = (
            body(&first, "", &model, true),
            body(&second, "", &model, true),
        );
        let (one, two) = (
            one["messages"].as_array().cloned().unwrap_or_default(),
            two["messages"].as_array().cloned().unwrap_or_default(),
        );
        assert_eq!(two[..one.len()], one[..]);
        assert_eq!(
            two[1]["content"][0]["signature"], "s1",
            "thinking replays unchanged"
        );
    }

    #[test]
    fn a_refusal_runs_no_tools_and_says_why() {
        let data = json!({
            "content": [{ "type": "tool_use", "id": "c1", "name": "rm", "input": {} }],
            "stop_reason": "refusal",
            "stop_details": { "type": "refusal", "category": "cyber", "explanation": "This looks harmful." },
        });
        let result = parse_json(
            data.as_object().unwrap_or(&Map::new()),
            "",
            "claude-opus-5",
            Instant::now(),
        );
        assert!(result.tool_calls.is_empty());
        assert_eq!(
            result.content,
            "The model declined this request. This looks harmful. (category: cyber)"
        );
    }

    #[test]
    fn a_paused_turn_continues_into_one_result() {
        let part = |text: &str, reason: &str| ChatResult {
            content: text.into(),
            response_items: vec![json!({ "type": "text", "text": text })],
            stop_reason: reason.into(),
            usage: super::super::types::Usage {
                prompt_tokens: 10,
                completion_tokens: 2,
                ..Default::default()
            },
            ..ChatResult::default()
        };
        let merged = merge_results(
            part("Searching. ", "pause_turn"),
            part("Found it.", "end_turn"),
        );
        assert_eq!(merged.content, "Searching. Found it.");
        assert_eq!(merged.stop_reason, "end_turn");
        assert_eq!(merged.response_items.len(), 2);
        assert_eq!(merged.usage.prompt_tokens, 20);
    }

    #[test]
    fn streams_a_compaction_block_and_keeps_the_start_usage() {
        let mut state = ResultState::default();
        let mut pending = HashMap::new();
        let (mut stop, mut usage) = (String::new(), None);
        let events = [
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": 900, "cache_read_input_tokens": 800 } } }),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "compaction" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "compaction_delta", "content": "Summary so far." } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 40 } }),
        ];
        for event in events {
            apply_stream_event(
                event.as_object().unwrap_or(&Map::new()),
                &mut state,
                &mut pending,
                &mut stop,
                &mut usage,
                &|_| {},
            );
        }
        assert_eq!(
            state.blocks,
            vec![json!({ "type": "compaction", "content": "Summary so far." })]
        );
        let usage = usage.unwrap_or_default();
        assert_eq!(
            (
                usage["input_tokens"].as_i64(),
                usage["cache_read_input_tokens"].as_i64(),
                usage["output_tokens"].as_i64()
            ),
            (Some(900), Some(800), Some(40))
        );
        // Replayed on the next request, before the text.
        let message = Message {
            role: "assistant".into(),
            content: "Done".into(),
            raw_items: state.blocks.clone(),
            ..Message::default()
        };
        let (_, items) = normalize_messages(&[Message::new("user", "Hi"), message]);
        assert_eq!(items[1]["content"][0]["type"], "compaction");
    }
}
