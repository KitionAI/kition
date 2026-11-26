// Copied from kition-sdk crates/kition-kit-host/src/kit_files.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The host's `files.*` for one kit process (Kit Process Protocol section 5.1, `KitFiles 1.1` FA12):
//! a [`GrantStore`] session for the host connection, the handles the host mints for the documents
//! it names, and the answers to the kit's requests. A host written in Rust serves its kits with
//! it; a host in another language runs `kition-kits serve`, which does.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use kition_kit_process_protocol::types::{FileRef, FilesCreateParams, FilesReadParams, FilesReleaseParams, FilesResolveParams, FilesWriteParams};
use kition_kit_process_protocol::{ErrorReason, RpcError, base64};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::files::{FileError, FileStat, FilesManifest, GrantStore, Right, SessionRequest, WriteChunk};

/// Answers a kit's requests to its host, on a blocking thread.
pub trait HostService: Send + Sync {
    /// The services the host lists in `kit.initialize` `hostServices`.
    fn services(&self) -> Vec<String>;
    fn serve(&self, method: &str, params: Value) -> Result<Value, RpcError>;
}

/// One kit process's file grants: what its host connection may read and write.
pub struct KitFiles {
    store: Arc<GrantStore>,
    session: String,
    principal: String,
    /// The handle of each open document's file, by `documentId`.
    documents: Mutex<HashMap<String, String>>,
}

impl Drop for KitFiles {
    fn drop(&mut self) {
        // The connection is gone: its handles expire and staged writes are dropped (FA4).
        self.store.end_session(&self.session, &self.principal);
    }
}

/// A grant refusal as the Kit Process Protocol error with its code (`KitFiles 1.1` section 10).
pub fn file_error(error: &FileError) -> RpcError {
    let reason = match error {
        FileError::NotGranted(_) => ErrorReason::FileNotGranted,
        FileError::NotAllowed(_) => ErrorReason::FileNotAllowed,
        FileError::NotFound => ErrorReason::FileNotFound,
        FileError::AlreadyCommitted => ErrorReason::FileAlreadyCommitted,
        FileError::Conflict(_) => ErrorReason::FileConflict,
        FileError::UnsavedEdits => ErrorReason::FileUnsavedEdits,
        FileError::Quota => ErrorReason::FileQuota,
        FileError::Io => ErrorReason::IoError,
        FileError::BadParams(detail) => return RpcError::invalid_params(detail.clone()),
    };
    RpcError::kit_detail(reason, error.to_string())
}

fn params<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|error| RpcError::invalid_params(error.to_string()))
}

fn stat_json(stat: &FileStat) -> Value {
    serde_json::to_value(stat).unwrap_or(Value::Null)
}

impl KitFiles {
    /// A grant session for the kit `kit`, acting for `principal`; `manifest` is the kit's
    /// manifest `files` lists (K15), which bound `files.create`.
    pub fn open(store: Arc<GrantStore>, kit: &str, principal: &str, manifest: FilesManifest) -> Result<Self, FileError> {
        let session = store.open_session(SessionRequest { kit, principal, document: None, manifest, read_only: false })?;
        Ok(Self { store, session, principal: principal.to_owned(), documents: Mutex::default() })
    }

    /// A handle on the workspace file `path` for `file.open` or `document.saveAs`: `read` and
    /// `write` on an existing file, `read`, `create` and `write` on a new one (its first save makes
    /// it, H3). `read_only` grants `read` alone. `own` admits the host's own hidden files.
    pub fn document(&self, path: &str, read_only: bool, own: bool) -> Result<FileStat, FileError> {
        let exists = self.store.exists(path, own);
        let rights: &[Right] = match (exists, read_only) {
            (true, true) => &[Right::Read],
            (true, false) => &[Right::Read, Right::Write],
            (false, _) => &[Right::Read, Right::Create, Right::Write],
        };
        self.store.grant_document(&self.session, &self.principal, path, rights, own)
    }

