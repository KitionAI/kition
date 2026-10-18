//! Record routes (history, links, CSV/Markdown transfer: adapters over
//! `kition_table_api::records`), attachment uploads stored in the file as blobs, and the blobs'
//! bytes (see [`crate::blob_attachments`]).

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
pub use kition_table_api::records::stringify_cell;
use kition_table_api::records::{self as api, CsvRequest, LinkRequest, RecordRequest};

use crate::source::{list_window, parse_id};
use crate::{DataDocState, api_error, respond};

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
        .route("/data-documents/{documentId}/blobs/{hash}", get(read_blob))
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
            api::list(&file, &doc.doc_ref(), table_id, limit, offset).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
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
            let mut request = request;
            if let Some(values) = request.values.as_mut() {
                state.import_path_attachments(&mut file, table_id, values);
            }
            let record = api::create(&mut file, table_id, request).map_err(api_error)?;
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
            let mut request = request;
            if let Some(values) = request.values.as_mut() {
                state.import_path_attachments(&mut file, table_id, values);
            }
            let (record, previous) =
                api::update(&mut file, table_id, record_id, request).map_err(api_error)?;
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
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let record_id = parse_id(&record_id)?;
            let mut file = state.open_or_500(&doc)?;
            api::delete(&mut file, table_id, record_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
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
            let file = state.open_or_500(&doc)?;
            api::history(&file, table_id, record_id, limit, offset).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
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
            let field_id =
                api::link_field_id(query.get("field_id").map(String::as_str)).map_err(api_error)?;
            let file = state.open_or_500(&doc)?;
            api::list_links(&file, table_id, record_id, field_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

fn parse_link_request(body: &[u8]) -> AppResult<LinkRequest> {
    let request: LinkRequest = kition_http::decode_object(body)
        .map_err(|_| AppError::bad_request("Invalid request body"))?;
    request.check().map_err(api_error)
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
            api::replace_links(&mut file, table_id, record_id, request).map_err(api_error)
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
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let record_id = parse_id(&record_id)?;
            let request = parse_link_request(&body)?;
            let mut file = state.open_or_500(&doc)?;
            api::delete_links(&mut file, table_id, record_id, request).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
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
            let limit = api::candidate_limit(query.get("limit").map(String::as_str));
            let file = state.open_or_500(&doc)?;
            let search = query.get("q").map(String::as_str).unwrap_or_default();
            api::link_candidates(&file, field_id, search, limit).map_err(api_error)
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
            let mut file = state.open_or_500(&doc)?;
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
            kition_table_api::attachments::put(&mut file, table_id, &data, &original_name, &mime)
                .map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

/// MIME types a blob is served as in place; anything else downloads as bytes, so a stored page
/// or script never runs on the runtime's origin.
const INLINE_TYPES: &[&str] = &[
    "image/",
    "video/",
    "audio/",
    "application/pdf",
    "text/plain",
];

/// `GET /data-documents/{documentId}/blobs/{hash}`: a blob's bytes, as an attachment's URL
/// loads them. Blobs never change (the URL names their content), so they may be cached forever.
async fn read_blob(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, hash)): Path<(String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    let blob = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let file = state.open_or_500(&doc)?;
            file.blob(hash.trim())
                .map_err(AppError::unhandled)?
                .ok_or_else(|| AppError::not_found("Attachment does not exist"))
        })
        .await?;
    let mime = blob.info.mime.to_ascii_lowercase();
    let inline = INLINE_TYPES.iter().any(|kind| mime.starts_with(kind)) && mime != "image/svg+xml";
    let content_type = if inline {
        mime
    } else {
        "application/octet-stream".to_owned()
    };
    let disposition = if inline { "inline" } else { "attachment" };
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_DISPOSITION, disposition.to_owned()),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".to_owned(),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
            (
                header::CONTENT_SECURITY_POLICY,
                "sandbox; default-src 'none'".to_owned(),
            ),
        ],
        blob.bytes,
    )
        .into_response())
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
            let rows = api::parse_csv(&request.content.unwrap_or_default()).map_err(api_error)?;
            let table_id = parse_id(&table_id)?;
            let mut file = state.open_or_500(&doc)?;
            api::import_csv(&mut file, table_id, &rows).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
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
            api::export_csv(&file, table_id).map_err(api_error)
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
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let file = state.open_or_500(&doc)?;
            api::export_markdown(&file, table_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
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
}
