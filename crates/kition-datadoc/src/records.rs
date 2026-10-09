//! Record handlers, history, links, attachments, and CSV/Markdown transfer.

use std::collections::HashMap;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Multipart, Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::header;
use kition_core::events::{DomainEvent, RecordCreated, RecordUpdated};
use kition_core::{AppError, AppResult, now_millis};
use kition_http::{CurrentUser, JsonBody, ok};
use kition_kitable::{AttachmentSpec, HistoryEntry, KitableError, LinkRef};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::source::{list_window, parse_id};
use crate::{DataDocState, csvutil, respond};

pub const MAX_ATTACHMENT_BYTES: usize = 50 << 20;

pub fn routes() -> Router<DataDocState> {
    let records = "/data-documents/{documentId}/tables/{tableId}/records";
    Router::new()
        .route(records, get(list_records).post(create_record))
        .route(
            &format!("{records}/{{recordId}}"),
            patch(update_record).delete(delete_record),
        )
        .route(
            &format!("{records}/{{recordId}}/history"),
            get(record_history),
        )
        .route(
            &format!("{records}/{{recordId}}/links"),
            get(list_links).post(replace_links).delete(delete_links),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/fields/{fieldId}/link-candidates",
            get(link_candidates),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/attachments",
            post(upload_attachment),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/import/csv",
            post(import_csv),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/export/csv",
            get(export_csv),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/export/markdown",
            get(export_markdown),
        )
}

type Params = HashMap<String, String>;

fn bad(err: KitableError) -> AppError {
    AppError::bad_request(err.to_string())
}

async fn list_records(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
    Query(query): Query<Params>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let (limit, offset) = list_window(query.get("limit"), query.get("offset"));
            let table_id = parse_id(&table_id)?;
            let file = state.open_or_500(&doc)?;
            let failed = |_| AppError::internal("Failed to query records");
            let total = file.count_records(table_id).map_err(failed)?;
            let records = file
                .list_records_page(table_id, limit, offset)
                .map_err(failed)?;
            let items: Vec<Value> = records.iter().map(|r| respond::record(&doc, r)).collect();
            Ok(json!({ "items": items, "total": total, "offset": offset, "limit": limit }))
        })
        .await?;
    Ok(ok(body))
}

#[derive(Debug, Default, Deserialize)]
struct RecordRequest {
    #[serde(default)]
    values: Option<Map<String, Value>>,
    #[serde(default)]
    order: Option<i64>,
}

async fn create_record(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
    JsonBody(request): JsonBody<RecordRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let mut file = state.open_or_500(&doc)?;
            let record = file
                .create_record(table_id, &request.values.unwrap_or_default())
                .map_err(bad)?;
            state
                .events
                .publish(DomainEvent::RecordCreated(RecordCreated {
                    user_id: doc.user_id,
                    document_id: doc.id.to_string(),
                    table_id: table_id.to_string(),
                    record_id: record.id.to_string(),
                    fields: record.values.clone(),
                    created_at: now_millis(),
                }));
            Ok(respond::record(&doc, &record))
        })
        .await?;
    Ok(ok(body))
}

async fn update_record(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, record_id)): Path<(String, String, String)>,
    JsonBody(request): JsonBody<RecordRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let record_id = parse_id(&record_id)?;
            let mut file = state.open_or_500(&doc)?;
            let previous = file.get_record(table_id, record_id).ok().map(|r| r.values);
            let record = file
                .update_record(
                    table_id,
                    record_id,
                    &request.values.unwrap_or_default(),
                    request.order,
                )
                .map_err(bad)?;
            state
                .events
                .publish(DomainEvent::RecordUpdated(RecordUpdated {
                    user_id: doc.user_id,
                    document_id: doc.id.to_string(),
                    table_id: table_id.to_string(),
                    record_id: record.id.to_string(),
                    fields: record.values.clone(),
                    previous,
                    updated_at: now_millis(),
                }));
            Ok(respond::record(&doc, &record))
        })
        .await?;
    Ok(ok(body))
}

async fn delete_record(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, record_id)): Path<(String, String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let record_id = parse_id(&record_id)?;
            let mut file = state.open_or_500(&doc)?;
            file.delete_record(table_id, record_id)
                .map_err(|_| AppError::not_found("Record does not exist"))
        })
        .await?;
    Ok(ok(json!({ "message": "Record deleted" })))
}

