//! AI fields: a cell (or a batch of cells) filled by the model from the
//! field's `options.ai_config` and an optional source field.

use axum::Router;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::post;
use base64::Engine as _;
use kition_ai::engine::{ImageRequest, Message, MessagePart, RuntimeModel, image_prompt};
use kition_core::{AppError, AppResult, now_millis};
use kition_http::{CurrentUser, JsonBody, ok};
use kition_kdm::Origin;
use kition_kitable::{Field, Record};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::blob_attachments::inline_blob_images;
use crate::index::DataDocument;
use crate::records::stringify_cell;
use crate::source::parse_id;
use crate::{DataDocState, respond};

const TOOL_NAME: &str = "data_ai_field";
const MAX_SOURCE_CHARS: usize = 8000;
const MAX_OUTPUT_CHARS: usize = 20_000;
const BATCH_MAX_ROWS: usize = 100;
const MAX_IMAGES: usize = 4;
pub(crate) const MAX_IMAGE_BYTES: u64 = 20 << 20;
const MAX_IMAGE_COUNT: i64 = 5;

pub fn routes() -> Router<DataDocState> {
    Router::new()
        .route(
            "/data-documents/{documentId}/tables/{tableId}/records/{recordId}/fields/{fieldId}/ai/run",
            post(run_cell),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/fields/{fieldId}/ai/run",
            post(run_batch),
        )
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RunRequest {
    action: String,
    config: Map<String, Value>,
    record_ids: Vec<i64>,
    limit: i64,
    runtime_model: Option<RuntimeModel>,
}

/// A parsed `ai_config`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Config {
    pub(crate) raw: Value,
    pub(crate) action: String,
    pub(crate) source_field_id: i64,
    pub(crate) source_field_name: String,
    pub(crate) target_language: String,
    pub(crate) extract_instruction: String,
    pub(crate) improve_instruction: String,
    pub(crate) summary_instruction: String,
    pub(crate) custom_prompt: String,
    pub(crate) requirements: String,
    pub(crate) image_size: String,
    pub(crate) image_count: i64,
    pub(crate) image_quality: String,
    pub(crate) image_use_case: String,
    pub(crate) categories: Vec<String>,
    pub(crate) max_words: i64,
    pub(crate) extract_schema: String,
}

impl Config {
    fn is_image(&self) -> bool {
        matches!(
            self.action.as_str(),
            "image_generation" | "image_customization"
        )
    }

    fn requires_source(&self) -> bool {
        !matches!(
            self.action.as_str(),
            "text_generation" | "customize" | "image_customization"
        )
    }

    fn resolves_source(&self) -> bool {
        self.requires_source()
            || (self.action == "image_customization"
                && (self.source_field_id > 0 || !self.source_field_name.is_empty()))
    }
}

fn text(map: &Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|key| map.get(*key))
        .map(|value| match value {
            Value::String(text) => text.trim().to_owned(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        })
        .find(|text| !text.is_empty())
        .unwrap_or_default()
}

fn int(map: &Map<String, Value>, keys: &[&str]) -> i64 {
    keys.iter()
        .filter_map(|key| map.get(*key))
        .filter_map(|value| match value {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        })
        .find(|n| *n != 0)
        .unwrap_or(0)
}

fn is_false(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => !flag,
        Some(Value::String(text)) => {
            matches!(text.trim().to_lowercase().as_str(), "false" | "0" | "")
        }
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        _ => false,
    }
}

fn aspect_to_size(aspect: &str) -> &'static str {
    match aspect {
        "16:9" | "21:9" | "3:2" | "4:3" => "1536x1024",
        "9:16" | "2:3" | "3:4" => "1024x1536",
        _ => "1024x1024",
    }
}

fn has_ai_config(field: &Field) -> bool {
    if field.field_type == "ai" {
        return true;
    }
    match field.options.get("ai_config") {
        Some(Value::Object(config)) => {
            !is_false(config.get("enabled")) || config.get("enabled").is_none()
        }
        _ => false,
    }
}

