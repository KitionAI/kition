//! Image generation: the `image_search` tool, images the model's hosted
//! `image_generation` tool returns, saving web images, and direct image
//! requests from the image composer (`image_generation_intent`).

use std::collections::HashMap;

use base64::Engine as _;
use kition_ai::engine::{
    HostedImageGenerationCall, ImageRequest, KITION_CLOUD_PROVIDER, MessagePart,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use std::sync::Arc;

use kition_harness::driver::{LiveSink, append_live, next_turn, open_turn};
use kition_harness::events::{
    ContentBlock, EventBody, MessageSource, QueuedMessage, SessionEvent, TurnEndReason,
};
use kition_harness::llm::HostedCall;
use kition_harness::log::{SessionLog, SqliteLog};

use crate::run::{Run, ToolOutput, ToolResult, delivered, int_field, text_field};
use crate::tools::documents::default_folder;
use crate::tools::web;
use crate::workspace::{clean_path, sanitize_filename};

const MAX_REFERENCE_BYTES: usize = 5 * 1024 * 1024;

fn text_part(text: String) -> MessagePart {
    MessagePart {
        kind: "text".into(),
        text,
        ..MessagePart::default()
    }
}

fn artifact_folder(run: &Run, title: &str, requested: &str) -> String {
    if requested.is_empty() {
        default_folder(&run.active_document_path, title)
    } else {
        requested.to_owned()
    }
}

pub async fn image_search(run: &Run, input: &Value) -> ToolResult {
    let query = text_field(input, "query");
    if query.is_empty() {
        return Err("missing image prompt".into());
    }
    let count = int_field(input, "limit").clamp(1, 5);
    let width = match int_field(input, "width") {
        n if n <= 0 => 1024,
        n => n,
    };
    let height = match int_field(input, "height") {
        n if n <= 0 => 1024,
        n => n,
    };
    let request = ImageRequest {
        prompt: query.clone(),
        count,
        width,
        height,
        ..ImageRequest::default()
    };
    let images = run
        .agent
        .engine()
        .generate_images(&request, Some(&run.model))
        .await
        .map_err(|error| error.to_string())?;
    let mut title = text_field(input, "title");
    if title.is_empty() {
        title = query.clone();
    }
    let title = sanitize_filename(&title, "AI Image");
    let folder = artifact_folder(run, &title, &text_field(input, "folder"));
    let mut items = Vec::new();
    let mut paths = Vec::new();
    let mut deliverables = Vec::new();
    for (index, image) in images.iter().enumerate() {
        let item_title = if images.len() > 1 {
            format!("{title} {}", index + 1)
        } else {
            title.clone()
        };
        let extension = if image.extension.is_empty() {
            web::extension_for_image_mime(&image.mime_type)
                .unwrap_or(".png")
                .to_owned()
        } else {
            image.extension.clone()
        };
        let extension = if extension.starts_with('.') {
            extension
        } else {
            format!(".{extension}")
        };
        let filename = format!("{}{extension}", sanitize_filename(&item_title, "AI Image"));
        let path = run.workspace().write_new(&folder, &filename, &image.data)?;
        deliverables.push(delivered(&path, &item_title));
        items.push(json!({
            "path": path, "url": image.url, "preview_url": image.url, "title": item_title,
            "mime_type": image.mime_type,
            "width": if image.width != 0 { image.width } else { width },
            "height": if image.height != 0 { image.height } else { height },
            "prompt": query,
        }));
        paths.push(path);
    }
    let rows: Vec<String> = paths.iter().map(|path| format!("- `{path}`")).collect();
    Ok(ToolOutput {
        deliverables,
        follow_up: vec![text_part(format!(
            "[image_search system follow-up] The image generation completed and the file(s) below have been saved into the workspace:\n  - {}\nTell the user the image is ready and quote the saved path(s) verbatim so they can click to open it. Do not call image_search again unless the user asks for another image.",
            paths.join("\n  - ")
        ))],
        ..ToolOutput::new(
            format!("Generated and saved images:\n{}", rows.join("\n")),
            json!({ "query": query, "images": items, "generated": true, "saved_paths": paths }),
        )
    })
}

pub async fn save_image_asset(run: &Run, input: &Value) -> ToolResult {
    let url = text_field(input, "url");
    if url.is_empty() {
        return Err("missing image URL".into());
    }
    let mut title = text_field(input, "title");
    if title.is_empty() {
        title = text_field(input, "filename");
    }
    let mut title = sanitize_filename(&title, "Image Asset");
    if let Some((stem, ext)) = title.rsplit_once('.')
        && web::extension_for_image_mime(crate::attachments::image_mime(&format!("x.{ext}")))
            .is_some()
    {
        title = stem.to_owned();
    }
    let asset = web::fetch_image(run.agent.web(), &url).await?;
    let folder = artifact_folder(run, &title, &text_field(input, "folder"));
    let mut filename = text_field(input, "filename");
    if filename.is_empty() {
        filename = format!("{title}{}", asset.extension);
    } else if !filename.contains('.') {
        filename.push_str(asset.extension);
    }
    let path = run.workspace().write_new(&folder, &filename, &asset.data)?;
    Ok(ToolOutput {
        deliverables: vec![delivered(&path, &title)],
        ..ToolOutput::new(
            format!("Saved image asset: `{path}`"),
            json!({ "path": path, "source_url": url, "mime_type": asset.mime, "bytes": asset.data.len() }),
        )
    })
}

/// Saves images the model made with its hosted tool and returns them as
/// hosted `image_generation` calls for the log, with the follow-up for the
/// next model step. An image without an id gets `<id_prefix>_img_<i>`.
pub fn save_hosted_images(
    run: &Run,
    wire_api: &str,
    id_prefix: &str,
    calls: &[HostedImageGenerationCall],
) -> (Vec<HostedCall>, Vec<MessagePart>) {
    let mut saved = Vec::new();
    let mut hosted = Vec::new();
    for (index, call) in calls.iter().enumerate() {
        let Ok(data) = base64::engine::general_purpose::STANDARD.decode(call.result.trim()) else {
            continue;
        };
        if data.is_empty() {
            continue;
        }
        let id = if call.id.trim().is_empty() {
            format!("{id_prefix}_img_{index}")
        } else {
            call.id.trim().to_owned()
        };
        let folder = format!("Agent/images/{}", run.session_id);
        let filename = format!("{}.png", sanitize_filename(&id, "image"));
        let Ok(path) = run.workspace().write_new(&folder, &filename, &data) else {
            continue;
        };
        let input =
            json!({ "hosted": true, "revised_prompt": call.revised_prompt, "size": call.size });
        hosted.push(HostedCall {
            call_id: id,
            name: "image_generation".into(),
            arguments: input,
            value: json!({
                "provider": wire_api, "hosted": true, "status": call.status,
                "path": path, "mime": "image/png",
            }),
            meta: Some(json!({ "hosted": true })),
            files: vec![delivered(&path, "")],
        });
        saved.push(path);
    }
    if saved.is_empty() {
        return (hosted, Vec::new());
    }
    let mut lines = vec![
        "[image_generation system follow-up] The hosted image_generation tool produced the image(s) below and they have been saved into the workspace:".to_owned(),
        format!("  - {}", saved.join("\n  - ")),
        "Continue the user's original task using these saved paths. Do not request another image unless the user asks for one.".to_owned(),
    ];
    let active = run.active_document_path.trim();
    if active.is_empty() {
        lines.push("Report the saved workspace-relative paths in the final reply.".into());
    } else {
        lines.push(format!("Current linked document: `{active}`."));
        lines.push("If the original request asked for images or illustrations for this document or article, do not finish after generating artifacts: update this same document with Markdown image links at relevant positions before the final reply. Use document_write for a whole-document rewrite. Use apply_patch only for a small localized insertion whose exact surrounding text came from a complete recent document_read.".into());
        lines.push("If the user requested standalone image assets only, report the saved workspace-relative paths without modifying the document.".into());
    }
    (hosted, vec![text_part(lines.join("\n"))])
}

// --- Image composer requests ---------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageIntent {
    #[serde(rename = "type")]
    pub kind: String,
    pub schema_version: i64,
    pub request_id: String,
    pub operation: String,
    pub instruction: String,
    pub locale: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub template_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub template_version: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub template_variables: HashMap<String, String>,
    pub aspect_ratio: String,
    pub quality: String,
    pub resolution: String,
    pub variants: i64,
    pub text_mode: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub exact_text: String,
    pub reference_paths: Vec<String>,
    pub surface: String,
    pub target: Map<String, Value>,
    pub placement_preference: String,
    pub client_capability_version: i64,
}