fn history_entry(entry: &HistoryEntry) -> Value {
    json!({
        "id": entry.id, "document_id": entry.document_id, "table_id": entry.table_id,
        "record_id": entry.record_id, "field_id": entry.field_id, "action": entry.action,
        "before": entry.before, "after": entry.after, "actor": entry.actor, "created_at": entry.created_at,
    })
}

async fn record_history(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, record_id)): Path<(String, String, String)>,
    Query(query): Query<Params>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let record_id = parse_id(&record_id)?;
            let (limit, offset) = list_window(query.get("limit"), query.get("offset"));
            let limit = if limit <= 0 { 100 } else { limit };
            let file = state.open_or_500(&doc)?;
            let (entries, total) = file
                .list_record_history(table_id, record_id, limit, offset)
                .map_err(|_| AppError::internal("Failed to query record history"))?;
            let items: Vec<Value> = entries.iter().map(history_entry).collect();
            Ok(json!({ "items": items, "total": total, "limit": limit, "offset": offset }))
        })
        .await?;
    Ok(ok(body))
}

fn link_items(refs: &[LinkRef]) -> Value {
    json!({ "items": refs.iter().map(|r| json!({ "row_key": r.row_key, "display": r.display })).collect::<Vec<_>>() })
}

async fn list_links(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, record_id)): Path<(String, String, String)>,
    Query(query): Query<Params>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let record_id = parse_id(&record_id)?;
            let field_id = query
                .get("field_id")
                .and_then(|v| v.parse::<i64>().ok())
                .filter(|id| *id > 0)
                .ok_or_else(|| AppError::bad_request("field_id is required"))?;
            let file = state.open_or_500(&doc)?;
            let refs = file
                .list_record_links(table_id, record_id, field_id)
                .map_err(|_| AppError::internal("Failed to list record links"))?;
            Ok(link_items(&refs))
        })
        .await?;
    Ok(ok(body))
}

#[derive(Debug, Default, Deserialize)]
struct LinkRequest {
    #[serde(default)]
    field_id: Option<i64>,
    #[serde(default)]
    target_row_keys: Option<Vec<String>>,
}

fn parse_link_request(body: &[u8]) -> AppResult<LinkRequest> {
    let request: LinkRequest = kition_http::decode_object(body)
        .map_err(|_| AppError::bad_request("Invalid request body"))?;
    if request.field_id.unwrap_or_default() <= 0 {
        return Err(AppError::bad_request("field_id is required"));
    }
    Ok(request)
}

async fn replace_links(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, record_id)): Path<(String, String, String)>,
    body: Bytes,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let record_id = parse_id(&record_id)?;
            let request = parse_link_request(&body)?;
            let mut file = state.open_or_500(&doc)?;
            let refs = file
                .replace_record_links(
                    table_id,
                    record_id,
                    request.field_id.unwrap_or_default(),
                    &request.target_row_keys.unwrap_or_default(),
                )
                .map_err(bad)?;
            Ok(link_items(&refs))
        })
        .await?;
    Ok(ok(body))
}

async fn delete_links(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, record_id)): Path<(String, String, String)>,
    body: Bytes,
) -> AppResult<Response> {
    let user_id = user.id;
    state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let record_id = parse_id(&record_id)?;
            let request = parse_link_request(&body)?;
            let mut file = state.open_or_500(&doc)?;
            file.delete_record_links(
                table_id,
                record_id,
                request.field_id.unwrap_or_default(),
                &request.target_row_keys.unwrap_or_default(),
            )
            .map_err(|_| AppError::internal("Failed to delete record links"))
        })
        .await?;
    Ok(ok(json!({ "ok": true })))
}

async fn link_candidates(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, _table_id, field_id)): Path<(String, String, String)>,
    Query(query): Query<Params>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let field_id = parse_id(&field_id)?;
            let limit = query
                .get("limit")
                .and_then(|v| v.parse::<i64>().ok())
                .filter(|l| *l > 0)
                .unwrap_or(25);
            let file = state.open_or_500(&doc)?;
            let refs = file
                .list_link_candidates(
                    field_id,
                    query.get("q").map(String::as_str).unwrap_or_default(),
                    limit,
                )
                .map_err(|_| AppError::internal("Failed to list link candidates"))?;
            Ok(link_items(&refs))
        })
        .await?;
    Ok(ok(body))
}