pub(crate) fn parse_config(
    options: &Map<String, Value>,
    ai_prompt: &str,
) -> Result<Config, String> {
    let raw = options
        .get("ai_config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let aspect = text(&raw, &["aspect_ratio"]);
    let mut image_size = if aspect.is_empty() {
        String::new()
    } else {
        aspect_to_size(&aspect).to_owned()
    };
    if image_size.is_empty() {
        image_size = text(&raw, &["size", "image_size"]);
    }
    let mut config = Config {
        action: text(&raw, &["type", "action_type"]),
        source_field_id: int(&raw, &["source_field_id"]),
        source_field_name: text(&raw, &["source_field_name"]),
        target_language: text(&raw, &["target_language"]),
        extract_instruction: text(&raw, &["extract_instruction"]),
        improve_instruction: text(&raw, &["improve_instruction"]),
        summary_instruction: text(&raw, &["summary_instruction"]),
        custom_prompt: text(&raw, &["prompt", "custom_prompt"]),
        requirements: text(&raw, &["requirements"]),
        image_size,
        image_count: int(&raw, &["n", "image_count"]),
        image_quality: text(&raw, &["quality", "image_quality"]),
        image_use_case: text(&raw, &["image_use_case"]),
        categories: raw
            .get("categories")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|c| c.trim().to_owned())
            .filter(|c| !c.is_empty())
            .collect(),
        max_words: int(&raw, &["max_words"]),
        extract_schema: text(&raw, &["schema"]),
        raw: Value::Object(raw.clone()),
    };
    if config.action.is_empty() && !ai_prompt.trim().is_empty() {
        config.action = "customize".into();
        config.custom_prompt = ai_prompt.trim().to_owned();
    }
    if config.action.is_empty() {
        return Err("AI field has no action type configured".into());
    }
    if is_false(raw.get("enabled")) {
        return Err("AI field configuration is disabled".into());
    }
    if config.requires_source()
        && config.source_field_id <= 0
        && config.source_field_name.is_empty()
    {
        return Err("AI field has no source field configured".into());
    }
    match config.action.as_str() {
        "summarize"
        | "translate"
        | "extract"
        | "improve"
        | "customize"
        | "image_generation"
        | "image_customization"
        | "text_generation"
        | "classify" => {}
        _ => return Err("Unsupported AI action type".into()),
    }
    if config.action == "translate" && config.target_language.is_empty() {
        return Err("Translation action requires a target language".into());
    }
    if config.action == "extract"
        && config.extract_instruction.is_empty()
        && config.extract_schema.is_empty()
    {
        return Err("Extraction action requires extraction instructions".into());
    }
    if matches!(
        config.action.as_str(),
        "customize" | "text_generation" | "image_customization"
    ) && config.custom_prompt.is_empty()
    {
        return Err("Action requires a prompt".into());
    }
    if config.action == "classify" && config.categories.len() < 2 {
        return Err("Classify action requires at least two categories".into());
    }
    if config.is_image() {
        if config.image_size.is_empty() {
            config.image_size = "1024x1024".into();
        }
        if config.image_quality.is_empty() {
            config.image_quality = "low".into();
        }
        if config.image_count <= 0 {
            config.image_count = 3;
        }
        config.image_count = config.image_count.min(MAX_IMAGE_COUNT);
        if !["1024x1024", "1024x1536", "1536x1024"].contains(&config.image_size.as_str()) {
            return Err("Image generation has an invalid image size".into());
        }
        if !["low", "medium", "high"].contains(&config.image_quality.as_str()) {
            return Err("Image generation has an invalid image quality".into());
        }
        config.image_use_case = image_prompt::parse_use_case(&config.image_use_case).to_owned();
    }
    Ok(config)
}

/// The stored config, with the client's per-record prompt applied.
fn apply_execution(
    stored: Config,
    action: &str,
    raw: &Map<String, Value>,
) -> Result<Config, String> {
    if raw.is_empty() {
        return Ok(stored);
    }
    let mut options = Map::new();
    options.insert("ai_config".into(), Value::Object(raw.clone()));
    let execution = parse_config(&options, "")?;
    if !action.trim().is_empty() && action.trim() != stored.action {
        return Err("AI execution action does not match the field configuration".into());
    }
    if execution.action != stored.action {
        return Err("AI execution config does not match the field configuration".into());
    }
    let mut stored = stored;
    if !execution.custom_prompt.is_empty() {
        stored.custom_prompt = execution.custom_prompt;
    }
    Ok(stored)
}

