// Copied from kition-sdk crates/kition-kits/src/manager.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Running kits for the open workspace.
//!
//! A kit starts on first use, headless, with the workspace folder as its only root; it serves
//! previews and the agent (kit editors run in the page, `KitFrame`). Each kit process gets two
//! connections: the `host`
//! connection serves people, and an `agent` connection serves agent tools, so the kit itself
//! enforces the agent's role and URI limits. Kits stop when the manager is dropped, which happens
//! when the runtime restarts for another workspace.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use kition_kit_host::{ClientError, KitClient, KitProcess, LaunchOptions};
use kition_kit_protocol::methods::{self, NotificationMethod, RequestMethod};
use kition_kit_protocol::types::*;
use kition_kit_protocol::{ErrorReason, PROTOCOL_VERSION};
use serde::Serialize;
use serde_json::{Map, Value};

pub use crate::definitions::{KitAgent, KitDefinition, KitExport, KitSources};

/// What [`KitManager::write_file`] may do to its target.
#[derive(Debug, Clone, Copy)]
pub enum FileWrite<'a> {
    /// Saves `document`, the file an editor opened: only that file is replaced.
    Save { document: &'a str },
    /// Makes a new file (a new document, or an export); an existing file is never replaced.
    New,
}

/// Who is asking: a person in a kit tab or the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    User,
    Agent,
}