fn identifier(value: &str) -> bool {
    let mut chars = value.chars();
    value.len() <= 128
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}

fn locale(value: &str) -> bool {
    let mut parts = value.split('-');
    let first = parts.next().unwrap_or_default();
    value.len() <= 35
        && (2..=3).contains(&first.len())
        && first.chars().all(|c| c.is_ascii_alphabetic())
        && parts.all(|part| {
            (2..=8).contains(&part.len()) && part.chars().all(|c| c.is_ascii_alphanumeric())
        })
}

fn workspace_path(path: &str) -> bool {
    !path.trim().is_empty()
        && path.chars().count() <= 1024
        && !path.contains(['\\', '\0', ':'])
        && clean_path(path, false).is_ok_and(|cleaned| cleaned == path)
}

fn number(target: &Map<String, Value>, key: &str) -> Option<f64> {
    target.get(key).and_then(Value::as_f64)
}

fn target_text<'a>(target: &'a Map<String, Value>, key: &str) -> &'a str {
    target.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn validate_target(surface: &str, placement: &str, target: &Map<String, Value>) -> bool {
    let kind = target_text(target, "type");
    let allowed: &[&str] = match kind {
        "image.target.chat" => &[],
        "image.target.document" => &[
            "document_path",
            "document_format",
            "cursor_offset",
            "selected_image_path",
        ],
        "image.target.table" => &[
            "data_document_id",
            "table_id",
            "record_ids",
            "attachment_field_id",
        ],
        "image.target.whiteboard" => &[
            "board_path",
            "selected_element_ids",
            "replace_element_id",
            "viewport_center",
        ],
        "image.target.design" => &["design_path", "artboard", "replace_layer_id"],
        _ => return false,
    };
    for (key, value) in target {
        let known = key == "type"
            || (kind != "image.target.chat" && key == "target_revision")
            || allowed.contains(&key.as_str());
        if !known || value.is_null() || value.as_str() == Some("") {
            return false;
        }
    }
    if target_text(target, "target_revision").len() > 128
        || target_text(target, "document_format").len() > 64
    {
        return false;
    }
    if number(target, "cursor_offset").is_some_and(|n| !(0.0..=1e9).contains(&n))
        || number(target, "attachment_field_id").is_some_and(|n| n < 1.0)
    {
        return false;
    }
    let selected = target_text(target, "selected_image_path");
    if !selected.is_empty() && !workspace_path(selected) {
        return false;
    }
    let unique_ids = |key: &str, check: &dyn Fn(&Value) -> bool| -> bool {
        let Some(items) = target.get(key) else {
            return true;
        };
        let Some(items) = items.as_array() else {
            return false;
        };
        let mut seen = std::collections::HashSet::new();
        items.len() <= 100
            && items
                .iter()
                .all(|item| check(item) && seen.insert(item.to_string()))
    };
    match surface {
        "chat" => kind == "image.target.chat" && placement == "review",
        "document" => {
            kind == "image.target.document" && workspace_path(target_text(target, "document_path"))
        }
        "table" => {
            kind == "image.target.table"
                && number(target, "data_document_id").is_some_and(|n| n >= 1.0)
                && number(target, "table_id").is_some_and(|n| n >= 1.0)
                && unique_ids("record_ids", &|item| {
                    item.as_i64().is_some_and(|id| id >= 1)
                })
        }
        "whiteboard" => {
            let replace = target_text(target, "replace_element_id");
            let center_ok = match target.get("viewport_center") {
                None => true,
                Some(Value::Object(point)) => {
                    point.len() == 2
                        && ["x", "y"].iter().all(|axis| {
                            point
                                .get(*axis)
                                .and_then(Value::as_f64)
                                .is_some_and(|n| n.abs() <= 1e7)
                        })
                }
                Some(_) => false,
            };
            kind == "image.target.whiteboard"
                && workspace_path(target_text(target, "board_path"))
                && unique_ids("selected_element_ids", &|item| {
                    item.as_str().is_some_and(identifier)
                })
                && (replace.is_empty() || identifier(replace))
                && center_ok
        }
        "design" => {
            let replace = target_text(target, "replace_layer_id");
            let artboard_ok = match target.get("artboard") {
                None => true,
                Some(board) => ["width", "height"].iter().all(|axis| {
                    board
                        .get(*axis)
                        .and_then(Value::as_f64)
                        .is_some_and(|n| (1.0..=1e5).contains(&n))
                }),
            };
            kind == "image.target.design"
                && workspace_path(target_text(target, "design_path"))
                && (replace.is_empty() || identifier(replace))
                && artboard_ok
        }
        _ => false,
    }
}

