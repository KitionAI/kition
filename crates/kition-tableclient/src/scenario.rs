//! `POST /scenarios/build`: turns uploaded files and a request into a new table file: one
//! table, one record per file with the file in it, and AI fields filled from the files,
//! streaming progress as server-sent events. Everything is written through the Table kit
//! (`system:scenario`); the AI fields are filled as the kit fills them for an editor: the
//! engine builds each prompt (`ai.prepare`) and writes the answers (`ai.apply`), and the host
//! runs the model with the person's settings.

use std::collections::HashSet;
use std::convert::Infallible;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Multipart, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine as _;
use kition_ai::chat::{AiGate, require_ai};
use kition_ai::engine::{Engine, ImageRequest, Message, MessagePart, RuntimeModel};
use kition_core::{AppError, AppResult};
use kition_http::{AuthConfig, CurrentUser};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::{Step, TableClient, table_info};

/// What the scenario builder writes as.
const ORIGIN: &str = "system:scenario";
/// At most this many bytes per uploaded file.
const MAX_ATTACHMENT_BYTES: usize = 50 << 20;
const VIEW_TYPES: [&str; 4] = ["grid", "kanban", "calendar", "gallery"];

#[derive(Clone)]
pub struct ScenarioState {
    pub auth: AuthConfig,
    pub tables: TableClient,
    pub engine: Engine,
    pub ai_gate: AiGate,
}

impl axum::extract::FromRef<ScenarioState> for AuthConfig {
    fn from_ref(state: &ScenarioState) -> Self {
        state.auth.clone()
    }
}

const FILE_NAME_FIELD: &str = "File Name";
const ATTACHMENT_FIELD: &str = "Receipt Image";
const DEFAULT_BASE: &str = "Untitled Base";
const DEFAULT_TABLE: &str = "Untitled Table";
const DEFAULT_VIEW: &str = "Overall";
const MAX_FILES: usize = 50;

const FIELD_TYPES: &[&str] = &[
    "text",
    "long_text",
    "number",
    "date",
    "single_select",
    "multi_select",
    "checkbox",
    "url",
    "attachment",
    "ai",
];

const STUB_SCHEMA: &str = r#"{
  "baseName": "Talk to Files Base",
  "tableName": "Files",
  "fields": [
    {"name": "File Name", "type": "text", "isPrimary": true},
    {"name": "Receipt Image", "type": "attachment"},
    {"name": "Summary", "type": "text", "isAIField": true, "aiPrompt": "Summarize the contents of the attached file."},
    {"name": "Detected Date", "type": "date", "isAIField": true, "aiPrompt": "Extract a date from the attached file in ISO format if present."}
  ],
  "views": [{"name": "Overall", "kind": "grid"}]
}"#;

const SYSTEM_PROMPT: &str =
    "You are a database schema designer. Given a user request and a list of input files,
design a single base and a single table that fit the request. Reply with a JSON
object only \u{2014} no prose, no markdown fences \u{2014} with exactly these keys:

  baseName  (string)
  tableName (string)
  fields    (array of field objects)
  views     (array of view objects)

