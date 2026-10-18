//! A `.kitable` file's KDM replica for co-editing (`contracts/runtime/data-documents-replica.schema.json`):
//! the window's relay asks for the replica's version, exports the changes a sync room lacks,
//! and imports the changes others made. Documents are named by their workspace-relative path,
//! like the other by-path routes, and open through the shared [`crate::TableDocuments`] handle.
//! Bytes travel as standard base64 in the JSON bodies.
//!
//! Attachments the file holds as blobs travel beside the changes in a blob section
//! (`kition_kitable::blobs`): an export answers the blobs its changes name, an import (and a
//! `create`) stores the blobs it is given before the changes, so an imported attachment is
//! never without its bytes.
//!
//! An import has an `import` origin: it is no undo step, so a person's undo never reverts a
//! co-editor's edit. It is stored and projected in one SQL transaction like any write, then
//! published as `table/changed` so open editors refresh. Every local transaction is reported as
//! `table/replica-changed` by the shared handle itself (see [`DataDocState::publish_replica_changes`]).
//!
//! `create` makes a new file from another copy's full export (opening a shared table): the same
//! KDM document, projected, indexed, with no undo steps.

use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use base64::Engine as _;
use kition_core::events::DomainEvent;
use kition_core::{AppError, AppResult};
use kition_http::{CurrentUser, JsonBody, ok};
use kition_kdm::{Origin, OriginKind, Version};
use kition_kitable::{KitableError, KitableFile, TableChange, blobs};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::DataDocState;
use crate::index::DataDocument;
use crate::source::{default_document_path, resolve_from_root};
use crate::table_documents::{
    change_json, default_origin, encode_bytes, replica_changed_event, table_changed_event,
};

pub fn routes() -> Router<DataDocState> {
    Router::new()
        .route("/data-documents/replica/version", post(version))
        .route("/data-documents/replica/export", post(export))
        .route("/data-documents/replica/import", post(import))
        .route("/data-documents/replica/create", post(create))
}

#[derive(Debug, Default, Deserialize)]
struct ReplicaRequest {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    workspace_root: Option<String>,
    /// `export`: the version the caller has (base64); blank exports every change.
    #[serde(default)]
    since: Option<String>,
    /// `import`: the changes to import; `create`: the full export to create from (base64).
    #[serde(default)]
    changes: Option<String>,
    /// `import` and `create`: a blob section (base64) of the blobs the changes need.
    #[serde(default)]
    blobs: Option<String>,
}

fn decode(value: Option<&str>, what: &str) -> AppResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(value.unwrap_or_default().trim())
        .map_err(|_| AppError::bad_request(format!("{what} must be base64")))
}

/// A read-only file answers 409 like the transact routes; anything else the replica refused
/// (bytes that are not a KDM export, changes of another document) is the request's fault.
fn refused(err: KitableError) -> AppError {
    match err {
        KitableError::ReadOnly(reason) => AppError::conflict(reason),
        other => AppError::bad_request(other.to_string()),
    }
}

/// The `import` origin of relayed changes, as `table/changed` renders it (`import:sync`).
fn import_origin() -> Origin {
    Origin::new(
        OriginKind::Import,
        kition_kitable::kdm::commit::IMPORT_PRINCIPAL,
    )
}

fn identity(doc: &DataDocument, doc_id: &kition_kdm::DocId, version: &Version) -> Value {
    json!({
        "documentId": doc.id.to_string(),
        "documentPath": doc.path,
        "docId": doc_id.to_string(),
        "version": encode_bytes(&version.encode()),
    })
}

async fn version(
    State(state): State<DataDocState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<ReplicaRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.document_by_path(
                user_id,
                request.path.as_deref().unwrap_or_default(),
                request.workspace_root.as_deref().unwrap_or_default(),
            )?;
            let file = state.open_document_as(&doc, default_origin())?;
            Ok(identity(
                &doc,
                &file.replica().doc_id(),
                &file.replica_version(),
            ))
        })
        .await?;
    Ok(ok(body))
}

async fn export(
    State(state): State<DataDocState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<ReplicaRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let since = decode(request.since.as_deref(), "since")?;
            let since = if since.is_empty() {
                Version::empty()
            } else {
                Version::decode(&since)
                    .map_err(|_| AppError::bad_request("since is not a replica version"))?
            };
            let doc = state.document_by_path(
                user_id,
                request.path.as_deref().unwrap_or_default(),
                request.workspace_root.as_deref().unwrap_or_default(),
            )?;
            let file = state.open_document_as(&doc, default_origin())?;
            let changes = file.export_replica_changes(&since).map_err(refused)?;
            let blobs = file
                .blobs_for_changes(&changes)
                .map_err(AppError::unhandled)?;
            let mut body = identity(&doc, &file.replica().doc_id(), &file.replica_version());
            body["changes"] = Value::from(encode_bytes(&changes));
            body["blobs"] = Value::from(encode_bytes(&blobs));
            Ok(body)
        })
        .await?;
    Ok(ok(body))
}