/// Parses and validates an image composer request.
pub fn parse_intent(raw: &Value) -> Result<ImageIntent, String> {
    let invalid = || "invalid image generation intent".to_owned();
    if let Some(fields) = raw.as_object()
        && fields.values().any(Value::is_null)
    {
        return Err(invalid());
    }
    let intent: ImageIntent = serde_json::from_value(raw.clone()).map_err(|_| invalid())?;
    let i = &intent;
    let ok = i.kind == "image_generation.intent"
        && i.schema_version == 1
        && i.client_capability_version == 1
        && identifier(&i.request_id)
        && ["generate", "edit"].contains(&i.operation.as_str())
        && !i.instruction.trim().is_empty()
        && i.instruction.chars().count() <= 12_000
        && locale(&i.locale)
        && ["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"].contains(&i.aspect_ratio.as_str())
        && ["low", "medium", "high"].contains(&i.quality.as_str())
        && ["1K", "2K", "4K"].contains(&i.resolution.as_str())
        && (1..=5).contains(&i.variants)
        && ["editable_overlay", "baked_text", "no_text"].contains(&i.text_mode.as_str())
        && i.exact_text.chars().count() <= 2000
        && ["review", "insert", "replace"].contains(&i.placement_preference.as_str())
        && i.template_id.is_empty() == i.template_version.is_empty()
        && (i.template_id.is_empty()
            || (identifier(&i.template_id) && identifier(&i.template_version)))
        && i.template_variables.len() <= 32
        && i.template_variables
            .iter()
            .all(|(k, v)| identifier(k) && v.chars().count() <= 4000)
        && i.reference_paths.len() <= 8
        && (i.operation != "edit" || !i.reference_paths.is_empty())
        && i.reference_paths.iter().all(|path| workspace_path(path))
        && i.reference_paths
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            == i.reference_paths.len()
        && validate_target(&i.surface, &i.placement_preference, &i.target);
    if ok { Ok(intent) } else { Err(invalid()) }
}

