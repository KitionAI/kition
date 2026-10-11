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

use kition_harness::llm::HostedCall;

use crate::run::{EventInput, Run, ToolOutput, ToolResult, delivered, int_field, text_field};
use crate::store::{self, AgentMessage, AgentSession};
use crate::stream::{Frame, value};
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

pub async fn image_search(run: &Run, tool_call_id: i64, input: &Value) -> ToolResult {
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
    let mut first = None;
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
        let artifact = run
            .record_artifact(
                Some(tool_call_id),
                "image",
                &path,
                &image.mime_type,
                &item_title,
            )
            .await;
        if first.is_none() {
            first = artifact;
        }
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
        artifact: first,
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

pub async fn save_image_asset(run: &Run, tool_call_id: i64, input: &Value) -> ToolResult {
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
    let artifact = run
        .record_artifact(Some(tool_call_id), "image", &path, &asset.mime, &title)
        .await;
    Ok(ToolOutput {
        artifact,
        deliverables: vec![delivered(&path, &title)],
        ..ToolOutput::new(
            format!("Saved image asset: `{path}`"),
            json!({ "path": path, "source_url": url, "mime_type": asset.mime, "bytes": asset.data.len() }),
        )
    })
}

/// Saves images the model made with its hosted tool, records each as an
/// `image_generation` tool call, and returns them as hosted calls for the
/// log with the follow-up for the next model step. An image without an id
/// gets `<id_prefix>_img_<i>`.
pub async fn save_hosted_images(
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
            call_id: id.clone(),
            name: "image_generation".into(),
            arguments: input.clone(),
            value: json!({
                "provider": wire_api, "hosted": true, "status": call.status,
                "path": path, "mime": "image/png",
            }),
            meta: Some(json!({ "hosted": true })),
            files: vec![delivered(&path, "")],
        });
        let Some(mut tool_call) =
            crate::tools::start_tool_call(run, "image_generation", input).await
        else {
            continue;
        };
        let artifact = run
            .record_artifact(Some(tool_call.id), "image", &path, "image/png", &id)
            .await;
        let mut output = json!({
            "provider": wire_api, "hosted": true, "status": call.status,
            "path": path, "mime": "image/png",
        });
        if let Some(artifact) = &artifact {
            output["artifact_id"] = json!(artifact.id);
        }
        crate::tools::complete_tool_call(run, &mut tool_call, output.clone()).await;
        run.event(
            EventInput::new(
                "tool.completed",
                "artifact",
                "completed",
                "Image generated",
                path.clone(),
            )
            .tool_call(Some(tool_call.id))
            .data(json!({ "tool_name": "image_generation", "output": output })),
        )
        .await;
        run.send(&Frame {
            tool_call: value(&tool_call),
            ..Frame::new("tool_call")
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

async fn emit_image_event(
    run: &Run,
    intent: &ImageIntent,
    name: &str,
    status: &str,
    fields: Value,
) -> Result<(), String> {
    let mut event = json!({
        "type": "image_generation.event", "schema_version": 1, "request_id": intent.request_id,
        "event": format!("image_generation.{name}"), "status": status,
    });
    if let (Some(event), Some(fields)) = (event.as_object_mut(), fields.as_object()) {
        event.extend(fields.clone());
    }
    let mut data = json!({ "image_generation": event });
    if name == "accepted" {
        data["image_intent_sha256"] =
            json!(digest(&serde_json::to_vec(intent).unwrap_or_default()));
    }
    run.event(
        EventInput::new(
            &format!("image_generation.{name}"),
            "artifact",
            status,
            "Image generation",
            "",
        )
        .data(data),
    )
    .await
    .map(|_| ())
    .ok_or_else(|| "failed to persist image generation progress".to_owned())
}

/// Accepts a request ID once; replays earlier progress for a repeat.
async fn claim(run: &Run, intent: &ImageIntent) -> Result<bool, String> {
    let (session, user) = (run.session_id, run.user_id);
    let events: Vec<store::AgentEvent> = run
        .agent
        .with_db(move |conn| store::session_rows(conn, session, user))
        .await
        .map_err(|_| "failed to load image generation state".to_owned())?;
    let fingerprint = digest(&serde_json::to_vec(intent).unwrap_or_default());
    let mut found = false;
    for event in events
        .iter()
        .filter(|e| e.event_type.starts_with("image_generation."))
    {
        if event.data["image_generation"]["request_id"].as_str() != Some(intent.request_id.as_str())
        {
            continue;
        }
        if let Some(previous) = event.data["image_intent_sha256"].as_str()
            && previous != fingerprint
        {
            return Err("image request ID was already used for different settings".into());
        }
        found = true;
        run.send(&Frame {
            event: value(event),
            ..Frame::new("agent_event")
        });
    }
    if found {
        return Ok(false);
    }
    emit_image_event(run, intent, "accepted", "queued", json!({})).await?;
    Ok(true)
}

/// Records a failed image request; `None`, as there is no reply.
async fn fail_intent(
    run: &Run,
    intent: &ImageIntent,
    code: &str,
    message: String,
    count: i64,
) -> Option<String> {
    let message = crate::run::truncate_chars(&message, 1800);
    let canceled = run.emitter.is_closed();
    let status = if canceled { "canceled" } else { "failed" };
    let fields = if canceled {
        json!({ "artifact_count": count })
    } else {
        json!({ "artifact_count": count, "error": { "code": code, "message": message, "retryable": code != "reference_invalid" } })
    };
    let _ = emit_image_event(run, intent, status, status, fields).await;
    let session_id = run.session_id;
    let _ = run
        .agent
        .with_db(move |conn| store::set_session_status(conn, session_id, status))
        .await;
    run.send(&Frame::error(message));
    None
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

/// Runs an image composer request: generates each variant, saves it, and
/// streams progress, artifacts, and the final reply. Returns the reply, or
/// `None` when the request was not claimed or failed.
pub async fn stream_intent(
    run: &Run,
    mut session: AgentSession,
    portal: &str,
    intent: ImageIntent,
) -> Option<String> {
    let claimed = match claim(run, &intent).await {
        Ok(claimed) => claimed,
        Err(error) => {
            run.send(&Frame::error(error));
            return None;
        }
    };
    if !claimed {
        run.send(&Frame {
            done: true,
            ..Frame::new("done")
        });
        return None;
    }
    let session_id = session.id;
    let _ = run
        .agent
        .with_db(move |conn| store::set_session_status(conn, session_id, "running"))
        .await;
    let mut count = 0;
    let refs = match references(run, &intent.reference_paths) {
        Ok(refs) => refs,
        Err(error) => return fail_intent(run, &intent, "reference_invalid", error, 0).await,
    };
    let prompt = match resolve_prompt(run, portal, &intent).await {
        Ok(prompt) => prompt,
        Err(error) => {
            return fail_intent(run, &intent, "template_resolution_failed", error, 0).await;
        }
    };
    let (width, height) = intent_dimensions(&intent);
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
    let mut last = None;
    for index in 0..intent.variants {
        if run.emitter.is_closed() {
            return fail_intent(
                run,
                &intent,
                "image_generation_canceled",
                "canceled".into(),
                count,
            )
            .await;
        }
        let progress = json!({ "progress": index as f64 / intent.variants as f64 });
        if let Err(error) = emit_image_event(run, &intent, "progress", "generating", progress).await
        {
            return fail_intent(run, &intent, "image_progress_failed", error, count).await;
        }
        let request = ImageRequest {
            prompt: prompt.clone(),
            references: refs.clone(),
            count: 1,
            width,
            height,
            quality: intent.quality.clone(),
        };
        let images = match run
            .agent
            .engine()
            .generate_images(&request, Some(&run.model))
            .await
        {
            Ok(images) => images,
            Err(error) => {
                return fail_intent(
                    run,
                    &intent,
                    "image_provider_error",
                    error.to_string(),
                    count,
                )
                .await;
            }
        };
        let Some(image) = images
            .into_iter()
            .next()
            .filter(|image| !image.data.is_empty())
        else {
            return fail_intent(
                run,
                &intent,
                "image_result_missing",
                "image provider returned no usable image".into(),
                count,
            )
            .await;
        };
        let mime = kition_ai::engine::sniff_mime(&image.data);
        let Some(extension) = ["image/png", "image/jpeg", "image/webp"]
            .contains(&mime)
            .then(|| web::extension_for_image_mime(mime))
            .flatten()
        else {
            return fail_intent(
                run,
                &intent,
                "image_result_invalid",
                "image provider returned an unsupported image format".into(),
                count,
            )
            .await;
        };
        let Some((w, h)) = image_size(&image.data)
            .filter(|(w, h)| (1..=65536).contains(w) && (1..=65536).contains(h))
        else {
            return fail_intent(
                run,
                &intent,
                "image_result_invalid",
                "image provider returned an invalid image".into(),
                count,
            )
            .await;
        };
        let path = match run.workspace().write_new(
            &folder,
            &format!("variant-{}{extension}", index + 1),
            &image.data,
        ) {
            Ok(path) => path,
            Err(_) => {
                return fail_intent(
                    run,
                    &intent,
                    "image_save_failed",
                    "failed to save the generated image".into(),
                    count,
                )
                .await;
            }
        };
        let Some(artifact) = run
            .record_artifact(
                None,
                "image",
                &path,
                mime,
                &format!("Generated image {}", index + 1),
            )
            .await
        else {
            return fail_intent(
                run,
                &intent,
                "image_save_failed",
                "failed to record the generated image".into(),
                count,
            )
            .await;
        };
        let mut provenance = json!({
            "request_id": intent.request_id, "provider_class": provider_class,
            "prompt_sha256": prompt_digest, "source_paths": intent.reference_paths,
        });
        if !intent.template_id.is_empty() {
            provenance["template_id"] = json!(intent.template_id);
            provenance["template_version"] = json!(intent.template_version);
        }
        let artifact_view = json!({
            "id": artifact.id, "path": path, "mime_type": mime, "title": artifact.title,
            "width": w, "height": h, "variant_index": index, "variant_count": intent.variants,
            "created_at": kition_core::time::to_rfc3339(kition_core::now_millis()),
            "provenance": provenance,
        });
        if let Err(error) = emit_image_event(
            run,
            &intent,
            "artifact",
            "saving",
            json!({ "artifact": artifact_view }),
        )
        .await
        {
            return fail_intent(run, &intent, "image_save_failed", error, count).await;
        }
        last = Some(artifact);
        count += 1;
    }
    let message = store::new_message(
        &session,
        "assistant",
        &format!("Generated {count} image(s) for review."),
        json!({ "image_generation_request_id": intent.request_id }),
    );
    let message: AgentMessage = match run
        .agent
        .with_db(move |conn| store::insert_message(conn, message))
        .await
    {
        Ok(message) => message,
        Err(_) => {
            return fail_intent(
                run,
                &intent,
                "image_reply_save_failed",
                "failed to save the image generation reply".into(),
                count,
            )
            .await;
        }
    };
    if let Err(error) = emit_image_event(
        run,
        &intent,
        "completed",
        "completed",
        json!({ "artifact_count": count }),
    )
    .await
    {
        return fail_intent(run, &intent, "image_progress_failed", error, count).await;
    }
    session.status = "idle".into();
    let mut saved = session.clone();
    let _ = run
        .agent
        .with_db(move |conn| store::save_session(conn, &mut saved))
        .await;
    run.send(&Frame {
        chat: value(&message),
        ..Frame::new("assistant_message")
    });
    let mut done = Frame {
        done: true,
        ..Frame::new("done")
    }
    .extra("message", &message)
    .extra("session", &session);
    if let Some(artifact) = &last {
        done = done.extra("artifact", artifact);
    }
    run.send(&done);
    Some(message.content)
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

    #[test]
    fn reads_image_sizes() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&640_u32.to_be_bytes());
        png.extend_from_slice(&480_u32.to_be_bytes());
        assert_eq!(image_size(&png), Some((640, 480)));
        assert_eq!(image_size(b"nope"), None);
    }
}
