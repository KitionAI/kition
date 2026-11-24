//! Where the person was in a document (Kit UI protocol capability
//! `view-state`, section 7n): the page, the zoom, the camera, the panels a kit
//! keeps for one document. It belongs to the person on this device, not to the
//! document, so it is kept in the app's own data, never in the workspace, the
//! replica, or the file:
//!
//! ```text
//! <app data>/view-state/
//!   <workspace key>/   the first 32 hex digits of the SHA-256 of the workspace folder's path
//!     <docId>.bin      the JSON's length (8 bytes, little-endian), the JSON object, then the bytes
//! ```
//!
//! `<app data>` is the app's per-user data folder (shared by its workspace
//! windows), and `<docId>` the document's id in the workspace's document index
//! (`.kition/docs/index.json`, with `:` written `%3A`), so the view state
//! follows the file's renames and moves as its replica does. A value is
//! written whole (the last write wins); `state: null` deletes it. A missing or
//! damaged file reads as no view state. Deleting the folder loses nothing of
//! any document.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::docstore::validate_doc_id;
use super::files::check_expected_root;
use super::guarded::GuardedWrites;
use super::safety::{invalid, write_atomically};
use crate::request::Request;

pub const VIEW_STATE_DIR: &str = "view-state";
/// The largest view state JSON, in UTF-8 bytes (Kit UI protocol `VIEW_STATE_JSON_LIMIT`).
pub const JSON_LIMIT: usize = 256 * 1024;
/// The largest view state bytes (Kit UI protocol `VIEW_STATE_BYTES_LIMIT`).
pub const BYTES_LIMIT: usize = 16 * 1024 * 1024;
/// The error a larger value is refused with (the protocol's `too-large`).
pub const VIEW_STATE_TOO_LARGE: &str = "VIEW_STATE_TOO_LARGE";
const LENGTH_BYTES: usize = 8;

/// A document's view state: a JSON object and optional bytes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ViewState {
    pub state: Option<Map<String, Value>>,
    pub bytes: Option<Vec<u8>>,
}

/// The folder of `root`'s view state in `data_dir`.
fn workspace_dir(data_dir: &Path, root: &Path) -> PathBuf {
    let path = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let digest = hex::encode(Sha256::digest(path.to_string_lossy().as_bytes()));
    data_dir.join(VIEW_STATE_DIR).join(&digest[..32])
}

/// The file of `doc_id`'s view state.
pub fn file(data_dir: &Path, root: &Path, doc_id: &str) -> io::Result<PathBuf> {
    validate_doc_id(doc_id)?;
    Ok(workspace_dir(data_dir, root).join(format!("{}.bin", doc_id.replace(':', "%3A"))))
}

/// The file's contents as a view state, or none when they are damaged.
fn parse(content: &[u8]) -> ViewState {
    let damaged = ViewState::default();
    let Some(length) = content.get(..LENGTH_BYTES) else {
        return damaged;
    };
    let mut prefix = [0u8; LENGTH_BYTES];
    prefix.copy_from_slice(length);
    let Ok(length) = usize::try_from(u64::from_le_bytes(prefix)) else {
        return damaged;
    };
    let Some(json) = LENGTH_BYTES
        .checked_add(length)
        .and_then(|end| content.get(LENGTH_BYTES..end))
    else {
        return damaged;
    };
    let Ok(Value::Object(state)) = serde_json::from_slice::<Value>(json) else {
        return damaged;
    };
    let rest = &content[LENGTH_BYTES + length..];
    ViewState {
        state: Some(state),
        bytes: (!rest.is_empty()).then(|| rest.to_vec()),
    }
}