/// The AI field, its source field, and its config.
fn resolve_field(
    fields: &[Field],
    field_id: i64,
) -> Result<(Field, Option<Field>, Config), String> {
    let field = fields
        .iter()
        .find(|f| f.id == field_id)
        .cloned()
        .ok_or("AI field does not exist")?;
    if !has_ai_config(&field) {
        return Err("Target field is not an AI field".into());
    }
    let config = parse_config(&field.options, &field.ai_prompt)?;
    if !config.resolves_source() {
        return Ok((field, None, config));
    }
    let source = fields
        .iter()
        .find(|f| {
            (config.source_field_id > 0 && f.id == config.source_field_id)
                || (!config.source_field_name.is_empty() && f.name == config.source_field_name)
        })
        .cloned()
        .ok_or("Source field does not exist")?;
    if source.id == field.id {
        return Err("An AI field cannot reference itself".into());
    }
    let attachment_into_image = config.action == "image_customization"
        && source.field_type.trim().eq_ignore_ascii_case("attachment");
    if has_ai_config(&source) && !attachment_into_image {
        return Err("Source field cannot be an AI field".into());
    }
    Ok((field, Some(source), config))
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn sha256(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn build_prompt(
    config: &Config,
    field_title: &str,
    source_title: &str,
    source_text: &str,
) -> String {
    let mut out = String::from(
        "You are filling a single cell in a structured table.\nReturn only the final cell value. Do not include explanations, markdown fences, or extra labels.\n\n",
    );
    out.push_str(&format!("Target field: {}\n", field_title.trim()));
    if source_title.trim().is_empty() {
        out.push('\n');
    } else {
        out.push_str(&format!("Source field: {}\n\n", source_title.trim()));
    }
    match config.action.as_str() {
        "summarize" => {
            out.push_str("Task: Summarize the source content.\n");
            if !config.summary_instruction.is_empty() {
                out.push_str(&format!("Summary instruction: {}\n", config.summary_instruction));
            }
            if config.max_words > 0 {
                out.push_str(&format!("Maximum word count: {}\n", config.max_words));
            }
        }
        "translate" => out.push_str(&format!(
            "Task: Translate the source content.\nTarget language: {}\n",
            config.target_language
        )),
        "extract" => {
            out.push_str("Task: Extract information from the source content.\n");
            if !config.extract_instruction.is_empty() {
                out.push_str(&format!("Extraction instruction: {}\n", config.extract_instruction));
            }
            if !config.extract_schema.is_empty() {
                out.push_str(&format!("Return JSON matching this schema: {}\n", config.extract_schema));
            }
        }
        "improve" => {
            out.push_str("Task: Improve the source content.\n");
            if !config.improve_instruction.is_empty() {
                out.push_str(&format!("Improvement instruction: {}\n", config.improve_instruction));
            }
        }
        "customize" => out.push_str(&format!("Task: Follow this custom instruction.\n{}\n", config.custom_prompt)),
        "text_generation" => out.push_str(&format!(
            "Task: Generate text following this instruction.\n{}\n",
            config.custom_prompt
        )),
        "classify" => out.push_str(&format!(
            "Task: Classify the source content into exactly one of the categories below.\nCategories: {}\nReturn only the chosen category label, exactly as written above.\n",
            config.categories.join(", ")
        )),
        _ => {}
    }
    if !config.requirements.is_empty() {
        out.push_str(&format!(
            "Additional requirements: {}\n",
            config.requirements
        ));
    }
    if !source_text.is_empty() {
        out.push_str("\nSource content:\n");
        out.push_str(source_text);
    }
    out
}

fn image_prompt_for(config: &Config, source: &Value) -> String {
    let mut prompt = if config.action == "image_customization" {
        config.custom_prompt.clone()
    } else {
        stringify_cell(source).trim().to_owned()
    };
    if !config.requirements.is_empty() {
        prompt = if prompt.is_empty() {
            config.requirements.clone()
        } else {
            format!("{prompt}\n{}", config.requirements)
        };
    }
    let prompt = truncate(prompt.trim(), MAX_SOURCE_CHARS);
    if prompt.is_empty() {
        return String::new();
    }
    image_prompt::wrap(&prompt, &config.image_use_case, &config.image_size)
}

impl DataDocState {
    /// Image attachments in a cell as data URLs (or their remote URLs).
    fn cell_images(&self, value: &Value) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        for entry in value.as_array().into_iter().flatten() {
            let mime = entry["mimeType"]
                .as_str()
                .or_else(|| entry["mime_type"].as_str())
                .unwrap_or_default()
                .trim()
                .to_owned();
            let url = entry["url"].as_str().unwrap_or_default().trim();
            if !mime.to_lowercase().starts_with("image/") || url.is_empty() {
                continue;
            }
            if url.starts_with("data:") || url.starts_with("http://") || url.starts_with("https://")
            {
                out.push(url.to_owned());
            } else {
                let path = self
                    .assets
                    .resolve_url(url)
                    .map_err(|_| format!("Unsupported attachment URL: {url}"))?;
                let meta = std::fs::metadata(&path)
                    .map_err(|_| "Attachment file is missing".to_owned())?;
                if meta.len() > MAX_IMAGE_BYTES {
                    return Err(format!("Attachment exceeds {}MB", MAX_IMAGE_BYTES >> 20));
                }
                let data =
                    std::fs::read(&path).map_err(|_| "Failed to read attachment".to_owned())?;
                out.push(format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(data)
                ));
            }
            if out.len() >= MAX_IMAGES {
                break;
            }
        }
        Ok(out)
    }

    fn log_usage(&self, user_id: i64, model: &RuntimeModel, config: &Config, call: Call<'_>) {
        let entry = kition_ai::usage::NewUsage {
            user_id,
            provider: model.provider_type.clone(),
            model_name: model.model_name.clone(),
            tool: TOOL_NAME.into(),
            request_type: config.action.clone(),
            input_content: call.prompt.to_owned(),
            output_content: call.output.to_owned(),
            prompt_tokens: call.usage.prompt_tokens,
            completion_tokens: call.usage.completion_tokens,
            total_tokens: call.usage.total_tokens,
            status: if call.error.is_empty() {
                "success".into()
            } else {
                "failed".into()
            },
            error_message: call.error.to_owned(),
            response_time_ms: call.usage.response_time_ms,
            extra_data: config.raw.clone(),
        };
        if let Ok(conn) = self.db.conn() {
            let _ = kition_ai::usage::record(&conn, &entry);
        }
    }

    /// The generated cell value and its state.
    pub(crate) async fn generate(
        &self,
        user_id: i64,
        config: &Config,
        model: &RuntimeModel,
        field_title: &str,
        source_title: &str,
        source: &Value,
    ) -> Result<(Value, Value), String> {
        let engine = self.ai.as_ref().ok_or("AI engine is not configured")?;
        let images = self.cell_images(source)?;
        let config_hash = format!("sha256:{}", sha256(&config.raw.to_string()));
        let image_digests: Vec<String> = images.iter().map(|image| sha256(image)).collect();
        if config.is_image() {
            if config.action == "image_customization"
                && config.resolves_source()
                && images.is_empty()
            {
                return Err("Source field contains no usable images".into());
            }
            let prompt = image_prompt_for(config, source);
            if prompt.is_empty() {
                return Err(if config.requires_source() {
                    "Source field is empty".into()
                } else {
                    "Image generation requires a prompt".into()
                });
            }
            let (width, height) = config
                .image_size
                .split_once('x')
                .and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
                .unwrap_or((1024, 1024));
            let request = ImageRequest {
                prompt: prompt.clone(),
                references: images.clone(),
                count: config.image_count,
                width,
                height,
                quality: config.image_quality.clone(),
            };
            let generated = match engine.generate_images(&request, Some(model)).await {
                Ok(generated) if !generated.is_empty() => generated,
                Ok(_) => {
                    let error = "AI image generation returned no assets";
                    self.log_usage(
                        user_id,
                        model,
                        config,
                        Call {
                            prompt: &prompt,
                            output: "",
                            usage: Default::default(),
                            error,
                        },
                    );
                    return Err(error.into());
                }
                Err(error) => {
                    self.log_usage(
                        user_id,
                        model,
                        config,
                        Call {
                            prompt: &prompt,
                            output: "",
                            usage: Default::default(),
                            error: &error.to_string(),
                        },
                    );
                    return Err(error.to_string());
                }
            };
            let mut attachments = Vec::new();
            for (index, image) in generated.iter().enumerate() {
                let extension = if image.extension.is_empty() {
                    ".png".to_owned()
                } else {
                    image.extension.clone()
                };
                let extension = if extension.starts_with('.') {
                    extension
                } else {
                    format!(".{extension}")
                };
                let mime = if image.mime_type.is_empty() {
                    "image/png"
                } else {
                    image.mime_type.as_str()
                };
                let name = format!("generated-{}{extension}", index + 1);
                let asset = self
                    .assets
                    .save_bytes(&image.data, &name, mime)
                    .map_err(|_| "Failed to save generated image".to_owned())?;
                attachments.push(json!({
                    "url": asset.url, "name": name, "mimeType": asset.mime_type, "sizeBytes": asset.size_bytes,
                    "assetId": asset.asset_id, "sha256": asset.sha256, "workspacePath": asset.workspace_path,
                }));
            }
            self.log_usage(
                user_id,
                model,
                config,
                Call {
                    prompt: &prompt,
                    output: &format!("{} images", generated.len()),
                    usage: Default::default(),
                    error: "",
                },
            );
            let mut hash_input = prompt;
            if !image_digests.is_empty() {
                hash_input = format!("{hash_input}|{}", image_digests.join("|"));
            }
            let state = json!({
                "status": "done", "source_hash": format!("sha256:{}", sha256(&hash_input)),
                "config_hash": config_hash, "model_id": 0, "updated_at": now_millis(), "error": "",
            });
            return Ok((Value::Array(attachments), state));
        }
        let source_text = if images.is_empty() {
            stringify_cell(source).trim().to_owned()
        } else {
            String::new()
        };
        if config.requires_source() && source_text.is_empty() && images.is_empty() {
            return Err("Source field is empty".into());
        }
        let source_text = truncate(&source_text, MAX_SOURCE_CHARS);
        let prompt = build_prompt(config, field_title, source_title, &source_text);
        let mut message = Message::new("user", prompt.clone());
        if !images.is_empty() {
            message.parts.push(MessagePart {
                kind: "text".into(),
                text: prompt.clone(),
                ..MessagePart::default()
            });
            for image in &images {
                message.parts.push(MessagePart {
                    kind: "image_url".into(),
                    image_url: image.clone(),
                    ..MessagePart::default()
                });
            }
        }
        let result = match engine
            .chat_with_tools(&[message], &[], "", model, None)
            .await
        {
            Ok(result) => result,
            Err(error) => {
                self.log_usage(
                    user_id,
                    model,
                    config,
                    Call {
                        prompt: &prompt,
                        output: "",
                        usage: Default::default(),
                        error: &error.to_string(),
                    },
                );
                return Err(error.to_string());
            }
        };
        let output = truncate(result.content.trim(), MAX_OUTPUT_CHARS);
        if output.is_empty() {
            let error = "AI returned an empty response";
            self.log_usage(
                user_id,
                model,
                config,
                Call {
                    prompt: &prompt,
                    output: "",
                    usage: result.usage,
                    error,
                },
            );
            return Err(error.into());
        }
        self.log_usage(
            user_id,
            model,
            config,
            Call {
                prompt: &prompt,
                output: &output,
                usage: result.usage,
                error: "",
            },
        );
        let state = json!({
            "status": "done",
            "source_hash": format!("sha256:{}", sha256(&format!("{source_text}{}", image_digests.join("|")))),
            "config_hash": config_hash, "model_id": 0, "updated_at": now_millis(), "error": "",
        });
        Ok((Value::String(output), state))
    }
}

