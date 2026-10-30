// Copied from kition-sdk crates/kition-kits/src/grants.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! File grants for kits (Kition platform `KitFiles 1.0`): the runtime's grant table and the files
//! it serves through them.
//!
//! A **session** is one kit editor page (or, later, one headless connection or agent run). It is
//! bound to a kit, a person (the principal), the document it opened, and the kit manifest's
//! `files` lists (K15). A **handle** (`fh_` and 128 random bits, FA1) names a file or a folder
//! with a set of rights (`read`, `create`, `write`, FA2). The table maps each handle to its
//! session and its workspace path; the path never leaves this module, so a kit only ever sees
//! handles and display names (FA-P2).
//!
//! Every path is confined to the workspace: no `..`, no hidden segment (`.kition/` among them),
//! and no link that leads out of the workspace or into a hidden folder (H3, LR2, FA8). A file the
//! kit may not see is refused the same way whether it exists or not. Writes are staged in a
//! temporary file beside the target and commit atomically (FA9); a `create` handle never replaces
//! a file (H5). Every grant, commit, release, and revocation is recorded in the session's log.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// The prefix of every file handle (FA1).
pub const FILE_HANDLE_PREFIX: &str = "fh_";
/// The prefix of every grant session id.
pub const SESSION_PREFIX: &str = "fs_";

/// What a handle allows (FA2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Right {
    Read,
    Create,
    Write,
}

/// Whether a handle names a file or a folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Folder,
}

/// How a handle was granted (KitFiles section 3), as the grant log records it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Flow {
    /// The person chose the file in the host's picker.
    Pick,
    /// The person dropped the file on the kit's frame.
    Drop,
    /// `files/create`: a new file beside the document or in a granted folder.
    Create,
    /// An entry of a granted folder (`files/list`).
    List,
    /// A file an agent's command names (`KitAgent` A28): `write` only when approved (FA13).
    Agent,
}

/// The kit manifest's `files` lists (K15): extensions without the dot.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FilesManifest {
    pub read: Vec<String>,
    pub create: Vec<String>,
    pub folders: bool,
    pub print: bool,
}

impl FilesManifest {
    fn normalized(mut self) -> Self {
        let normalize = |list: &mut Vec<String>| {
            for item in list.iter_mut() {
                *item = item.trim_start_matches('.').to_ascii_lowercase();
            }
        };
        normalize(&mut self.read);
        normalize(&mut self.create);
        self
    }
}

/// A handle as the kit sees it (FA3): never a path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub handle: String,
    /// The last path segment only; untrusted text for the kit.
    pub name: String,
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// The host's opaque version stamp; `None` for a created file not committed yet.
    pub version: Option<String>,
    pub rights: Vec<Right>,
}

/// A handle as the host shows it to the person (FA16): its stat and how it was granted.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantView {
    #[serde(flatten)]
    pub stat: FileStat,
    pub flow: Flow,
}

/// What happened to a handle, in the session's log.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GrantEvent {
    Grant,
    Commit,
    Release,
    Revoke,
}

/// One entry of a session's grant log (KitFiles section 7, A10, A30). It names the file by its
/// display name only.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantLogEntry {
    /// Milliseconds since the Unix epoch.
    pub at: u64,
    pub event: GrantEvent,
    pub handle: String,
    pub flow: Flow,
    pub kit: String,
    pub principal: String,
    pub rights: Vec<Right>,
    pub kind: Kind,
    pub name: String,
}

/// A session as the host shows it to the person (FA16).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub session: String,
    pub kit: String,
    /// The document the editor opened (workspace path), when it opened one.
    pub document: Option<String>,
    pub read_only: bool,
    pub grants: Vec<GrantView>,
    pub log: Vec<GrantLogEntry>,
}

/// Bytes read through a handle (`files/read`).
#[derive(Debug)]
pub struct FileRead {
    pub bytes: Vec<u8>,
    pub version: String,
    /// The whole file's size.
    pub size: u64,
}

/// A refusal, with its KitFiles reason (section 10).
#[derive(Debug, thiserror::Error)]
pub enum FileError {
    /// Unknown, expired, revoked, or foreign handle or session, or a right the handle lacks.
    #[error("{0}")]
    NotGranted(String),
    /// The host's policy refuses the grant or the file.
    #[error("{0}")]
    NotAllowed(String),
    #[error("this file was already committed")]
    AlreadyCommitted,
    #[error("{0}")]
    Conflict(String),
    #[error("the file is open with unsaved edits")]
    UnsavedEdits,
    #[error("this write passes the host's cap")]
    Quota,
    /// Storage failed; the message names no path.
    #[error("the host could not reach the file")]
    Io,
    /// Malformed parameters (`-32602` in the Kit UI protocol).
    #[error("{0}")]
    BadParams(String),
}

