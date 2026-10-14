//! Data import jobs: preview tokens, background writes into `.kitable`
//! files, progress, cancellation, and idempotency.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRequest, Multipart, Path, Request, State};
use axum::response::Response;
use axum::routing::{get, post};
use kition_core::coerce::nullable;
use kition_core::{AppError, AppResult, Millis, now_millis};
use kition_http::{CurrentUser, ok};
use kition_kitable::{Field, FieldPatch, FieldSpec, KitableFile, Record, TableSpec};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::DataDocState;
use crate::import_parse::{self, ImportField, ImportPreview, ImportSource, ImportWarning};
use crate::index;
use crate::source::{default_document_path, resolve_from_root};
use crate::tables::{FieldSeed, TableSeed, ViewSeed};

const PREVIEW_TTL_MS: Millis = 30 * 60 * 1000;
pub const MAX_SOURCE_BYTES: usize = 100 << 20;

/// A float as JSON, written as an integer when it has no fraction.
pub fn float_value(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e15 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

/// Shortest decimal text for a float, without exponent for whole numbers.
pub fn format_float(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e15 {
        (value as i64).to_string()
    } else {
        value.to_string()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    #[serde(skip_serializing_if = "is_zero")]
    pub document_id: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub table_id: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
    pub rows_total: usize,
    pub rows_created: usize,
    pub rows_updated: usize,
    pub rows_skipped: usize,
    pub fields_created: usize,
    pub fields_updated: usize,
    pub warnings: Vec<ImportWarning>,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

#[derive(Debug, Clone, Serialize)]
pub struct JobError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportJob {
    pub id: String,
    pub status: String,
    pub stage: String,
    pub processed_rows: usize,
    pub total_rows: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ImportResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JobError>,
    pub created_at: Millis,
    pub updated_at: Millis,
}

struct PreviewEntry {
    preview: ImportPreview,
    rows: Vec<Vec<String>>,
    user_id: i64,
}

struct JobState {
    job: ImportJob,
    user_id: i64,
    canceled: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    previews: HashMap<String, PreviewEntry>,
    jobs: HashMap<String, JobState>,
    idempotency: HashMap<String, String>,
}

/// In-memory previews and jobs; they do not survive a restart.
#[derive(Clone, Default)]
pub struct ImportStore {
    inner: Arc<Mutex<Inner>>,
}

impl ImportStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn update_job(&self, id: &str, update: impl FnOnce(&mut ImportJob)) {
        let mut inner = self.lock();
        if let Some(state) = inner.jobs.get_mut(id) {
            update(&mut state.job);
            state.job.updated_at = now_millis();
        }
    }
}

fn prune(inner: &mut Inner, now: Millis) {
    inner
        .previews
        .retain(|_, entry| entry.preview.expires_at >= now);
}

pub fn routes() -> Router<DataDocState> {
    Router::new()
        .route("/data-imports/preview", post(preview))
        .route("/data-imports", post(execute))
        .route("/data-imports/{jobId}", get(get_job).delete(cancel_job))
}

#[derive(Debug, Default, Deserialize)]
struct WorkspaceSourceRequest {
    #[serde(default)]
    source: Option<WorkspaceSource>,
    #[serde(default, deserialize_with = "nullable")]
    sheet: String,
}

#[derive(Debug, Default, Deserialize)]
struct WorkspaceSource {
    #[serde(default, deserialize_with = "nullable")]
    kind: String,
    #[serde(default, deserialize_with = "nullable")]
    workspace_path: String,
}

/// Reads the source from a multipart upload (`file`, optional `sheet`) or a
/// workspace path.
async fn read_source(
    state: &DataDocState,
    request: Request,
) -> AppResult<(String, ImportSource, String, Vec<u8>)> {
    let content_type = request
        .headers()
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if content_type.starts_with("multipart/form-data") {
        let required = || AppError::bad_request("Import file is required");
        let mut multipart = Multipart::from_request(request, state)
            .await
            .map_err(|_| required())?;
        let mut file: Option<(String, Vec<u8>)> = None;
        let mut sheet = String::new();
        while let Some(field) = multipart.next_field().await.map_err(|_| required())? {
            match field.name() {
                Some("file") if file.is_none() && field.file_name().is_some() => {
                    let name = field.file_name().unwrap_or_default().to_owned();
                    let data = field
                        .bytes()
                        .await
                        .map_err(|_| AppError::bad_request("failed to open import file"))?;
                    if data.len() > MAX_SOURCE_BYTES {
                        return Err(AppError::bad_request(format!(
                            "import file exceeds {} MB",
                            MAX_SOURCE_BYTES >> 20
                        )));
                    }
                    file = Some((name, data.to_vec()));
                }
                Some("sheet") => sheet = field.text().await.unwrap_or_default().trim().to_owned(),
                _ => {}
            }
        }
        let (name, data) = file.ok_or_else(required)?;
        let filename = name
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned();
        let source = ImportSource {
            kind: "upload".into(),
            upload_name: filename.clone(),
            ..ImportSource::default()
        };
        return Ok((filename, source, sheet, data));
    }
    let bytes = Bytes::from_request(request, state)
        .await
        .map_err(|_| AppError::localized_bad_request("common.bad_request"))?;
    let body: WorkspaceSourceRequest = kition_http::decode_object(&bytes)?;
    let source = body.source.unwrap_or_default();
    if source.kind != "workspace" || source.workspace_path.trim().is_empty() {
        return Err(AppError::bad_request(
            "A workspace-relative import source is required",
        ));
    }
    let absolute = state
        .assets
        .resolve_workspace_path(&source.workspace_path)
        .map_err(|_| AppError::bad_request("Import source path is invalid"))?;
    let data = tokio::fs::read(&absolute)
        .await
        .map_err(|_| AppError::bad_request("Failed to read import source"))?;
    if data.len() > MAX_SOURCE_BYTES {
        return Err(AppError::bad_request("Failed to read import source"));
    }
    let filename = std::path::Path::new(&source.workspace_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned =
        kition_workspace::fsutil::resolve_within(std::path::Path::new(""), &source.workspace_path)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| source.workspace_path.clone());
    let import_source = ImportSource {
        kind: "workspace".into(),
        workspace_path: cleaned,
        ..ImportSource::default()
    };
    Ok((filename, import_source, body.sheet.trim().to_owned(), data))
}

async fn preview(
    State(state): State<DataDocState>,
    user: CurrentUser,
    request: Request,
) -> AppResult<Response> {
    let (filename, source, sheet, raw) = read_source(&state, request).await?;
    let user_id = user.id;
    let preview =
        tokio::task::spawn_blocking(move || -> AppResult<(ImportPreview, Vec<Vec<String>>)> {
            let parsed = import_parse::parse(&filename, source, &sheet, &raw)
                .map_err(AppError::bad_request)?;
            if parsed.field_count == 0 {
                return Err(AppError::bad_request(
                    "Import source does not contain a header row",
                ));
            }
            let rows = import_parse::data_rows(&raw, &filename, &parsed.selected_sheet);
            Ok((parsed, rows))
        })
        .await
        .map_err(AppError::unhandled)??;
    let (mut preview, rows) = preview;
    let now = now_millis();
    preview.import_token = uuid::Uuid::new_v4().to_string();
    preview.expires_at = now + PREVIEW_TTL_MS;
    let mut inner = state.imports.lock();
    prune(&mut inner, now);
    inner.previews.insert(
        preview.import_token.clone(),
        PreviewEntry {
            preview: preview.clone(),
            rows,
            user_id,
        },
    );
    Ok(ok(preview))
}

#[derive(Debug, Clone, Default, Deserialize)]
struct Target {
    #[serde(default, deserialize_with = "nullable")]
    kind: String,
    #[serde(default, deserialize_with = "nullable")]
    path: String,
    #[serde(default, deserialize_with = "nullable")]
    table_title: String,
    #[serde(default, deserialize_with = "nullable")]
    document_id: i64,
    #[serde(default, deserialize_with = "nullable")]
    table_id: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct FieldOverride {
    #[serde(default, deserialize_with = "nullable")]
    index: i64,
    #[serde(default, deserialize_with = "nullable")]
    title: String,
    #[serde(default, rename = "type", deserialize_with = "nullable")]
    field_type: String,
    #[serde(default)]
    options: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ExecuteRequest {
    #[serde(default, deserialize_with = "nullable")]
    import_token: String,
    #[serde(default, deserialize_with = "nullable")]
    target: Target,
    #[serde(default, deserialize_with = "nullable")]
    write_mode: String,
    #[serde(default, deserialize_with = "nullable")]
    schema_mode: String,
    #[serde(default, deserialize_with = "nullable")]
    unique_by: Vec<String>,
    #[serde(default, deserialize_with = "nullable")]
    field_overrides: Vec<FieldOverride>,
    #[serde(default, deserialize_with = "nullable")]
    idempotency_key: String,
}

fn validate(request: &ExecuteRequest) -> Result<(), &'static str> {
    if request.import_token.trim().is_empty() {
        return Err("import_token is required");
    }
    if !matches!(request.write_mode.as_str(), "append" | "replace" | "upsert") {
        return Err("write_mode must be append, replace, or upsert");
    }
    if !matches!(
        request.schema_mode.as_str(),
        "auto" | "preserve" | "replace"
    ) {
        return Err("schema_mode must be auto, preserve, or replace");
    }
    let target = &request.target;
    match target.kind.as_str() {
        "existing_table" if target.document_id <= 0 || target.table_id <= 0 => {
            return Err("existing_table target requires document_id and table_id");
        }
        "new_table" if target.document_id <= 0 || target.table_title.trim().is_empty() => {
            return Err("new_table target requires document_id and table_title");
        }
        "new_document" if target.path.trim().is_empty() || target.table_title.trim().is_empty() => {
            return Err("new_document target requires path and table_title");
        }
        "existing_table" | "new_table" | "new_document" => {}
        _ => return Err("unsupported import target"),
    }
    if request.write_mode == "upsert" && request.unique_by.is_empty() {
        return Err("upsert requires unique_by fields");
    }
    Ok(())
}

async fn execute(
    State(state): State<DataDocState>,
    user: CurrentUser,
    kition_http::JsonBody(request): kition_http::JsonBody<ExecuteRequest>,
) -> AppResult<Response> {
    validate(&request).map_err(AppError::bad_request)?;
    let user_id = user.id;
    let now = now_millis();
    let idempotency = format!("{user_id}:{}", request.idempotency_key.trim());
    let (job, rows, fields, canceled) = {
        let mut inner = state.imports.lock();
        prune(&mut inner, now);
        let entry = inner
            .previews
            .get(&request.import_token)
            .filter(|entry| entry.user_id == user_id)
            .ok_or_else(|| AppError::bad_request("Import preview token is invalid or expired"))?;
        let rows = entry.rows.clone();
        let fields = entry.preview.fields.clone();
        if !request.idempotency_key.is_empty()
            && let Some(state) = inner
                .idempotency
                .get(&idempotency)
                .and_then(|id| inner.jobs.get(id))
        {
            return Ok(ok(state.job.clone()));
        }
        let job = ImportJob {
            id: uuid::Uuid::new_v4().to_string(),
            status: "queued".into(),
            stage: "queued".into(),
            processed_rows: 0,
            total_rows: rows.len().saturating_sub(1),
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
        };
        let canceled = Arc::new(AtomicBool::new(false));
        inner.jobs.insert(
            job.id.clone(),
            JobState {
                job: job.clone(),
                user_id,
                canceled: canceled.clone(),
            },
        );
        if !request.idempotency_key.is_empty() {
            inner.idempotency.insert(idempotency, job.id.clone());
        }
        (job, rows, fields, canceled)
    };
    let job_id = job.id.clone();
    let worker = state.clone();
    tokio::task::spawn_blocking(move || {
        run_job(
            &worker, &job_id, user_id, request, &rows, &fields, &canceled,
        )
    });
    Ok(ok(job))
}

async fn get_job(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let inner = state.imports.lock();
    let job = inner
        .jobs
        .get(&id)
        .filter(|s| s.user_id == user.id)
        .map(|s| s.job.clone())
        .ok_or_else(|| AppError::not_found("Import job does not exist"))?;
    Ok(ok(job))
}

async fn cancel_job(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let mut inner = state.imports.lock();
    let job_state = inner
        .jobs
        .get_mut(&id)
        .filter(|s| s.user_id == user.id)
        .ok_or_else(|| AppError::not_found("Import job does not exist"))?;
    if job_state.job.status == "queued" || job_state.job.status == "running" {
        job_state.canceled.store(true, Ordering::SeqCst);
        job_state.job.status = "canceled".into();
        job_state.job.stage = "canceled".into();
        job_state.job.updated_at = now_millis();
    }
    Ok(ok(job_state.job.clone()))
}

fn run_job(
    state: &DataDocState,
    job_id: &str,
    user_id: i64,
    request: ExecuteRequest,
    rows: &[Vec<String>],
    fields: &[ImportField],
    canceled: &AtomicBool,
) {
    if canceled.load(Ordering::SeqCst) {
        return;
    }
    state.imports.update_job(job_id, |job| {
        if job.status != "canceled" {
            job.status = "running".into();
            job.stage = "validating".into();
        }
    });
    let fields = apply_overrides(fields, &request.field_overrides);
    let progress = |stage: &str, processed: usize| {
        state.imports.update_job(job_id, |job| {
            job.stage = stage.to_owned();
            job.processed_rows = processed;
        });
    };
    let outcome = write_import(state, user_id, request, rows, fields, &progress, canceled);
    state.imports.update_job(job_id, |job| match outcome {
        Ok(result) => {
            job.status = "completed".into();
            job.stage = "completed".into();
            job.processed_rows = job.total_rows;
            job.result = Some(result);
        }
        Err(_) if canceled.load(Ordering::SeqCst) || job.status == "canceled" => {
            job.status = "canceled".into();
            job.stage = "canceled".into();
        }
        Err(message) => {
            job.status = "failed".into();
            job.stage = "failed".into();
            job.error = Some(JobError {
                code: "import_failed".into(),
                message,
            });
        }
    });
}

fn apply_overrides(fields: &[ImportField], overrides: &[FieldOverride]) -> Vec<ImportField> {
    let mut out = fields.to_vec();
    for item in overrides {
        let Some(field) = usize::try_from(item.index)
            .ok()
            .and_then(|i| out.get_mut(i))
        else {
            continue;
        };
        if !item.title.trim().is_empty() {
            field.title = item.title.trim().to_owned();
        }
        if kition_kitable::FIELD_TYPES.contains(&item.field_type.as_str())
            && !matches!(item.field_type.as_str(), "attachment" | "formula" | "ai")
        {
            field.field_type = item.field_type.clone();
        }
        if let Some(options) = &item.options {
            field.options = Some(options.clone());
        }
    }
    out
}

/// Fills select choices from the data when a select field has no options.
fn ensure_select_options(fields: &mut [ImportField], rows: &[Vec<String>]) {
    for (index, field) in fields.iter_mut().enumerate() {
        if !matches!(field.field_type.as_str(), "single_select" | "multi_select")
            || field.options.is_some()
        {
            continue;
        }
        let mut seen = HashSet::new();
        let mut choices = Vec::new();
        for row in rows {
            let Some(cell) = row.get(index) else { continue };
            for raw in cell.split(',') {
                let value = raw.trim();
                if !value.is_empty() && choices.len() < 50 && seen.insert(value.to_owned()) {
                    choices.push(Value::String(value.to_owned()));
                }
            }
        }
        let mut options = Map::new();
        options.insert("choices".into(), Value::Array(choices));
        field.options = Some(options);
    }
}

fn field_seeds(fields: &[ImportField]) -> Vec<FieldSeed> {
    fields
        .iter()
        .enumerate()
        .map(|(index, f)| FieldSeed {
            title: f.title.clone(),
            field_type: f.field_type.clone(),
            primary: index == 0,
            options: f.options.clone().map_or(Value::Null, Value::Object),
            ..FieldSeed::default()
        })
        .collect()
}

fn import_table_spec(title: &str, fields: &[ImportField]) -> TableSpec {
    crate::tables::seed_to_spec(&TableSeed {
        title: title.to_owned(),
        fields: field_seeds(fields),
        views: vec![ViewSeed {
            title: "All".into(),
            view_type: "grid".into(),
            config: Value::Null,
        }],
        ..TableSeed::default()
    })
}

fn write_import(
    state: &DataDocState,
    user_id: i64,
    mut request: ExecuteRequest,
    rows: &[Vec<String>],
    mut fields: Vec<ImportField>,
    progress: &dyn Fn(&str, usize),
    canceled: &AtomicBool,
) -> Result<ImportResult, String> {
    if rows.is_empty() || fields.is_empty() {
        return Err("import source does not contain fields".into());
    }
    let data = &rows[1..];
    ensure_select_options(&mut fields, data);
    progress("writing_schema", 0);

    if request.target.kind == "new_document" {
        return write_new_document(state, user_id, &request, data, &fields, progress, canceled);
    }
    let conn = state.db.conn().map_err(|e| e.to_string())?;
    let doc = index::find(&conn, user_id, &request.target.document_id.to_string())
        .ok()
        .flatten()
        .ok_or_else(|| "target data document does not exist".to_owned())?;
    drop(conn);
    let root = if doc.workspace_root.trim().is_empty() {
        state.workspace_root_string()
    } else {
        doc.workspace_root.clone()
    };
    let absolute = resolve_from_root(&root, &doc.path)
        .or_else(|_| resolve_from_root(&state.workspace_root_string(), &doc.path))
        .map_err(|e| e.to_string())?;
    let backup = absolute.with_file_name(format!(
        "{}.import-backup-{}",
        absolute
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        uuid::Uuid::new_v4()
    ));
    std::fs::copy(&absolute, &backup)
        .map_err(|_| "failed to prepare import rollback".to_owned())?;
    let outcome = (|| -> Result<ImportResult, String> {
        let mut file = state.open_document(&doc).map_err(|e| e.to_string())?;
        let (table, fields_created, fields_updated) = if request.target.kind == "new_table" {
            let table = file
                .create_table(&import_table_spec(&request.target.table_title, &fields))
                .map_err(|e| e.to_string())?;
            (table, fields.len(), 0)
        } else {
            let table = file
                .get_table(request.target.table_id)
                .map_err(|e| e.to_string())?;
            let (created, updated, replaced) = prepare_schema(
                &mut file,
                &table.fields,
                table.id,
                &fields,
                &request.schema_mode,
            )
            .map_err(|e| e.to_string())?;
            if replaced {
                request.write_mode = "replace".into();
            }
            (
                file.get_table(table.id).map_err(|e| e.to_string())?,
                created,
                updated,
            )
        };
        let (created, updated, skipped) = write_rows(
            &mut file,
            table.id,
            &table.fields,
            &fields,
            data,
            &request,
            progress,
            canceled,
        )?;
        file.close();
        Ok(ImportResult {
            document_id: doc.id,
            table_id: table.id,
            path: doc.path.clone(),
            rows_total: data.len(),
            rows_created: created,
            rows_updated: updated,
            rows_skipped: skipped,
            fields_created,
            fields_updated,
            warnings: Vec::new(),
        })
    })();
    match &outcome {
        Ok(_) => {
            let _ = std::fs::remove_file(&backup);
        }
        Err(_) => {
            let _ = std::fs::remove_file(&absolute);
            let _ = std::fs::rename(&backup, &absolute);
        }
    }
    outcome
}

fn write_new_document(
    state: &DataDocState,
    user_id: i64,
    request: &ExecuteRequest,
    data: &[Vec<String>],
    fields: &[ImportField],
    progress: &dyn Fn(&str, usize),
    canceled: &AtomicBool,
) -> Result<ImportResult, String> {
    let stem = std::path::Path::new(request.target.path.trim())
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let path = default_document_path(&request.target.path, &stem);
    let title = std::path::Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let doc = state
        .create_document(
            user_id,
            &title,
            &path,
            &[TableSeed {
                title: request.target.table_title.clone(),
                fields: field_seeds(fields),
                views: vec![ViewSeed {
                    title: "All".into(),
                    view_type: "grid".into(),
                    config: Value::Null,
                }],
                ..TableSeed::default()
            }],
        )
        .map_err(|_| "failed to create Kitable import target".to_owned())?;
    let cleanup = || {
        if let Ok(conn) = state.db.conn() {
            let _ = index::soft_delete(&conn, doc.id);
        }
        if let Ok(absolute) = resolve_from_root(&state.workspace_root_string(), &path) {
            let _ = std::fs::remove_file(absolute);
        }
    };
    let outcome = (|| -> Result<ImportResult, String> {
        let mut file = state
            .open_document(&doc)
            .map_err(|_| "failed to open Kitable import target".to_owned())?;
        let tables = file
            .list_tables()
            .map_err(|_| "failed to initialize Kitable import target".to_owned())?;
        let table = tables
            .first()
            .cloned()
            .ok_or_else(|| "failed to initialize Kitable import target".to_owned())?;
        let (created, updated, skipped) = write_rows(
            &mut file,
            table.id,
            &table.fields,
            fields,
            data,
            request,
            progress,
            canceled,
        )?;
        file.close();
        Ok(ImportResult {
            document_id: doc.id,
            table_id: table.id,
            path: path.clone(),
            rows_total: data.len(),
            rows_created: created,
            rows_updated: updated,
            rows_skipped: skipped,
            fields_created: fields.len(),
            fields_updated: 0,
            warnings: Vec::new(),
        })
    })();
    if outcome.is_err() {
        cleanup();
    }
    outcome
}

/// The default table shape every new document starts with.
fn is_default_schema(fields: &[Field]) -> bool {
    fields.len() == 3
        && fields[0].title == "Title"
        && fields[0].field_type == "text"
        && fields[1].title == "Status"
        && fields[1].field_type == "single_select"
        && fields[2].title == "Notes"
        && fields[2].field_type == "long_text"
}

/// Adapts the target table's schema. Returns (created, updated, replaced).
fn prepare_schema(
    file: &mut KitableFile,
    existing: &[Field],
    table_id: i64,
    fields: &[ImportField],
    schema_mode: &str,
) -> kition_kitable::Result<(usize, usize, bool)> {
    let replaced =
        schema_mode == "replace" || (schema_mode == "auto" && is_default_schema(existing));
    let (mut created, mut updated) = (0, 0);
    let options = |f: &ImportField| f.options.clone().map_or(Value::Null, Value::Object);
    if replaced {
        for (current, field) in existing.iter().zip(fields) {
            file.update_field(
                table_id,
                current.id,
                &FieldPatch {
                    title: Some(field.title.clone()),
                    field_type: Some(field.field_type.clone()),
                    options: Some(options(field)),
                    ..FieldPatch::default()
                },
            )?;
            updated += 1;
        }
        for (index, field) in fields.iter().enumerate().skip(existing.len()) {
            file.create_field(
                table_id,
                &FieldSpec {
                    title: field.title.clone(),
                    field_type: field.field_type.clone(),
                    options: options(field),
                    order: Some(i64::try_from(index + 1).unwrap_or(i64::MAX)),
                    ..FieldSpec::default()
                },
            )?;
            created += 1;
        }
        for current in existing.iter().skip(fields.len()) {
            if !current.is_primary {
                file.delete_field(table_id, current.id)?;
            }
        }
        return Ok((created, updated, true));
    }
    let titles: HashSet<String> = existing.iter().map(|f| f.title.to_lowercase()).collect();
    for field in fields {
        if titles.contains(&field.title.to_lowercase()) {
            continue;
        }
        file.create_field(
            table_id,
            &FieldSpec {
                title: field.title.clone(),
                field_type: field.field_type.clone(),
                options: options(field),
                ..FieldSpec::default()
            },
        )?;
        created += 1;
    }
    Ok((created, updated, false))
}

/// Text form used for upsert keys, like the legacy `%v` formatting.
fn key_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "<nil>".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) => n
            .as_f64()
            .map(format_float)
            .unwrap_or_else(|| n.to_string()),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Array(items)) => format!(
            "[{}]",
            items
                .iter()
                .map(|v| key_text(Some(v)))
                .collect::<Vec<_>>()
                .join(" ")
        ),
        Some(other) => other.to_string(),
    }
}

