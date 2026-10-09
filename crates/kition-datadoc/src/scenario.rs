//! `POST /scenarios/build`: turns uploaded files and a request into a new
//! data document — one table, one record per file, and AI fields filled
//! from the attachments — streaming progress as server-sent events.

use std::collections::HashSet;
use std::convert::Infallible;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Multipart, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use kition_ai::engine::{Message, RuntimeModel};
use kition_core::{AppError, AppResult};
use kition_http::CurrentUser;
use kition_kitable::{FieldSpec, TableSpec, ViewSpec};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::DataDocState;
use crate::ai_field::parse_config;
use crate::index::{DataDocument, NewDocument};
use crate::records::{MAX_ATTACHMENT_BYTES, mime_guess_type, safe_attachment_name};

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
  kind   (string, required \u{2014} one of: grid, calendar, kanban, gallery, form)
  config (object, optional \u{2014} view-kind-specific config, e.g.
          {\"startField\": \"Date\"} for a calendar view)

Reply with the JSON object and nothing else.";

pub fn routes() -> Router<DataDocState> {
    Router::new().route("/scenarios/build", post(build))
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

/// The table spec; AI fields become long text with an `extract` config
/// reading their source field.
fn table_spec(plan: &Plan) -> TableSpec {
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
    let fields = plan
        .fields
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
            FieldSpec {
                name: name.clone(),
                title: field.name.clone(),
                field_type: if field.is_ai { "long_text".into() } else { field.kind.clone() },
                primary: field.is_primary,
                required: field.is_primary,
                readonly: field.is_ai,
                options: Value::Object(options),
                ai_prompt: field.ai_prompt.clone(),
                ..FieldSpec::default()
            }
        })
        .collect();
    let has_date = plan.fields.iter().any(|f| f.kind == "date");
    let views = plan
        .views
        .iter()
        .filter(|view| view.kind != "calendar" || has_date)
        .map(|view| ViewSpec {
            title: view.name.clone(),
            view_type: if kition_kitable::VIEW_TYPES.contains(&view.kind.as_str()) {
                view.kind.clone()
            } else {
                "grid".into()
            },
            config: view.config.clone().map_or(Value::Null, Value::Object),
        })
        .collect();
    TableSpec {
        title: plan.table_name.clone(),
        fields,
        views,
        ..TableSpec::default()
    }
}

struct Upload {
    name: String,
    mime: String,
    data: Bytes,
}

fn sse(event: &Value) -> Bytes {
    Bytes::from(format!("data: {event}\n\n"))
}

async fn build(
    State(state): State<DataDocState>,
    user: CurrentUser,
    mut multipart: Multipart,
) -> AppResult<Response> {
    state.require_ai()?;
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
                    mime = mime_guess_type(&extension);
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
    let user_id = user.id;
    tokio::spawn(async move {
        let emit = |event: Value| {
            let _ = tx.send(sse(&event));
        };
        if let Err(message) = run(&state, user_id, &prompt, model, uploads, &emit).await {
            emit(json!({ "kind": "error", "code": "scenario.build_failed", "message": message }));
        }
        emit(json!({ "kind": "done" }));
    });
    let body = Body::from_stream(futures_stream(rx));
    Ok((
        [
            (http::header::CONTENT_TYPE, "text/event-stream"),
            (http::header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response())
}

fn futures_stream(
    rx: mpsc::UnboundedReceiver<Bytes>,
) -> impl futures::Stream<Item = Result<Bytes, Infallible>> {
    futures::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|chunk| (Ok(chunk), rx))
    })
}

async fn infer(
    state: &DataDocState,
    model: Option<&RuntimeModel>,
    prompt: &str,
    uploads: &[Upload],
) -> Result<Plan, String> {
    let (Some(model), Some(engine)) = (model, state.ai.as_ref()) else {
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

async fn run(
    state: &DataDocState,
    user_id: i64,
    prompt: &str,
    model: Option<RuntimeModel>,
    uploads: Vec<Upload>,
    emit: &(dyn Fn(Value) + Sync),
) -> Result<(), String> {
    let plan = match infer(state, model.as_ref(), prompt, &uploads).await {
        Ok(plan) => plan,
        Err(message) => {
            emit(json!({ "kind": "error", "code": "scenario.infer_failed", "message": message }));
            return Ok(());
        }
    };
    let spec = table_spec(&plan);
    let base_name = plan.base_name.clone();
    let (doc, table, records) = state
        .blocking(move |state| {
            let mut path = format!("{}.kitable", crate::source::default_document_path("", &base_name).trim_end_matches(".kitable"));
            let mut counter = 2;
            while crate::source::resolve_from_root(&state.workspace_root_string(), &path).is_ok_and(|p| p.exists()) {
                path = format!("{} {counter}.kitable", base_name.trim());
                counter += 1;
            }
            let (doc, tables) = state.create_kitable_document(
                NewDocument {
                    user_id,
                    workspace_root: String::new(),
                    path,
                    title: base_name.clone(),
                    description: String::new(),
                    icon: String::new(),
                    color: String::new(),
                    meta: Map::new(),
                },
                &[spec],
            )?;
            let table = tables.into_iter().next().ok_or_else(|| AppError::internal("Failed to create table"))?;
            let primary = table.fields.iter().find(|f| f.is_primary).map(|f| f.name.clone());
            let attachment_fields: Vec<String> =
                table.fields.iter().filter(|f| f.field_type == "attachment").map(|f| f.name.clone()).collect();
            let mut file = state.open_or_500(&doc)?;
            let mut records = Vec::new();
            for upload in &uploads {
                let asset = state.assets.save_bytes(&upload.data, &upload.name, &upload.mime)?;
                let mut values = Map::new();
                if let Some(primary) = &primary {
                    values.insert(primary.clone(), json!(upload.name));
                }
                let attachment = json!([{
                    "url": asset.url, "name": upload.name, "mimeType": asset.mime_type, "sizeBytes": asset.size_bytes,
                    "assetId": asset.asset_id, "sha256": asset.sha256, "workspacePath": asset.workspace_path,
                }]);
                for name in &attachment_fields {
                    values.insert(name.clone(), attachment.clone());
                }
                let record = file.create_record(table.id, &values).map_err(|err| AppError::internal(err.to_string()))?;
                state.publish_record_created(&doc, &record);
                records.push(record);
            }
            Ok((doc, table, records))
        })
        .await
        .map_err(|err| err.to_string())?;
    emit(json!({ "kind": "base.created", "baseId": doc.id.to_string(), "baseName": doc.title }));
    emit(
        json!({ "kind": "table.created", "tableId": table.id.to_string(), "tableName": table.title }),
    );
    let ai_fields: Vec<_> = table
        .fields
        .iter()
        .filter(|f| f.options.contains_key("ai_config"))
        .cloned()
        .collect();
    emit(
        json!({ "kind": "fields.generated", "stage": "fields", "count": table.fields.len() - ai_fields.len() }),
    );
    emit(json!({ "kind": "fields.generated", "stage": "ai-fields", "count": ai_fields.len() }));
    emit(json!({ "kind": "records.generated", "count": records.len() }));
    for view in &table.views {
        emit(
            json!({ "kind": "views.generated", "viewKind": view.view_type, "viewId": view.id.to_string(), "viewName": view.title }),
        );
    }
    let Some(model) = model else { return Ok(()) };
    for record in &records {
        for field in &ai_fields {
            let Ok(config) = parse_config(&field.options, &field.ai_prompt) else {
                continue;
            };
            let source = table
                .fields
                .iter()
                .find(|f| f.name == config.source_field_name);
            let source_value = source
                .and_then(|s| record.values.get(&s.name))
                .cloned()
                .unwrap_or(Value::Null);
            let source_title = source.map(|s| s.title.clone()).unwrap_or_default();
            match state
                .generate(
                    user_id,
                    &config,
                    &model,
                    &field.title,
                    &source_title,
                    &source_value,
                )
                .await
            {
                Ok((value, _)) => {
                    if save_cell(state, &doc, table.id, record.id, &field.name, value.clone())
                        .await
                        .is_ok()
                    {
                        emit(
                            json!({ "kind": "cell.ai.filled", "recordId": record.id, "fieldId": field.id, "value": value }),
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(field = %field.title, record = record.id, error = %error, "scenario cell fill failed")
                }
            }
        }
    }
    Ok(())
}

async fn save_cell(
    state: &DataDocState,
    doc: &DataDocument,
    table_id: i64,
    record_id: i64,
    name: &str,
    value: Value,
) -> AppResult<()> {
    let (doc, name) = (doc.clone(), name.to_owned());
    state
        .blocking(move |state| {
            let mut file = state.open_or_500(&doc)?;
            let mut values = Map::new();
            values.insert(name, value);
            file.update_record(table_id, record_id, &values, None)
                .map(|_| ())
                .map_err(|err| AppError::internal(err.to_string()))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_the_stub_plan() {
        let plan = plan_from(STUB_SCHEMA).unwrap_or_default();
        assert_eq!(plan.fields[0].name, FILE_NAME_FIELD);
        let spec = table_spec(&plan);
        let summary = spec
            .fields
            .iter()
            .find(|f| f.title == "Summary")
            .cloned()
            .unwrap_or_default();
        assert_eq!(summary.field_type, "long_text");
        assert_eq!(
            summary.options["ai_config"]["source_field_name"],
            "receipt_image"
        );
        assert!(parse_config(summary.options.as_object().unwrap_or(&Map::new()), "").is_ok());
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