    /// A `create` handle on the new workspace file `path`, for `file.export`: an export
    /// never replaces a file.
    pub fn export(&self, path: &str) -> Result<FileStat, FileError> {
        self.store.grant_document(&self.session, &self.principal, path, &[Right::Create], false)
    }

    /// Remembers that the kit's document `document_id` is the file of `handle`.
    pub fn opened(&self, document_id: &str, handle: &str) {
        self.documents.lock().unwrap_or_else(PoisonError::into_inner).insert(document_id.to_owned(), handle.to_owned());
    }

    pub fn closed(&self, document_id: &str) {
        self.documents.lock().unwrap_or_else(PoisonError::into_inner).remove(document_id);
    }

    /// The handle of the open document `document_id`.
    pub fn handle_of(&self, document_id: &str) -> Option<String> {
        self.documents.lock().unwrap_or_else(PoisonError::into_inner).get(document_id).cloned()
    }

    /// The workspace path of a handle this session minted, for the host; never sent to the kit.
    pub fn path_of(&self, handle: &str) -> Option<String> {
        self.store.path_of(&self.session, &self.principal, handle)
    }

    fn document_handle(&self, document_id: Option<&str>, file: Option<&str>) -> Result<String, RpcError> {
        match (file, document_id) {
            (Some(file), _) => Ok(file.to_owned()),
            (None, Some(id)) => self.handle_of(id).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound)),
            (None, None) => Err(RpcError::invalid_params("name the document by `documentId` or `file`")),
        }
    }
}

impl HostService for KitFiles {
    fn services(&self) -> Vec<String> {
        vec![kition_kit_process_protocol::HOST_SERVICE_FILES.to_owned()]
    }