/// `doc_id`'s view state; none when there is none or it is damaged.
pub fn read(
    data_dir: &Path,
    root: &Path,
    locks: &GuardedWrites,
    doc_id: &str,
) -> io::Result<ViewState> {
    let path = file(data_dir, root, doc_id)?;
    locks.exclusive(&path, || match fs::read(&path) {
        Ok(content) => Ok(parse(&content)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(ViewState::default()),
        Err(error) => Err(error),
    })
}

/// Replaces `doc_id`'s view state whole; a value without `state` deletes it.
/// A larger value than the limits is refused and nothing is kept.
pub fn write(
    data_dir: &Path,
    root: &Path,
    locks: &GuardedWrites,
    doc_id: &str,
    value: &ViewState,
) -> io::Result<()> {
    let path = file(data_dir, root, doc_id)?;
    let content = match &value.state {
        None => None,
        Some(state) => {
            let json = serde_json::to_vec(state).map_err(io::Error::other)?;
            let bytes = value.bytes.as_deref().unwrap_or_default();
            if json.len() > JSON_LIMIT || bytes.len() > BYTES_LIMIT {
                return Err(io::Error::other(VIEW_STATE_TOO_LARGE));
            }
            let mut content = Vec::with_capacity(LENGTH_BYTES + json.len() + bytes.len());
            content.extend_from_slice(&(json.len() as u64).to_le_bytes());
            content.extend_from_slice(&json);
            content.extend_from_slice(bytes);
            Some(content)
        }
    };
    locks.exclusive(&path, || match &content {
        Some(content) => write_atomically(&path, content),
        None => match fs::remove_file(&path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        },
    })
}

// --- Renderer requests --------------------------------------------------

/// `{ doc_id, expected_root? }` to `{ state, bytes_base64? }`.
pub fn read_request(
    data_dir: &Path,
    root: &Path,
    locks: &GuardedWrites,
    request: &Request,
) -> io::Result<Value> {
    check_expected_root(root, request)?;
    let value = read(data_dir, root, locks, &request.str("doc_id"))?;
    let mut answer = json!({ "state": value.state });
    if let (Some(_), Some(bytes)) = (&value.state, &value.bytes) {
        answer["bytes_base64"] = Value::String(BASE64.encode(bytes));
    }
    Ok(answer)
}

/// `{ doc_id, state: object | null, bytes_base64?, expected_root? }`.
pub fn write_request(
    data_dir: &Path,
    root: &Path,
    locks: &GuardedWrites,
    request: &Request,
) -> io::Result<Value> {
    check_expected_root(root, request)?;
    let state = match request.value("state") {
        Some(Value::Object(state)) => Some(state.clone()),
        Some(Value::Null) => None,
        _ => return Err(invalid("a view state is an object or null")),
    };
    let bytes = match request.value("bytes_base64") {
        Some(Value::String(text)) => Some(
            BASE64
                .decode(text.trim())
                .map_err(|_| invalid("view state bytes are not base64"))?,
        ),
        _ => None,
    };
    write(
        data_dir,
        root,
        locks,
        &request.str("doc_id"),
        &ViewState { state, bytes },
    )?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "0199c2a4-7b3e-7cde-8f00-1234567890ab";

    fn ok<T>(result: io::Result<T>) -> T {
        result.unwrap_or_else(|err| panic!("{err}"))
    }

    fn error_text<T: std::fmt::Debug>(result: io::Result<T>) -> String {
        result.err().map(|err| err.to_string()).unwrap_or_default()
    }

    struct Folders {
        _temp: tempfile::TempDir,
        data: PathBuf,
        root: PathBuf,
    }

    fn folders() -> Folders {
        let temp = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let data = temp.path().join("app-data");
        let root = temp.path().join("workspace");
        ok(fs::create_dir_all(&root));
        Folders {
            _temp: temp,
            data,
            root,
        }
    }

    fn state(value: Value) -> Option<Map<String, Value>> {
        value.as_object().cloned()
    }

    #[test]
    fn keeps_view_state_in_app_data_not_the_workspace() {
        let f = folders();
        let locks = GuardedWrites::default();
        assert_eq!(
            ok(read(&f.data, &f.root, &locks, DOC)),
            ViewState::default()
        );
        let value = ViewState {
            state: state(json!({ "v": 1, "page": 3, "zoom": 1.5 })),
            bytes: Some(vec![1, 2, 3]),
        };
        ok(write(&f.data, &f.root, &locks, DOC, &value));
        assert_eq!(ok(read(&f.data, &f.root, &locks, DOC)), value);

        let path = ok(file(&f.data, &f.root, DOC));
        assert!(path.starts_with(f.data.join(VIEW_STATE_DIR)));
        assert!(path.exists());
        // Nothing in the workspace.
        assert_eq!(ok(fs::read_dir(&f.root)).count(), 0);

        // Written whole: a value without bytes has none.
        let plain = ViewState {
            state: state(json!({ "v": 1 })),
            bytes: None,
        };
        ok(write(&f.data, &f.root, &locks, DOC, &plain));
        assert_eq!(ok(read(&f.data, &f.root, &locks, DOC)), plain);
        // `state: null` deletes it.
        ok(write(&f.data, &f.root, &locks, DOC, &ViewState::default()));
        assert!(!path.exists());
        assert_eq!(
            ok(read(&f.data, &f.root, &locks, DOC)),
            ViewState::default()
        );
    }

    #[test]
    fn keeps_each_workspace_and_document_apart() {
        let f = folders();
        let other_root = f.root.with_file_name("other");
        ok(fs::create_dir_all(&other_root));
        assert_ne!(
            ok(file(&f.data, &f.root, DOC)),
            ok(file(&f.data, &other_root, DOC))
        );
        assert_ne!(
            ok(file(&f.data, &f.root, DOC)),
            ok(file(&f.data, &f.root, "doc-2"))
        );
        let colon = ok(file(&f.data, &f.root, "board:1"));
        assert_eq!(
            colon
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            Some("board%3A1.bin".to_owned())
        );
        assert!(file(&f.data, &f.root, "../escape").is_err());
    }

    #[test]
    fn refuses_values_past_the_limits() {
        let f = folders();
        let locks = GuardedWrites::default();
        let kept = ViewState {
            state: state(json!({ "v": 1 })),
            bytes: None,
        };
        ok(write(&f.data, &f.root, &locks, DOC, &kept));
        let large_json = ViewState {
            state: state(json!({ "text": "x".repeat(JSON_LIMIT) })),
            bytes: None,
        };
        assert_eq!(
            error_text(write(&f.data, &f.root, &locks, DOC, &large_json)),
            VIEW_STATE_TOO_LARGE
        );
        let large_bytes = ViewState {
            state: state(json!({ "v": 1 })),
            bytes: Some(vec![0; BYTES_LIMIT + 1]),
        };
        assert_eq!(
            error_text(write(&f.data, &f.root, &locks, DOC, &large_bytes)),
            VIEW_STATE_TOO_LARGE
        );
        // Nothing was kept of the refused values.
        assert_eq!(ok(read(&f.data, &f.root, &locks, DOC)), kept);
        // At the limits exactly, it is kept.
        let at_limit = ViewState {
            state: state(json!({ "t": "x".repeat(JSON_LIMIT - 8) })),
            bytes: Some(vec![7; BYTES_LIMIT]),
        };
        ok(write(&f.data, &f.root, &locks, DOC, &at_limit));
        assert_eq!(ok(read(&f.data, &f.root, &locks, DOC)), at_limit);
    }

    #[test]
    fn reads_a_damaged_value_as_none() {
        let f = folders();
        let locks = GuardedWrites::default();
        let path = ok(file(&f.data, &f.root, DOC));
        ok(fs::create_dir_all(path.parent().unwrap_or(&f.data)));
        for damaged in [
            b"".to_vec(),
            b"short".to_vec(),
            [&u64::MAX.to_le_bytes()[..], b"{}"].concat(),
            [&2u64.to_le_bytes()[..], b"[]"].concat(),
            [&3u64.to_le_bytes()[..], b"{x}"].concat(),
        ] {
            ok(fs::write(&path, damaged));
            assert_eq!(
                ok(read(&f.data, &f.root, &locks, DOC)),
                ViewState::default()
            );
        }
    }

    #[test]
    fn answers_renderer_requests() {
        let f = folders();
        let locks = GuardedWrites::default();
        let request = |value: Value| Request::new(Some(value));
        assert_eq!(
            ok(read_request(
                &f.data,
                &f.root,
                &locks,
                &request(json!({ "doc_id": DOC }))
            )),
            json!({ "state": null })
        );
        ok(write_request(
            &f.data,
            &f.root,
            &locks,
            &request(
                json!({ "doc_id": DOC, "state": { "v": 2 }, "bytes_base64": BASE64.encode([9, 8]) }),
            ),
        ));
        assert_eq!(
            ok(read_request(
                &f.data,
                &f.root,
                &locks,
                &request(json!({ "doc_id": DOC }))
            )),
            json!({ "state": { "v": 2 }, "bytes_base64": BASE64.encode([9, 8]) })
        );
        assert!(
            write_request(
                &f.data,
                &f.root,
                &locks,
                &request(json!({ "doc_id": DOC, "state": [1] }))
            )
            .is_err()
        );
        ok(write_request(
            &f.data,
            &f.root,
            &locks,
            &request(json!({ "doc_id": DOC, "state": null })),
        ));
        assert_eq!(
            ok(read_request(
                &f.data,
                &f.root,
                &locks,
                &request(json!({ "doc_id": DOC }))
            )),
            json!({ "state": null })
        );
    }
}