pub fn intent_dimensions(intent: &ImageIntent) -> (i64, i64) {
    let edge = match intent.resolution.as_str() {
        "2K" => 2048,
        "4K" => 4096,
        _ => 1024,
    };
    let (w, h) = intent
        .aspect_ratio
        .split_once(':')
        .and_then(|(w, h)| Some((w.parse::<f64>().ok()?, h.parse::<f64>().ok()?)))
        .unwrap_or((1.0, 1.0));
    let scaled = |a: f64, b: f64| (((edge as f64 * a / b) / 64.0).round() as i64 * 64).max(64);
    if w >= h {
        (edge, scaled(h, w))
    } else {
        (scaled(w, h), edge)
    }
}

fn digest(text: &[u8]) -> String {
    hex::encode(Sha256::digest(text))
}

/// Width and height from a PNG, JPEG, or WebP header.
pub fn image_size(data: &[u8]) -> Option<(u32, u32)> {
    let be16 = |at: usize| Some(u16::from_be_bytes([*data.get(at)?, *data.get(at + 1)?]) as u32);
    let be32 = |at: usize| Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?));
    let le16 = |at: usize| Some(u16::from_le_bytes([*data.get(at)?, *data.get(at + 1)?]) as u32);
    let le24 = |at: usize| {
        Some(u32::from_le_bytes([
            *data.get(at)?,
            *data.get(at + 1)?,
            *data.get(at + 2)?,
            0,
        ]))
    };
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some((be32(16)?, be32(20)?));
    }
    if data.starts_with(&[0xFF, 0xD8]) {
        let mut at = 2;
        while at + 9 < data.len() {
            if data[at] != 0xFF {
                at += 1;
                continue;
            }
            let marker = data[at + 1];
            if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
                return Some((be16(at + 7)?, be16(at + 5)?));
            }
            at += 2 + be16(at + 2)? as usize;
        }
        return None;
    }
    if data.get(0..4) == Some(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        return match data.get(12..16)? {
            b"VP8 " => Some((le16(26)? & 0x3FFF, le16(28)? & 0x3FFF)),
            b"VP8L" => {
                let bits = u32::from_le_bytes(data.get(21..25)?.try_into().ok()?);
                Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
            }
            b"VP8X" => Some((le24(24)? + 1, le24(27)? + 1)),
            _ => None,
        };
    }
    None
}

/// The fingerprint of an image composer request's settings.
pub fn intent_sha256(intent: &ImageIntent) -> String {
    digest(&serde_json::to_vec(intent).unwrap_or_default())
}

/// The call id of variant `index` of request `request_id`.
fn variant_call_id(request_id: &str, index: i64) -> String {
    format!("img_{}_{index}", &digest(request_id.as_bytes())[..24])
}

/// Whether `intent` is new to the session log: `Ok(false)` when an
/// `image_generation` call already logged its request id with the same
/// settings, an error when it logged other settings.
pub fn claim(events: &[SessionEvent], intent: &ImageIntent) -> Result<bool, String> {
    let fingerprint = intent_sha256(intent);
    for event in events {
        let EventBody::ToolCall {
            name, arguments, ..
        } = &event.body
        else {
            continue;
        };
        if name != "image_generation"
            || arguments["request_id"].as_str() != Some(intent.request_id.as_str())
        {
            continue;
        }
        if arguments["intent_sha256"].as_str() != Some(fingerprint.as_str()) {
            return Err("image request ID was already used for different settings".into());
        }
        return Ok(false);
    }
    Ok(true)
}

/// An image composer request as one logged turn without a model call:
/// `turn/start`, `step/start`, the user's `user/message`, per variant an
/// `image_generation` `tool/call` and its `tool/result`, then the reply,
/// `step/end`, and `turn/end`. Every append happens under the session's
/// turn guard, which `session::prepare` took.
pub struct Composer {
    log: Arc<dyn SessionLog>,
    key: String,
    live: LiveSink,
    turn: u32,
    request_id: String,
    /// The variant call that has no result yet.
    open: std::sync::Mutex<Option<String>>,
    /// Set by the first `end`; later ends append nothing.
    ended: std::sync::atomic::AtomicBool,
}

