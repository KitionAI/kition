//! Document handlers: list, create, read, update, delete, and by-path
//! operations driven by the desktop file tree.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use axum::Router;
use axum::extract::{Path as UrlPath, Query, State};
use axum::response::Response;
use axum::routing::{get, post};
use kition_core::coerce::as_str;
use kition_core::{AppError, AppResult};
use kition_http::{CurrentUser, JsonBody, ok};
use kition_kitable::{FORMAT, KitableFile};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::index::{self, DataDocument, NewDocument, STORAGE_KITABLE_FILE};
use crate::source::{default_document_path, resolve_from_root};
use crate::tables::{TableSeed, default_table_seed, seed_to_spec};
use crate::{DataDocState, WorkflowCleaner};

pub fn routes() -> Router<DataDocState> {
    Router::new()
        .route("/data-documents", get(list).post(create))
        .route("/data-documents/ai/infer-schema", post(infer_schema))
        .route("/data-documents/open", post(open_by_path))
        .route("/data-documents/delete-by-path", post(delete_by_path))
        .route("/data-documents/rename-by-path", post(rename_by_path))
        .route(
            "/data-documents/{documentId}",
            get(detail).patch(update).delete(delete),
        )
}

const FS_LISTING_MAX_DEPTH: usize = 12;
const FS_LISTING_MAX_FILES: usize = 5000;

/// Workspace-relative `.kitable` paths under `root`, skipping hidden and
/// dependency folders and symlinks, bounded in depth and count.
fn scan_workspace_kitables(root: &str) -> Option<Vec<String>> {
    let root_path = Path::new(root);
    if !root_path.is_absolute() || !root_path.is_dir() {
        return None;
    }
    let mut found = Vec::new();
    let mut stack = vec![(root_path.to_path_buf(), 0_usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        let mut subdirs = Vec::new();
        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_dir() {
                if name.starts_with('.')
                    || name == "node_modules"
                    || depth + 1 > FS_LISTING_MAX_DEPTH
                {
                    continue;
                }
                subdirs.push((entry.path(), depth + 1));
            } else if !file_type.is_symlink()
                && !name.starts_with('.')
                && Path::new(&name)
                    .extension()
                    .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("kitable"))
                && let Ok(relative) = entry.path().strip_prefix(root_path)
            {
                found.push(relative.to_string_lossy().replace('\\', "/"));
                if found.len() >= FS_LISTING_MAX_FILES {
                    return Some(found);
                }
            }
        }
        subdirs.reverse();
        stack.extend(subdirs);
    }
    Some(found)
}

impl DataDocState {
    /// Indexes unseen `.kitable` files under `root` and returns the set of
    /// paths present on disk, or `None` when `root` cannot be scanned.
    fn reconcile_workspace_index(&self, user_id: i64, root: &str) -> Option<HashSet<String>> {
        let paths = scan_workspace_kitables(root)?;
        let present: HashSet<String> = paths.iter().cloned().collect();
        let Ok(conn) = self.db.conn() else {
            return Some(present);
        };
        let Ok(indexed) = index::indexed_paths(&conn, user_id, root) else {
            return Some(present);
        };
        drop(conn);
        let known: HashSet<String> = indexed.into_iter().map(|p| p.replace('\\', "/")).collect();
        for path in paths.iter().filter(|p| !known.contains(*p)) {
            // Unreadable or foreign files stay unindexed; the next listing retries them.
            let _ = self.index_kitable_from_root(user_id, root, root, path);
        }
        Some(present)
    }

    /// Creates the index row for an existing `.kitable` file under `root`.
    /// The caller's document at the workspace-relative `raw_path` under `request_root` (the
    /// runtime's workspace when blank), indexed from its file first if it is not yet.
    pub(crate) fn document_by_path(
        &self,
        user_id: i64,
        raw_path: &str,
        request_root: &str,
    ) -> AppResult<DataDocument> {
        let path = default_document_path(raw_path, "");
        if raw_path.trim().is_empty() {
            return Err(AppError::bad_request("Data document path cannot be empty"));
        }
        let root = self.request_workspace_root(request_root);
        let conn = self.db.conn()?;
        let found = index::find_by_path(&conn, user_id, &root, &path)
            .map_err(|_| AppError::internal("Failed to query data document"))?;
        drop(conn);
        match found {
            Some(doc) => Ok(doc),
            None => self.index_kitable_from_root(user_id, request_root, &root, &path),
        }
    }