/// One model call, for the usage log.
struct Call<'a> {
    prompt: &'a str,
    output: &'a str,
    usage: kition_ai::engine::Usage,
    error: &'a str,
}

struct Target {
    doc: DataDocument,
    field: Field,
    source: Option<Field>,
    config: Config,
}

fn model_of(request: &RunRequest) -> AppResult<RuntimeModel> {
    request
        .runtime_model
        .clone()
        .filter(|model| !model.model_name.trim().is_empty())
        .ok_or_else(|| {
            AppError::bad_request("Configure a model in Settings before running AI fields")
        })
}

async fn load_target(
    state: &DataDocState,
    user_id: i64,
    document_id: String,
    table_id: i64,
    field_id: i64,
    request: &RunRequest,
) -> AppResult<Target> {
    let action = request.action.clone();
    let raw = request.config.clone();
    state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let file = state.open_or_500(&doc)?;
            let table = file
                .get_table(table_id)
                .map_err(|_| AppError::not_found("Table does not exist"))?;
            let (field, source, config) =
                resolve_field(&table.fields, field_id).map_err(AppError::bad_request)?;
            let config = apply_execution(config, &action, &raw).map_err(AppError::bad_request)?;
            Ok(Target {
                doc,
                field,
                source,
                config,
            })
        })
        .await
}