impl Composer {
    /// Opens the turn with the user's message.
    pub fn start(run: &Run, request_id: &str, content: &str) -> Result<Self, String> {
        Self::begin(
            Arc::new(SqliteLog::new(run.agent.db().clone())),
            crate::log::log_key(run.session_id),
            run.live.clone(),
            request_id,
            QueuedMessage {
                id: run.message_id.clone(),
                content: vec![ContentBlock::text(content)],
                source: MessageSource::user(),
            },
        )
    }

    /// Opens the turn with `message` on `key` of `log`, sending its events
    /// to `live`. When the turn started but its step or message could not be
    /// logged, the turn ends as failed.
    fn begin(
        log: Arc<dyn SessionLog>,
        key: String,
        live: LiveSink,
        request_id: &str,
        message: QueuedMessage,
    ) -> Result<Self, String> {
        let turn = next_turn(&log.read(&key)?);
        let composer = Self {
            log,
            key,
            live,
            turn,
            request_id: request_id.to_owned(),
            open: std::sync::Mutex::new(None),
            ended: std::sync::atomic::AtomicBool::new(false),
        };
        open_turn(
            composer.log.as_ref(),
            &composer.key,
            &composer.live,
            turn,
            Some(&message),
        )?;
        let opened = composer
            .append(EventBody::StepStart { turn, step: 1 })
            .and_then(|()| {
                composer.append(EventBody::UserMessage {
                    id: message.id,
                    content: message.content,
                    source: message.source,
                })
            });
        if let Err(error) = opened {
            composer.append(EventBody::TurnEnd {
                turn,
                reason: TurnEndReason::Failed,
                error: error.clone(),
            })?;
            return Err(error);
        }
        Ok(composer)
    }

    fn append(&self, body: EventBody) -> Result<(), String> {
        append_live(self.log.as_ref(), &self.key, &self.live, body).map(|_| ())
    }