/// The upload's base name, stripped of separators and NULs, at most 160
/// characters; `attachment` when nothing usable remains.
pub(crate) fn safe_attachment_name(value: &str) -> String {
    let base = value.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if base.is_empty() || base == "." {
        return "attachment".to_owned();
    }
    let cleaned: String = base.replace('\0', "").chars().take(160).collect();
    if cleaned.trim().is_empty() {
        "attachment".to_owned()
    } else {
        cleaned
    }
}

async fn upload_attachment(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
    mut multipart: Multipart,
) -> AppResult<Response> {
    let choose = || AppError::bad_request("Please choose an attachment to upload");
    let mut upload: Option<(String, String, Bytes)> = None;
    while let Some(field) = multipart.next_field().await.map_err(|_| choose())? {
        if field.name() == Some("file") && field.file_name().is_some() {
            let name = field.file_name().unwrap_or_default().to_owned();
            let content_type = field.content_type().unwrap_or_default().to_owned();
            let data = field.bytes().await.map_err(|_| choose())?;
            upload = Some((name, content_type, data));
            break;
        }
    }
    let (file_name, content_type, data) = upload.ok_or_else(choose)?;
    if data.is_empty() {
        return Err(AppError::bad_request("Attachment content is empty"));
    }
    if data.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::bad_request("Attachment cannot exceed 50MB"));
    }
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let file = state.open_or_500(&doc)?;
            file.get_table(table_id)
                .map_err(|_| AppError::not_found("Table does not exist"))?;

            let original_name = safe_attachment_name(&file_name);
            let mut mime = content_type.trim().to_owned();
            if mime.is_empty() {
                let extension = std::path::Path::new(&original_name)
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .filter(|e| e.len() < 16)
                    .unwrap_or_default();
                if !extension.is_empty() {
                    mime = mime_guess_type(&extension);
                }
            }
            if mime.is_empty() {
                mime = "application/octet-stream".to_owned();
            }
            let asset = state
                .assets
                .save_bytes(&data, &original_name, &mime)
                .map_err(|_| AppError::internal("Failed to save attachment"))?;
            let response = json!({
                "name": original_name,
                "mimeType": mime,
                "sizeBytes": asset.size_bytes,
                "url": asset.url,
                "assetId": asset.asset_id,
                "sha256": asset.sha256,
                "workspacePath": asset.workspace_path,
            });
            let register = || AppError::internal("Failed to register attachment");
            let file_document_id = file.document_id().map_err(|_| register())?;
            file.add_attachment(&AttachmentSpec {
                document_id: file_document_id,
                record_id: None,
                field_id: None,
                name: original_name.clone(),
                path: asset.workspace_path.clone(),
                mime_type: mime.clone(),
                size: asset.size_bytes,
                meta: response.clone(),
            })
            .map_err(|_| register())?;
            Ok(response)
        })
        .await?;
    Ok(ok(body))
}

pub(crate) fn mime_guess_type(extension: &str) -> String {
    match extension {
        "png" => "image/png".to_owned(),
        "jpg" | "jpeg" => "image/jpeg".to_owned(),
        "gif" => "image/gif".to_owned(),
        "webp" => "image/webp".to_owned(),
        "svg" => "image/svg+xml".to_owned(),
        "pdf" => "application/pdf".to_owned(),
        "json" => "application/json".to_owned(),
        _ => String::new(),
    }
}

#[derive(Debug, Default, Deserialize)]
struct CsvRequest {
    #[serde(default)]
    content: Option<String>,
}

