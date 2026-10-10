//! Running kits for the open workspace.
//!
//! A kit starts on first use in the `headless` surface with the workspace folder as its only
//! root; it serves previews, kit tabs in the browser, and the agent. A kit tab in the desktop app
//! starts its own kit process in the `embedded` surface instead, whose native editor window the
//! runtime keeps over the tab (`surfaces.rs`). Each kit process gets two connections: the `host`
//! connection serves people, and an `agent` connection serves agent tools, so the kit itself
//! enforces the agent's role and URI limits. Kits stop when the manager is dropped, which happens
//! when the runtime restarts for another workspace.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use kition_kit_host::{ClientError, KitClient, KitProcess, LaunchOptions};
use kition_kit_protocol::launch::Surface;
use kition_kit_protocol::methods::{self, NotificationMethod, RequestMethod};
use kition_kit_protocol::types::*;
use kition_kit_protocol::{ErrorReason, PROTOCOL_VERSION};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::surfaces::SurfaceKit;

/// A kit Kition knows how to use.
#[derive(Debug)]
pub struct KitDefinition {
    pub id: &'static str,
    pub name: &'static str,
    /// The environment variable that points at a local build of the kit executable.
    pub binary_env: &'static str,
    /// Lowercase extensions, without the dot, that open in this kit.
    pub extensions: &'static [&'static str],
    /// Extensions Kition can create new documents in, with the kit's format id for each.
    pub creates: &'static [(&'static str, &'static str)],
    /// Whether the kit's own editor can be embedded in a desktop tab.
    pub embeds: bool,
}