    fn open(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.open
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Logs the call for variant `index`.
    fn call(&self, index: i64, arguments: Value) -> Result<String, String> {
        let call_id = variant_call_id(&self.request_id, index);
        self.append(EventBody::ToolCall {
            turn: self.turn,
            step: 1,
            call_id: call_id.clone(),
            name: "image_generation".into(),
            arguments,
            hosted: true,
        })?;
        *self.open() = Some(call_id.clone());
        Ok(call_id)
    }

    /// Logs the saved variant of the open call and hands its file over.
    fn saved(&self, artifact: &Value, path: &str, title: &str) -> Result<(), String> {
        let Some(call_id) = self.open().take() else {
            return Err("no image variant is pending".into());
        };
        self.append(EventBody::ToolResult {
            turn: self.turn,
            step: 1,
            call_id: call_id.clone(),
            name: "image_generation".into(),
            value: artifact.clone(),
            content: vec![ContentBlock::text(format!(
                "Generated image {}: {path}",
                artifact["variant_index"].as_i64().unwrap_or_default() + 1
            ))],
            is_error: false,
            meta: Some(json!({
                "kind": "image_generation.variant",
                "request_id": self.request_id,
                "artifact": artifact,
            })),
            hosted: true,
        })?;
        self.append(EventBody::DeliverablesPresented {
            turn: self.turn,
            call_id,
            files: vec![delivered(path, title)],
        })
    }

    /// Ends the turn: a failed open call first, then the reply (when the
    /// turn completed), `step/end`, and `turn/end`. Only the first end
    /// appends anything, even when one of its appends failed.
    fn end(
        &self,
        reason: TurnEndReason,
        error: Option<(&str, &str, bool)>,
        reply: Option<&str>,
    ) -> Result<(), String> {
        if self.ended.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        let open = self.open().take();
        if let (Some(call_id), Some((code, message, retryable))) = (open, error) {
            self.append(EventBody::ToolResult {
                turn: self.turn,
                step: 1,
                call_id,
                name: "image_generation".into(),
                value: Value::Null,
                content: vec![
                    ContentBlock::text(message),
                    ContentBlock::text(
                        json!({ "code": code, "message": message, "retryable": retryable })
                            .to_string(),
                    ),
                ],
                is_error: true,
                meta: None,
                hosted: true,
            })?;
        }
        if let Some(reply) = reply {
            self.append(EventBody::AssistantMessage {
                turn: self.turn,
                step: 1,
                content: reply.to_owned(),
                tool_calls: Vec::new(),
                stop_reason: "stop".into(),
                provider: "kition".into(),
                model: "image-composer".into(),
                raw_items: Vec::new(),
            })?;
        }
        self.append(EventBody::StepEnd {
            turn: self.turn,
            step: 1,
        })?;
        self.append(EventBody::TurnEnd {
            turn: self.turn,
            reason,
            error: error
                .map(|(_, message, _)| message.to_owned())
                .unwrap_or_default(),
        })
    }

    /// Ends the turn as cancelled (the client left) unless it already ended.
    pub fn cancel(&self) {
        let ended = self.end(
            TurnEndReason::Cancelled,
            Some(("image_generation_canceled", "canceled", true)),
            None,
        );
        if let Err(error) = ended {
            tracing::warn!(error = %error, "could not log the cancelled image request");
        }
    }
}

/// Ends the logged turn of a failed image request, or a cancelled one when
/// the client has gone away.
fn fail_intent(run: &Run, composer: &Composer, code: &str, message: String) {
    if run.emitter.is_closed() {
        composer.cancel();
        return;
    }
    let message = crate::run::truncate_chars(&message, 1800);
    let retryable = code != "reference_invalid";
    let ended = composer.end(
        TurnEndReason::Failed,
        Some((code, &message, retryable)),
        None,
    );
    if let Err(error) = ended {
        tracing::warn!(error = %error, "could not log the failed image request");
    }
}

async fn resolve_prompt(run: &Run, portal: &str, intent: &ImageIntent) -> Result<String, String> {
    let mut prompt = intent.instruction.clone();
    if !intent.template_id.is_empty() {
        let base = if portal.trim().is_empty() {
            "https://kition.ai"
        } else {
            portal.trim()
        };
        let mut endpoint = url::Url::parse(base)
            .map_err(|_| "image template service is unavailable".to_owned())?;
        let loopback = matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost"));
        if endpoint.scheme() != "https" && !(endpoint.scheme() == "http" && loopback) {
            return Err("image template service is unavailable".into());
        }
        let path = format!(
            "{}/api/media/image-templates/{}/resolve",
            endpoint.path().trim_end_matches('/'),
            url::form_urlencoded::byte_serialize(intent.template_id.as_bytes()).collect::<String>()
        );
        endpoint.set_path(&path);
        let response = run
            .agent
            .web()
            .post(endpoint)
            .timeout(std::time::Duration::from_secs(20))
            .json(&json!({
                "version": intent.template_version, "variables": intent.template_variables,
                "instruction": intent.instruction, "operation": intent.operation,
                "has_reference_image": !intent.reference_paths.is_empty(),
            }))
            .send()
            .await
            .map_err(|_| "image template resolution failed".to_owned())?;
        if response.status().as_u16() != 200 {
            return Err(format!(
                "image template is unavailable or its requirements are not met (HTTP {})",
                response.status().as_u16()
            ));
        }
        let body = response
            .bytes()
            .await
            .map_err(|_| "image template resolution failed".to_owned())?;
        let resolved: Value =
            serde_json::from_slice(&body[..body.len().min(256 << 10)]).unwrap_or(Value::Null);
        let text = |key: &str| resolved[key].as_str().unwrap_or_default();
        if text("id") != intent.template_id
            || text("version") != intent.template_version
            || text("prompt").trim().is_empty()
            || text("prompt").len() > 200_000
        {
            return Err("image template resolution returned an invalid version or prompt".into());
        }
        if digest(text("prompt").as_bytes()) != text("prompt_sha256") {
            return Err("image template prompt integrity check failed".into());
        }
        prompt = text("prompt").to_owned();
    }
    prompt.push_str(&format!(
        "\nOutput: one {} image, {}, {} quality.",
        intent.aspect_ratio, intent.resolution, intent.quality
    ));
    match intent.text_mode.as_str() {
        "editable_overlay" => prompt.push_str("\nDo not render readable text, letters, numerals, logos, or pseudo-text. Leave a clean text zone for a separate editable text layer."),
        "no_text" => prompt.push_str("\nDo not include words, letters, numerals, logos, signatures, watermarks, or pseudo-text."),
        _ if !intent.exact_text.trim().is_empty() => {
            prompt.push_str(&format!("\nRequired visible copy: {}", intent.exact_text));
        }
        _ => {}
    }
    Ok(prompt)
}

fn references(run: &Run, paths: &[String]) -> Result<Vec<String>, String> {
    paths
        .iter()
        .map(|path| {
            let (_, absolute) = run.workspace().locate(path, false).map_err(|_| {
                "reference image is outside the workspace or unavailable".to_owned()
            })?;
            let data = std::fs::read(absolute).map_err(|_| {
                "reference image is outside the workspace or unavailable".to_owned()
            })?;
            if data.is_empty() || data.len() > MAX_REFERENCE_BYTES {
                return Err("reference image is empty, unreadable, or exceeds 5 MB".into());
            }
            let mime = kition_ai::engine::sniff_mime(&data);
            if !["image/png", "image/jpeg", "image/webp"].contains(&mime) {
                return Err("reference image must be PNG, JPEG, or WebP".into());
            }
            Ok(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&data)
            ))
        })
        .collect()
}