#[derive(Debug, thiserror::Error)]
pub enum KitError {
    #[error("`{0}` is not a known kit")]
    UnknownKit(String),
    #[error("{name} is not installed: its headless executable is not with Kition yet.")]
    NotInstalled { name: &'static str },
    #[error("open a workspace folder first")]
    NoWorkspace,
    #[error("{0}")]
    InvalidPath(String),
    /// A path the person's or the agent's request may not name (KHP A29).
    #[error("{0}")]
    NotAllowed(String),
    #[error("{name} could not start: {detail}")]
    Launch { name: &'static str, detail: String },
    #[error("{name} stopped. Open the file again.")]
    Stopped { name: &'static str },
    #[error("{0}")]
    Unavailable(String),
    #[error("{message}")]
    Kit { reason: Option<ErrorReason>, message: String },
    /// An object-model failure (`model.batch`, `model.describe`): the kit's `data.model`, whose
    /// `code` is a `BatchErrorCode` (`invalid-op`, `not-found`, `invalid-value`, `read-only`,
    /// `command-failed`) and `index` the operation that failed.
    #[error("{message}")]
    Model { code: String, index: Option<usize>, message: String },
}

impl KitError {
    pub(crate) fn from_client(kit: &'static KitDefinition, error: ClientError) -> Self {
        match error {
            ClientError::Rpc(error) => {
                let detail = error.data.as_ref().and_then(|data| data.get("detail")).and_then(Value::as_str).map(str::to_owned);
                let message = match detail {
                    Some(detail) if !detail.is_empty() => format!("{}: {detail}", error.message),
                    _ => error.message.clone(),
                };
                Self::Kit { reason: error.reason(), message }
            }
            ClientError::Closed | ClientError::Io(_) => Self::Stopped { name: kit.name },
            other => Self::Kit { reason: None, message: other.to_string() },
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub extensions: Vec<&'static str>,
    /// Extensions this kit can create new documents in.
    pub creates: Vec<&'static str>,
    pub installed: bool,
}

/// A document open in a kit, as Kition shows it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentView {
    pub kit_id: &'static str,
    pub document_id: String,
    /// Workspace-relative, `/`-separated; `None` until the document is saved.
    pub path: Option<String>,
    pub title: String,
    pub format: String,
    pub read_only: bool,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Increments whenever the kit reports a change, so views know when to refresh.
    pub version: u64,
    pub summary: String,
    /// Kit-defined structure from `view.describe`, for example layers.
    pub details: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandView {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub group: String,
    /// JSON Schema for the command's params, as the kit's `commands.list` gives it.
    pub params: Value,
    /// JSON Schema for what the command answers (KHP A1 `output.schema`), when the kit gives one.
    pub output: Option<Value>,
    pub mutates: bool,
    pub enabled: bool,
    pub menu: Vec<String>,
    pub shortcut: Option<String>,
    /// The query matched no command, and this is one of the closest by spelling.
    pub closest: bool,
    /// The command has every word of the query (a ranked search also answers commands that have
    /// some of them; counting those as matches said "310 commands match `layer timing`").
    pub all_words: bool,
    /// The command's keywords the query named (at most eight): what it was found by when its
    /// title does not say, for example `Gradient Ramp` for `effect.apply`.
    pub matched: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteView {
    pub changed: bool,
    pub result: Option<Value>,
    pub document: DocumentView,
}

type Versions = Arc<Mutex<HashMap<String, u64>>>;

/// One kit process and its two connections.
pub(crate) struct RunningKit {
    pub(crate) process: tokio::sync::Mutex<KitProcess>,
    pub(crate) host: Arc<KitClient>,
    pub(crate) agent: Arc<KitClient>,
    versions: Versions,
}

impl RunningKit {
    pub(crate) fn client(&self, caller: Caller) -> &KitClient {
        match caller {
            Caller::User => &self.host,
            Caller::Agent => &self.agent,
        }
    }

    fn version(&self, document_id: &str) -> u64 {
        self.versions.lock().unwrap_or_else(PoisonError::into_inner).get(document_id).copied().unwrap_or(0)
    }

    pub(crate) async fn stop(&self) {
        let _ = self.host.call::<methods::Shutdown>(&Empty {}).await;
        let mut process = self.process.lock().await;
        if process.wait_for_exit(kition_kit_protocol::launch::SHUTDOWN_TIMEOUT).await.is_none() {
            process.kill().await;
        }
    }
}

pub(crate) struct Inner {
    workspace: Option<PathBuf>,
    /// Known kits and their executables, when installed.
    kits: Vec<(&'static KitDefinition, Option<PathBuf>)>,
    running: tokio::sync::Mutex<HashMap<&'static str, Arc<RunningKit>>>,
    /// Kit editors open in the renderer, for the agent (`bridge.rs`).
    bridge: Arc<crate::bridge::Bridge>,
    /// Each kit's object model as `model.describe` last answered it (the kit's schema, which is
    /// the same for all its documents): the agent's `<prefix>_query` and `<prefix>_batch`
    /// argument schemas are generated from it.
    described: Mutex<HashMap<&'static str, Value>>,
    /// Whether an agent's draft of a file no editor has open lives headless (`drafts.rs`):
    /// `kition-kits-mcp` turns it on; Kition keeps drafts in the person's open editor.
    headless_drafts: AtomicBool,
    /// The headless kits' draft documents, by workspace path.
    pub(crate) draft_documents: tokio::sync::Mutex<HashMap<String, String>>,
    /// The file grants kits hold (`grants.rs`, KitFiles 1.0).
    grants: crate::grants::GrantStore,
    /// Every headless save of a workspace file, for whoever follows file edits (the host table
    /// client's triggers).
    saves: tokio::sync::broadcast::Sender<SavedFile>,
}

/// A headless document saved to its workspace file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedFile {
    pub kit_id: &'static str,
    /// Workspace-relative, `/`-separated.
    pub path: String,
    /// The headless document, still open after the save.
    pub document_id: String,
}

/// The kits of one workspace. Cheap to clone.
#[derive(Clone)]
pub struct KitManager {
    pub(crate) inner: Arc<Inner>,
}

impl KitManager {
    /// The kits `sources` declare, for `workspace` (`definitions.rs`).
    pub fn discover(workspace: Option<PathBuf>, sources: &KitSources) -> Self {
        Self::new(workspace, crate::definitions::discover(sources))
    }

    pub fn new(workspace: Option<PathBuf>, kits: Vec<(&'static KitDefinition, Option<PathBuf>)>) -> Self {
        crate::definitions::register(kits.iter().map(|(kit, _)| kit));
        let workspace = workspace.map(|dir| std::fs::canonicalize(&dir).unwrap_or(dir));
        Self {
            inner: Arc::new(Inner {
                grants: crate::grants::GrantStore::new(workspace.clone()),
                workspace,
                kits,
                running: tokio::sync::Mutex::new(HashMap::new()),
                bridge: Arc::default(),
                described: Mutex::default(),
                headless_drafts: AtomicBool::new(false),
                draft_documents: tokio::sync::Mutex::default(),
                saves: tokio::sync::broadcast::channel(256).0,
            }),
        }
    }

    /// Keeps an agent's drafts of files no editor has open in the headless kits, stored in the
    /// workspace's `.kition/drafts/` (`drafts.rs`), instead of refusing them.
    #[must_use]
    pub fn with_headless_drafts(self) -> Self {
        self.inner.headless_drafts.store(true, Ordering::Relaxed);
        self
    }

    /// Whether drafts of files no editor has open live headless.
    pub fn headless_drafts(&self) -> bool {
        self.inner.headless_drafts.load(Ordering::Relaxed)
    }

    /// The workspace folder, if there is one.
    pub fn workspace_dir(&self) -> Option<&Path> {
        self.inner.workspace.as_deref()
    }

    /// The file grants kits hold in this workspace (KitFiles 1.0).
    pub fn grants(&self) -> &crate::grants::GrantStore {
        &self.inner.grants
    }

    /// `files/write` through a handle: stages the chunk, and the final one commits. A final
    /// chunk that replaces a file is refused while an editor has that file open with unsaved
    /// edits (FA14).
    pub async fn write_granted(
        &self,
        session: &str,
        principal: &str,
        handle: &str,
        chunk: crate::grants::WriteChunk<'_>,
    ) -> Result<Option<String>, crate::grants::FileError> {
        let grants = self.grants();
        let unsaved = match grants.replaces(session, principal, handle) {
            Some(path) if chunk.last => self.inner.bridge.find(&path).await.is_some_and(|document| document.dirty),
            _ => false,
        };
        grants.write(session, principal, handle, chunk, unsaved)
    }

    /// A Kit Protocol request to the kit's headless executable that names no document (or names
    /// it in `params`): `model.open`, `model.export`, `model.save`.
    pub(crate) async fn headless_request(&self, caller: Caller, kit: &'static KitDefinition, method: &str, params: Value) -> Result<Value, KitError> {
        let running = self.running(kit).await?;
        running.client(caller).request(method, params, None).await.map_err(|error| KitError::from_client(kit, error))
    }

    /// The Kit AI bridge to the renderer's open kit editors.
    pub fn bridge(&self) -> &Arc<crate::bridge::Bridge> {
        &self.inner.bridge
    }

    pub fn statuses(&self) -> Vec<KitStatus> {
        self.inner
            .kits
            .iter()
            .map(|(kit, binary)| KitStatus {
                id: kit.id,
                name: kit.name,
                extensions: kit.extensions.to_vec(),
                creates: kit.creates.iter().map(|(extension, _)| *extension).collect(),
                installed: binary.as_deref().is_some_and(Path::is_file),
            })
            .collect()
    }

    /// The kit's object model as `model.describe` last answered it, when one was asked for.
    pub fn described(&self, kit_id: &str) -> Option<Value> {
        self.inner.described.lock().unwrap_or_else(PoisonError::into_inner).iter().find(|(id, _)| **id == kit_id).map(|(_, described)| described.clone())
    }

    /// Keeps what `model.describe` answered for `kit_id` (a live editor's or a headless kit's).
    pub fn remember_described(&self, kit_id: &str, described: &Value) {
        let Ok(kit) = self.definition(kit_id) else {
            return;
        };
        if described.get("types").is_some_and(Value::is_object) {
            self.inner.described.lock().unwrap_or_else(PoisonError::into_inner).insert(kit.id, described.clone());
        }
    }

    /// The definitions of the kits this manager knows.
    pub fn definitions(&self) -> impl Iterator<Item = &'static KitDefinition> + '_ {
        self.inner.kits.iter().map(|(kit, _)| *kit)
    }

    pub(crate) fn definition(&self, id: &str) -> Result<&'static KitDefinition, KitError> {
        self.inner.kits.iter().map(|(kit, _)| *kit).find(|kit| kit.id == id).ok_or_else(|| KitError::UnknownKit(id.to_owned()))
    }

    /// The kit that opens a workspace path, by extension.
    pub fn kit_for_path(&self, path: &str) -> Option<&'static KitDefinition> {
        let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
        self.inner.kits.iter().map(|(kit, _)| *kit).find(|kit| kit.extensions.contains(&extension.as_str()))
    }

    fn workspace(&self) -> Result<&Path, KitError> {
        self.inner.workspace.as_deref().ok_or(KitError::NoWorkspace)
    }

    /// Starts the headless kit if it is not running and returns it.
    async fn running(&self, kit: &'static KitDefinition) -> Result<Arc<RunningKit>, KitError> {
        let mut running = self.inner.running.lock().await;
        if let Some(existing) = running.get(kit.id) {
            if !existing.host.is_closed() {
                return Ok(Arc::clone(existing));
            }
            running.remove(kit.id);
        }
        let started = Arc::new(self.launch(kit).await?);
        running.insert(kit.id, Arc::clone(&started));
        Ok(started)
    }

    async fn launch(&self, kit: &'static KitDefinition) -> Result<RunningKit, KitError> {
        let workspace = self.workspace()?;
        let binary = self
            .inner
            .kits
            .iter()
            .find(|(known, _)| known.id == kit.id)
            .and_then(|(_, binary)| binary.as_ref())
            .filter(|path| path.is_file())
            .ok_or(KitError::NotInstalled { name: kit.name })?;
        let launch_error = |detail: String| KitError::Launch { name: kit.name, detail };
        let process = KitProcess::launch(LaunchOptions::new(binary)).await.map_err(|error| launch_error(error.to_string()))?;
        let root = url::Url::from_directory_path(workspace).map(String::from).map_err(|()| launch_error("the workspace path is not absolute".into()))?;
        let params = |role: Role| InitializeParams {
            protocol_version: PROTOCOL_VERSION,
            token: process.token().to_owned(),
            role,
            client: ClientInfo { name: "Kition".into(), version: env!("CARGO_PKG_VERSION").into() },
            locale: (role == Role::Host).then(|| "en-US".to_owned()),
            appearance: (role == Role::Host).then_some(Appearance::Light),
            workspace_roots: if role == Role::Host { vec![root.clone()] } else { Vec::new() },
        };
        let connect = |role: Role| {
            let params = params(role);
            let process = &process;
            async move {
                let client = process.connect().await.map_err(|error| format!("cannot connect: {error}"))?;
                let result = client.initialize(&params).await.map_err(|error| format!("kit.initialize failed: {error}"))?;
                if result.kit.id != kit.id {
                    return Err(format!("the executable is `{}`, not `{}`", result.kit.id, kit.id));
                }
                Ok::<_, String>(Arc::new(client))
            }
        };
        let host = connect(Role::Host).await.map_err(launch_error)?;
        let agent = connect(Role::Agent).await.map_err(launch_error)?;
        let versions: Versions = Arc::default();
        tokio::spawn(watch_notifications(Arc::clone(&host), Arc::clone(&versions)));
        // The agent connection receives the same notifications; drain them.
        let drained = Arc::clone(&agent);
        tokio::spawn(async move { while drained.next_notification().await.is_some() {} });
        tracing::info!(kit = kit.id, pid = ?process.id(), "kit started");
        Ok(RunningKit { process: tokio::sync::Mutex::new(process), host, agent, versions })
    }

    async fn call<M: RequestMethod>(&self, kit: &'static KitDefinition, caller: Caller, params: &M::Params) -> Result<(Arc<RunningKit>, M::Result), KitError> {
        let running = self.running(kit).await?;
        match running.client(caller).call::<M>(params).await {
            Ok(result) => Ok((running, result)),
            Err(error) => {
                let error = KitError::from_client(kit, error);
                if matches!(error, KitError::Stopped { .. }) {
                    self.inner.running.lock().await.remove(kit.id);
                }
                Err(error)
            }
        }
    }

    fn file_uri(&self, path: &str, own: bool) -> Result<String, KitError> {
        let absolute = self.resolve_in(path, own)?;
        if !absolute.is_file() {
            return Err(KitError::InvalidPath(format!("`{path}` does not exist")));
        }
        url::Url::from_file_path(&absolute).map(String::from).map_err(|()| KitError::InvalidPath(format!("`{path}` is not a local file")))
    }

    /// Opens a workspace file in the kit that handles its extension.
    pub async fn open(&self, caller: Caller, path: &str) -> Result<DocumentView, KitError> {
        self.open_in(caller, path, false).await
    }

    /// [`KitManager::open`] for a file Kition keeps itself under `.kition/` (a draft's copies).
    pub(crate) async fn open_own(&self, caller: Caller, path: &str) -> Result<DocumentView, KitError> {
        self.open_in(caller, path, true).await
    }

    async fn open_in(&self, caller: Caller, path: &str, own: bool) -> Result<DocumentView, KitError> {
        let kit = self.kit_for_path(path).ok_or_else(|| KitError::InvalidPath(format!("no kit opens `{path}`")))?;
        let params = DocumentOpenParams { uri: self.file_uri(path, own)?, read_only: None, create: None };
        let (running, state) = self.call::<methods::DocumentOpen>(kit, caller, &params).await?;
        self.view(kit, &running, caller, state).await
    }

    /// Creates a new document in `folder` (workspace-relative, `""` for the root) with an
    /// unused name from the kit's base name (`Untitled photo`), saves it so it appears in the workspace,
    /// and opens it.
    pub async fn create(&self, caller: Caller, folder: &str, extension: &str, options: Map<String, Value>) -> Result<DocumentView, KitError> {
        let extension = extension.trim_start_matches('.').to_ascii_lowercase();
        let (kit, format) = self
            .inner
            .kits
            .iter()
            .find_map(|(kit, _)| kit.creates.iter().find(|(known, _)| *known == extension).map(|(_, format)| (*kit, *format)))
            .ok_or_else(|| KitError::InvalidPath(format!("no kit creates .{extension} files")))?;
        let directory = if folder.trim().trim_matches('/').is_empty() { self.workspace()?.to_path_buf() } else { self.resolve(folder)? };
        if !directory.is_dir() {
            return Err(KitError::InvalidPath(format!("`{folder}` is not a workspace folder")));
        }
        let base = kit.base_name;
        let target_path = (1..1000)
            .map(|n| {
                let name = if n == 1 { format!("{base}.{extension}") } else { format!("{base} {n}.{extension}") };
                directory.join(name)
            })
            .find(|path| !path.exists())
            .ok_or_else(|| KitError::InvalidPath("too many untitled files in this folder".into()))?;
        self.create_file(caller, kit, format, &target_path, options).await
    }

    /// Opens a new document of `kit` in `format` at `target_path`, saves it so the file exists,
    /// and answers its view.
    async fn create_file(
        &self,
        caller: Caller,
        kit: &'static KitDefinition,
        format: &str,
        target_path: &Path,
        options: Map<String, Value>,
    ) -> Result<DocumentView, KitError> {
        let uri = url::Url::from_file_path(target_path).map(String::from).map_err(|()| KitError::InvalidPath("the folder is not a local path".into()))?;
        let params = DocumentOpenParams { uri, read_only: None, create: Some(CreateDocument { format: format.to_owned(), options: Some(options) }) };
        let (_, state) = self.call::<methods::DocumentOpen>(kit, caller, &params).await?;
        let saved = DocumentRef { document_id: state.document_id.clone() };
        let (running, _) = self.call::<methods::DocumentSave>(kit, caller, &saved).await?;
        let (_, state) = self.state(kit, caller, &saved.document_id).await?;
        self.view(kit, &running, caller, state).await
    }

    /// The agent's `<prefix>_create` (KHP A41): a new document at `path`, a workspace path whose
    /// extension the kit `creates`. A new file never replaces one: when `path` exists the next
    /// free name (`Title 2.kslide`) is used. No hidden segment (A29). Answers its view; its
    /// `path` is the file written.
    pub async fn create_at(&self, caller: Caller, path: &str, options: Map<String, Value>) -> Result<DocumentView, KitError> {
        let extension = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        let (kit, format) = self
            .inner
            .kits
            .iter()
            .find_map(|(kit, _)| kit.creates.iter().find(|(known, _)| *known == extension).map(|(_, format)| (*kit, *format)))
            .ok_or_else(|| KitError::InvalidPath(format!("no kit creates .{extension} files")))?;
        let wanted = self.resolve(path)?;
        if !wanted.parent().is_some_and(Path::is_dir) {
            return Err(KitError::InvalidPath(format!("`{path}` is not in a workspace folder")));
        }
        let target = if wanted.exists() {
            let file = wanted.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_owned();
            let (stem, extension) = file.rsplit_once('.').unwrap_or((file.as_str(), ""));
            (2..1000)
                .map(|n| wanted.with_file_name(if extension.is_empty() { format!("{stem} {n}") } else { format!("{stem} {n}.{extension}") }))
                .find(|candidate| !candidate.exists())
                .ok_or_else(|| KitError::InvalidPath(format!("too many files named like `{path}`")))?
        } else {
            wanted
        };
        self.create_file(caller, kit, format, &target, options).await
    }

    pub async fn document(&self, caller: Caller, kit_id: &str, document_id: &str) -> Result<DocumentView, KitError> {
        let kit = self.definition(kit_id)?;
        let inner = document_id;
        let (running, state) = self.state(kit, caller, inner).await?;
        self.view(kit, &running, caller, state).await
    }

    async fn state(&self, kit: &'static KitDefinition, caller: Caller, document_id: &str) -> Result<(Arc<RunningKit>, DocumentState), KitError> {
        let (running, list) = self.call::<methods::DocumentList>(kit, caller, &Empty {}).await?;
        let state = list
            .documents
            .into_iter()
            .find(|document| document.document_id == document_id)
            .ok_or(KitError::Kit { reason: Some(ErrorReason::DocumentNotFound), message: "the document is not open".into() })?;
        Ok((running, state))
    }

    pub(crate) async fn view(&self, kit: &'static KitDefinition, running: &RunningKit, caller: Caller, state: DocumentState) -> Result<DocumentView, KitError> {
        let described = running
            .client(caller)
            .call::<methods::ViewDescribe>(&DocumentRef { document_id: state.document_id.clone() })
            .await
            .map_err(|error| KitError::from_client(kit, error))?;
        Ok(DocumentView {
            kit_id: kit.id,
            version: running.version(&state.document_id),
            path: state.uri.as_deref().and_then(|uri| self.relative(uri)),
            document_id: state.document_id.clone(),
            title: state.title,
            format: state.format,
            read_only: state.read_only,
            dirty: state.dirty,
            can_undo: state.can_undo,
            can_redo: state.can_redo,
            summary: described.summary,
            details: described.state,
        })
    }

    /// A PNG of the document, at most `max_size` pixels on its longer side.
    pub async fn preview(&self, kit_id: &str, document_id: &str, max_size: u32) -> Result<Vec<u8>, KitError> {
        use base64::Engine as _;
        let kit = self.definition(kit_id)?;
        let inner = document_id;
        let params = ViewScreenshotParams { document_id: inner.to_owned(), scope: ScreenshotScope::Canvas, max_size: Some(max_size.clamp(16, 4096)) };
        let (_, image) = self.call::<methods::ViewScreenshot>(kit, Caller::User, &params).await?;
        base64::engine::general_purpose::STANDARD
            .decode(image.data)
            .map_err(|error| KitError::Kit { reason: None, message: format!("the kit sent an unreadable image: {error}") })
    }

    /// Commands, optionally limited to those whose id, title, or description contains `query`.
    pub async fn commands(&self, caller: Caller, kit_id: &str, document_id: Option<&str>, query: Option<&str>) -> Result<Vec<CommandView>, KitError> {
        let kit = self.definition(kit_id)?;
        let inner = document_id;
        let params = CommandsListParams { document_id: inner.map(str::to_owned), groups: None };
        let (_, list) = self.call::<methods::CommandsList>(kit, caller, &params).await?;
        // Ranked, not all-words: each command scores the words of the query it contains (in its
        // id, title, description or menu, with a few synonyms and plurals); the best come first.
        // A query no command shares a word with still answers the closest commands, never none.
        let terms: Vec<Vec<String>> = query.unwrap_or_default().split_whitespace().map(|term| search_variants(&term.to_lowercase())).collect();
        // Keywords (the effect names effect.apply takes, …) count as the description does.
        let fields: Vec<(String, String, String)> = list
            .commands
            .iter()
            .map(|command| {
                (
                    command.id.to_lowercase(),
                    command.title.to_lowercase(),
                    format!("{} {:?} {}", command.description.as_deref().unwrap_or_default(), command.menu, command.keywords.join(" | ")).to_lowercase(),
                )
            })
            .collect();
        let has = |(id, title, rest): &(String, String, String), v: &str| id.contains(v) || title.contains(v) || rest.contains(v);
        let n = fields.len() as f64;
        let weights: Vec<f64> = terms
            .iter()
            .map(|variants| {
                let df = fields.iter().filter(|f| variants.iter().any(|v| has(f, v))).count() as f64;
                ((n + 1.0) / (df + 1.0)).ln() + 0.1
            })
            .collect();
        let mut scored: Vec<(f64, _, bool)> = list
            .commands
            .into_iter()
            .zip(fields.iter())
            .map(|(command, (id, title, rest))| {
                let all_words = !terms.is_empty()
                    && terms.iter().all(|variants| variants.iter().any(|v| id.contains(v.as_str()) || title.contains(v.as_str()) || rest.contains(v.as_str())));
                let score: f64 = terms
                    .iter()
                    .zip(&weights)
                    .map(|(variants, weight)| {
                        let field = if variants.iter().any(|v| id.contains(v.as_str())) {
                            3.0
                        } else if variants.iter().any(|v| title.contains(v.as_str())) {
                            2.0
                        } else if variants.iter().any(|v| rest.contains(v.as_str())) {
                            1.0
                        } else if variants.iter().any(|v| v.len() >= 4 && (id.contains(&v[..4]) || title.contains(&v[..4]))) {
                            0.5
                        } else {
                            0.0
                        };
                        field * weight
                    })
                    .sum();
                (score, command, all_words)
            })
            .collect();
        let matched = terms.is_empty() || scored.iter().any(|(score, _, _)| *score > 0.0);
        if matched {
            if !terms.is_empty() {
                scored.retain(|(score, _, _)| *score > 0.0);
            }
        } else {
            // No command shares a word with the query: rank by spelling (the share of the query's
            // three-letter pieces found in the command's id and title), so the answer is the
            // closest commands, never the list's first ones (search never returns empty).
            let query = query.unwrap_or_default().to_lowercase();
            for (score, command, _) in &mut scored {
                *score = spelling(&query, &format!("{} {}", command.id, command.title).to_lowercase());
            }
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        Ok(scored
            .into_iter()
            .map(|(_, command, all_words)| CommandView {
                all_words,
                // The keywords the query names, so the agent sees what matched (an effect's name).
                // Those with the most of the query's words first (`gaussian blur` names Gaussian
                // Blur before the other blurs), then in the kit's order.
                matched: {
                    let mut hits: Vec<(usize, &String)> = command
                        .keywords
                        .iter()
                        .map(|keyword| {
                            let keyword_lower = keyword.to_lowercase();
                            (terms.iter().filter(|variants| variants.iter().any(|v| keyword_lower.contains(v.as_str()))).count(), keyword)
                        })
                        .filter(|(words, _)| *words > 0)
                        .collect();
                    hits.sort_by_key(|hit| std::cmp::Reverse(hit.0));
                    hits.into_iter().take(8).map(|(_, keyword)| keyword.clone()).collect()
                },
                id: command.id,
                title: command.title,
                description: command.description,
                group: command.group,
                params: command.params,
                output: command.output,
                mutates: command.mutates,
                enabled: command.enabled,
                menu: command.menu,
                shortcut: command.shortcut,
                closest: !matched,
            })
            .collect())
    }

    pub async fn execute(&self, caller: Caller, kit_id: &str, document_id: &str, command: &str, params: Map<String, Value>) -> Result<ExecuteView, KitError> {
        let kit = self.definition(kit_id)?;
        let inner = document_id;
        let request = CommandsExecuteParams {
            document_id: inner.to_owned(),
            command: command.to_owned(),
            params,
            origin: match caller {
                Caller::User => Origin::User,
                Caller::Agent => Origin::Agent,
            },
        };
        let (_, executed) = self.call::<methods::CommandsExecute>(kit, caller, &request).await?;
        let document = self.document(caller, kit_id, document_id).await?;
        Ok(ExecuteView { changed: executed.changed, result: executed.result, document })
    }

    /// The kit's diagnostics on the document (KHP A21, `document.check`):
    /// `{ "diagnostics": [...] }`, or `None` when the running kit predates the method.
    pub async fn check(&self, caller: Caller, kit_id: &str, document_id: &str) -> Result<Option<Value>, KitError> {
        let kit = self.definition(kit_id)?;
        let inner = document_id;
        let running = self.running(kit).await?;
        match running.client(caller).request("document.check", serde_json::json!({ "documentId": inner }), None).await {
            Ok(answer) => Ok(Some(answer)),
            Err(ClientError::Rpc(error)) if error.code == -32601 => Ok(None),
            Err(error) => Err(KitError::from_client(kit, error)),
        }
    }

    /// An object-model request of the Kit Protocol (`model.describe`, `model.batch`) on an open
    /// document; `params` gets the document's id. A refused batch is [`KitError::Model`]; a kit
    /// that serves no object model answers [`KitError::Kit`] with no reason (method not found).
    pub async fn model(&self, caller: Caller, kit_id: &str, document_id: &str, method: &str, mut params: Map<String, Value>) -> Result<Value, KitError> {
        let kit = self.definition(kit_id)?;
        let inner = document_id;
        params.insert("documentId".into(), Value::String(inner.to_owned()));
        let running = self.running(kit).await?;
        match running.client(caller).request(method, Value::Object(params), None).await {
            Ok(answer) => {
                if method == "model.describe" {
                    self.remember_described(kit.id, &answer);
                }
                Ok(answer)
            }
            Err(ClientError::Rpc(error)) if error.data.as_ref().and_then(|data| data.get("model")).is_some_and(Value::is_object) => {
                let model = &error.data.as_ref().map_or(Value::Null, |data| data["model"].clone());
                Err(KitError::Model {
                    code: model["code"].as_str().unwrap_or("invalid-op").to_owned(),
                    index: model["index"].as_u64().and_then(|index| usize::try_from(index).ok()),
                    message: model["message"].as_str().map_or_else(|| error.message.clone(), str::to_owned),
                })
            }
            Err(error) => {
                let error = KitError::from_client(kit, error);
                if matches!(error, KitError::Stopped { .. }) {
                    self.inner.running.lock().await.remove(kit.id);
                }
                Err(error)
            }
        }
    }

    /// Closes the running headless kits' documents of the workspace file `path`, dropping their
    /// unsaved changes: the file changed under them.
    pub async fn close_file(&self, path: &str) {
        let running: Vec<Arc<RunningKit>> = self.inner.running.lock().await.values().cloned().collect();
        for kit in running {
            let Ok(list) = kit.host.call::<methods::DocumentList>(&Empty {}).await else {
                continue;
            };
            for document in list.documents {
                let here = document.uri.as_deref().and_then(|uri| self.relative(uri));
                if here.as_deref() == Some(path) {
                    let params = DocumentCloseParams { document_id: document.document_id, discard_changes: Some(true) };
                    let _ = kit.host.call::<methods::DocumentClose>(&params).await;
                }
            }
        }
    }

    /// The workspace files open in the running headless kits, as `(kit id, path)`.
    pub async fn open_files(&self) -> Vec<(&'static str, String)> {
        let running: Vec<(&'static str, Arc<RunningKit>)> = self.inner.running.lock().await.iter().map(|(id, kit)| (*id, Arc::clone(kit))).collect();
        let mut files = Vec::new();
        for (kit_id, kit) in running {
            let Ok(list) = kit.agent.call::<methods::DocumentList>(&Empty {}).await else {
                continue;
            };
            files.extend(list.documents.iter().filter_map(|document| document.uri.as_deref()).filter_map(|uri| self.relative(uri)).map(|path| (kit_id, path)));
        }
        files
    }

    pub async fn save(&self, caller: Caller, kit_id: &str, document_id: &str) -> Result<DocumentView, KitError> {
        let kit = self.definition(kit_id)?;
        let inner = document_id;
        let params = DocumentRef { document_id: inner.to_owned() };
        self.call::<methods::DocumentSave>(kit, caller, &params).await?;
        let view = self.document(caller, kit_id, document_id).await?;
        if let Some(path) = view.path.clone() {
            let _ = self.inner.saves.send(SavedFile { kit_id: view.kit_id, path, document_id: document_id.to_owned() });
        }
        Ok(view)
    }

    /// Hears every headless save of a workspace file from now on.
    pub fn subscribe_saves(&self) -> tokio::sync::broadcast::Receiver<SavedFile> {
        self.inner.saves.subscribe()
    }

    pub async fn close(&self, kit_id: &str, document_id: &str, discard_changes: bool) -> Result<(), KitError> {
        let kit = self.definition(kit_id)?;
        let inner = document_id;
        let params = DocumentCloseParams { document_id: inner.to_owned(), discard_changes: Some(discard_changes) };
        self.call::<methods::DocumentClose>(kit, Caller::User, &params).await?;
        Ok(())
    }

    /// Writes `bytes` to the workspace file `path`, crash-safely: the bytes go to a temporary file
    /// beside the target, which is then renamed over it. `write` says what the write may do: a
    /// save replaces only the document it names, which some kit edits; any other write makes a new
    /// file and never replaces one (the in-page editors' `host/write` modes, Kit UI protocol). So
    /// one kit's editor never overwrites another file, its own kind or another kit's.
    pub fn write_file(&self, path: &str, bytes: &[u8], write: FileWrite<'_>) -> Result<(), KitError> {
        let edited = self.kit_for_path(path).is_some();
        let target = self.resolve(path)?;
        match write {
            FileWrite::Save { document } => {
                if !edited {
                    return Err(KitError::InvalidPath(format!("no kit edits `{path}`")));
                }
                if self.resolve(document)? != target {
                    return Err(KitError::InvalidPath(format!("`{path}` is not `{document}`, the document this save is for")));
                }
            }
            FileWrite::New => {
                let extension = path.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).unwrap_or_default();
                let export = self.inner.kits.iter().any(|(kit, _)| kit.exports.contains(&extension.as_str()));
                if !edited && !export {
                    return Err(KitError::InvalidPath(format!("no kit edits `{path}`")));
                }
                if target.exists() {
                    return Err(KitError::InvalidPath(format!("`{path}` exists; a new file never replaces one")));
                }
            }
        }
        let missing = || KitError::InvalidPath(format!("the folder of `{path}` does not exist"));
        let parent = target.parent().ok_or_else(missing)?;
        if !parent.is_dir() {
            // A new file may start a folder of its own (an image pasted into a note goes to the
            // note's attachments folder); a save writes over its document where it is.
            match write {
                FileWrite::New => self.make_folders(path, parent)?,
                FileWrite::Save { .. } => return Err(missing()),
            }
        }
        let name = target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let temporary = parent.join(format!(".{name}.kition-{}.tmp", std::process::id()));
        let written = std::fs::write(&temporary, bytes).and_then(|()| std::fs::rename(&temporary, &target));
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(KitError::Kit { reason: Some(ErrorReason::IoError), message: format!("could not save `{path}`: {}", error.kind()) });
        }
        Ok(())
    }

    /// Makes the missing folders of a new file at `path` (`folder`, inside the workspace): never
    /// through a link out of the workspace, and never a hidden folder.
    fn make_folders(&self, path: &str, folder: &Path) -> Result<(), KitError> {
        let workspace = self.workspace()?;
        let invalid = || KitError::InvalidPath(format!("`{path}` is not a workspace path"));
        let mut existing = folder;
        while !existing.exists() {
            existing = existing.parent().ok_or_else(invalid)?;
        }
        let real = std::fs::canonicalize(existing).map_err(|_| invalid())?;
        if !real.starts_with(workspace) || !real.is_dir() {
            return Err(invalid());
        }
        let made = folder.strip_prefix(existing).map_err(|_| invalid())?;
        if made.components().any(|part| part.as_os_str().to_string_lossy().starts_with('.')) {
            return Err(invalid());
        }
        std::fs::create_dir_all(real.join(made))
            .map_err(|error| KitError::Kit { reason: Some(ErrorReason::IoError), message: format!("could not make the folder of `{path}`: {}", error.kind()) })
    }

    /// Asks every running kit to exit.
    pub async fn shutdown(&self) {
        let stopping: Vec<Arc<RunningKit>> = self.inner.running.lock().await.drain().map(|(_, kit)| kit).collect();
        for kit in stopping {
            kit.stop().await;
        }
    }

    /// Resolves a workspace-relative path without letting it leave the workspace.
    /// A workspace path from a person or an agent, as a file system path. It is refused, the same
    /// way whether the file exists or not (KHP A29), when it leaves the workspace (`..`, an
    /// absolute path, or a symbolic link out) or has a hidden segment (`.git/`, `.env`, Kition's
    /// own `.kition/`): [`KitError::NotAllowed`].
    pub(crate) fn resolve(&self, path: &str) -> Result<PathBuf, KitError> {
        self.resolve_in(path, false)
    }

    /// [`KitManager::resolve`] for a path Kition makes itself, which may be under `.kition/`
    /// (drafts).
    pub(crate) fn resolve_own(&self, path: &str) -> Result<PathBuf, KitError> {
        self.resolve_in(path, true)
    }

    fn resolve_in(&self, path: &str, own: bool) -> Result<PathBuf, KitError> {
        let workspace = self.workspace()?;
        let outside = || KitError::NotAllowed(format!("`{path}` is outside the workspace"));
        let given = path.trim();
        // An absolute path is a workspace path only when it lies in the workspace.
        let relative = if Path::new(given).is_absolute() {
            let absolute = Path::new(given);
            let existing = absolute.ancestors().find(|ancestor| ancestor.exists()).ok_or_else(outside)?;
            let real = std::fs::canonicalize(existing).map_err(|_| outside())?;
            let rest = absolute.strip_prefix(existing).map_err(|_| outside())?;
            let inside = real.strip_prefix(workspace).map_err(|_| outside())?.join(rest);
            inside.to_str().ok_or_else(outside)?.replace(std::path::MAIN_SEPARATOR, "/")
        } else {
            given.to_owned()
        };
        let trimmed = relative.as_str();
        if trimmed.is_empty() || trimmed.contains('\\') {
            return Err(KitError::InvalidPath(format!("`{path}` is not a workspace path")));
        }
        let mut absolute = workspace.to_path_buf();
        for part in trimmed.split('/') {
            if part.is_empty() || part == "." || part == ".." || Path::new(part).is_absolute() {
                return Err(outside());
            }
            if part.starts_with('.') && !own {
                return Err(KitError::NotAllowed(format!("`{path}` names a hidden file or folder")));
            }
            absolute.push(part);
        }
        // Where the path really leads: its nearest existing folder, resolved, so a link out of
        // the workspace is refused for a new file too.
        let existing = absolute.ancestors().find(|ancestor| ancestor.exists()).unwrap_or(workspace);
        match std::fs::canonicalize(existing) {
            Ok(real) if real.starts_with(workspace) => Ok(match std::fs::canonicalize(&absolute) {
                Ok(real) => real,
                Err(_) => absolute,
            }),
            _ => Err(outside()),
        }
    }

    fn relative(&self, uri: &str) -> Option<String> {
        let workspace = self.inner.workspace.as_deref()?;
        let path = url::Url::parse(uri).ok()?.to_file_path().ok()?;
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        let relative = path.strip_prefix(workspace).ok()?;
        let parts: Option<Vec<&str>> = relative
            .components()
            .map(|component| match component {
                Component::Normal(part) => part.to_str(),
                _ => None,
            })
            .collect();
        Some(parts?.join("/"))
    }
}

async fn watch_notifications(host: Arc<KitClient>, versions: Versions) {
    while let Some(notification) = host.next_notification().await {
        if notification.method != methods::DocumentDidChangeState::NAME {
            continue;
        }
        let Some(id) = notification.params.as_ref().and_then(|params| params.get("documentId")).and_then(Value::as_str) else {
            continue;
        };
        *versions.lock().unwrap_or_else(PoisonError::into_inner).entry(id.to_owned()).or_default() += 1;
    }
}

/// How much of `query` is spelled in `text`: the share of the query's three-letter pieces
/// (`mp4` → ` mp`, `mp4`, `p4 `) that occur in `text`, 0 to 1.
fn spelling(query: &str, text: &str) -> f64 {
    let pieces = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_alphanumeric())
            .filter(|word| !word.is_empty())
            .flat_map(|word| {
                let padded: Vec<char> = format!(" {word} ").chars().collect();
                padded.windows(3).map(|w| w.iter().collect::<String>()).collect::<Vec<_>>()
            })
            .collect()
    };
    let wanted = pieces(query);
    if wanted.is_empty() {
        return 0.0;
    }
    let have = pieces(text);
    wanted.iter().filter(|piece| have.contains(piece)).count() as f64 / wanted.len() as f64
}

/// A query word and the words it may be written as in a command (plural, synonyms).
fn search_variants(term: &str) -> Vec<String> {
    let mut out = vec![term.to_owned()];
    if term.len() > 3 && term.ends_with('s') {
        out.push(term[..term.len() - 1].to_owned());
    }
    let synonyms: &[(&str, &[&str])] = &[
        ("colour", &["color"]),
        ("color", &["colour", "fill"]),
        ("reorder", &["move", "order"]),
        ("remove", &["delete"]),
        ("erase", &["delete"]),
        ("copy", &["duplicate"]),
        ("enter", &["edit"]),
        ("change", &["set", "edit"]),
        ("modify", &["set", "edit"]),
        ("replace", &["set"]),
        ("values", &["data", "series"]),
        ("value", &["data", "series"]),
        ("resize", &["size", "bounds"]),
        ("position", &["move", "bounds"]),
        ("typeface", &["font"]),
        ("bigger", &["grow", "size"]),
    ];
    for (word, alts) in synonyms {
        if term == *word {
            out.extend(alts.iter().map(|a| (*a).to_owned()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn spelling_ranks_the_commands_a_query_spells_closest() {
        assert_eq!(super::spelling("mp4", "renderqueue.add add to render queue"), 0.0);
        assert!(super::spelling("renderqeue", "renderqueue.add add to render queue") > super::spelling("renderqeue", "layer.newtext new text layer"));
        assert_eq!(super::spelling("", "anything"), 0.0);
        assert_eq!(super::spelling("text", "layer.newtext text"), 1.0);
    }
}
