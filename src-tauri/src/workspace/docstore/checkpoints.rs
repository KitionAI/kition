//! A document's checkpoints as kits see them (Kit UI protocol capability
//! `checkpoints`, section 7m): listed, found, renamed, deleted, and read.
//!
//! A kit's checkpoint is `{ id, time, origin, author?, label?, description?,
//! version, available }`, its `version` in base64 as the protocol carries it
//! (`history.json` keeps the writer's hex). A kit records its checkpoints with
//! the replica write that holds their version (`write_entry_request`'s
//! `checkpoint`, origin `kit`), and changes only those: the host's own are
//! listed and read, never changed. Refusals are the `history` errors
//! (`CHECKPOINT_NOT_FOUND`, `CHECKPOINT_HISTORY_MISSING`,
//! `CHECKPOINT_TOO_LONG`, `CHECKPOINT_READ_ONLY`) and `STORE_READ_ONLY`; the
//! page turns them into the protocol's reasons.

use std::io;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};

use super::history::{self, CHECKPOINT_HISTORY_MISSING, CHECKPOINT_NOT_FOUND, Checkpoint};
use super::{Access, blobs, entry_dir, prepare};
use crate::request::Request;
use crate::workspace::guarded::GuardedWrites;

/// The most checkpoints one list answers (Kit UI protocol `CHECKPOINT_LIST_LIMIT`).
pub const LIST_LIMIT: usize = 200;

/// The replica version as the protocol carries it: the stored hex in base64
/// (empty when none was recorded or it is not hex).
fn version_base64(version: Option<&str>) -> String {
    version
        .and_then(|hex_text| hex::decode(hex_text).ok())
        .map(|bytes| BASE64.encode(bytes))
        .unwrap_or_default()
}

/// A checkpoint as a kit sees it (`KitCheckpoint`).
pub fn kit_checkpoint_json(checkpoint: &Checkpoint) -> Value {
    let mut value = json!({
        "id": checkpoint.id,
        "time": checkpoint.time,
        "origin": checkpoint.origin,
        "version": version_base64(checkpoint.version.as_deref()),
        "available": checkpoint.available,
    });
    for (key, field) in [
        ("author", &checkpoint.author),
        ("label", &checkpoint.label),
        ("description", &checkpoint.description),
    ] {
        if let Some(text) = field {
            value[key] = Value::String(text.clone());
        }
    }
    value
}

/// A field of an update: absent or `null` keeps it, a string (empty removes it) changes it.
fn edit_field(request: &Request, key: &str) -> io::Result<Option<String>> {
    match request.value(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(crate::workspace::safety::invalid(format!(
            "a checkpoint's {key} is a string"
        ))),
    }
}

/// `{ doc_id, labelled?, before?, limit?, expected_root? }` to `{ checkpoints,
/// more }`: newest first, at most `limit` (default and most `LIST_LIMIT`).
pub fn list_request(
    root: &Path,
    locks: &GuardedWrites,
    _access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let dir = entry_dir(root, &request.str("doc_id"))?;
    let limit = request
        .number("limit")
        .filter(|limit| limit.fract() == 0.0 && *limit >= 1.0)
        .map_or(LIST_LIMIT, |limit| (limit as usize).min(LIST_LIMIT));
    let page = history::Page {
        labelled: request.bool("labelled"),
        before: request.string("before"),
        limit,
    };
    let (checkpoints, more) = locks.exclusive(&dir, || history::list_page(root, &dir, &page))?;
    Ok(json!({
        "checkpoints": checkpoints.iter().map(kit_checkpoint_json).collect::<Vec<_>>(),
        "more": more,
    }))
}

/// `{ doc_id, id, expected_root? }` to the checkpoint, or `null`.
pub fn find_request(
    root: &Path,
    locks: &GuardedWrites,
    _access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let dir = entry_dir(root, &request.str("doc_id"))?;
    let id = request.str("id");
    let found = locks.exclusive(&dir, || history::find(root, &dir, &id))?;
    Ok(found.as_ref().map_or(Value::Null, kit_checkpoint_json))
}

/// `{ doc_id, id, label?, description?, expected_root? }` to `{ checkpoint }`:
/// renames the kit's checkpoint (an absent field is kept, an empty one removed).
pub fn update_request(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let dir = entry_dir(root, &request.str("doc_id"))?;
    let edit = history::Edit {
        label: edit_field(request, "label")?,
        description: edit_field(request, "description")?,
    };
    access.check()?;
    let id = request.str("id");
    let updated = locks.exclusive(&dir, || history::update(root, &dir, &id, edit))?;
    Ok(json!({ "checkpoint": kit_checkpoint_json(&updated) }))
}