impl FileError {
    /// The KitFiles reason (`error.data.reason`), `None` for malformed parameters.
    pub fn reason(&self) -> Option<&'static str> {
        Some(match self {
            Self::NotGranted(_) => "file-not-granted",
            Self::NotAllowed(_) => "not-allowed",
            Self::AlreadyCommitted => "already-committed",
            Self::Conflict(_) => "conflict",
            Self::UnsavedEdits => "unsaved-edits",
            Self::Quota => "quota",
            Self::Io => "io-error",
            Self::BadParams(_) => return None,
        })
    }
}

fn io(_: std::io::Error) -> FileError {
    FileError::Io
}

/// Caps and lifetimes of grants.
#[derive(Clone, Copy, Debug)]
pub struct GrantLimits {
    /// Bytes written through one handle (FA10).
    pub per_grant: u64,
    /// Bytes written in one session (FA10).
    pub per_session: u64,
    /// A session nobody used for this long ends, and its handles expire (FA4).
    pub idle: Duration,
    /// The most bytes one `files/read` answers; the kit reads on (KitFiles section 4).
    pub read_chunk: u64,
}

impl Default for GrantLimits {
    fn default() -> Self {
        Self { per_grant: 4 << 30, per_session: 16 << 30, idle: Duration::from_secs(12 * 60 * 60), read_chunk: 8 << 20 }
    }
}

/// What a session is opened with.
#[derive(Clone, Debug)]
pub struct SessionRequest<'a> {
    pub kit: &'a str,
    pub principal: &'a str,
    /// The document the editor opened (workspace path), beside which `files/create` makes files.
    pub document: Option<&'a str>,
    pub manifest: FilesManifest,
    /// A read-only document: no `write` grants (FA17).
    pub read_only: bool,
}

/// A grant of a file or folder the host chose (a pick, a drop, an agent's `file` parameter).
#[derive(Clone, Debug)]
pub struct GrantRequest<'a> {
    pub path: &'a str,
    pub kind: Kind,
    pub rights: &'a [Right],
    /// For a folder: the extensions its listed files may have (within the manifest's `read`).
    pub accept: &'a [String],
    pub flow: Flow,
    /// For an agent's `write`: a draft or the person's explicit approval stands behind it (FA13).
    pub approved: bool,
}

/// A chunk of a staged write (`files/write`).
#[derive(Clone, Copy, Debug)]
pub struct WriteChunk<'a> {
    pub bytes: &'a [u8],
    pub offset: u64,
    pub last: bool,
    pub expected: Option<&'a str>,
}

/// A write in progress: a temporary file beside the target, removed unless it was committed.
struct Staging {
    temp: PathBuf,
    file: File,
}

impl Drop for Staging {
    fn drop(&mut self) {
        // Committed staging files were moved already; the removal then finds nothing.
        let _ = std::fs::remove_file(&self.temp);
    }
}

struct Grant {
    handle: String,
    flow: Flow,
    rights: Vec<Right>,
    kind: Kind,
    name: String,
    /// The absolute path, inside the workspace.
    path: PathBuf,
    /// For a `files/create` handle: the folder it goes in, for a name taken meanwhile.
    folder: Option<PathBuf>,
    accept: Vec<String>,
    mime: Option<String>,
    version: Option<String>,
    size: Option<u64>,
    committed: bool,
    staging: Option<Staging>,
    staged: u64,
    written: u64,
}

impl Grant {
    fn has(&self, right: Right) -> bool {
        self.rights.contains(&right)
    }

    fn stat(&self) -> FileStat {
        FileStat {
            handle: self.handle.clone(),
            name: self.name.clone(),
            kind: self.kind,
            size: self.size,
            mime: self.mime.clone(),
            version: self.version.clone(),
            rights: self.rights.clone(),
        }
    }
}

/// One kit editor page: its identity is the kit and the document it opened, for the person.
struct Session {
    kit: String,
    principal: String,
    /// The document the editor opened, workspace-relative.
    document: Option<String>,
    /// The document's folder, where `files/create` without a folder makes files.
    beside: Option<PathBuf>,
    manifest: FilesManifest,
    read_only: bool,
    grants: HashMap<String, Grant>,
    written: u64,
    touched: Instant,
    log: Vec<GrantLogEntry>,
}