    fn index_kitable_from_root(
        &self,
        user_id: i64,
        request_root: &str,
        root: &str,
        path: &str,
    ) -> AppResult<DataDocument> {
        let absolute = resolve_from_root(root, path)?;
        let invalid =
            || AppError::not_found("Data document does not exist or has an invalid format");
        match std::fs::metadata(&absolute) {
            Err(_) => return Err(AppError::not_found("Data document does not exist")),
            Ok(meta) if meta.is_dir() || meta.len() == 0 => return Err(invalid()),
            Ok(_) => {}
        }
        let file = KitableFile::open(&absolute).map_err(|_| invalid())?;
        let info = file
            .info()
            .map_err(|_| AppError::internal("Failed to read data-document file"));
        file.close();
        let info = info?;
        if info.document_id.trim().is_empty() {
            return Err(AppError::bad_request(
                "Data-document file is missing document metadata",
            ));
        }
        let title = match info.title.trim() {
            "" => Path::new(path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            title => title.to_owned(),
        };
        let meta = json!({
            "storage": STORAGE_KITABLE_FILE,
            "file_format": FORMAT,
            "file_document_id": info.document_id,
            "file_format_version": info.format_version,
            "file_schema_version": info.schema_version,
            "indexed_from_kitable": true,
        });
        let workspace_root = match request_root.trim() {
            "" => self.workspace_root_string(),
            root => root.to_owned(),
        };
        let conn = self.db.conn()?;
        index::insert(
            &conn,
            NewDocument {
                user_id,
                workspace_root,
                path: path.to_owned(),
                title,
                description: String::new(),
                icon: String::new(),
                color: String::new(),
                meta: meta.as_object().cloned().unwrap_or_default(),
            },
        )
        .map_err(|_| AppError::internal("Failed to create data-document index"))
    }

    /// Clears the way for a new file: removes empty files and legacy JSON
    /// markers, refuses folders, existing documents, and other files.
    pub(crate) fn prepare_kitable_target(&self, absolute: &Path) -> AppResult<()> {
        if let Some(parent) = absolute.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let meta = match std::fs::metadata(absolute) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.into()),
            Ok(meta) => meta,
        };
        if meta.is_dir() {
            return Err(AppError::bad_request(
                "Data document path is already used by a folder",
            ));
        }
        if meta.len() == 0 {
            std::fs::remove_file(absolute)?;
            return Ok(());
        }
        if let Ok(existing) = KitableFile::open(absolute) {
            existing.close();
            return Err(AppError::bad_request("Data document file already exists"));
        }
        if meta.len() > 64 * 1024 {
            return Err(AppError::bad_request(
                "Data document path is already used by another file",
            ));
        }
        let content = std::fs::read(absolute)?;
        let is_marker = serde_json::from_slice::<Value>(&content)
            .ok()
            .is_some_and(|v| {
                v.get("format").and_then(Value::as_str) == Some("kition-data-document")
            });
        if String::from_utf8_lossy(&content).trim().is_empty() || is_marker {
            std::fs::remove_file(absolute)?;
            return Ok(());
        }
        Err(AppError::bad_request(
            "Data document path is already used by another file",
        ))
    }
}

async fn list(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Response> {
    let user_id = user.id;
    let workspace = query
        .get("workspace_root")
        .map(|v| v.trim().to_owned())
        .unwrap_or_default();
    let search = query.get("query").cloned().unwrap_or_default();
    let items = state
        .blocking(move |state| {
            let present = if workspace.is_empty() {
                None
            } else {
                state.reconcile_workspace_index(user_id, &workspace)
            };
            let conn = state.db.conn()?;
            let docs = index::list(
                &conn,
                &index::ListQuery {
                    user_id,
                    workspace_root: &workspace,
                    search: &search,
                },
            )
            .map_err(|_| AppError::internal("Failed to query data document"))?;
            drop(conn);
            Ok(docs
                .iter()
                .filter(|doc| {
                    present.as_ref().is_none_or(|present| {
                        !doc.is_file_backed() || present.contains(&doc.path.replace('\\', "/"))
                    })
                })
                .map(|doc| state.document_response(doc, true))
                .collect::<Vec<_>>())
        })
        .await?;
    let total = items.len();
    Ok(ok(json!({ "items": items, "total": total })))
}

#[derive(Debug, Default, Deserialize)]
struct CreateDocumentRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    workspace_root: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    meta: Value,
    #[serde(default)]
    tables: Option<Vec<TableSeed>>,
}