async fn import(
    State(state): State<DataDocState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<ReplicaRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let origin = import_origin();
    let event_origin = origin.clone();
    let (doc, change, mut body) = state
        .blocking(move |state| {
            let changes = decode(request.changes.as_deref(), "changes")?;
            if changes.is_empty() {
                return Err(AppError::bad_request("changes must not be empty"));
            }
            let blobs = decode(request.blobs.as_deref(), "blobs")?;
            let doc = state.document_by_path(
                user_id,
                request.path.as_deref().unwrap_or_default(),
                request.workspace_root.as_deref().unwrap_or_default(),
            )?;
            let mut file = state.open_document_as(&doc, origin)?;
            file.add_blob_section(&blobs).map_err(refused)?;
            let imported = file.import_replica_changes(&changes).map_err(refused)?;
            if imported.repaired {
                // The repair wrote changes of this replica's own: the room must get them.
                file.report_replica_change();
            }
            let body = identity(&doc, &file.replica().doc_id(), &file.replica_version());
            Ok((doc, imported.change, body))
        })
        .await?;
    if change != TableChange::default() {
        state
            .events
            .publish(DomainEvent::TableChanged(table_changed_event(
                &doc.id.to_string(),
                &event_origin,
                &doc.path,
                &change,
            )));
    }
    body["change"] = change_json(&doc.id.to_string(), &event_origin, &change);
    Ok(ok(body))
}

async fn create(
    State(state): State<DataDocState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<ReplicaRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let changes = decode(request.changes.as_deref(), "changes")?;
            if changes.is_empty() {
                return Err(AppError::bad_request("changes must not be empty"));
            }
            let blobs = decode(request.blobs.as_deref(), "blobs")?;
            // Checked before anything touches the disk, like the changes.
            let entries = blobs::decode_blob_section(&blobs).map_err(refused)?;
            if entries
                .iter()
                .any(|(hash, bytes)| blobs::blob_hash(bytes) != *hash)
            {
                return Err(AppError::bad_request("a blob holds bytes of another hash"));
            }
            let raw_path = request.path.unwrap_or_default();
            if raw_path.trim().is_empty() {
                return Err(AppError::bad_request("Data document path cannot be empty"));
            }
            let request_root = request.workspace_root.unwrap_or_default();
            let root = state.request_workspace_root(&request_root);
            let path = default_document_path(&raw_path, "");
            let absolute = resolve_from_root(&root, &path)?;
            match KitableFile::create_from_replica(&absolute, &changes) {
                Ok(mut file) => {
                    if let Err(err) = file.add_blob_section(&blobs) {
                        tracing::warn!(error = %err, "a shared table's blobs could not be stored");
                    }
                    file.close();
                }
                Err(KitableError::Exists) => {
                    return Err(AppError::conflict("A file already exists at this path"));
                }
                Err(KitableError::Kdm(message)) => return Err(AppError::bad_request(message)),
                Err(err) => return Err(AppError::unhandled(err)),
            }
            state.tables.forget(&absolute);
            let doc = state.document_by_path(user_id, &path, &request_root)?;
            let file = state.open_document_as(&doc, default_origin())?;
            Ok(identity(
                &doc,
                &file.replica().doc_id(),
                &file.replica_version(),
            ))
        })
        .await?;
    Ok(ok(body))
}

impl DataDocState {
    /// Publishes every local transaction's new replica version (see
    /// [`crate::TableDocuments::on_replica_changed`]) as a `table/replica-changed` event on this
    /// state's event bus, which `kition-kits` forwards to the kit bridge stream. Call once when
    /// the runtime starts; a later call replaces the listener.
    pub fn publish_replica_changes(&self) {
        let events = self.events.clone();
        let workspace_dir = self.workspace_dir.clone();
        self.tables.on_replica_changed(move |change| {
            events.publish(DomainEvent::TableReplicaChanged(replica_changed_event(
                &workspace_dir,
                change,
            )));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_parse_with_or_without_the_optional_fields() {
        let request: ReplicaRequest =
            serde_json::from_value(json!({ "path": "a.kitable" })).unwrap_or_default();
        assert_eq!(request.path.as_deref(), Some("a.kitable"));
        assert_eq!(request.since, None);
        assert_eq!(decode(None, "since").unwrap_or_default(), Vec::<u8>::new());
        assert_eq!(
            decode(Some("AQI="), "changes").unwrap_or_default(),
            vec![1, 2]
        );
        assert!(decode(Some("not base64!"), "changes").is_err());
    }

    #[test]
    fn imports_render_as_an_import_origin() {
        assert_eq!(
            kition_table_api::respond::render_origin(&import_origin()),
            "import:sync"
        );
    }
}