/// The log entry of `event` on `grant` in the session of `kit` and `principal`.
fn log_entry(kit: &str, principal: &str, event: GrantEvent, grant: &Grant) -> GrantLogEntry {
    let entry = GrantLogEntry {
        at: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX)),
        event,
        handle: grant.handle.clone(),
        flow: grant.flow,
        kit: kit.to_owned(),
        principal: principal.to_owned(),
        rights: grant.rights.clone(),
        kind: grant.kind,
        name: grant.name.clone(),
    };
    tracing::info!(
        target: "kition::kit_files",
        event = ?entry.event,
        handle = %entry.handle,
        flow = ?entry.flow,
        kit = %entry.kit,
        principal = %entry.principal,
        rights = ?entry.rights,
        name = %entry.name,
        "kit file grant"
    );
    entry
}

impl Session {
    fn record(&mut self, event: GrantEvent, grant: &Grant) {
        let entry = log_entry(&self.kit, &self.principal, event, grant);
        self.log.push(entry);
    }

    fn add(&mut self, mut grant: Grant) -> FileStat {
        grant.handle = random_id(FILE_HANDLE_PREFIX);
        let stat = grant.stat();
        self.record(GrantEvent::Grant, &grant);
        self.grants.insert(grant.handle.clone(), grant);
        stat
    }

    fn granted(&mut self, handle: &str) -> Result<&mut Grant, FileError> {
        self.grants.get_mut(handle).ok_or_else(|| FileError::NotGranted("this handle was not granted to this session".into()))
    }

    fn may_read(&self, name: &str, accept: &[String]) -> bool {
        let extension = extension_of(name);
        self.manifest.read.contains(&extension) && (accept.is_empty() || accept.contains(&extension))
    }

    fn may_create(&self, name: &str) -> bool {
        self.manifest.create.contains(&extension_of(name))
    }
}

/// The grant table of one workspace. Its sessions end with the runtime.
pub struct GrantStore {
    workspace: Option<PathBuf>,
    limits: Mutex<GrantLimits>,
    sessions: Mutex<HashMap<String, Session>>,
}

/// The refusal for a file the kit may not see, the same whether it exists or not (FA8).
fn unavailable() -> FileError {
    FileError::NotAllowed("this file is not available to the kit".into())
}

impl GrantStore {
    pub fn new(workspace: Option<PathBuf>) -> Self {
        Self { workspace, limits: Mutex::new(GrantLimits::default()), sessions: Mutex::default() }
    }

    /// Changes the caps and lifetimes for grants made from now on and sessions still open.
    pub fn set_limits(&self, limits: GrantLimits) {
        *self.limits.lock().unwrap_or_else(PoisonError::into_inner) = limits;
    }