pub const KITS: &[KitDefinition] = &[KitDefinition {
    id: "kit.photo",
    name: "Kition Photo",
    binary_env: "KITION_KIT_PHOTO_BINARY",
    extensions: &["psd", "psb", "pcraft"],
    creates: &[("psd", "psd"), ("psb", "psb"), ("pcraft", "pcraft")],
    embeds: true,
}];

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
    #[error("{name} is not installed. Set {binary_env} to a kit-photo build and restart Kition.")]
    NotInstalled {
        name: &'static str,
        binary_env: &'static str,
    },
    #[error("open a workspace folder first")]
    NoWorkspace,
    #[error("{0}")]
    InvalidPath(String),
    #[error("{name} could not start: {detail}")]
    Launch { name: &'static str, detail: String },
    #[error("{name} stopped. Open the file again.")]
    Stopped { name: &'static str },
    #[error("{0}")]
    Unavailable(String),
    #[error("{message}")]
    Kit {
        reason: Option<ErrorReason>,
        message: String,
    },
}

impl KitError {
    pub(crate) fn from_client(kit: &'static KitDefinition, error: ClientError) -> Self {
        match error {
            ClientError::Rpc(error) => {
                let detail = error
                    .data
                    .as_ref()
                    .and_then(|data| data.get("detail"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let message = match detail {
                    Some(detail) if !detail.is_empty() => format!("{}: {detail}", error.message),
                    _ => error.message.clone(),
                };
                Self::Kit {
                    reason: error.reason(),
                    message,
                }
            }
            ClientError::Closed | ClientError::Io(_) => Self::Stopped { name: kit.name },
            other => Self::Kit {
                reason: None,
                message: other.to_string(),
            },
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
    /// Whether kit tabs can show the kit's own editor here (desktop app on a supported OS).
    pub embeddable: bool,
    pub binary_env: &'static str,
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
    pub mutates: bool,
    pub enabled: bool,
    pub menu: Vec<String>,
    pub shortcut: Option<String>,
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
    /// The kit's own window has keyboard focus (embedded surfaces).
    pub(crate) focused: Arc<AtomicBool>,
    /// Woken by focus notifications.
    pub(crate) focus_changed: Arc<tokio::sync::Notify>,
}

impl RunningKit {
    pub(crate) fn client(&self, caller: Caller) -> &KitClient {
        match caller {
            Caller::User => &self.host,
            Caller::Agent => &self.agent,
        }
    }

    fn version(&self, document_id: &str) -> u64 {
        self.versions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(document_id)
            .copied()
            .unwrap_or(0)
    }

    pub(crate) async fn stop(&self) {
        let _ = self.host.call::<methods::Shutdown>(&Empty {}).await;
        let mut process = self.process.lock().await;
        if process
            .wait_for_exit(kition_kit_protocol::launch::SHUTDOWN_TIMEOUT)
            .await
            .is_none()
        {
            process.kill().await;
        }
    }
}

/// Which kit process serves a document: the shared headless one or a tab's embedded one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Headless,
    Surface(u64),
}

/// Document ids from embedded surfaces carry their surface: `s<surface>::<kit document id>`.
pub(crate) fn split_document_id(id: &str) -> (Target, &str) {
    if let Some(rest) = id.strip_prefix('s')
        && let Some((surface, inner)) = rest.split_once("::")
        && let Ok(surface) = surface.parse()
    {
        return (Target::Surface(surface), inner);
    }
    (Target::Headless, id)
}

fn external_document_id(target: Target, inner: &str) -> String {
    match target {
        Target::Headless => inner.to_owned(),
        Target::Surface(surface) => format!("s{surface}::{inner}"),
    }
}

pub(crate) struct Inner {
    workspace: Option<PathBuf>,
    /// Known kits and their executables, when installed.
    kits: Vec<(&'static KitDefinition, Option<PathBuf>)>,
    running: tokio::sync::Mutex<HashMap<&'static str, Arc<RunningKit>>>,
    pub(crate) surfaces: tokio::sync::Mutex<HashMap<u64, Arc<SurfaceKit>>>,
    pub(crate) next_surface: AtomicU64,
}

/// The kits of one workspace. Cheap to clone.
#[derive(Clone)]
pub struct KitManager {
    pub(crate) inner: Arc<Inner>,
}

impl KitManager {
    /// Kits for `workspace`, with executables from each kit's environment variable.
    pub fn from_env(workspace: Option<PathBuf>) -> Self {
        let kits = KITS
            .iter()
            .map(|kit| {
                let binary = std::env::var_os(kit.binary_env)
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from);
                (kit, binary)
            })
            .collect();
        Self::new(workspace, kits)
    }

    pub fn new(
        workspace: Option<PathBuf>,
        kits: Vec<(&'static KitDefinition, Option<PathBuf>)>,
    ) -> Self {
        let workspace = workspace.map(|dir| std::fs::canonicalize(&dir).unwrap_or(dir));
        Self {
            inner: Arc::new(Inner {
                workspace,
                kits,
                running: tokio::sync::Mutex::new(HashMap::new()),
                surfaces: tokio::sync::Mutex::new(HashMap::new()),
                next_surface: AtomicU64::new(1),
            }),
        }
    }

    pub fn statuses(&self) -> Vec<KitStatus> {
        let host = crate::host::current();
        self.inner
            .kits
            .iter()
            .map(|(kit, binary)| KitStatus {
                id: kit.id,
                name: kit.name,
                extensions: kit.extensions.to_vec(),
                creates: kit
                    .creates
                    .iter()
                    .map(|(extension, _)| *extension)
                    .collect(),
                installed: binary.as_deref().is_some_and(Path::is_file),
                embeddable: kit.embeds && host.known && crate::surfaces::SUPPORTED,
                binary_env: kit.binary_env,
            })
            .collect()
    }

    pub(crate) fn definition(&self, id: &str) -> Result<&'static KitDefinition, KitError> {
        self.inner
            .kits
            .iter()
            .map(|(kit, _)| *kit)
            .find(|kit| kit.id == id)
            .ok_or_else(|| KitError::UnknownKit(id.to_owned()))
    }

    /// The kit that opens a workspace path, by extension.
    pub fn kit_for_path(&self, path: &str) -> Option<&'static KitDefinition> {
        let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
        self.inner
            .kits
            .iter()
            .map(|(kit, _)| *kit)
            .find(|kit| kit.extensions.contains(&extension.as_str()))
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
        let started = Arc::new(self.launch(kit, Surface::Headless).await?);
        running.insert(kit.id, Arc::clone(&started));
        Ok(started)
    }

    pub(crate) async fn launch(
        &self,
        kit: &'static KitDefinition,
        surface: Surface,
    ) -> Result<RunningKit, KitError> {
        let workspace = self.workspace()?;
        let binary = self
            .inner
            .kits
            .iter()
            .find(|(known, _)| known.id == kit.id)
            .and_then(|(_, binary)| binary.as_ref())
            .filter(|path| path.is_file())
            .ok_or(KitError::NotInstalled {
                name: kit.name,
                binary_env: kit.binary_env,
            })?;
        let launch_error = |detail: String| KitError::Launch {
            name: kit.name,
            detail,
        };
        let process = KitProcess::launch(LaunchOptions::new(binary, surface))
            .await
            .map_err(|error| launch_error(error.to_string()))?;
        let root = url::Url::from_directory_path(workspace)
            .map(String::from)
            .map_err(|()| launch_error("the workspace path is not absolute".into()))?;
        let params = |role: Role| InitializeParams {
            protocol_version: PROTOCOL_VERSION,
            token: process.token().to_owned(),
            role,
            client: ClientInfo {
                name: "Kition".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            locale: (role == Role::Host).then(|| "en-US".to_owned()),
            appearance: (role == Role::Host).then_some(Appearance::Light),
            reserved_shortcuts: Vec::new(),
            workspace_roots: if role == Role::Host {
                vec![root.clone()]
            } else {
                Vec::new()
            },
        };
        let connect = |role: Role| {
            let params = params(role);
            let process = &process;
            async move {
                let client = process
                    .connect()
                    .await
                    .map_err(|error| format!("cannot connect: {error}"))?;
                let result = client
                    .initialize(&params)
                    .await
                    .map_err(|error| format!("kit.initialize failed: {error}"))?;
                if result.kit.id != kit.id {
                    return Err(format!(
                        "the executable is `{}`, not `{}`",
                        result.kit.id, kit.id
                    ));
                }
                Ok::<_, String>(Arc::new(client))
            }
        };
        let host = connect(Role::Host).await.map_err(launch_error)?;
        let agent = connect(Role::Agent).await.map_err(launch_error)?;
        let versions: Versions = Arc::default();
        let focused = Arc::new(AtomicBool::new(false));
        let focus_changed = Arc::new(tokio::sync::Notify::new());
        tokio::spawn(watch_notifications(
            Arc::clone(&host),
            Arc::clone(&versions),
            Arc::clone(&focused),
            Arc::clone(&focus_changed),
        ));
        // The agent connection receives the same notifications; drain them.
        let drained = Arc::clone(&agent);
        tokio::spawn(async move { while drained.next_notification().await.is_some() {} });
        tracing::info!(kit = kit.id, surface = surface.as_env(), pid = ?process.id(), "kit started");
        Ok(RunningKit {
            process: tokio::sync::Mutex::new(process),
            host,
            agent,
            versions,
            focused,
            focus_changed,
        })
    }

    async fn instance(
        &self,
        kit: &'static KitDefinition,
        target: Target,
    ) -> Result<Arc<RunningKit>, KitError> {
        match target {
            Target::Headless => self.running(kit).await,
            Target::Surface(id) => self
                .inner
                .surfaces
                .lock()
                .await
                .get(&id)
                .map(|surface| Arc::clone(&surface.running))
                .ok_or(KitError::Stopped { name: kit.name }),
        }
    }

    async fn call<M: RequestMethod>(
        &self,
        kit: &'static KitDefinition,
        target: Target,
        caller: Caller,
        params: &M::Params,
    ) -> Result<(Arc<RunningKit>, M::Result), KitError> {
        let running = self.instance(kit, target).await?;
        match running.client(caller).call::<M>(params).await {
            Ok(result) => Ok((running, result)),
            Err(error) => {
                let error = KitError::from_client(kit, error);
                if matches!(error, KitError::Stopped { .. }) {
                    match target {
                        Target::Headless => {
                            self.inner.running.lock().await.remove(kit.id);
                        }
                        Target::Surface(id) => {
                            self.inner.surfaces.lock().await.remove(&id);
                        }
                    }
                }
                Err(error)
            }
        }
    }

    pub(crate) fn file_uri(&self, path: &str) -> Result<String, KitError> {
        let absolute = self.resolve(path)?;
        if !absolute.is_file() {
            return Err(KitError::InvalidPath(format!("`{path}` does not exist")));
        }
        url::Url::from_file_path(&absolute)
            .map(String::from)
            .map_err(|()| KitError::InvalidPath(format!("`{path}` is not a local file")))
    }

    /// Opens a workspace file in the kit that handles its extension. The agent works on the
    /// editor a tab shows for the file, when there is one, so the person sees its edits live.
    pub async fn open(&self, caller: Caller, path: &str) -> Result<DocumentView, KitError> {
        let kit = self
            .kit_for_path(path)
            .ok_or_else(|| KitError::InvalidPath(format!("no kit opens `{path}`")))?;
        let target = match caller {
            Caller::Agent => self
                .surface_for_path(path)
                .await
                .map_or(Target::Headless, |surface| Target::Surface(surface.id)),
            Caller::User => Target::Headless,
        };
        let params = DocumentOpenParams {
            uri: self.file_uri(path)?,
            read_only: None,
            create: None,
        };
        let (running, state) = self
            .call::<methods::DocumentOpen>(kit, target, caller, &params)
            .await?;
        self.view(kit, target, &running, caller, state).await
    }

    /// Creates a new document in `folder` (workspace-relative, `""` for the root) with an
    /// unused `Untitled image` name, saves it so it appears in the workspace, and opens it.
    pub async fn create(
        &self,
        caller: Caller,
        folder: &str,
        extension: &str,
        options: Map<String, Value>,
    ) -> Result<DocumentView, KitError> {
        let extension = extension.trim_start_matches('.').to_ascii_lowercase();
        let (kit, format) = self
            .inner
            .kits
            .iter()
            .find_map(|(kit, _)| {
                kit.creates
                    .iter()
                    .find(|(known, _)| *known == extension)
                    .map(|(_, format)| (*kit, *format))
            })
            .ok_or_else(|| KitError::InvalidPath(format!("no kit creates .{extension} files")))?;
        let directory = if folder.trim().trim_matches('/').is_empty() {
            self.workspace()?.to_path_buf()
        } else {
            self.resolve(folder)?
        };
        if !directory.is_dir() {
            return Err(KitError::InvalidPath(format!(
                "`{folder}` is not a workspace folder"
            )));
        }
        let target_path = (1..1000)
            .map(|n| {
                let name = if n == 1 {
                    format!("Untitled image.{extension}")
                } else {
                    format!("Untitled image {n}.{extension}")
                };
                directory.join(name)
            })
            .find(|path| !path.exists())
            .ok_or_else(|| {
                KitError::InvalidPath("too many untitled images in this folder".into())
            })?;
        let uri = url::Url::from_file_path(&target_path)
            .map(String::from)
            .map_err(|()| KitError::InvalidPath("the folder is not a local path".into()))?;
        let params = DocumentOpenParams {
            uri,
            read_only: None,
            create: Some(CreateDocument {
                format: format.to_owned(),
                options: Some(options),
            }),
        };
        let (_, state) = self
            .call::<methods::DocumentOpen>(kit, Target::Headless, caller, &params)
            .await?;
        let saved = DocumentRef {
            document_id: state.document_id.clone(),
        };
        let (running, _) = self
            .call::<methods::DocumentSave>(kit, Target::Headless, caller, &saved)
            .await?;
        let (_, state) = self
            .state(kit, Target::Headless, caller, &saved.document_id)
            .await?;
        self.view(kit, Target::Headless, &running, caller, state)
            .await
    }

    pub async fn document(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: &str,
    ) -> Result<DocumentView, KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let (running, state) = self.state(kit, target, caller, inner).await?;
        self.view(kit, target, &running, caller, state).await
    }

    async fn state(
        &self,
        kit: &'static KitDefinition,
        target: Target,
        caller: Caller,
        document_id: &str,
    ) -> Result<(Arc<RunningKit>, DocumentState), KitError> {
        let (running, list) = self
            .call::<methods::DocumentList>(kit, target, caller, &Empty {})
            .await?;
        let state = list
            .documents
            .into_iter()
            .find(|document| document.document_id == document_id)
            .ok_or(KitError::Kit {
                reason: Some(ErrorReason::DocumentNotFound),
                message: "the document is not open".into(),
            })?;
        Ok((running, state))
    }

    pub(crate) async fn view(
        &self,
        kit: &'static KitDefinition,
        target: Target,
        running: &RunningKit,
        caller: Caller,
        state: DocumentState,
    ) -> Result<DocumentView, KitError> {
        let described = running
            .client(caller)
            .call::<methods::ViewDescribe>(&DocumentRef {
                document_id: state.document_id.clone(),
            })
            .await
            .map_err(|error| KitError::from_client(kit, error))?;
        Ok(DocumentView {
            kit_id: kit.id,
            version: running.version(&state.document_id),
            path: state.uri.as_deref().and_then(|uri| self.relative(uri)),
            document_id: external_document_id(target, &state.document_id),
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

    /// A PNG of the document, at most `max_size` pixels on its longer side. An embedded editor
    /// answers with its window.
    pub async fn preview(
        &self,
        kit_id: &str,
        document_id: &str,
        max_size: u32,
    ) -> Result<Vec<u8>, KitError> {
        use base64::Engine as _;
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let params = ViewScreenshotParams {
            document_id: inner.to_owned(),
            scope: ScreenshotScope::Canvas,
            max_size: Some(max_size.clamp(16, 4096)),
        };
        let (_, image) = self
            .call::<methods::ViewScreenshot>(kit, target, Caller::User, &params)
            .await?;
        base64::engine::general_purpose::STANDARD
            .decode(image.data)
            .map_err(|error| KitError::Kit {
                reason: None,
                message: format!("the kit sent an unreadable image: {error}"),
            })
    }

    /// Commands, optionally limited to those whose id, title, or description contains `query`.
    pub async fn commands(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: Option<&str>,
        query: Option<&str>,
    ) -> Result<Vec<CommandView>, KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = document_id.map_or((Target::Headless, None), |id| {
            let (target, inner) = split_document_id(id);
            (target, Some(inner))
        });
        let params = CommandsListParams {
            document_id: inner.map(str::to_owned),
            groups: None,
        };
        let (_, list) = self
            .call::<methods::CommandsList>(kit, target, caller, &params)
            .await?;
        let terms: Vec<String> = query
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_lowercase)
            .collect();
        Ok(list
            .commands
            .into_iter()
            .filter(|command| {
                let haystack = format!(
                    "{} {} {}",
                    command.id,
                    command.title,
                    command.description.as_deref().unwrap_or_default()
                )
                .to_lowercase();
                terms.iter().all(|term| haystack.contains(term))
            })
            .map(|command| CommandView {
                id: command.id,
                title: command.title,
                description: command.description,
                group: command.group,
                mutates: command.mutates,
                enabled: command.enabled,
                menu: command.menu,
                shortcut: command.shortcut,
            })
            .collect())
    }

    pub async fn execute(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: &str,
        command: &str,
        params: Map<String, Value>,
    ) -> Result<ExecuteView, KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let request = CommandsExecuteParams {
            document_id: inner.to_owned(),
            command: command.to_owned(),
            params,
            origin: match caller {
                Caller::User => Origin::User,
                Caller::Agent => Origin::Agent,
            },
        };
        let (_, executed) = self
            .call::<methods::CommandsExecute>(kit, target, caller, &request)
            .await?;
        let document = self.document(caller, kit_id, document_id).await?;
        Ok(ExecuteView {
            changed: executed.changed,
            result: executed.result,
            document,
        })
    }

    pub async fn save(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: &str,
    ) -> Result<DocumentView, KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let params = DocumentRef {
            document_id: inner.to_owned(),
        };
        self.call::<methods::DocumentSave>(kit, target, caller, &params)
            .await?;
        self.document(caller, kit_id, document_id).await
    }

    pub async fn close(
        &self,
        kit_id: &str,
        document_id: &str,
        discard_changes: bool,
    ) -> Result<(), KitError> {
        let kit = self.definition(kit_id)?;
        let (target, inner) = split_document_id(document_id);
        let params = DocumentCloseParams {
            document_id: inner.to_owned(),
            discard_changes: Some(discard_changes),
        };
        self.call::<methods::DocumentClose>(kit, target, Caller::User, &params)
            .await?;
        Ok(())
    }

    /// Asks every running kit, headless and embedded, to exit.
    pub async fn shutdown(&self) {
        let mut stopping: Vec<Arc<RunningKit>> = self
            .inner
            .running
            .lock()
            .await
            .drain()
            .map(|(_, kit)| kit)
            .collect();
        stopping.extend(
            self.inner
                .surfaces
                .lock()
                .await
                .drain()
                .map(|(_, surface)| Arc::clone(&surface.running)),
        );
        for kit in stopping {
            kit.stop().await;
        }
    }

    /// Resolves a workspace-relative path without letting it leave the workspace.
    pub(crate) fn resolve(&self, path: &str) -> Result<PathBuf, KitError> {
        let workspace = self.workspace()?;
        let invalid = || KitError::InvalidPath(format!("`{path}` is not a workspace path"));
        let trimmed = path.trim().trim_start_matches('/');
        if trimmed.is_empty() || trimmed.contains('\\') {
            return Err(invalid());
        }
        let mut absolute = workspace.to_path_buf();
        for part in trimmed.split('/') {
            if part.is_empty() || part == "." || part == ".." || Path::new(part).is_absolute() {
                return Err(invalid());
            }
            absolute.push(part);
        }
        match std::fs::canonicalize(&absolute) {
            Ok(real) if real.starts_with(workspace) => Ok(real),
            Ok(_) => Err(invalid()),
            Err(_) => Ok(absolute),
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

async fn watch_notifications(
    host: Arc<KitClient>,
    versions: Versions,
    focused: Arc<AtomicBool>,
    focus_changed: Arc<tokio::sync::Notify>,
) {
    while let Some(notification) = host.next_notification().await {
        match notification.method.as_str() {
            methods::DocumentDidChangeState::NAME => {
                let Some(id) = notification
                    .params
                    .as_ref()
                    .and_then(|params| params.get("documentId"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                *versions
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .entry(id.to_owned())
                    .or_default() += 1;
            }
            methods::SurfaceDidFocus::NAME | methods::SurfaceDidBlur::NAME => {
                focused.store(
                    notification.method == methods::SurfaceDidFocus::NAME,
                    Ordering::SeqCst,
                );
                focus_changed.notify_waiters();
            }
            _ => {}
        }
    }
    // The connection closed: wake surface watchers so they notice.
    focus_changed.notify_waiters();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_document_ids_round_trip() {
        assert_eq!(split_document_id("7"), (Target::Headless, "7"));
        assert_eq!(
            split_document_id("s3::art/cover.psd"),
            (Target::Surface(3), "art/cover.psd")
        );
        assert_eq!(
            external_document_id(Target::Surface(3), "art/cover.psd"),
            "s3::art/cover.psd"
        );
        assert_eq!(split_document_id("sx::a"), (Target::Headless, "sx::a"));
    }
}
