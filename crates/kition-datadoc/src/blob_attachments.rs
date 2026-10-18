//! Attachments as blobs of their `.kitable` file (`kition_kitable::blobs`), on the runtime's side.
//!
//! **Uploads** are stored in the file (`attachments.put`), not in the workspace, so the file
//! carries its attachments wherever it goes: into an embedded Table kit, or to a co-editor.
//!
//! **Path attachments** (values whose `url` names a workspace file), which every file made before
//! blobs holds, keep showing as they are. When Kition writes such a value again (a person edits
//! the cell, an AI field fills it) and it names one of the workspace's content-addressed assets,
//! the asset's bytes are stored as a blob and the value names the blob instead
//! ([`DataDocState::import_path_attachments`]). A value whose file cannot be read, or that names
//! any other file, stays exactly as it was, and the workspace file itself is never touched, so
//! nothing an older value names is ever lost (undo can bring an older value back).
//!
//! **Readers** that need the bytes (AI fields reading images) get blob attachments as `data:`
//! URLs ([`inline_blob_images`]); the renderer loads them from `GET .../blobs/{hash}`.

use std::collections::HashMap;

use base64::Engine as _;
use kition_kitable::blobs::{self, attachment_value, blob_hash_of_url};
use kition_kitable::{KitableFile, TableOp};
use serde_json::{Map, Value};

use crate::DataDocState;

/// Where the workspace keeps content-addressed assets.
const ASSET_PREFIX: &str = ".kition/assets/sha256/";

/// URLs that need no workspace file: remote, inline, browser-local, bundled with the app, or a
/// blob already.
fn is_self_contained(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    [
        "http://",
        "https://",
        "data:",
        "blob:",
        "kition-blob:",
        "kition-bundled:",
        "file:",
    ]
    .iter()
    .any(|scheme| lower.starts_with(scheme))
}