/// Reads a record's source cell, generates the value, and saves it.
async fn fill(
    state: &DataDocState,
    user_id: i64,
    target: &Target,
    model: &RuntimeModel,
    table_id: i64,
    record_id: i64,
) -> Result<(Record, Value), String> {
    let doc = target.doc.clone();
    let source_name = target.source.as_ref().map(|source| source.name.clone());
    let source_value = state
        .blocking(move |state| {
            let file = state.open_or_500(&doc)?;
            let record = file
                .get_record(table_id, record_id)
                .map_err(|_| AppError::not_found("Record does not exist"))?;
            let value = source_name
                .and_then(|name| record.values.get(&name).cloned())
                .unwrap_or(Value::Null);
            Ok(inline_blob_images(&file, &value, MAX_IMAGE_BYTES))
        })
        .await
        .map_err(|error| error.to_string())?;
    let source_title = target
        .source
        .as_ref()
        .map(|source| source.title.clone())
        .unwrap_or_default();
    let (output, cell_state) = state
        .generate(
            user_id,
            &target.config,
            model,
            &target.field.title,
            &source_title,
            &source_value,
        )
        .await?;
    let doc = target.doc.clone();
    let name = target.field.name.clone();
    let updated = state
        .blocking(move |state| {
            let mut file = state.open_or_500_as(&doc, Origin::system("aifield"))?;
            let mut values = Map::new();
            values.insert(name, output);
            // Generated images are stored in the file, like uploads.
            state.import_path_attachments(&mut file, table_id, &mut values);
            file.update_record(table_id, record_id, &values, None)
                .map_err(|error| AppError::bad_request(error.to_string()))
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok((updated, cell_state))
}

async fn run_cell(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, record_id, field_id)): Path<(String, String, String, String)>,
    JsonBody(request): JsonBody<RunRequest>,
) -> AppResult<Response> {
    state.require_ai()?;
    let (table_id, record_id, field_id) = (
        parse_id(&table_id)?,
        parse_id(&record_id)?,
        parse_id(&field_id)?,
    );
    let model = model_of(&request)?;
    let target = load_target(&state, user.id, document_id, table_id, field_id, &request).await?;
    let (record, cell_state) = fill(&state, user.id, &target, &model, table_id, record_id)
        .await
        .map_err(AppError::bad_request)?;
    Ok(ok(json!({
        "record": respond::record(&target.doc, &record),
        "field": respond::field(&target.doc, &target.field),
        "state": cell_state,
    })))
}