    fn serve(&self, method: &str, request: Value) -> Result<Value, RpcError> {
        let (store, session, principal) = (&self.store, self.session.as_str(), self.principal.as_str());
        match method {
            "files.stat" => {
                let file: FileRef = params(request)?;
                store.stat(session, principal, &file.handle).map(|stat| stat_json(&stat)).map_err(|error| file_error(&error))
            }
            "files.read" => {
                let read: FilesReadParams = params(request)?;
                let answer = store.read(session, principal, &read.handle, read.offset.unwrap_or(0), read.length).map_err(|error| file_error(&error))?;
                Ok(json!({ "data": base64::encode(&answer.bytes), "version": answer.version, "size": answer.size }))
            }
            "files.list" => {
                let folder: FileRef = params(request)?;
                let files = store.list(session, principal, &folder.handle).map_err(|error| file_error(&error))?;
                Ok(json!({ "files": files.iter().map(stat_json).collect::<Vec<_>>() }))
            }
            "files.write" => {
                let write: FilesWriteParams = params(request)?;
                let bytes = base64::decode(&write.data).ok_or_else(|| RpcError::invalid_params("`data` is base64"))?;
                let chunk = WriteChunk { bytes: &bytes, offset: write.offset, last: write.last == Some(true), expected: write.expected.as_deref() };
                let version = store.write(session, principal, &write.handle, chunk, false).map_err(|error| file_error(&error))?;
                Ok(match version {
                    Some(version) => json!({ "version": version }),
                    None => json!({}),
                })
            }
            "files.create" => {
                let create: FilesCreateParams = params(request)?;
                let stat = match (&create.folder, &create.document_id) {
                    (Some(folder), _) => store.create(session, principal, &create.suggested_name, create.mime.as_deref(), Some(folder)),
                    (None, Some(id)) => {
                        let document = self.handle_of(id).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
                        store.create_beside(session, principal, &create.suggested_name, create.mime.as_deref(), &document)
                    }
                    (None, None) => return Err(RpcError::invalid_params("`files.create` names a `folder` or a `documentId` to create beside")),
                };
                stat.map(|stat| stat_json(&stat)).map_err(|error| file_error(&error))
            }
            "files.resolve" => {
                let resolve: FilesResolveParams = params(request)?;
                let document = self.document_handle(resolve.document_id.as_deref(), resolve.file.as_deref())?;
                store.resolve(session, principal, &document, &resolve.link).map(|stat| stat_json(&stat)).map_err(|error| file_error(&error))
            }
            "files.release" => {
                let release: FilesReleaseParams = params(request)?;
                store.release(session, principal, &release.handles);
                Ok(json!({}))
            }
            method => Err(RpcError::method_not_found(method)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("kit-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("media")).unwrap();
        std::fs::canonicalize(root).unwrap()
    }

    fn files(root: &std::path::Path) -> KitFiles {
        let manifest = FilesManifest { create: vec!["png".into()], ..FilesManifest::default() };
        KitFiles::open(Arc::new(GrantStore::new(Some(root.to_path_buf()))), "kit.grid", "person:local", manifest).unwrap()
    }

    fn call(files: &KitFiles, method: &str, params: Value) -> Result<Value, RpcError> {
        files.serve(method, params)
    }

    #[test]
    fn a_new_document_is_created_once_then_replaced_with_its_version() {
        let root = workspace("new");
        let files = files(&root);
        let stat = files.document("plan.grid", false, false).unwrap();
        assert_eq!(stat.version, None);
        let handle = stat.handle;
        let first = call(&files, "files.write", json!({ "handle": handle, "data": base64::encode(b"one"), "offset": 0, "final": true })).unwrap();
        assert_eq!(std::fs::read(root.join("plan.grid")).unwrap(), b"one");
        // The next save replaces it, with the version the first answered; a stale one is refused.
        let stale = call(&files, "files.write", json!({ "handle": handle, "data": base64::encode(b"x"), "offset": 0, "final": true, "expected": "\"0-0\"" }));
        assert_eq!(stale.unwrap_err().reason(), Some(ErrorReason::FileConflict));
        call(&files, "files.write", json!({ "handle": handle, "data": base64::encode(b"tw"), "offset": 0 })).unwrap();
        call(&files, "files.write", json!({ "handle": handle, "data": base64::encode(b"o"), "offset": 2, "final": true, "expected": first["version"] }))
            .unwrap();
        assert_eq!(std::fs::read(root.join("plan.grid")).unwrap(), b"two");
        let read = call(&files, "files.read", json!({ "handle": handle })).unwrap();
        assert_eq!(base64::decode(read["data"].as_str().unwrap()).unwrap(), b"two");
        // The same file asked for again is the same handle: one document (section 5).
        assert_eq!(files.document("plan.grid", false, false).unwrap().handle, handle);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn handles_are_this_session_s_and_paths_stay_in_the_workspace() {
        let root = workspace("confine");
        let files = files(&root);
        let foreign = call(&files, "files.read", json!({ "handle": "fh_00000000000000000000000000000000" }));
        assert_eq!(foreign.unwrap_err().reason(), Some(ErrorReason::FileNotGranted));
        assert!(files.document("../outside.grid", false, false).is_err());
        assert!(files.document(".kition/drafts/a.grid", false, false).is_err());
        std::fs::write(root.join("a.grid"), b"GRID").unwrap();
        // An export never replaces a file (H5).
        assert!(matches!(files.export("a.grid"), Err(FileError::Conflict(_))));
        let read_only = files.document("a.grid", true, false).unwrap();
        assert_eq!(read_only.rights, vec![Right::Read]);
        let refused = call(&files, "files.write", json!({ "handle": read_only.handle, "data": "", "offset": 0, "final": true, "expected": read_only.version }));
        assert_eq!(refused.unwrap_err().reason(), Some(ErrorReason::FileNotGranted));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn lent_files_resolve_beside_the_document_and_exports_go_beside_it() {
        let root = workspace("lent");
        std::fs::write(root.join("media/a.png"), b"PNG").unwrap();
        std::fs::create_dir_all(root.join("films")).unwrap();
        std::fs::write(root.join("films/cut.grid"), b"GRID").unwrap();
        let files = files(&root);
        let document = files.document("films/cut.grid", false, false).unwrap().handle;
        // While the document opens, the kit names it by its handle.
        let lent = call(&files, "files.resolve", json!({ "file": document, "link": "../media/a.png" })).unwrap();
        assert_eq!(lent["name"], "a.png");
        assert_eq!(lent["rights"], json!(["read"]));
        let bytes = call(&files, "files.read", json!({ "handle": lent["handle"] })).unwrap();
        assert_eq!(bytes["data"], base64::encode(b"PNG"));
        // Then by its id.
        files.opened("1", &document);
        assert_eq!(call(&files, "files.resolve", json!({ "documentId": "1", "link": "/media/a.png" })).unwrap()["handle"], lent["handle"]);
        for outside in ["../../etc/passwd", "../.git/config"] {
            let refused = call(&files, "files.resolve", json!({ "documentId": "1", "link": outside })).unwrap_err();
            assert_eq!(refused.reason(), Some(ErrorReason::FileNotAllowed), "{outside}");
        }
        // A missing file the kit may see is not found (regressions/issue-file-not-found).
        let missing = call(&files, "files.resolve", json!({ "documentId": "1", "link": "missing.png" })).unwrap_err();
        assert_eq!(missing.reason(), Some(ErrorReason::FileNotFound));
        let created = call(&files, "files.create", json!({ "suggestedName": "cut.png", "documentId": "1" })).unwrap();
        call(&files, "files.write", json!({ "handle": created["handle"], "data": base64::encode(b"P"), "offset": 0, "final": true })).unwrap();
        assert!(root.join("films/cut.png").is_file());
        let not_declared = call(&files, "files.create", json!({ "suggestedName": "cut.exe", "documentId": "1" })).unwrap_err();
        assert_eq!(not_declared.reason(), Some(ErrorReason::FileNotAllowed));
        assert_eq!(files.path_of(&document).as_deref(), Some("films/cut.grid"));
        let _ = std::fs::remove_dir_all(root);
    }

    /// A workspace for the `file_not_found` tests: the document `notes/a.md`, the picture
    /// `media/a.png`, a hidden `.git/config`, the host's own `.kition/drafts/a.png`, and links out
    /// of it to the folder `outside`, which holds `secret.png`: `media/out` (a folder link) and
    /// `media/escape.png` (a file link). The document is open as `1`.
    fn linked(name: &str) -> (std::path::PathBuf, std::path::PathBuf, KitFiles) {
        let root = workspace(name);
        let outside = std::env::temp_dir().join(format!("kit-files-{name}-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.png"), b"SECRET").unwrap();
        for folder in ["notes", ".git", ".kition/drafts"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        std::fs::write(root.join("notes/a.md"), b"# A").unwrap();
        std::fs::write(root.join("media/a.png"), b"PNG").unwrap();
        std::fs::write(root.join(".git/config"), b"[core]").unwrap();
        std::fs::write(root.join(".kition/drafts/a.png"), b"DRAFT").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("media/out")).unwrap();
            std::os::unix::fs::symlink(outside.join("secret.png"), root.join("media/escape.png")).unwrap();
            std::os::unix::fs::symlink(outside.join("gone.png"), root.join("media/dangling.png")).unwrap();
        }
        let files = files(&root);
        let document = files.document("notes/a.md", false, false).unwrap().handle;
        files.opened("1", &document);
        (root, outside, files)
    }

    fn resolve(files: &KitFiles, link: &str) -> Result<Value, RpcError> {
        call(files, "files.resolve", json!({ "documentId": "1", "link": link }))
    }

    // regressions/issue-file-not-found: a file the kit asks for by path that passes every check
    // (inside the workspace once `..` and links are resolved, no hidden segment, not the host's
    // own data) and does not exist is `file_not_found`, so an engine can tell a broken link from
    // a refused one. Before, it was the refusal `file_not_allowed`.
    #[test]
    fn file_not_found_answers_a_missing_file_the_kit_may_see() {
        let (root, outside, files) = linked("not-found");
        assert_eq!(resolve(&files, "../media/a.png").unwrap()["name"], "a.png", "an existing file resolves");
        for missing in ["../media/missing.png", "/media/missing.png", "missing.md", "../media/new/folder/missing.png", "/etc/passwd"] {
            let error = resolve(&files, missing).unwrap_err();
            assert_eq!(error.reason(), Some(ErrorReason::FileNotFound), "{missing}: {error:?}");
            assert_eq!(error.code, -32023, "{missing}");
            let text = serde_json::to_string(&error).unwrap();
            assert!(!text.contains(root.to_string_lossy().as_ref()), "the answer names no host path: {text}");
        }
        let _ = (std::fs::remove_dir_all(root), std::fs::remove_dir_all(outside));
    }

    // regressions/issue-file-not-found: every path that fails a check gets the same refusal
    // whether its target exists or not (KHP A29; KitFiles FA8; host contract H3, LR2), so a kit
    // cannot probe the disk with `file_not_found`.
    #[test]
    fn file_not_found_never_answers_a_refused_path() {
        let (root, outside, files) = linked("refused");
        let refusal = serde_json::to_string(&file_error(&crate::files::FileError::NotAllowed("this file is not available to the kit".into()))).unwrap();
        let mut pairs = vec![
            ("outside the workspace", "../../../secret.png", "../../../nothing.png"),
            ("`..` above the workspace", "../../etc/passwd", "../../etc/nothing"),
            ("a hidden segment", "../.git/config", "../.git/nothing"),
            ("a hidden folder that does not exist", "../.git/config", "../.nothing/config"),
            ("the host's own data", "../.kition/drafts/a.png", "../.kition/drafts/nothing.png"),
        ];
        if cfg!(unix) {
            pairs.push(("a folder link out of the workspace", "../media/out/secret.png", "../media/out/nothing.png"));
            pairs.push(("a file link out of the workspace", "../media/escape.png", "../media/dangling.png"));
        }
        for (class, existing, missing) in pairs {
            let (existing, missing) = (resolve(&files, existing).unwrap_err(), resolve(&files, missing).unwrap_err());
            assert_eq!(serde_json::to_string(&existing).unwrap(), refusal, "{class}: an existing target");
            assert_eq!(serde_json::to_string(&missing).unwrap(), refusal, "{class}: a missing target");
        }

        // A grant the kit's manifest does not cover (K15) is refused alike for an existing and a
        // missing file: the extension is checked before the file is looked for.
        std::fs::write(root.join("media/a.exe"), b"MZ").unwrap();
        let store = GrantStore::new(Some(root.clone()));
        let manifest = FilesManifest { read: vec!["png".into()], ..FilesManifest::default() };
        let session = store.open_session(SessionRequest { kit: "kit.grid", principal: "person:local", document: None, manifest, read_only: false }).unwrap();
        let grant = |path: &str| {
            let request = crate::files::GrantRequest {
                path,
                kind: crate::files::Kind::File,
                rights: &[Right::Read],
                accept: &[],
                flow: crate::files::Flow::Agent,
                approved: false,
            };
            store.grant(&session, "person:local", request).map(|stat| stat.name).map_err(|error| serde_json::to_string(&file_error(&error)).unwrap())
        };
        assert_eq!(grant("media/a.png"), Ok("a.png".to_owned()));
        let (existing, missing) = (grant("media/a.exe").unwrap_err(), grant("media/b.exe").unwrap_err());
        assert_eq!(existing, missing, "a wrong extension");
        assert!(existing.contains("file_not_allowed"), "{existing}");
        let _ = (std::fs::remove_dir_all(root), std::fs::remove_dir_all(outside));
    }
}