async fn import_csv(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
    JsonBody(request): JsonBody<CsvRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let rows = csvutil::read_all(&request.content.unwrap_or_default())
                .filter(|rows| !rows.is_empty())
                .ok_or_else(|| AppError::bad_request("Invalid CSV content"))?;
            let table_id = parse_id(&table_id)?;
            let mut file = state.open_or_500(&doc)?;
            let table = file
                .get_table(table_id)
                .map_err(|_| AppError::not_found("Table does not exist"))?;
            let headers = &rows[0];
            let mut created = 0;
            for row in &rows[1..] {
                let mut values = Map::new();
                for (index, header) in headers.iter().enumerate() {
                    let Some(cell) = row.get(index) else { continue };
                    if let Some(field) = table
                        .fields
                        .iter()
                        .find(|f| &f.title == header || &f.name == header)
                    {
                        values.insert(field.name.clone(), Value::String(cell.clone()));
                    }
                }
                file.create_record(table_id, &values)
                    .map_err(|_| AppError::internal("Failed to import CSV"))?;
                created += 1;
            }
            Ok(json!({ "created": created }))
        })
        .await?;
    Ok(ok(body))
}

/// Text form of a cell for CSV and Markdown exports.
pub fn stringify_cell(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(stringify_cell)
            .collect::<Vec<_>>()
            .join(", "),
        Value::Object(map) => ["display", "name", "title", "url", "href", "row_key"]
            .iter()
            .find_map(|key| {
                map.get(*key)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_default()
            .to_owned(),
        Value::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(int), _) => int.to_string(),
            (None, Some(float)) => float.to_string(),
            _ => number.to_string(),
        },
        Value::Bool(flag) => flag.to_string(),
    }
}

fn escape_markdown_cell(value: &str) -> String {
    value.replace('\n', "<br>").replace('|', "\\|")
}

async fn export_csv(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    let (name, content) = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let file = state.open_or_500(&doc)?;
            let table = file
                .get_table(table_id)
                .map_err(|_| AppError::not_found("Table does not exist"))?;
            let records = file
                .list_records(table_id)
                .map_err(|_| AppError::internal("Failed to export CSV"))?;
            let mut out = String::new();
            csvutil::write_record(
                &mut out,
                &table
                    .fields
                    .iter()
                    .map(|f| f.title.clone())
                    .collect::<Vec<_>>(),
            );
            for record in &records {
                let row: Vec<String> = table
                    .fields
                    .iter()
                    .map(|f| stringify_cell(record.values.get(&f.name).unwrap_or(&Value::Null)))
                    .collect();
                csvutil::write_record(&mut out, &row);
            }
            Ok((table.name, out))
        })
        .await?;
    let disposition = format!("attachment; filename={:?}", format!("{name}.csv"));
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_owned()),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        content,
    )
        .into_response())
}

async fn export_markdown(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    let content = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let file = state.open_or_500(&doc)?;
            let table = file
                .get_table(table_id)
                .map_err(|_| AppError::not_found("Table does not exist"))?;
            let records = file
                .list_records(table_id)
                .map_err(|_| AppError::internal("Failed to export Markdown"))?;
            let mut out = String::from("|");
            for field in &table.fields {
                out.push_str(&format!(" {} |", escape_markdown_cell(&field.title)));
            }
            out.push_str("\n|");
            for _ in &table.fields {
                out.push_str(" --- |");
            }
            out.push('\n');
            for record in &records {
                out.push('|');
                for field in &table.fields {
                    let cell =
                        stringify_cell(record.values.get(&field.name).unwrap_or(&Value::Null));
                    out.push_str(&format!(" {} |", escape_markdown_cell(&cell)));
                }
                out.push('\n');
            }
            Ok(out)
        })
        .await?;
    Ok(ok(json!({ "content": content })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_names() {
        assert_eq!(safe_attachment_name("dir/photo.png"), "photo.png");
        assert_eq!(safe_attachment_name("C:\\x\\a.txt"), "a.txt");
        assert_eq!(safe_attachment_name(" "), "attachment");
        assert_eq!(safe_attachment_name("a\0b"), "ab");
        assert_eq!(safe_attachment_name(&"x".repeat(200)).chars().count(), 160);
    }

    #[test]
    fn stringifies_cells() {
        assert_eq!(
            stringify_cell(&json!([1, "a", {"display": "D"}])),
            "1, a, D"
        );
        assert_eq!(stringify_cell(&json!(2.5)), "2.5");
        assert_eq!(stringify_cell(&json!({"x": 1})), "");
        assert_eq!(stringify_cell(&json!(true)), "true");
        assert_eq!(escape_markdown_cell("a|b\nc"), "a\\|b<br>c");
    }
}