fn values_key(fields: &[Field], values: &Map<String, Value>, unique_by: &[String]) -> String {
    let mut names: HashMap<String, String> = HashMap::new();
    for field in fields {
        names.insert(field.title.to_lowercase(), field.name.clone());
        names.insert(field.name.to_lowercase(), field.name.clone());
    }
    let mut parts = Vec::with_capacity(unique_by.len());
    for title in unique_by {
        let Some(name) = names.get(&title.trim().to_lowercase()) else {
            return String::new();
        };
        let value = key_text(values.get(name)).trim().to_owned();
        if value.is_empty() || value == "<nil>" {
            return String::new();
        }
        parts.push(value);
    }
    parts.join("\u{1f}")
}

/// Rows written per transaction by an import.
const IMPORT_BATCH: usize = 500;

#[allow(clippy::too_many_arguments)]
fn write_rows(
    file: &mut KitableFile,
    table_id: i64,
    fields: &[Field],
    source_fields: &[ImportField],
    rows: &[Vec<String>],
    request: &ExecuteRequest,
    progress: &dyn Fn(&str, usize),
    canceled: &AtomicBool,
) -> Result<(usize, usize, usize), String> {
    let map_err = |e: kition_kitable::KitableError| e.to_string();
    if request.write_mode == "replace" {
        let keys: Vec<String> = file
            .list_records(table_id)
            .map_err(map_err)?
            .into_iter()
            .map(|record| record.row_key)
            .collect();
        file.bulk_delete_records(table_id, &keys).map_err(map_err)?;
    }
    let mut existing: HashMap<String, Record> = HashMap::new();
    if !request.unique_by.is_empty() {
        for record in file.list_records(table_id).map_err(map_err)? {
            let key = values_key(fields, &record.values, &request.unique_by);
            if !key.is_empty() {
                existing.insert(key, record);
            }
        }
    }
    let by_title: HashMap<String, &Field> = fields
        .iter()
        .map(|f| (f.title.trim().to_lowercase(), f))
        .collect();
    let (mut created, mut updated, mut skipped) = (0, 0, 0);
    // New records are written in batches: one transaction each, not one per row.
    let mut pending: Vec<Map<String, Value>> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        if canceled.load(Ordering::SeqCst) {
            return Err("context canceled".into());
        }
        let mut values = Map::new();
        for (column, source) in source_fields.iter().enumerate() {
            if let (Some(field), Some(cell)) = (
                by_title.get(&source.title.trim().to_lowercase()),
                row.get(column),
            ) && !cell.is_empty()
            {
                values.insert(
                    field.name.clone(),
                    import_parse::coerce_value(cell, &field.field_type),
                );
            }
        }
        if request.write_mode == "upsert" {
            let key = values_key(fields, &values, &request.unique_by);
            if key.is_empty() {
                skipped += 1;
                continue;
            }
            if let Some(record) = existing.get(&key) {
                let mut merged = record.values.clone();
                merged.extend(values);
                file.update_record(table_id, record.id, &merged, None)
                    .map_err(map_err)?;
                updated += 1;
                continue;
            }
        }
        pending.push(values);
        created += 1;
        if pending.len() >= IMPORT_BATCH {
            file.create_records(table_id, &pending).map_err(map_err)?;
            pending.clear();
        }
        if index % 100 == 0 || index + 1 == rows.len() {
            progress("writing_records", index + 1);
        }
    }
    if !pending.is_empty() {
        file.create_records(table_id, &pending).map_err(map_err)?;
    }
    Ok((created, updated, skipped))
}