fn text<'a>(item: &'a Map<String, Value>, keys: &[&str]) -> &'a str {
    keys.iter()
        .find_map(|key| {
            item.get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
        .unwrap_or_default()
}

impl DataDocState {
    /// The bytes of the workspace asset a path attachment names: a content-addressed file
    /// under `.kition/assets/sha256/` (where uploads and generated images went) whose bytes hash
    /// to the digest its name carries. Only such files are read: a value a co-editor wrote that
    /// names any other workspace file stays a path, so editing a cell never copies a private
    /// file into a shared document.
    fn asset_bytes(&self, item: &Map<String, Value>) -> Option<Vec<u8>> {
        let url = text(item, &["url"]);
        let relative = match url.strip_prefix("/workspace-files/") {
            Some(relative) => relative,
            None if url.is_empty() || !is_self_contained(url) => text(item, &["workspacePath"]),
            None => return None,
        };
        let relative = relative.replace('\\', "/");
        let digest = relative
            .strip_prefix(ASSET_PREFIX)?
            .rsplit('/')
            .next()?
            .split('.')
            .next()
            .filter(|digest| blobs::is_blob_hash(digest))?
            .to_owned();
        let path = self.assets.resolve_workspace_path(&relative).ok()?;
        let meta = std::fs::metadata(&path).ok()?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > blobs::MAX_BLOB_BYTES as u64 {
            return None;
        }
        let bytes = std::fs::read(&path).ok()?;
        (blobs::blob_hash(&bytes) == digest).then_some(bytes)
    }

    /// One attachment value, as a blob of `file` when it is a path attachment whose bytes can be
    /// read; `None` leaves it as it is.
    fn import_path_attachment(
        &self,
        file: &mut KitableFile,
        item: &Map<String, Value>,
    ) -> Option<Value> {
        if blob_hash_of_url(text(item, &["url"])).is_some() {
            return None;
        }
        let bytes = self.asset_bytes(item)?;
        let mime = text(item, &["mimeType", "mime_type", "type"]);
        let name = match text(item, &["name", "filename", "file_name"]) {
            "" => text(item, &["url"])
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_owned(),
            name => name.to_owned(),
        };
        let info = match file.put_blob(&bytes, mime, &name) {
            Ok(info) => info,
            Err(err) => {
                tracing::debug!(error = %err, "a path attachment stays a path: its bytes could not be stored");
                return None;
            }
        };
        // The item's own keys are kept; what named the workspace file goes.
        let mut value = item.clone();
        value.remove("workspacePath");
        value.remove("assetId");
        value.remove("src");
        value.remove("href");
        if let Value::Object(blob) = attachment_value(&info, &name) {
            value.extend(blob);
        }
        Some(Value::Object(value))
    }

    /// An attachment cell's value with its path attachments stored as blobs of `file`; `None`
    /// when nothing changed.
    fn import_path_attachments_in(&self, file: &mut KitableFile, value: &Value) -> Option<Value> {
        match value {
            Value::Array(items) => {
                let mut changed = false;
                let next: Vec<Value> = items
                    .iter()
                    .map(|item| match item {
                        Value::Object(map) => match self.import_path_attachment(file, map) {
                            Some(blob) => {
                                changed = true;
                                blob
                            }
                            None => item.clone(),
                        },
                        other => other.clone(),
                    })
                    .collect();
                changed.then_some(Value::Array(next))
            }
            Value::Object(map) => self.import_path_attachment(file, map),
            _ => None,
        }
    }

    /// Stores the path attachments among `values` (cell values by field name, of the table
    /// `table_id`) as blobs of `file`, rewriting their values to name the blobs. Values of other
    /// fields, and attachments that cannot be read, are left as they are.
    pub(crate) fn import_path_attachments(
        &self,
        file: &mut KitableFile,
        table_id: i64,
        values: &mut Map<String, Value>,
    ) {
        let mut fields = AttachmentFields::default();
        self.import_path_attachments_cached(file, table_id, values, &mut fields);
    }

    fn import_path_attachments_cached(
        &self,
        file: &mut KitableFile,
        table_id: i64,
        values: &mut Map<String, Value>,
        fields: &mut AttachmentFields,
    ) {
        if values
            .values()
            .all(|value| !matches!(value, Value::Array(_) | Value::Object(_)))
        {
            return;
        }
        let names = fields.of(file, table_id);
        for name in names {
            let Some(value) = values.get(&name) else {
                continue;
            };
            if let Some(next) = self.import_path_attachments_in(file, value) {
                values.insert(name, next);
            }
        }
    }

    /// [`DataDocState::import_path_attachments`] for the cell values a transaction sets or
    /// creates.
    pub(crate) fn import_path_attachments_in_ops(
        &self,
        file: &mut KitableFile,
        ops: &mut [TableOp],
    ) {
        let mut fields = AttachmentFields::default();
        for op in ops {
            match op {
                TableOp::CellsSet { table_id, records } => {
                    for edit in records {
                        self.import_path_attachments_cached(
                            file,
                            *table_id,
                            &mut edit.values,
                            &mut fields,
                        );
                    }
                }
                TableOp::RecordsCreate {
                    table_id, records, ..
                } => {
                    for values in records {
                        self.import_path_attachments_cached(file, *table_id, values, &mut fields);
                    }
                }
                _ => {}
            }
        }
    }
}

/// The names of each table's attachment fields, read once per request.
#[derive(Default)]
struct AttachmentFields(HashMap<i64, Vec<String>>);

impl AttachmentFields {
    fn of(&mut self, file: &KitableFile, table_id: i64) -> Vec<String> {
        self.0
            .entry(table_id)
            .or_insert_with(|| {
                file.get_table(table_id)
                    .map(|table| {
                        table
                            .fields
                            .iter()
                            .filter(|field| field.field_type == "attachment")
                            .map(|field| field.name.clone())
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .clone()
    }
}

/// `value` (an attachment cell's value) with each image blob of `file` as a `data:` URL, for
/// readers that take image URLs (AI fields). Blobs the file does not hold, and blobs over
/// `max_bytes`, are left as they are.
pub(crate) fn inline_blob_images(file: &KitableFile, value: &Value, max_bytes: u64) -> Value {
    let Value::Array(items) = value else {
        return value.clone();
    };
    let items = items
        .iter()
        .map(|item| {
            let Value::Object(map) = item else {
                return item.clone();
            };
            let Some(hash) = blob_hash_of_url(text(map, &["url"])) else {
                return item.clone();
            };
            let Ok(Some(blob)) = file.blob(hash) else {
                return item.clone();
            };
            let mime = match text(map, &["mimeType", "mime_type"]) {
                "" => blob.info.mime.clone(),
                mime => mime.to_owned(),
            };
            if !mime.to_ascii_lowercase().starts_with("image/") || blob.info.size > max_bytes {
                return item.clone();
            }
            let mut inlined = map.clone();
            inlined.insert("mimeType".into(), Value::from(mime.clone()));
            inlined.insert(
                "url".into(),
                Value::from(format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&blob.bytes)
                )),
            );
            Value::Object(inlined)
        })
        .collect();
    Value::Array(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_contained_urls_need_no_workspace_file() {
        for url in [
            "https://example.com/a.png",
            "data:image/png;base64,AA",
            "kition-blob:ab",
            "kition-bundled:/a.png",
            "blob:x",
        ] {
            assert!(is_self_contained(url), "{url}");
        }
        for url in [
            "/workspace-files/.kition/assets/a.png",
            "/uploads/a.png",
            "photos/a.png",
        ] {
            assert!(!is_self_contained(url), "{url}");
        }
    }
}