async fn create(
    State(state): State<DataDocState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<CreateDocumentRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let response = state
        .blocking(move |state| {
            let title = match request.title.as_deref().unwrap_or_default().trim() {
                "" => "Untitled data document".to_owned(),
                title => title.to_owned(),
            };
            let path = default_document_path(request.path.as_deref().unwrap_or_default(), &title);
            let meta: Map<String, Value> = match &request.meta {
                Value::Object(map) => map.clone(),
                Value::Null => Map::new(),
                other => serde_json::from_value(other.clone()).unwrap_or_default(),
            };
            let text =
                |value: &Option<String>| value.as_deref().unwrap_or_default().trim().to_owned();
            let seeds = request
                .tables
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| vec![default_table_seed("Table")]);
            let specs: Vec<_> = seeds.iter().map(seed_to_spec).collect();
            let (doc, _) = state.create_kitable_document(
                NewDocument {
                    user_id,
                    workspace_root: text(&request.workspace_root),
                    path,
                    title,
                    description: text(&request.description),
                    icon: text(&request.icon),
                    color: text(&request.color),
                    meta,
                },
                &specs,
            )?;
            Ok(state.document_response(&doc, true))
        })
        .await?;
    Ok(ok(response))
}

async fn detail(
    State(state): State<DataDocState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
) -> AppResult<Response> {
    let user_id = user.id;
    let response = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &id)?;
            Ok(state.document_response(&doc, true))
        })
        .await?;
    Ok(ok(response))
}

async fn update(
    State(state): State<DataDocState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    let user_id = user.id;
    let response = state
        .blocking(move |state| {
            let mut doc = state.load_document(user_id, &id)?;
            let request: Map<String, Value> = kition_http::decode_object(&body)?;
            let title = as_str(request.get("title").unwrap_or(&Value::Null))
                .trim()
                .to_owned();
            if !title.is_empty() {
                doc.title = title;
            }
            let text = |key: &str| request.get(key).map(|v| as_str(v).to_owned());
            if let Some(value) = text("description") {
                doc.description = value;
            }
            if let Some(value) = text("workspace_root") {
                doc.workspace_root = value;
            }
            if let Some(value) = text("path") {
                doc.path = default_document_path(&value, &doc.title);
            }
            if let Some(value) = text("icon") {
                doc.icon = value;
            }
            if let Some(value) = text("color") {
                doc.color = value;
            }
            if let Some(meta) = request.get("meta") {
                doc.meta = meta.clone();
            }
            let conn = state.db.conn()?;
            index::save(&conn, &mut doc)
                .map_err(|_| AppError::internal("Failed to update data document"))?;
            drop(conn);
            Ok(state.document_response(&doc, true))
        })
        .await?;
    Ok(ok(response))
}

async fn delete(
    State(state): State<DataDocState>,
    user: CurrentUser,
    UrlPath(id): UrlPath<String>,
) -> AppResult<Response> {
    let user_id = user.id;
    state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &id)?;
            let conn = state.db.conn()?;
            index::soft_delete(&conn, doc.id)
                .map_err(|_| AppError::internal("Failed to delete data document"))
        })
        .await?;
    Ok(ok(json!({ "message": "Data document deleted" })))
}

#[derive(Debug, Default, Deserialize)]
struct PathRequest {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    target_path: Option<String>,
    #[serde(default)]
    workspace_root: Option<String>,
}

async fn open_by_path(
    State(state): State<DataDocState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<PathRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let response = state
        .blocking(move |state| {
            let doc = state.document_by_path(
                user_id,
                &request.path.unwrap_or_default(),
                &request.workspace_root.unwrap_or_default(),
            )?;
            Ok(state.document_response(&doc, true))
        })
        .await?;
    Ok(ok(response))
}