impl DataDocState {
    /// Creates a `.kitable` document with the given tables and its index row.
    pub(crate) fn create_document(
        &self,
        user_id: i64,
        title: &str,
        path: &str,
        seeds: &[TableSeed],
    ) -> AppResult<index::DataDocument> {
        let absolute = resolve_from_root(&self.workspace_root_string(), path)?;
        self.prepare_kitable_target(&absolute)?;
        let mut meta = Map::new();
        meta.insert(
            "storage".into(),
            Value::String(index::STORAGE_KITABLE_FILE.into()),
        );
        meta.insert(
            "file_format".into(),
            Value::String(kition_kitable::FORMAT.into()),
        );
        let conn = self.db.conn()?;
        let doc = index::insert(
            &conn,
            index::NewDocument {
                user_id,
                workspace_root: self.workspace_root_string(),
                path: path.to_owned(),
                title: title.to_owned(),
                description: String::new(),
                icon: String::new(),
                color: String::new(),
                meta: meta.clone(),
            },
        )?;
        let created = KitableFile::create(
            &absolute,
            &kition_kitable::CreateOptions {
                title: title.to_owned(),
                document_id: format!("data-doc-{}", doc.id),
                meta_json: Value::Object(meta).to_string(),
                ..kition_kitable::CreateOptions::default()
            },
        );
        let mut file = match created {
            Ok(file) => file,
            Err(err) => {
                let _ = index::soft_delete(&conn, doc.id);
                return Err(AppError::unhandled(err));
            }
        };
        for seed in seeds {
            if let Err(err) = file.create_table(&crate::tables::seed_to_spec(seed)) {
                let _ = index::soft_delete(&conn, doc.id);
                drop(file);
                let _ = std::fs::remove_file(&absolute);
                return Err(AppError::unhandled(err));
            }
        }
        file.close();
        Ok(doc)
    }
}