    fn limits(&self) -> GrantLimits {
        *self.limits.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn workspace(&self) -> Result<&Path, FileError> {
        self.workspace.as_deref().ok_or_else(|| FileError::NotAllowed("open a workspace folder first".into()))
    }

    /// Opens a session for a kit's editor page.
    pub fn open_session(&self, request: SessionRequest<'_>) -> Result<String, FileError> {
        if request.kit.trim().is_empty() {
            return Err(FileError::BadParams("kit is a kit id".into()));
        }
        let workspace = self.workspace()?;
        let (document, beside) = match request.document {
            Some(document) => {
                let path = self.confine(document)?;
                if !path.is_file() {
                    return Err(unavailable());
                }
                (relative_to(workspace, &path), path.parent().map(Path::to_path_buf))
            }
            None => (None, None),
        };
        let id = random_id(SESSION_PREFIX);
        let session = Session {
            kit: request.kit.to_owned(),
            principal: request.principal.to_owned(),
            document,
            beside,
            manifest: request.manifest.normalized(),
            read_only: request.read_only,
            grants: HashMap::new(),
            written: 0,
            touched: Instant::now(),
            log: Vec::new(),
        };
        let mut sessions = self.sessions();
        sessions.insert(id.clone(), session);
        Ok(id)
    }

    /// Ends a session (its frame closed): every handle expires and staged writes are dropped
    /// (FA4, FA9). Answers the revoked handles; an unknown session has none.
    pub fn end_session(&self, session: &str, principal: &str) -> Vec<String> {
        let mut sessions = self.sessions();
        let owned = sessions.get(session).is_some_and(|found| found.principal == principal);
        if !owned {
            return Vec::new();
        }
        let Some(mut ended) = sessions.remove(session) else {
            return Vec::new();
        };
        let grants: Vec<Grant> = ended.grants.drain().map(|(_, grant)| grant).collect();
        for grant in &grants {
            ended.record(GrantEvent::Revoke, grant);
        }
        let mut handles: Vec<String> = grants.into_iter().map(|grant| grant.handle).collect();
        handles.sort();
        handles
    }

    /// What a session holds now, and its grant log (FA16).
    pub fn view(&self, session: &str, principal: &str) -> Result<SessionView, FileError> {
        self.with_session(session, principal, |id, session| {
            let mut grants: Vec<GrantView> = session.grants.values().map(|grant| GrantView { stat: grant.stat(), flow: grant.flow }).collect();
            grants.sort_by(|a, b| a.stat.handle.cmp(&b.stat.handle));
            Ok(SessionView {
                session: id.to_owned(),
                kit: session.kit.clone(),
                document: session.document.clone(),
                read_only: session.read_only,
                grants,
                log: session.log.clone(),
            })
        })
    }

    /// Grants a handle on a file or folder the host chose: the person's pick or drop, or a file
    /// an agent's command names (FA6, FA8, FA13, FA17, K15).
    pub fn grant(&self, session: &str, principal: &str, request: GrantRequest<'_>) -> Result<FileStat, FileError> {
        let mut rights: Vec<Right> = Vec::new();
        for right in request.rights {
            if !rights.contains(right) {
                rights.push(*right);
            }
        }
        if rights.is_empty() {
            return Err(FileError::BadParams("rights lists at least one right".into()));
        }
        if matches!(request.flow, Flow::Create | Flow::List) {
            return Err(FileError::BadParams("flow is pick, drop, or agent".into()));
        }
        let path = self.confine(request.path)?;
        self.with_session(session, principal, |_, session| {
            let name = display_name(&path);
            let metadata = std::fs::metadata(&path).ok();
            let grant = match request.kind {
                Kind::Folder => {
                    if !metadata.as_ref().is_some_and(std::fs::Metadata::is_dir) {
                        return Err(unavailable());
                    }
                    if !session.manifest.folders {
                        return Err(FileError::NotAllowed("the kit may not ask for folders".into()));
                    }
                    if rights.contains(&Right::Write) {
                        return Err(FileError::BadParams("a folder has no write right".into()));
                    }
                    if rights.contains(&Right::Create) && session.manifest.create.is_empty() {
                        return Err(FileError::NotAllowed("the kit may not create files".into()));
                    }
                    let accept = normalized(request.accept);
                    if accept.iter().any(|extension| !session.manifest.read.contains(extension)) {
                        return Err(FileError::NotAllowed("the kit asked for a file type its manifest does not declare".into()));
                    }
                    Grant { accept, ..new_grant(request.flow, rights, Kind::Folder, name, path.clone(), None) }
                }
                Kind::File if rights.contains(&Right::Create) => {
                    if rights.len() > 1 {
                        return Err(FileError::BadParams("a create right on a file comes alone".into()));
                    }
                    // A new file only: create never replaces one (H5).
                    if std::fs::symlink_metadata(&path).is_ok() {
                        return Err(FileError::Conflict("a file with this name exists; create never replaces one".into()));
                    }
                    if !session.may_create(&name) {
                        return Err(FileError::NotAllowed(format!("the kit may not create .{} files", extension_label(&name))));
                    }
                    new_grant(request.flow, rights, Kind::File, name, path.clone(), None)
                }
                Kind::File => {
                    let Some(metadata) = metadata.filter(std::fs::Metadata::is_file) else {
                        return Err(unavailable());
                    };
                    if rights.contains(&Right::Read) && !session.may_read(&name, &[]) {
                        return Err(FileError::NotAllowed(format!("the kit may not read .{} files", extension_label(&name))));
                    }
                    if rights.contains(&Right::Write) {
                        if session.read_only {
                            return Err(FileError::NotAllowed("a read-only session replaces no file".into()));
                        }
                        if request.flow == Flow::Agent && !request.approved {
                            return Err(FileError::NotAllowed("an agent replaces a file only through a draft or the person's approval".into()));
                        }
                        if !session.may_create(&name) {
                            return Err(FileError::NotAllowed(format!("the kit may not write .{} files", extension_label(&name))));
                        }
                    }
                    Grant {
                        version: Some(version_of(&metadata)),
                        size: Some(metadata.len()),
                        ..new_grant(request.flow, rights, Kind::File, name, path.clone(), None)
                    }
                }
            };
            Ok(session.add(grant))
        })
    }

    /// `files/create`: a handle with right `create` on a new file, beside the session's document
    /// or in a granted folder, under an unused name (FA7, FA15). The file appears when committed.
    pub fn create(&self, session: &str, principal: &str, suggested_name: &str, mime: Option<&str>, folder: Option<&str>) -> Result<FileStat, FileError> {
        self.with_session(session, principal, |_, session| {
            let parent = match folder {
                Some(handle) => {
                    let folder = session.granted(handle)?;
                    if folder.kind != Kind::Folder || !folder.has(Right::Create) {
                        return Err(FileError::NotGranted("this handle is not a folder with a create right".into()));
                    }
                    folder.path.clone()
                }
                None => session.beside.clone().ok_or_else(|| FileError::BadParams("this session has no document to create beside".into()))?,
            };
            let suggested = sanitize_file_name(suggested_name);
            if !session.may_create(&suggested) {
                return Err(FileError::NotAllowed(format!("the kit may not create .{} files", extension_label(&suggested))));
            }
            let name = free_name(session, &parent, &suggested)?;
            let path = parent.join(&name);
            let grant = Grant { mime: mime.map(str::to_owned), ..new_grant(Flow::Create, vec![Right::Create], Kind::File, name, path, Some(parent)) };
            Ok(session.add(grant))
        })
    }

    /// `files/stat`.
    pub fn stat(&self, session: &str, principal: &str, handle: &str) -> Result<FileStat, FileError> {
        let workspace = self.workspace()?.to_path_buf();
        self.with_session(session, principal, |_, session| {
            let grant = session.granted(handle)?;
            let creating = grant.has(Right::Create) && grant.kind == Kind::File;
            if grant.kind == Kind::File
                && (!creating || grant.committed)
                && let Some(metadata) = still_inside(&workspace, &grant.path).and_then(|real| std::fs::metadata(real).ok()).filter(std::fs::Metadata::is_file)
            {
                grant.version = Some(version_of(&metadata));
                grant.size = Some(metadata.len());
            }
            Ok(grant.stat())
        })
    }

    /// `files/read`: at most `length` bytes from `offset`, capped at the read chunk.
    pub fn read(&self, session: &str, principal: &str, handle: &str, offset: u64, length: Option<u64>) -> Result<FileRead, FileError> {
        let workspace = self.workspace()?.to_path_buf();
        let chunk = self.limits().read_chunk;
        self.with_session(session, principal, |_, session| {
            let grant = session.granted(handle)?;
            if grant.kind != Kind::File || !grant.has(Right::Read) {
                return Err(FileError::NotGranted("this handle has no read right on a file".into()));
            }
            // The file may have become a link out of the workspace since it was granted.
            let real = still_inside(&workspace, &grant.path).ok_or_else(unavailable)?;
            let mut file = File::open(real).map_err(io)?;
            let metadata = file.metadata().map_err(io)?;
            if !metadata.is_file() {
                return Err(unavailable());
            }
            let size = metadata.len();
            let start = offset.min(size);
            let wanted = length.unwrap_or(u64::MAX).min(chunk).min(size - start);
            file.seek(SeekFrom::Start(start)).map_err(io)?;
            let mut bytes = Vec::with_capacity(usize::try_from(wanted).unwrap_or(0));
            file.take(wanted).read_to_end(&mut bytes).map_err(io)?;
            let version = version_of(&metadata);
            grant.version = Some(version.clone());
            grant.size = Some(size);
            Ok(FileRead { bytes, version, size })
        })
    }

    /// `files/list`: the folder's files its grant accepts, not recursively, each with `read`.
    pub fn list(&self, session: &str, principal: &str, handle: &str) -> Result<Vec<FileStat>, FileError> {
        let workspace = self.workspace()?.to_path_buf();
        self.with_session(session, principal, |_, session| {
            let folder = session.granted(handle)?;
            if folder.kind != Kind::Folder || !folder.has(Right::Read) {
                return Err(FileError::NotGranted("this handle has no read right on a folder".into()));
            }
            let real = still_inside(&workspace, &folder.path).ok_or_else(unavailable)?;
            let accept = folder.accept.clone();
            let mut entries: Vec<(String, PathBuf)> = std::fs::read_dir(real)
                .map_err(io)?
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let name = entry.file_name().to_str()?.to_owned();
                    (!name.starts_with('.')).then(|| (name, entry.path()))
                })
                .collect();
            entries.sort();
            let mut files = Vec::new();
            for (name, path) in entries {
                if !session.may_read(&name, &accept) {
                    continue;
                }
                let Some(metadata) = still_inside(&workspace, &path).and_then(|real| std::fs::metadata(real).ok()).filter(std::fs::Metadata::is_file) else {
                    continue;
                };
                let grant = Grant {
                    version: Some(version_of(&metadata)),
                    size: Some(metadata.len()),
                    ..new_grant(Flow::List, vec![Right::Read], Kind::File, name, path, None)
                };
                files.push(session.add(grant));
            }
            Ok(files)
        })
    }

    /// The workspace path a final `write` chunk would replace, for the unsaved-edits check (FA14);
    /// `None` when the chunk replaces nothing.
    pub fn replaces(&self, session: &str, principal: &str, handle: &str) -> Option<String> {
        let workspace = self.workspace.clone()?;
        let mut sessions = self.sessions();
        let session = sessions.get_mut(session).filter(|found| found.principal == principal)?;
        let grant = session.grants.get(handle)?;
        if grant.kind != Kind::File || !grant.has(Right::Write) {
            return None;
        }
        relative_to(&workspace, &grant.path)
    }

    /// `files/write`: stages a chunk; the final one commits atomically (FA9). `unsaved` says the
    /// file is open with unsaved edits in an editor (FA14).
    pub fn write(&self, session: &str, principal: &str, handle: &str, chunk: WriteChunk<'_>, unsaved: bool) -> Result<Option<String>, FileError> {
        let workspace = self.workspace()?.to_path_buf();
        let limits = self.limits();
        self.with_session(session, principal, |_, session| {
            let written = session.written;
            let grant = session.granted(handle)?;
            if grant.kind != Kind::File {
                return Err(FileError::NotGranted("this handle is not a file".into()));
            }
            let creating = grant.has(Right::Create);
            if !creating && !grant.has(Right::Write) {
                return Err(FileError::NotGranted("this handle has no create or write right".into()));
            }
            if creating && grant.committed {
                return Err(FileError::AlreadyCommitted);
            }
            if chunk.offset != grant.staged {
                return Err(FileError::BadParams(format!("offset is {}, the bytes staged so far", grant.staged)));
            }
            let size = chunk.bytes.len() as u64;
            if grant.written.saturating_add(size) > limits.per_grant || written.saturating_add(size) > limits.per_session {
                return Err(FileError::Quota);
            }
            let expected = if chunk.last && !creating {
                let Some(expected) = chunk.expected else {
                    return Err(FileError::Conflict("the final chunk carries the version it replaces".into()));
                };
                if unsaved {
                    return Err(FileError::UnsavedEdits);
                }
                Some(expected.to_owned())
            } else {
                None
            };
            if grant.staging.is_none() {
                grant.staging = Some(stage(&workspace, &grant.path)?);
            }
            if let Some(staging) = grant.staging.as_mut() {
                staging.file.write_all(chunk.bytes).map_err(io)?;
            }
            grant.staged += size;
            grant.written += size;
            session.written += size;
            if !chunk.last {
                return Ok(None);
            }
            let Some(grant) = session.grants.get_mut(handle) else {
                return Err(FileError::Io);
            };
            let staging = grant.staging.take();
            grant.staged = 0;
            let Some(staging) = staging else {
                return Err(FileError::Io);
            };
            let version = commit(&workspace, grant, staging, expected.as_deref())?;
            if creating {
                grant.committed = true;
            }
            let entry = log_entry(&session.kit, &session.principal, GrantEvent::Commit, grant);
            session.log.push(entry);
            Ok(Some(version))
        })
    }

    /// `files/release`: drops handles; an unknown or expired one is not an error.
    pub fn release(&self, session: &str, principal: &str, handles: &[String]) {
        let _ = self.with_session(session, principal, |_, session| {
            for handle in handles {
                if let Some(grant) = session.grants.remove(handle) {
                    session.record(GrantEvent::Release, &grant);
                }
            }
            Ok(())
        });
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        let idle = self.limits().idle;
        sessions.retain(|_, session| session.touched.elapsed() <= idle);
        sessions
    }

    /// The one gate of every request on a session and its handles: the session must be open and
    /// the caller's. A check of the caller's kit origin (kit frame isolation) belongs here too.
    fn with_session<T>(&self, id: &str, principal: &str, run: impl FnOnce(&str, &mut Session) -> Result<T, FileError>) -> Result<T, FileError> {
        let mut sessions = self.sessions();
        let session = sessions
            .get_mut(id)
            .filter(|session| session.principal == principal)
            .ok_or_else(|| FileError::NotGranted("this session has ended or is not yours".into()))?;
        session.touched = Instant::now();
        run(id, session)
    }

    /// The absolute path of a workspace path the kit may reach (H3, LR2, FA8): no `..`, no hidden
    /// segment, and, once links are followed, inside the workspace and outside its hidden
    /// folders. A missing file is confined through its folder, which must exist.
    fn confine(&self, path: &str) -> Result<PathBuf, FileError> {
        let workspace = self.workspace()?;
        let trimmed = path.trim().trim_start_matches('/');
        if trimmed.is_empty() || trimmed.contains('\\') || trimmed.contains('\0') {
            return Err(unavailable());
        }
        let mut absolute = workspace.to_path_buf();
        for part in trimmed.split('/') {
            if part.is_empty() || part.starts_with('.') || Path::new(part).is_absolute() {
                return Err(unavailable());
            }
            absolute.push(part);
        }
        if std::fs::symlink_metadata(&absolute).is_ok() {
            return still_inside(workspace, &absolute).ok_or_else(unavailable);
        }
        let (Some(parent), Some(name)) = (absolute.parent(), absolute.file_name()) else {
            return Err(unavailable());
        };
        let parent = still_inside(workspace, parent).ok_or_else(unavailable)?;
        if !parent.is_dir() {
            return Err(unavailable());
        }
        Ok(parent.join(name))
    }
}