async fn delete_by_path(
    State(state): State<DataDocState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<PathRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let response = state
        .blocking(move |state| {
            let raw_path = request.path.unwrap_or_default();
            if raw_path.trim().is_empty() {
                return Err(AppError::bad_request("Data document path cannot be empty"));
            }
            let path = default_document_path(&raw_path, "");
            let root = state.request_workspace_root(&request.workspace_root.unwrap_or_default());
            let conn = state.db.conn()?;
            let docs = index::list_by_path(&conn, user_id, &root, &path)
                .map_err(|_| AppError::internal("Failed to query data document"))?;
            if docs.is_empty() {
                return Ok(json!({ "deleted": false, "workflows_removed": 0 }));
            }
            let mut removed = 0;
            for doc in docs {
                index::soft_delete(&conn, doc.id)
                    .map_err(|_| AppError::internal("Failed to delete data document"))?;
                if let Some(cleaner) = &state.workflow_cleaner {
                    removed += WorkflowCleaner::delete_by_document_id(
                        cleaner.as_ref(),
                        &doc.id.to_string(),
                    )
                    .map_err(|_| {
                        AppError::internal("Failed to clean workflows for data document")
                    })?;
                }
            }
            Ok(json!({ "deleted": true, "workflows_removed": removed }))
        })
        .await?;
    Ok(ok(response))
}

async fn rename_by_path(
    State(state): State<DataDocState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<PathRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let response = state
        .blocking(move |state| {
            let raw_path = request.path.unwrap_or_default();
            let raw_target = request.target_path.unwrap_or_default();
            if raw_path.trim().is_empty() || raw_target.trim().is_empty() {
                return Err(AppError::bad_request("Data document path cannot be empty"));
            }
            let path = default_document_path(&raw_path, "");
            let target = default_document_path(&raw_target, "");
            if path == target {
                return Ok(json!({ "renamed": false, "count": 0 }));
            }
            let root = state.request_workspace_root(&request.workspace_root.unwrap_or_default());
            let conn = state.db.conn()?;
            let count = index::rename_path(&conn, user_id, &root, &path, &target)
                .map_err(|_| AppError::internal("Failed to rename data document"))?;
            Ok(if count == 0 {
                json!({ "renamed": false, "count": 0 })
            } else {
                json!({ "renamed": true, "count": count })
            })
        })
        .await?;
    Ok(ok(response))
}

#[derive(Debug, Default, Deserialize)]
struct InferSchemaRequest {
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

/// A starter schema derived from the prompt; deterministic, no model call.
async fn infer_schema(
    State(state): State<DataDocState>,
    _user: CurrentUser,
    JsonBody(request): JsonBody<InferSchemaRequest>,
) -> AppResult<Response> {
    state.require_ai()?;
    let title = match request.title.as_deref().unwrap_or_default().trim() {
        "" => {
            let prompt = request.prompt.as_deref().unwrap_or_default().trim();
            if prompt.is_empty() {
                "AI Table".to_owned()
            } else {
                prompt.chars().take(18).collect()
            }
        }
        title => title.to_owned(),
    };
    let field = |title: &str, field_type: &str, primary: bool, options: Value| {
        json!({ "title": title, "name": "", "type": field_type, "primary": primary, "required": false,
                "readonly": false, "options": options, "formula": "", "ai_prompt": "" })
    };
    let view = |title: &str, view_type: &str, config: Value| json!({ "title": title, "type": view_type, "config": config });
    Ok(ok(json!({
        "title": title,
        "tables": [{
            "title": title,
            "name": "",
            "description": "",
            "fields": [
                field("Title", "text", true, Value::Null),
                field("Status", "single_select", false, json!({"choices": ["To Triage", "In Progress", "Done"]})),
                field("Date", "date", false, Value::Null),
                field("Tags", "multi_select", false, Value::Null),
                field("Notes", "long_text", false, Value::Null),
            ],
            "views": [
                view("All", "grid", Value::Null),
                view("By status", "kanban", json!({"group_field": "status"})),
                view("Calendar", "calendar", json!({"start_field": "date"})),
            ],
        }],
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_kitables_skipping_hidden_and_dependencies() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = dir.path();
        for path in [
            "a.kitable",
            "sub/b.KITABLE",
            ".hidden/c.kitable",
            "node_modules/d.kitable",
            "sub/.e.kitable",
            "f.md",
        ] {
            let full = root.join(path);
            std::fs::create_dir_all(full.parent().unwrap_or(root))
                .unwrap_or_else(|err| panic!("{err}"));
            std::fs::write(full, b"x").unwrap_or_else(|err| panic!("{err}"));
        }
        let mut found = scan_workspace_kitables(&root.to_string_lossy()).unwrap_or_default();
        found.sort();
        assert_eq!(found, ["a.kitable", "sub/b.KITABLE"]);
        assert!(scan_workspace_kitables("relative/path").is_none());
    }
}