/// Runs an image composer request that `claim` accepted: generates each
/// variant, saves it, and logs it on `composer`'s turn, then the reply.
pub async fn stream_intent(run: &Run, portal: &str, intent: &ImageIntent, composer: &Composer) {
    if let Err((code, message)) = generate_intent(run, portal, intent, composer).await {
        fail_intent(run, composer, code, message);
    }
}

async fn generate_intent(
    run: &Run,
    portal: &str,
    intent: &ImageIntent,
    composer: &Composer,
) -> Result<(), (&'static str, String)> {
    let (width, height) = intent_dimensions(intent);
    let fingerprint = intent_sha256(intent);
    let arguments = |index: i64| {
        let mut arguments = json!({
            "request_id": intent.request_id, "intent_sha256": fingerprint,
            "variant_index": index, "variant_count": intent.variants,
            "size": format!("{width}x{height}"), "quality": intent.quality,
            "reference_count": intent.reference_paths.len(),
        });
        if !intent.template_id.is_empty() {
            arguments["template_id"] = json!(intent.template_id);
        }
        arguments
    };
    let progress = |error: String| ("image_progress_failed", error);
    let mut call_id = composer.call(0, arguments(0)).map_err(progress)?;
    let refs =
        references(run, &intent.reference_paths).map_err(|error| ("reference_invalid", error))?;
    let prompt = resolve_prompt(run, portal, intent)
        .await
        .map_err(|error| ("template_resolution_failed", error))?;
    let folder = format!(
        "Agent/images/{}/{}",
        run.session_id,
        &digest(intent.request_id.as_bytes())[..24]
    );
    let provider_class = if run
        .model
        .provider_type
        .trim()
        .eq_ignore_ascii_case(KITION_CLOUD_PROVIDER)
    {
        "kition_cloud"
    } else {
        "connected_provider"
    };
    let prompt_digest = digest(prompt.as_bytes());
    let mut count = 0;
    for index in 0..intent.variants {
        if run.emitter.is_closed() {
            return Err(("image_generation_canceled", "canceled".into()));
        }
        if index > 0 {
            call_id = composer.call(index, arguments(index)).map_err(progress)?;
        }
        let request = ImageRequest {
            prompt: prompt.clone(),
            references: refs.clone(),
            count: 1,
            width,
            height,
            quality: intent.quality.clone(),
        };
        let images = run
            .agent
            .engine()
            .generate_images(&request, Some(&run.model))
            .await
            .map_err(|error| ("image_provider_error", error.to_string()))?;
        let image = images
            .into_iter()
            .next()
            .filter(|image| !image.data.is_empty())
            .ok_or_else(|| {
                (
                    "image_result_missing",
                    "image provider returned no usable image".to_owned(),
                )
            })?;
        let mime = kition_ai::engine::sniff_mime(&image.data);
        let extension = ["image/png", "image/jpeg", "image/webp"]
            .contains(&mime)
            .then(|| web::extension_for_image_mime(mime))
            .flatten()
            .ok_or_else(|| {
                (
                    "image_result_invalid",
                    "image provider returned an unsupported image format".to_owned(),
                )
            })?;
        let (w, h) = image_size(&image.data)
            .filter(|(w, h)| (1..=65536).contains(w) && (1..=65536).contains(h))
            .ok_or_else(|| {
                (
                    "image_result_invalid",
                    "image provider returned an invalid image".to_owned(),
                )
            })?;
        let path = run
            .workspace()
            .write_new(
                &folder,
                &format!("variant-{}{extension}", index + 1),
                &image.data,
            )
            .map_err(|_| {
                (
                    "image_save_failed",
                    "failed to save the generated image".to_owned(),
                )
            })?;
        let title = format!("Generated image {}", index + 1);
        let mut provenance = json!({
            "request_id": intent.request_id, "provider_class": provider_class,
            "prompt_sha256": prompt_digest, "source_paths": intent.reference_paths,
        });
        if !intent.template_id.is_empty() {
            provenance["template_id"] = json!(intent.template_id);
            provenance["template_version"] = json!(intent.template_version);
        }
        let artifact_view = json!({
            "call_id": call_id, "path": path, "mime_type": mime, "title": title,
            "width": w, "height": h, "variant_index": index, "variant_count": intent.variants,
            "created_at": kition_core::time::to_rfc3339(kition_core::now_millis()),
            "provenance": provenance,
        });
        composer
            .saved(&artifact_view, &path, &title)
            .map_err(|error| ("image_save_failed", error))?;
        count += 1;
    }
    let reply = format!("Generated {count} image(s) for review.");
    composer
        .end(TurnEndReason::Completed, None, Some(&reply))
        .map_err(progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent() -> Value {
        json!({
            "type": "image_generation.intent", "schema_version": 1, "request_id": "req-1",
            "operation": "generate", "instruction": "A red fox", "locale": "en-US",
            "aspect_ratio": "16:9", "quality": "high", "resolution": "1K", "variants": 2,
            "text_mode": "no_text", "reference_paths": [], "surface": "chat",
            "target": { "type": "image.target.chat" }, "placement_preference": "review",
            "client_capability_version": 1,
        })
    }

    #[test]
    fn validates_intents() {
        let parsed = parse_intent(&intent()).unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(intent_dimensions(&parsed), (1024, 576));
        let mut bad = intent();
        bad["extra"] = json!(1);
        assert!(parse_intent(&bad).is_err());
        let mut bad = intent();
        bad["target"] = json!({ "type": "image.target.chat", "document_path": "a.md" });
        assert!(parse_intent(&bad).is_err());
        let mut doc = intent();
        doc["surface"] = json!("document");
        doc["placement_preference"] = json!("insert");
        doc["target"] = json!({ "type": "image.target.document", "document_path": "Notes/a.md", "cursor_offset": 4 });
        assert!(parse_intent(&doc).is_ok());
        doc["target"]["document_path"] = json!("../a.md");
        assert!(parse_intent(&doc).is_err());
    }

    /// A memory log that refuses `step/start`.
    #[derive(Default)]
    struct NoSteps(kition_harness::log::MemoryLog);

    impl SessionLog for NoSteps {
        fn append(&self, session: &str, body: EventBody) -> Result<SessionEvent, String> {
            if matches!(body, EventBody::StepStart { .. }) {
                return Err("disk full".into());
            }
            self.0.append(session, body)
        }

        fn read(&self, session: &str) -> Result<Vec<SessionEvent>, String> {
            self.0.read(session)
        }
    }

    fn fox() -> QueuedMessage {
        QueuedMessage {
            id: "msg-1".into(),
            content: vec![ContentBlock::text("A red fox")],
            source: MessageSource::user(),
        }
    }

    fn types(log: &dyn SessionLog) -> Vec<String> {
        log.read("agent:1")
            .unwrap_or_else(|error| panic!("{error}"))
            .iter()
            .map(|event| {
                serde_json::to_value(&event.body).unwrap_or_default()["type"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn a_composer_turn_ends_once() {
        let log = Arc::new(kition_harness::log::MemoryLog::default());
        let composer = Composer::begin(
            log.clone(),
            "agent:1".into(),
            Arc::new(|_| {}),
            "req-1",
            fox(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        composer
            .call(0, json!({ "request_id": "req-1" }))
            .unwrap_or_else(|error| panic!("{error}"));
        composer
            .end(TurnEndReason::Completed, None, Some("Done."))
            .unwrap_or_else(|error| panic!("{error}"));
        composer.cancel();
        composer
            .end(TurnEndReason::Failed, Some(("x", "late", true)), None)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            types(log.as_ref()),
            [
                "agent/inbox/spliced",
                "turn/start",
                "agent/inbox/spliced",
                "step/start",
                "user/message",
                "tool/call",
                "assistant/message",
                "step/end",
                "turn/end",
            ]
        );
        let events = log
            .read("agent:1")
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(events.iter().any(|event| matches!(
            &event.body,
            EventBody::ToolCall {
                turn: 1,
                step: 1,
                hosted: true,
                ..
            }
        )));
        assert!(events.iter().any(|event| matches!(
            &event.body,
            EventBody::AssistantMessage { turn: 1, step: 1, provider, model, .. }
                if provider == "kition" && model == "image-composer"
        )));
    }

    #[test]
    fn a_composer_that_cannot_open_its_step_ends_the_turn_as_failed() {
        let log = Arc::new(NoSteps::default());
        let opened = Composer::begin(
            log.clone(),
            "agent:1".into(),
            Arc::new(|_| {}),
            "req-1",
            fox(),
        );
        assert_eq!(opened.err(), Some("disk full".to_owned()));
        let events = log
            .read("agent:1")
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            types(log.as_ref()),
            [
                "agent/inbox/spliced",
                "turn/start",
                "agent/inbox/spliced",
                "turn/end"
            ]
        );
        assert!(matches!(
            &events[3].body,
            EventBody::TurnEnd { turn: 1, reason: TurnEndReason::Failed, error } if error == "disk full"
        ));
    }

    #[test]
    fn reads_image_sizes() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&640_u32.to_be_bytes());
        png.extend_from_slice(&480_u32.to_be_bytes());
        assert_eq!(image_size(&png), Some((640, 480)));
        assert_eq!(image_size(b"nope"), None);
    }
}