fn new_grant(flow: Flow, rights: Vec<Right>, kind: Kind, name: String, path: PathBuf, folder: Option<PathBuf>) -> Grant {
    Grant {
        handle: String::new(),
        flow,
        rights,
        kind,
        name,
        path,
        folder,
        accept: Vec::new(),
        mime: None,
        version: None,
        size: None,
        committed: false,
        staging: None,
        staged: 0,
        written: 0,
    }
}

/// `prefix` and 128 random bits in hex (FA1).
fn random_id(prefix: &str) -> String {
    format!("{prefix}{}", hex::encode(rand::random::<[u8; 16]>()))
}

/// The real path of `path` when, links followed, it is inside `workspace` and no part of it
/// below the workspace is hidden.
fn still_inside(workspace: &Path, path: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(path).ok()?;
    let inside = real.strip_prefix(workspace).ok()?;
    let hidden = inside.components().any(|part| match part {
        Component::Normal(part) => part.to_string_lossy().starts_with('.'),
        _ => true,
    });
    (!hidden).then_some(real)
}

/// `path` relative to `workspace`, `/`-separated.
fn relative_to(workspace: &Path, path: &Path) -> Option<String> {
    let parts: Option<Vec<&str>> = path
        .strip_prefix(workspace)
        .ok()?
        .components()
        .map(|part| match part {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect();
    Some(parts?.join("/"))
}

fn display_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The host's version stamp of a file: its modification time and size.
fn version_of(metadata: &std::fs::Metadata) -> String {
    let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |since| since.as_nanos());
    format!("\"{modified}-{}\"", metadata.len())
}

/// The extension of a name, lower case, without the dot; empty when it has none.
pub fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn extension_label(name: &str) -> String {
    let extension = extension_of(name);
    if extension.is_empty() { "(none)".into() } else { extension }
}

fn normalized(list: &[String]) -> Vec<String> {
    list.iter().map(|item| item.trim_start_matches('.').to_ascii_lowercase()).collect()
}

/// A name the host may create (FA15): the last segment only, no control characters or
/// characters the platforms reserve, no leading dot, no trailing dot or space, no reserved
/// device name (`CON`, `NUL` on Windows), at most 255 characters; `Untitled` when nothing is
/// left.
pub fn sanitize_file_name(suggested: &str) -> String {
    let last = suggested.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last.chars().filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')).collect();
    let mut name = cleaned.trim().trim_start_matches('.').trim_end_matches(['.', ' ']).to_owned();
    let base_end = name.find('.').unwrap_or(name.len());
    let base = name[..base_end].to_owned();
    let reserved = matches!(base.to_ascii_lowercase().as_str(), "con" | "prn" | "aux" | "nul") || {
        let lower = base.to_ascii_lowercase();
        (lower.starts_with("com") || lower.starts_with("lpt")) && lower.len() == 4 && lower.as_bytes()[3].is_ascii_digit() && lower.as_bytes()[3] != b'0'
    };
    if reserved {
        name = format!("{base}_{}", &name[base_end..]);
    }
    if name.chars().count() > 255 {
        let extension = extension_of(&name);
        name = if extension.is_empty() {
            name.chars().take(255).collect()
        } else {
            let keep = 254usize.saturating_sub(extension.chars().count());
            format!("{}.{extension}", name.chars().take(keep).collect::<String>())
        };
    }
    if name.is_empty() { "Untitled".into() } else { name }
}

/// `Report.pdf`, then `Report 2.pdf`, `Report 3.pdf`, …: the first name `taken` says is free (FA7).
pub fn unused_name(name: &str, taken: impl Fn(&str) -> bool) -> Option<String> {
    let (base, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    (1..10_000).find_map(|number| {
        let candidate = if number == 1 { name.to_owned() } else { format!("{base} {number}{extension}") };
        (!taken(&candidate)).then_some(candidate)
    })
}

/// An unused name in `folder`, skipping names this session's uncommitted creates hold.
fn free_name(session: &Session, folder: &Path, suggested: &str) -> Result<String, FileError> {
    let reserved: Vec<&PathBuf> =
        session.grants.values().filter(|grant| grant.kind == Kind::File && grant.has(Right::Create) && !grant.committed).map(|grant| &grant.path).collect();
    unused_name(suggested, |candidate| {
        let path = folder.join(candidate);
        reserved.contains(&&path) || std::fs::symlink_metadata(&path).is_ok()
    })
    .ok_or(FileError::Io)
}

/// A new staging file beside `target`, hidden so no kit reads it.
fn stage(workspace: &Path, target: &Path) -> Result<Staging, FileError> {
    let parent = target.parent().ok_or(FileError::Io)?;
    let parent = still_inside(workspace, parent).ok_or_else(unavailable)?;
    let temp = parent.join(format!(".{}.kition-{}.part", display_name(target), hex::encode(rand::random::<[u8; 8]>())));
    let file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(io)?;
    Ok(Staging { temp, file })
}

/// Commits a staged write. A `create` handle's file never replaces one: when its name was taken
/// since it was granted, a `files/create` handle moves on to the next unused name, and any other
/// answers `conflict` (FA7, FA9, H5). A `write` handle replaces the file only while its version
/// is still `expected`. A failed commit drops the staged bytes; the kit writes again from 0.
fn commit(workspace: &Path, grant: &mut Grant, mut staging: Staging, expected: Option<&str>) -> Result<String, FileError> {
    staging.file.flush().map_err(io)?;
    staging.file.sync_all().map_err(io)?;
    if let Some(expected) = expected {
        let real = still_inside(workspace, &grant.path).ok_or_else(unavailable)?;
        let metadata = std::fs::metadata(&real).map_err(io)?;
        if version_of(&metadata) != expected {
            return Err(FileError::Conflict("the file changed since the version the kit read".into()));
        }
        std::fs::rename(&staging.temp, &real).map_err(io)?;
        return finish(grant, &real);
    }
    for _ in 0..8 {
        match place_new(&staging.temp, &grant.path) {
            Ok(()) => {
                let path = grant.path.clone();
                return finish(grant, &path);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let Some(folder) = grant.folder.clone().filter(|_| grant.flow == Flow::Create) else {
                    return Err(FileError::Conflict("a file with this name exists; create never replaces one".into()));
                };
                let name = unused_name(&grant.name, |candidate| std::fs::symlink_metadata(folder.join(candidate)).is_ok()).ok_or(FileError::Io)?;
                grant.path = folder.join(&name);
                grant.name = name;
            }
            Err(_) => return Err(FileError::Io),
        }
    }
    Err(FileError::Io)
}

/// Moves `temp` to `target` unless `target` exists: a hard link fails when it does, atomically.
/// Where the file system has no hard links, the target is claimed first, then replaced.
fn place_new(temp: &Path, target: &Path) -> std::io::Result<()> {
    match std::fs::hard_link(temp, target) {
        Ok(()) => {
            let _ = std::fs::remove_file(temp);
            Ok(())
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Err(error),
        Err(_) => {
            OpenOptions::new().write(true).create_new(true).open(target)?;
            std::fs::rename(temp, target)
        }
    }
}

fn finish(grant: &mut Grant, path: &Path) -> Result<String, FileError> {
    let metadata = std::fs::metadata(path).map_err(io)?;
    let version = version_of(&metadata);
    grant.version = Some(version.clone());
    grant.size = Some(metadata.len());
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_sanitised() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("a\\b\\Report.pdf"), "Report.pdf");
        assert_eq!(sanitize_file_name(".hidden.png"), "hidden.png");
        assert_eq!(sanitize_file_name("CON.txt"), "CON_.txt");
        assert_eq!(sanitize_file_name("com1"), "com1_");
        assert_eq!(sanitize_file_name("trail. "), "trail");
        assert_eq!(sanitize_file_name("a\u{7}b?.pdf"), "ab.pdf");
        assert_eq!(sanitize_file_name("..."), "Untitled");
        let long = format!("{}.pdf", "x".repeat(300));
        let cut = sanitize_file_name(&long);
        assert_eq!(cut.chars().count(), 255);
        assert!(cut.ends_with(".pdf"));
    }

    #[test]
    fn unused_names_count_up() {
        let taken = ["Report.pdf", "Report 2.pdf"];
        assert_eq!(unused_name("Report.pdf", |name| taken.contains(&name)).as_deref(), Some("Report 3.pdf"));
        assert_eq!(unused_name("notes", |_| false).as_deref(), Some("notes"));
    }

    #[test]
    fn handles_carry_128_random_bits() {
        let handle = random_id(FILE_HANDLE_PREFIX);
        assert!(handle.starts_with("fh_"));
        assert_eq!(handle.len(), 3 + 32);
        assert_ne!(handle, random_id(FILE_HANDLE_PREFIX));
    }
}