/// `{ doc_id, id, expected_root? }`: deletes the kit's checkpoint.
pub fn delete_request(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let dir = entry_dir(root, &request.str("doc_id"))?;
    access.check()?;
    let id = request.str("id");
    locks.exclusive(&dir, || history::delete(root, &dir, &id))?;
    Ok(Value::Null)
}

/// `{ doc_id, id, expected_root? }` to `{ checkpoint, blobs_base64 }`: the
/// blobs the replica named at the checkpoint (empty for a replica without
/// blobs). The content itself the page derives from the stored replica at the
/// checkpoint's version. A checkpoint the store no longer reaches, or whose
/// blobs are gone, is `CHECKPOINT_HISTORY_MISSING`.
pub fn read_request(
    root: &Path,
    locks: &GuardedWrites,
    _access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let dir = entry_dir(root, &request.str("doc_id"))?;
    let id = request.str("id");
    locks.exclusive(&dir, || {
        let Some(checkpoint) = history::find(root, &dir, &id)? else {
            return Err(io::Error::other(CHECKPOINT_NOT_FOUND));
        };
        if !checkpoint.available {
            return Err(io::Error::other(CHECKPOINT_HISTORY_MISSING));
        }
        let bundle = match &checkpoint.blobs {
            Some(record) => blobs::load(root, &dir, record)?
                .ok_or_else(|| io::Error::other(CHECKPOINT_HISTORY_MISSING))?,
            None => Vec::new(),
        };
        Ok(json!({
            "checkpoint": kit_checkpoint_json(&checkpoint),
            "blobs_base64": BASE64.encode(bundle),
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::docstore::lock::STORE_READ_ONLY;
    use crate::workspace::docstore::{blobs, read_entry_request, write_entry_request};

    const DOC: &str = "0199c2a4-7b3e-7cde-8f00-1234567890ab";
    const W: Access = Access::Writer;

    fn ok<T>(result: io::Result<T>) -> T {
        result.unwrap_or_else(|err| panic!("{err}"))
    }

    fn error_text<T: std::fmt::Debug>(result: io::Result<T>) -> String {
        result.err().map(|err| err.to_string()).unwrap_or_default()
    }

    fn workspace() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = dir.path().join("workspace");
        std::fs::create_dir_all(&root).unwrap_or_else(|err| panic!("{err}"));
        (dir, root)
    }

    fn request(value: Value) -> Request {
        Request::new(Some(value))
    }

    /// Writes a kit replica at `version` (hex) with `blobs`, and the checkpoint asked.
    fn save(
        root: &Path,
        locks: &GuardedWrites,
        version: &str,
        blobs: &[u8],
        checkpoint: Value,
    ) -> Value {
        let meta =
            json!({ "docId": DOC, "kit": "kit.design", "path": "a.kdesign", "fileStamp": "v1" });
        ok(write_entry_request(
            root,
            locks,
            W,
            &request(json!({
                "doc_id": DOC, "meta": meta, "snapshot_base64": BASE64.encode(version.as_bytes()),
                "version": version, "blobs_base64": BASE64.encode(blobs), "checkpoint": checkpoint,
            })),
        ))
    }

    #[test]
    fn serves_a_kits_checkpoints() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        let first = blobs::bundle(&[b"image"]);
        save(&root, &locks, "0a0b", &first, json!({ "origin": "save" }));
        // A labelled checkpoint at the newest version becomes the kit's.
        let written = save(
            &root,
            &locks,
            "0a0b",
            &first,
            json!({ "origin": "kit", "label": "Draft", "description": "For review" }),
        );
        assert_eq!(written["checkpoint"]["origin"], json!("kit"));
        assert_eq!(
            written["kit_checkpoint"],
            json!({
                "id": written["checkpoint"]["id"], "time": written["checkpoint"]["time"], "origin": "kit",
                "label": "Draft", "description": "For review", "version": BASE64.encode([0x0a, 0x0b]),
                "available": true,
            })
        );
        save(
            &root,
            &locks,
            "0c0d",
            &blobs::bundle(&[b"other"]),
            json!({ "origin": "agent" }),
        );

        let listed = ok(list_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC })),
        ));
        assert_eq!(listed["more"], json!(false));
        let checkpoints = listed["checkpoints"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(checkpoints.len(), 2);
        assert_eq!(checkpoints[0]["origin"], json!("agent"));
        let draft = checkpoints[1].clone();
        // The version in base64, as the protocol carries it.
        assert_eq!(draft["version"], json!(BASE64.encode([0x0a, 0x0b])));
        assert_eq!(
            (
                draft["label"].clone(),
                draft["description"].clone(),
                draft["available"].clone()
            ),
            (json!("Draft"), json!("For review"), json!(true))
        );
        assert_eq!(draft.get("seq"), None);
        assert_eq!(draft.get("blobs"), None);
        let id = draft["id"].as_str().unwrap_or_default().to_owned();

        let labelled = ok(list_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "labelled": true, "limit": 1 })),
        ));
        assert_eq!(labelled["checkpoints"], json!([draft]));
        assert_eq!(
            error_text(list_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC, "before": "none" }))
            )),
            CHECKPOINT_NOT_FOUND
        );

        assert_eq!(
            ok(find_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC, "id": id }))
            )),
            draft
        );
        assert_eq!(
            ok(find_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC, "id": "none" }))
            )),
            Value::Null
        );

        // Read: the blobs of the checkpoint's time.
        let read = ok(read_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "id": id })),
        ));
        assert_eq!(read["blobs_base64"], json!(BASE64.encode(&first)));
        assert_eq!(
            error_text(read_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC, "id": "none" }))
            )),
            CHECKPOINT_NOT_FOUND
        );

        // Update: the kit's own only; absent kept, empty removed.
        let agent_id = checkpoints[0]["id"].as_str().unwrap_or_default().to_owned();
        assert_eq!(
            error_text(update_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC, "id": agent_id, "label": "Mine" }))
            )),
            history::CHECKPOINT_READ_ONLY
        );
        let updated = ok(update_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "id": id, "description": "" })),
        ));
        assert_eq!(updated["checkpoint"]["label"], json!("Draft"));
        assert_eq!(updated["checkpoint"].get("description"), None);
        assert_eq!(
            error_text(update_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC, "id": id, "label": "x".repeat(201) }))
            )),
            history::CHECKPOINT_TOO_LONG
        );
        // Only the store's writer changes checkpoints.
        assert_eq!(
            error_text(update_request(
                &root,
                &locks,
                Access::ReadOnly,
                &request(json!({ "doc_id": DOC, "id": id, "label": "x" }))
            )),
            STORE_READ_ONLY
        );
        assert_eq!(
            error_text(delete_request(
                &root,
                &locks,
                Access::ReadOnly,
                &request(json!({ "doc_id": DOC, "id": id }))
            )),
            STORE_READ_ONLY
        );

        // A replica of a new lineage: the labelled checkpoint stays, unavailable, and is not read.
        let meta =
            json!({ "docId": DOC, "kit": "kit.design", "path": "a.kdesign", "fileStamp": "v2" });
        ok(write_entry_request(
            &root,
            &locks,
            W,
            &request(json!({
                "doc_id": DOC, "meta": meta, "snapshot_base64": BASE64.encode(b"n"), "version": "ff",
                "blobs_base64": BASE64.encode(blobs::bundle(&[b"new"])), "lineage": "new",
            })),
        ));
        let listed = ok(list_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC })),
        ));
        assert_eq!(listed["checkpoints"].as_array().map(Vec::len), Some(1));
        assert_eq!(listed["checkpoints"][0]["available"], json!(false));
        assert_eq!(
            error_text(read_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC, "id": id }))
            )),
            CHECKPOINT_HISTORY_MISSING
        );
        assert!(
            ok(read_entry_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC }))
            ))
            .is_object()
        );

        // Delete: gone from the list.
        ok(delete_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "id": id })),
        ));
        assert_eq!(
            ok(list_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC }))
            ))["checkpoints"],
            json!([])
        );
        assert_eq!(
            error_text(delete_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC, "id": id }))
            )),
            CHECKPOINT_NOT_FOUND
        );
    }

    #[test]
    fn refuses_a_too_long_checkpoint_before_writing() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        let meta =
            json!({ "docId": DOC, "kit": "kit.design", "path": "a.kdesign", "fileStamp": "v1" });
        let written = write_entry_request(
            &root,
            &locks,
            W,
            &request(json!({
                "doc_id": DOC, "meta": meta, "snapshot_base64": BASE64.encode(b"s"), "version": "01",
                "checkpoint": { "origin": "kit", "description": "d".repeat(2001) },
            })),
        );
        assert_eq!(error_text(written), history::CHECKPOINT_TOO_LONG);
        assert_eq!(
            ok(read_entry_request(
                &root,
                &locks,
                W,
                &request(json!({ "doc_id": DOC }))
            )),
            Value::Null
        );
    }

    #[test]
    fn writes_versions_in_base64() {
        assert_eq!(
            version_base64(Some("00ff10")),
            BASE64.encode([0x00, 0xff, 0x10])
        );
        assert_eq!(version_base64(Some("not hex")), "");
        assert_eq!(version_base64(None), "");
    }
}