async fn run_batch(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, field_id)): Path<(String, String, String)>,
    JsonBody(request): JsonBody<RunRequest>,
) -> AppResult<Response> {
    state.require_ai()?;
    let max = match request.limit {
        n if n > 0 && (n as usize) < BATCH_MAX_ROWS => n as usize,
        _ => BATCH_MAX_ROWS,
    };
    let mut record_ids: Vec<i64> = Vec::new();
    for id in &request.record_ids {
        if *id > 0 && !record_ids.contains(id) && record_ids.len() < max {
            record_ids.push(*id);
        }
    }
    if record_ids.is_empty() {
        return Err(AppError::bad_request(
            "Please select the records to generate",
        ));
    }
    let (table_id, field_id) = (parse_id(&table_id)?, parse_id(&field_id)?);
    let model = model_of(&request)?;
    let target = load_target(&state, user.id, document_id, table_id, field_id, &request).await?;
    let mut items = Vec::new();
    let mut errors = Vec::new();
    for record_id in &record_ids {
        match fill(&state, user.id, &target, &model, table_id, *record_id).await {
            Ok((record, cell_state)) => {
                items.push(
                    json!({ "record": respond::record(&target.doc, &record), "state": cell_state }),
                );
            }
            Err(message) => errors.push(json!({ "record_id": record_id, "message": message })),
        }
    }
    Ok(ok(json!({
        "items": items,
        "field": respond::field(&target.doc, &target.field),
        "accepted": record_ids.len(),
        "completed": items.len(),
        "failed": errors.len(),
        "errors": errors,
        "limit": BATCH_MAX_ROWS,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(id: i64, name: &str, options: Value) -> Field {
        Field {
            id,
            name: name.into(),
            title: name.into(),
            field_type: "text".into(),
            options: options.as_object().cloned().unwrap_or_default(),
            ..Field::default()
        }
    }

    #[test]
    fn parses_and_validates_configs() {
        let config = |raw: Value| {
            let mut options = Map::new();
            options.insert("ai_config".into(), raw);
            parse_config(&options, "")
        };
        assert!(config(json!({ "type": "summarize", "source_field_id": 1 })).is_ok());
        assert!(config(json!({ "type": "summarize" })).is_err());
        assert!(config(json!({ "type": "translate", "source_field_id": 1 })).is_err());
        assert!(
            config(json!({ "type": "classify", "source_field_id": 1, "categories": ["a"] }))
                .is_err()
        );
        let image = config(
            json!({ "type": "image_generation", "source_field_id": 1, "aspect_ratio": "16:9" }),
        )
        .unwrap_or_default();
        assert_eq!(
            (
                image.image_size.as_str(),
                image.image_count,
                image.image_quality.as_str()
            ),
            ("1536x1024", 3, "low")
        );
        assert!(
            config(json!({ "type": "summarize", "source_field_id": 1, "enabled": false })).is_err()
        );
        let legacy = parse_config(&Map::new(), "Write a tagline").unwrap_or_default();
        assert_eq!(legacy.action, "customize");
    }

    #[test]
    fn resolves_ai_and_source_fields() {
        let fields = vec![
            field(1, "body", json!({})),
            field(
                2,
                "summary",
                json!({ "ai_config": { "type": "summarize", "source_field_id": 1 } }),
            ),
            field(
                3,
                "loop",
                json!({ "ai_config": { "type": "summarize", "source_field_id": 3 } }),
            ),
        ];
        let (target, source, _) = resolve_field(&fields, 2).unwrap_or_else(|err| panic!("{err}"));
        assert_eq!((target.id, source.map(|s| s.id)), (2, Some(1)));
        assert!(resolve_field(&fields, 1).is_err());
        assert!(resolve_field(&fields, 3).is_err());
        let prompt = build_prompt(
            &parse_config(&fields[1].options, "").unwrap_or_default(),
            "Summary",
            "Body",
            "Long text",
        );
        assert!(
            prompt.contains("Task: Summarize the source content.") && prompt.ends_with("Long text")
        );
    }
}