Each field object has:
  name      (string, required)
  type      (string, required \u{2014} one of: text, long_text, number, date,
            single_select, multi_select, checkbox, url, attachment, ai)
  options   (object, optional \u{2014} field-type-specific options)
  isAIField (boolean, optional \u{2014} true if the value must be extracted by an
            AI vision model from an attachment column)
  aiSource  (string, optional \u{2014} when isAIField is true, the name of the
            attachment column the vision model should read. Defaults to
            \"Receipt Image\".)
  aiPrompt  (string, required when isAIField is true \u{2014} a concise instruction
            the vision model can act on, e.g. \"Extract the merchant name
            from the receipt image.\")
  isPrimary (boolean, optional \u{2014} at most one field per table)

Each view object has:
  name   (string, required)
  kind   (string, required \u{2014} one of: grid, calendar, kanban, gallery)
  config (object, optional \u{2014} view-kind-specific config, e.g.
          {\"startField\": \"Date\"} for a calendar view)

Reply with the JSON object and nothing else.";

pub fn router(state: ScenarioState) -> Router {
    Router::new()
        .route("/scenarios/build", post(build))
        .with_state(state)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct FieldPlan {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    options: Option<Map<String, Value>>,
    #[serde(rename = "isAIField")]
    is_ai: bool,
    ai_source: String,
    ai_prompt: String,
    is_primary: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct ViewPlan {
    name: String,
    kind: String,
    config: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Plan {
    base_name: String,
    table_name: String,
    fields: Vec<FieldPlan>,
    views: Vec<ViewPlan>,
}

fn strip_fences(text: &str) -> &str {
    let text = text.trim();
    let Some(rest) = text.strip_prefix("```") else {
        return text;
    };
    let rest = rest.trim_start_matches("json").trim_start_matches("JSON");
    rest.rfind("```").map_or(rest, |end| &rest[..end]).trim()
}

/// Parses, completes, and checks a schema plan.
fn plan_from(text: &str) -> Result<Plan, String> {
    let mut plan: Plan = serde_json::from_str(strip_fences(text))
        .map_err(|err| format!("parse AI response: {err}"))?;
    for field in &mut plan.fields {
        field.name = field.name.trim().to_owned();
        field.kind = field.kind.trim().to_owned();
        field.ai_source = field.ai_source.trim().to_owned();
        field.ai_prompt = field.ai_prompt.trim().to_owned();
        if !FIELD_TYPES.contains(&field.kind.as_str()) {
            return Err(format!(
                "field {:?} has unknown type {:?}",
                field.name, field.kind
            ));
        }
    }
    if plan.base_name.trim().is_empty() {
        plan.base_name = DEFAULT_BASE.into();
    }
    if plan.table_name.trim().is_empty() {
        plan.table_name = DEFAULT_TABLE.into();
    }
    match plan.fields.first_mut() {
        Some(first) if first.name == FILE_NAME_FIELD => {
            *first = FieldPlan {
                name: FILE_NAME_FIELD.into(),
                kind: "text".into(),
                is_primary: true,
                ..FieldPlan::default()
            };
        }
        _ => plan.fields.insert(
            0,
            FieldPlan {
                name: FILE_NAME_FIELD.into(),
                kind: "text".into(),
                is_primary: true,
                ..FieldPlan::default()
            },
        ),
    }
    for field in plan.fields.iter_mut().skip(1) {
        field.is_primary = false;
    }
    if !plan.fields.iter().any(|f| f.kind == "attachment") {
        plan.fields.insert(
            1,
            FieldPlan {
                name: ATTACHMENT_FIELD.into(),
                kind: "attachment".into(),
                ..FieldPlan::default()
            },
        );
    }
    let default_source = plan
        .fields
        .iter()
        .find(|f| f.kind == "attachment")
        .map(|f| f.name.clone())
        .unwrap_or_default();
    let names: HashSet<String> = plan.fields.iter().map(|f| f.name.clone()).collect();
    for field in &mut plan.fields {
        if field.name.is_empty() {
            return Err("a field has an empty name".into());
        }
        if field.is_ai || field.kind == "ai" {
            field.is_ai = true;
            if field.ai_source.is_empty() {
                field.ai_source = default_source.clone();
            }
            if field.ai_prompt.is_empty() {
                return Err(format!("AI field {:?} has an empty aiPrompt", field.name));
            }
            if !names.contains(&field.ai_source) {
                return Err(format!(
                    "AI field {:?} reads {:?}, which is not a field",
                    field.name, field.ai_source
                ));
            }
        }
    }
    if plan.views.is_empty() {
        plan.views.push(ViewPlan {
            name: DEFAULT_VIEW.into(),
            kind: "grid".into(),
            config: None,
        });
    }
    for view in &mut plan.views {
        view.name = view.name.trim().to_owned();
        view.kind = view.kind.trim().to_owned();
        if view.name.is_empty() || view.kind.is_empty() {
            return Err("a view has an empty name or kind".into());
        }
    }
    Ok(plan)
}

fn internal_name(title: &str, taken: &mut HashSet<String>) -> String {
    let mut base = String::new();
    for c in title.trim().chars() {
        if c.is_ascii_alphanumeric() {
            base.push(c.to_ascii_lowercase());
        } else if !base.ends_with('_') {
            base.push('_');
        }
    }
    let mut base = base.trim_matches('_').to_owned();
    if base.is_empty() {
        base = "field".into();
    } else if !base.starts_with(|c: char| c.is_ascii_alphabetic()) {
        base = format!("f_{base}");
    }
    let mut name = base.clone();
    let mut counter = 2;
    while !taken.insert(name.clone()) {
        name = format!("{base}_{counter}");
        counter += 1;
    }
    name
}

/// The table's field seeds, for `tables.create`; AI fields become long text with an `extract`
/// config reading their source field.
fn field_seeds(plan: &Plan) -> Vec<Value> {
    let mut taken = HashSet::new();
    let names: Vec<String> = plan
        .fields
        .iter()
        .map(|f| internal_name(&f.name, &mut taken))
        .collect();
    let name_of = |title: &str| {
        plan.fields
            .iter()
            .position(|f| f.name == title)
            .map(|i| names[i].clone())
            .unwrap_or_default()
    };
    plan.fields
        .iter()
        .zip(&names)
        .map(|(field, name)| {
            let mut options = field.options.clone().unwrap_or_default();
            if field.is_ai {
                options.insert(
                    "ai_config".into(),
                    json!({
                        "enabled": true, "type": "extract", "source_field_name": name_of(&field.ai_source),
                        "extract_instruction": field.ai_prompt, "output_format": "text",
                    }),
                );
            }
            json!({
                "name": name,
                "title": field.name,
                "type": if field.is_ai { "long_text" } else { field.kind.as_str() },
                "primary": field.is_primary,
                "required": field.is_primary,
                "readonly": field.is_ai,
                "options": Value::Object(options),
                "ai_prompt": field.ai_prompt,
            })
        })
        .collect()
}

/// The table's view seeds: a calendar only with a date field.
fn view_seeds(plan: &Plan) -> Vec<Value> {
    let has_date = plan.fields.iter().any(|f| f.kind == "date");
    plan.views
        .iter()
        .filter(|view| view.kind != "calendar" || has_date)
        .map(|view| {
            json!({
                "title": view.name,
                "type": if VIEW_TYPES.contains(&view.kind.as_str()) { view.kind.as_str() } else { "grid" },
                "config": view.config.clone().map_or(Value::Null, Value::Object),
            })
        })
        .collect()
}

struct Upload {
    name: String,
    mime: String,
    data: Bytes,
}

fn sse(event: &Value) -> Bytes {
    Bytes::from(format!("data: {event}\n\n"))
}

fn safe_attachment_name(value: &str) -> String {
    let base = value.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    let cleaned: String = base.replace('\0', "").chars().take(160).collect();
    if cleaned.trim().is_empty() || cleaned == "." {
        "attachment".to_owned()
    } else {
        cleaned
    }
}

fn mime_guess_type(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

async fn build(
    State(state): State<ScenarioState>,
    _user: CurrentUser,
    mut multipart: Multipart,
) -> AppResult<Response> {
    require_ai(&state.ai_gate)?;
    let bad = |message: &str| AppError::bad_request(message.to_owned());
    let mut prompt = String::new();
    let mut model: Option<RuntimeModel> = None;
    let mut uploads = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|err| bad(&format!("Failed to parse multipart form: {err}")))?
    {
        match field.name().unwrap_or_default() {
            "prompt" => prompt = field.text().await.unwrap_or_default().trim().to_owned(),
            "runtime_model" => {
                model = serde_json::from_str(&field.text().await.unwrap_or_default())
                    .ok()
                    .filter(|m: &RuntimeModel| !m.model_name.trim().is_empty());
            }
            "attachments" if uploads.len() < MAX_FILES => {
                let name = safe_attachment_name(field.file_name().unwrap_or_default());
                let mut mime = field.content_type().unwrap_or_default().trim().to_owned();
                if mime.is_empty() {
                    let extension = name
                        .rsplit_once('.')
                        .map(|(_, e)| e.to_lowercase())
                        .unwrap_or_default();
                    mime = mime_guess_type(&extension).to_owned();
                }
                let data = field
                    .bytes()
                    .await
                    .map_err(|_| bad("Failed to read upload"))?;
                if data.len() > MAX_ATTACHMENT_BYTES {
                    return Err(bad("Attachment cannot exceed 50MB"));
                }
                uploads.push(Upload { name, mime, data });
            }
            _ => {}
        }
    }
    if prompt.is_empty() {
        return Err(bad("prompt is required"));
    }
    if uploads.is_empty() {
        return Err(bad("at least one attachment is required"));
    }
    let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
    tokio::spawn(async move {
        let emit = |event: Value| {
            let _ = tx.send(sse(&event));
        };
        if let Err(message) = run(
            &state.tables,
            &state.engine,
            &prompt,
            model,
            uploads,
            &emit,
            &|| tx.is_closed(),
        )
        .await
        {
            emit(json!({ "kind": "error", "code": "scenario.build_failed", "message": message }));
        }
        emit(json!({ "kind": "done" }));
    });
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|chunk| (Ok::<_, Infallible>(chunk), rx))
    });
    Ok((
        [
            (http::header::CONTENT_TYPE, "text/event-stream"),
            (http::header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

async fn infer(
    engine: &Engine,
    model: Option<&RuntimeModel>,
    prompt: &str,
    uploads: &[Upload],
) -> Result<Plan, String> {
    let Some(model) = model else {
        return plan_from(STUB_SCHEMA);
    };
    let mut user = format!("User request:\n{}\n\nUploaded files:\n", prompt.trim());
    for upload in uploads {
        user.push_str(&format!(
            "- {} \u{2022} {} \u{2022} {} bytes\n",
            upload.name,
            upload.mime,
            upload.data.len()
        ));
    }
    let result = engine
        .chat_with_tools(
            &[
                Message::new("system", SYSTEM_PROMPT),
                Message::new("user", user),
            ],
            &[],
            "",
            model,
            None,
        )
        .await
        .map_err(|err| format!("AI inference failed: {err}"))?;
    plan_from(&result.content)
}

/// An unused `<name>.ktable` in the workspace root.
fn unused_path(tables: &TableClient, base: &str) -> String {
    let base: String = base
        .trim()
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let base = if base.trim().is_empty() {
        DEFAULT_BASE.to_owned()
    } else {
        base.trim().to_owned()
    };
    let taken = |path: &str| {
        tables
            .kits()
            .workspace_dir()
            .is_some_and(|dir| dir.join(path).exists())
    };
    let mut path = format!("{base}.ktable");
    let mut counter = 2;
    while taken(&path) {
        path = format!("{base} {counter}.ktable");
        counter += 1;
    }
    path
}

async fn run(
    tables: &TableClient,
    engine: &Engine,
    prompt: &str,
    model: Option<RuntimeModel>,
    uploads: Vec<Upload>,
    emit: &(dyn Fn(Value) + Sync),
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<(), String> {
    let plan = match infer(engine, model.as_ref(), prompt, &uploads).await {
        Ok(plan) => plan,
        Err(message) => {
            emit(json!({ "kind": "error", "code": "scenario.infer_failed", "message": message }));
            return Ok(());
        }
    };
    if cancelled() {
        return Ok(());
    }
    let path = unused_path(tables, &plan.base_name);
    // From here a cancel discards the file this run made: no half-filled table is left behind.
    let stop = || async {
        if let Err(error) = tables.discard_file(&path).await {
            tracing::warn!(path = %path, error = %error, "a cancelled scenario run could not remove its file");
        }
    };
    let starter = tables
        .create_file(&path, None)
        .await
        .map_err(|e| e.message)?;
    let created = tables
        .request(
            &path,
            "tables.create",
            json!({ "title": plan.table_name, "fields": field_seeds(&plan), "views": view_seeds(&plan) }),
            Some(ORIGIN),
        )
        .await
        .map_err(|e| e.message)?;
    for table in starter {
        let _ = tables
            .request(
                &path,
                "tables.delete",
                json!({ "tableId": table.id.parse::<i64>().unwrap_or_default() }),
                Some(ORIGIN),
            )
            .await;
    }
    let table = table_info(&created);
    let table_id = table.id.parse::<i64>().unwrap_or_default();
    let primary = table
        .fields
        .iter()
        .find(|f| f.primary)
        .map(|f| f.name.clone());
    let attachment_fields: Vec<String> = table
        .fields
        .iter()
        .filter(|f| f.field_type == "attachment")
        .map(|f| f.name.clone())
        .collect();
    let mut records = Vec::new();
    for upload in &uploads {
        if cancelled() {
            stop().await;
            return Ok(());
        }
        // Stored in the file as a blob, like an attachment uploaded to a cell.
        let attachment = tables
            .put_attachment(
                &path,
                &table.id,
                &upload.name,
                &upload.mime,
                &upload.data,
                ORIGIN,
            )
            .await
            .map_err(|e| e.message)?;
        let mut values = Map::new();
        if let Some(primary) = &primary {
            values.insert(primary.clone(), json!(upload.name));
        }
        for name in &attachment_fields {
            values.insert(name.clone(), json!([attachment.clone()]));
        }
        let record = tables
            .create_record(&path, &table.id, &values, ORIGIN)
            .await
            .map_err(|e| e.message)?;
        records.push(record);
    }
    emit(json!({ "kind": "base.created", "path": path, "baseName": plan.base_name }));
    emit(json!({ "kind": "table.created", "tableId": table.id, "tableName": table.title }));
    let ai_fields: Vec<_> = table
        .fields
        .iter()
        .filter(|f| f.raw["options"].get("ai_config").is_some())
        .cloned()
        .collect();
    emit(
        json!({ "kind": "fields.generated", "stage": "fields", "count": table.fields.len() - ai_fields.len() }),
    );
    emit(json!({ "kind": "fields.generated", "stage": "ai-fields", "count": ai_fields.len() }));
    emit(json!({ "kind": "records.generated", "count": records.len() }));
    for view in created["views"].as_array().into_iter().flatten() {
        emit(
            json!({ "kind": "views.generated", "viewKind": view["type"], "viewId": view["id"].to_string(), "viewName": view["title"] }),
        );
    }
    let Some(model) = model else { return Ok(()) };
    if cancelled() {
        stop().await;
        return Ok(());
    }
    let record_ids: Vec<i64> = records.iter().filter_map(|r| r.id.parse().ok()).collect();
    for field in &ai_fields {
        let field_id = field.id.parse::<i64>().unwrap_or_default();
        let prepared = match tables
            .request(
                &path,
                "ai.prepare",
                json!({ "tableId": table_id, "fieldId": field_id, "record_ids": record_ids }),
                None,
            )
            .await
        {
            Ok(prepared) => prepared,
            Err(error) => {
                tracing::warn!(field = %field.title, error = %error, "scenario AI field could not be prepared");
                continue;
            }
        };
        let mut results = Vec::new();
        for request in prepared["requests"].as_array().into_iter().flatten() {
            if cancelled() {
                stop().await;
                return Ok(());
            }
            let record_id = request["recordId"].clone();
            match generate(
                tables,
                engine,
                &path,
                &model,
                prepared["output"].as_str().unwrap_or("text"),
                request,
            )
            .await
            {
                Ok(answer) => {
                    let mut result = answer;
                    result["recordId"] = record_id;
                    results.push(result);
                }
                Err(error) => {
                    tracing::warn!(field = %field.title, error = %error, "scenario cell fill failed");
                    results.push(json!({ "recordId": record_id, "error": error }));
                }
            }
        }
        if results.is_empty() {
            continue;
        }
        if let Err(error) = tables
            .run(
                &path,
                vec![Step::new(
                    "ai.apply",
                    json!({ "tableId": table_id, "fieldId": field_id, "results": results }),
                )],
                None,
            )
            .await
        {
            tracing::warn!(field = %field.title, error = %error, "scenario AI answers could not be written");
            continue;
        }
        let filled = tables.records(&path, &table.id).await.unwrap_or_default();
        for record in filled {
            if let Some(value) = record
                .values
                .get(&field.name)
                .filter(|value| !value.is_null())
            {
                emit(
                    json!({ "kind": "cell.ai.filled", "recordId": record.id, "fieldId": field.id, "value": value }),
                );
            }
        }
    }
    if cancelled() {
        stop().await;
    }
    Ok(())
}

/// One prepared AI request run on the person's model: `{ text }` or `{ images }`.
async fn generate(
    tables: &TableClient,
    engine: &Engine,
    path: &str,
    model: &RuntimeModel,
    output: &str,
    request: &Value,
) -> Result<Value, String> {
    let mut prompt = String::new();
    let mut images = Vec::new();
    for message in request["messages"].as_array().into_iter().flatten() {
        for part in message["parts"].as_array().into_iter().flatten() {
            match part["type"].as_str() {
                Some("text") => {
                    if !prompt.is_empty() {
                        prompt.push('\n');
                    }
                    prompt.push_str(part["text"].as_str().unwrap_or_default());
                }
                Some("image") => {
                    if let Some(hash) = part["hash"].as_str() {
                        let blob = tables
                            .request(path, "attachments.read", json!({ "hash": hash }), None)
                            .await
                            .map_err(|e| e.message)?;
                        let mime = part["mime"]
                            .as_str()
                            .filter(|m| !m.is_empty())
                            .or_else(|| blob["mimeType"].as_str())
                            .unwrap_or("image/png");
                        images.push(format!(
                            "data:{mime};base64,{}",
                            blob["data"].as_str().unwrap_or_default()
                        ));
                    } else if let Some(url) = part["url"].as_str() {
                        images.push(url.to_owned());
                    }
                }
                _ => {}
            }
        }
    }
    if output == "image" {
        let options = &request["options"];
        let generated = engine
            .generate_images(
                &ImageRequest {
                    prompt,
                    references: images,
                    count: options["count"].as_i64().unwrap_or(1).clamp(1, 5),
                    width: options["width"].as_i64().unwrap_or(1024),
                    height: options["height"].as_i64().unwrap_or(1024),
                    quality: options["quality"].as_str().unwrap_or_default().to_owned(),
                },
                Some(model),
            )
            .await
            .map_err(|err| err.to_string())?;
        let images: Vec<Value> = generated
            .iter()
            .map(|image| json!({
                "mime": if image.mime_type.is_empty() { "image/png" } else { image.mime_type.as_str() },
                "content": base64::engine::general_purpose::STANDARD.encode(&image.data),
            }))
            .collect();
        return Ok(json!({ "images": images }));
    }
    let mut message = Message::new("user", prompt.clone());
    if !images.is_empty() {
        message.parts.push(MessagePart {
            kind: "text".into(),
            text: prompt,
            ..MessagePart::default()
        });
        for image in images {
            message.parts.push(MessagePart {
                kind: "image_url".into(),
                image_url: image,
                ..MessagePart::default()
            });
        }
    }
    let answer = engine
        .chat_with_tools(&[message], &[], "", model, None)
        .await
        .map_err(|err| err.to_string())?;
    Ok(json!({ "text": answer.content.trim() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_the_stub_plan() {
        let plan = plan_from(STUB_SCHEMA).unwrap_or_default();
        assert_eq!(plan.fields[0].name, FILE_NAME_FIELD);
        let seeds = field_seeds(&plan);
        let summary = seeds
            .iter()
            .find(|f| f["title"] == "Summary")
            .cloned()
            .unwrap_or_default();
        assert_eq!(summary["type"], "long_text");
        assert_eq!(
            summary["options"]["ai_config"]["source_field_name"],
            "receipt_image"
        );
        assert_eq!(summary["options"]["ai_config"]["type"], "extract");
        assert_eq!(view_seeds(&plan)[0]["type"], "grid");
    }

    #[test]
    fn adds_missing_fields_and_rejects_bad_plans() {
        let plan =
            plan_from("```json\n{\"fields\":[{\"name\":\"Total\",\"type\":\"number\"}]}\n```")
                .unwrap_or_default();
        let names: Vec<&str> = plan.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, [FILE_NAME_FIELD, ATTACHMENT_FIELD, "Total"]);
        assert_eq!(plan.base_name, DEFAULT_BASE);
        assert!(plan_from(r#"{"fields":[{"name":"x","type":"blob"}]}"#).is_err());
        assert!(plan_from(r#"{"fields":[{"name":"x","type":"text","isAIField":true}]}"#).is_err());
    }
}

/// AI-SCENE-005 (docs/kition-onboarding-core-scenarios.csv): receipts the person attaches become a
/// table with one traceable row per receipt, each AI column read from that receipt; a receipt the
/// model cannot read stays a reviewable row without blocking the others. The scenario runs against
/// the Table kit's headless program and a local model that reads each receipt's own bytes.
#[cfg(test)]
mod receipt_flow {
    use std::path::PathBuf;

    use axum::Json;
    use axum::routing::post;
    use kition_kits::KitManager;

    use super::*;
    use crate::RecordInfo;

    /// The Table kit's headless program: `KITION_KIT_TABLE_BINARY`, or the sibling checkout's debug build.
    fn executable() -> Option<PathBuf> {
        if let Some(path) =
            std::env::var_os("KITION_KIT_TABLE_BINARY").filter(|value| !value.is_empty())
        {
            return Some(PathBuf::from(path));
        }
        let sibling = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../kition-table/target/debug/kition-table")
            .with_extension(std::env::consts::EXE_EXTENSION);
        sibling.is_file().then_some(sibling)
    }

    const PLAN: &str = r#"{
      "baseName": "Receipt Archive", "tableName": "Receipts",
      "fields": [
        {"name": "File Name", "type": "text", "isPrimary": true},
        {"name": "Receipt Image", "type": "attachment"},
        {"name": "Vendor", "type": "text", "isAIField": true, "aiPrompt": "Extract the vendor name."},
        {"name": "Address", "type": "text", "isAIField": true, "aiPrompt": "Extract the vendor address."},
        {"name": "Category", "type": "text", "isAIField": true, "aiPrompt": "Extract the spending category."},
        {"name": "Transaction Date", "type": "text", "isAIField": true, "aiPrompt": "Extract the transaction date in ISO format."},
        {"name": "Total", "type": "text", "isAIField": true, "aiPrompt": "Extract the total amount."},
        {"name": "Tax", "type": "text", "isAIField": true, "aiPrompt": "Extract the tax amount."}
      ],
      "views": [{"name": "Overall", "kind": "grid"}]
    }"#;

    /// A receipt as the fake model reads it: `vendor|address|category|date|total|tax`.
    fn receipt(fields: [&str; 6]) -> Upload {
        Upload {
            name: format!("{}.png", fields[0].to_lowercase().replace(' ', "-")),
            mime: "image/png".into(),
            data: Bytes::from(fields.join("|")),
        }
    }

    /// Every `data:` URL in a request body, decoded.
    fn images(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) if text.starts_with("data:") => {
                let data = text
                    .split_once(',')
                    .map(|(_, data)| data)
                    .unwrap_or_default();
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                    out.push(String::from_utf8_lossy(&bytes).into_owned());
                }
            }
            Value::Array(items) => items.iter().for_each(|item| images(item, out)),
            Value::Object(map) => map.values().for_each(|item| images(item, out)),
            _ => {}
        }
    }

    /// The fake model: the scenario's plan, then each cell from the receipt it is shown. A receipt
    /// that is not one fails, as an unreadable picture does.
    async fn answer(Json(body): Json<Value>) -> axum::response::Response {
        let text = body.to_string();
        let reply = |content: &str| {
            Json(json!({
                "id": "test", "object": "chat.completion", "model": "test-model",
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            }))
            .into_response()
        };
        if text.contains("database schema designer") {
            return reply(PLAN);
        }
        let mut shown = Vec::new();
        images(&body, &mut shown);
        let Some(fields) = shown
            .first()
            .map(|receipt| receipt.split('|').map(str::to_owned).collect::<Vec<_>>())
            .filter(|fields| fields.len() == 6)
        else {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"error": {"message": "the picture is not a receipt"}})),
            )
                .into_response();
        };
        let column = [
            "Vendor",
            "Address",
            "Category",
            "Transaction Date",
            "Total",
            "Tax",
        ]
        .iter()
        .position(|name| text.contains(&format!("Target field: {name}")))
        .unwrap_or(0);
        reply(&fields[column])
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn receipts_become_one_traceable_row_each_and_a_bad_one_does_not_block_the_rest() {
        let Some(executable) = executable() else {
            eprintln!(
                "skipped: build kition-table (cargo build -p kition-table in ../kition-table) or set KITION_KIT_TABLE_BINARY"
            );
            return;
        };
        let manifest = kition_kits::definitions::manifest_beside(&executable)
            .unwrap_or_else(|| panic!("no kit.json above {}", executable.display()));
        let kit = kition_kits::KitDefinition::from_manifest_text(&manifest)
            .unwrap_or_else(|error| panic!("{error}"));
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let tables = TableClient::new(KitManager::new(
            Some(dir.path().to_path_buf()),
            vec![(kit, Some(executable))],
        ));
        let engine = Engine::new(dir.path().join("uploads"), None);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap_or_else(|err| panic!("{err}"));
        let address = listener.local_addr().unwrap_or_else(|err| panic!("{err}"));
        tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route("/v1/chat/completions", post(answer)),
            )
            .await
        });
        let model = RuntimeModel {
            provider_type: "custom".into(),
            model_name: "test-model".into(),
            base_url: format!("http://{address}/v1"),
            api_key: "test-key".into(),
            auth_scheme: "bearer".into(),
            wire_api: "chat_completions".into(),
            ..RuntimeModel::default()
        };

        let bakery = [
            "Hearth and Grain Bakery",
            "12 Orchard Lane, Portland",
            "Food",
            "2026-03-04",
            "18.40",
            "1.47",
        ];
        let fuel = [
            "Northgate Fuel",
            "400 Ridge Road, Denver",
            "Travel",
            "2026-03-06",
            "52.10",
            "4.17",
        ];
        let uploads = vec![
            receipt(bakery),
            Upload {
                name: "smudged.png".into(),
                mime: "image/png".into(),
                data: Bytes::from_static(b"\x89PNG not a receipt"),
            },
            receipt(fuel),
        ];
        let events = std::sync::Mutex::new(Vec::new());
        let emit = |event: Value| {
            events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(event)
        };
        run(
            &tables,
            &engine,
            "Extract vendor, address, category, date, total and tax from these receipts",
            Some(model),
            uploads,
            &emit,
            &|| false,
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
        let events = events
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(
            events.iter().all(|event| event["kind"] != "error"),
            "{events:?}"
        );

        let path = events
            .iter()
            .find(|event| event["kind"] == "base.created")
            .and_then(|event| event["path"].as_str())
            .unwrap_or_default()
            .to_owned();
        assert_eq!(path, "Receipt Archive.ktable");
        // A fresh client reads the file from disk: what the scenario made survives a reload.
        let manifest =
            kition_kits::definitions::manifest_beside(&executable_or_panic()).unwrap_or_default();
        let kit = kition_kits::KitDefinition::from_manifest_text(&manifest)
            .unwrap_or_else(|error| panic!("{error}"));
        let reopened = TableClient::new(KitManager::new(
            Some(dir.path().to_path_buf()),
            vec![(kit, Some(executable_or_panic()))],
        ));
        let table = reopened
            .tables(&path)
            .await
            .unwrap_or_else(|err| panic!("{err}"))
            .into_iter()
            .next()
            .unwrap_or_else(|| panic!("no table"));
        let titles: Vec<&str> = table
            .fields
            .iter()
            .map(|field| field.title.as_str())
            .collect();
        for wanted in [
            "File Name",
            "Receipt Image",
            "Vendor",
            "Address",
            "Category",
            "Transaction Date",
            "Total",
            "Tax",
        ] {
            assert!(titles.contains(&wanted), "{wanted} missing from {titles:?}");
        }
        let key = |title: &str| {
            table
                .fields
                .iter()
                .find(|field| field.title == title)
                .map(|field| field.name.clone())
                .unwrap_or_default()
        };
        let records = reopened
            .records(&path, &table.id)
            .await
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(records.len(), 3, "one row per receipt");
        let row = |file: &str| {
            records
                .iter()
                .find(|record| {
                    record.values.get(&key("File Name")).and_then(Value::as_str) == Some(file)
                })
                .unwrap_or_else(|| panic!("no row for {file}"))
        };
        for record in &records {
            assert_eq!(
                record
                    .values
                    .get(&key("Receipt Image"))
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1),
                "each receipt is attached once"
            );
        }
        let text = |record: &RecordInfo, title: &str| {
            record
                .values
                .get(&key(title))
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default()
        };
        for (file, fields) in [
            ("hearth-and-grain-bakery.png", bakery),
            ("northgate-fuel.png", fuel),
        ] {
            let record = row(file);
            for (title, value) in [
                "Vendor",
                "Address",
                "Category",
                "Transaction Date",
                "Total",
                "Tax",
            ]
            .iter()
            .zip(fields)
            {
                assert_eq!(text(record, title), value, "{file}: {title}");
            }
        }
        let smudged = row("smudged.png");
        for title in ["Vendor", "Total"] {
            assert_eq!(
                text(smudged, title),
                "",
                "an unreadable receipt leaves {title} empty to review"
            );
        }
    }

    /// AI-SCENE-005, cancellation: a run the person cancels part way (the stream closed) stops and
    /// leaves no table file behind, so no half-filled final table appears later.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_run_leaves_no_partial_table_behind() {
        let Some(executable) = executable() else {
            eprintln!(
                "skipped: build kition-table (cargo build -p kition-table in ../kition-table) or set KITION_KIT_TABLE_BINARY"
            );
            return;
        };
        let manifest = kition_kits::definitions::manifest_beside(&executable)
            .unwrap_or_else(|| panic!("no kit.json above {}", executable.display()));
        let kit = kition_kits::KitDefinition::from_manifest_text(&manifest)
            .unwrap_or_else(|error| panic!("{error}"));
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let tables = TableClient::new(KitManager::new(
            Some(dir.path().to_path_buf()),
            vec![(kit, Some(executable))],
        ));
        let engine = Engine::new(dir.path().join("uploads"), None);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap_or_else(|err| panic!("{err}"));
        let address = listener.local_addr().unwrap_or_else(|err| panic!("{err}"));
        tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route("/v1/chat/completions", post(answer)),
            )
            .await
        });
        let model = RuntimeModel {
            provider_type: "custom".into(),
            model_name: "test-model".into(),
            base_url: format!("http://{address}/v1"),
            api_key: "test-key".into(),
            auth_scheme: "bearer".into(),
            wire_api: "chat_completions".into(),
            ..RuntimeModel::default()
        };
        let uploads = vec![
            receipt([
                "Hearth and Grain Bakery",
                "12 Orchard Lane, Portland",
                "Food",
                "2026-03-04",
                "18.40",
                "1.47",
            ]),
            receipt([
                "Northgate Fuel",
                "400 Ridge Road, Denver",
                "Travel",
                "2026-03-06",
                "52.10",
                "4.17",
            ]),
        ];
        // The person cancels once the table file exists and its rows are being filled.
        let made = std::sync::atomic::AtomicBool::new(false);
        let emit = |event: Value| {
            if event["kind"] == "base.created" {
                made.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        };
        let cancelled = || made.load(std::sync::atomic::Ordering::SeqCst);
        run(
            &tables,
            &engine,
            "Extract vendor, address, category, date, total and tax from these receipts",
            Some(model),
            uploads,
            &emit,
            &cancelled,
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
        assert!(
            made.load(std::sync::atomic::Ordering::SeqCst),
            "the run made its file before the cancel"
        );
        assert!(
            !dir.path().join("Receipt Archive.ktable").exists(),
            "a cancelled run leaves no partial table file"
        );
        assert!(
            tables.table_files().is_empty(),
            "no table file is listed after a cancel: {:?}",
            tables.table_files()
        );
    }

    fn executable_or_panic() -> PathBuf {
        executable().unwrap_or_else(|| panic!("no kition-table executable"))
    }
}
