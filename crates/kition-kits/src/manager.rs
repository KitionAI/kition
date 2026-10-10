//! Running kits for the open workspace.
//!
//! A kit starts on first use in the `headless` surface with the workspace folder as its only
//! root. Each kit gets two connections: the `host` connection serves people working in a kit
//! tab, and an `agent` connection serves agent tools, so the kit itself enforces the agent's
//! role and URI limits. Kits stop when the manager is dropped, which happens when the runtime
//! restarts for another workspace.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use kition_kit_host::{ClientError, KitClient, KitProcess, LaunchOptions};
use kition_kit_protocol::launch::Surface;
use kition_kit_protocol::methods::{self, NotificationMethod, RequestMethod};
use kition_kit_protocol::types::*;
use kition_kit_protocol::{ErrorReason, PROTOCOL_VERSION};
use serde::Serialize;
use serde_json::{Map, Value};

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
}

pub const KITS: &[KitDefinition] = &[KitDefinition {
    id: "kit.photo",
    name: "Kition Photo",
    binary_env: "KITION_KIT_PHOTO_BINARY",
    extensions: &["psd", "psb", "pcraft"],
    creates: &[("psd", "psd"), ("psb", "psb"), ("pcraft", "pcraft")],
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
    #[error("{message}")]
    Kit {
        reason: Option<ErrorReason>,
        message: String,
    },
}

impl KitError {
    fn from_client(kit: &'static KitDefinition, error: ClientError) -> Self {
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
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteView {
    pub changed: bool,
    pub result: Option<Value>,
    pub document: DocumentView,
}

type Versions = Arc<Mutex<HashMap<String, u64>>>;

struct RunningKit {
    process: tokio::sync::Mutex<KitProcess>,
    host: Arc<KitClient>,
    agent: Arc<KitClient>,
    versions: Versions,
}

impl RunningKit {
    fn client(&self, caller: Caller) -> &KitClient {
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
}

struct Inner {
    workspace: Option<PathBuf>,
    /// Known kits and their executables, when installed.
    kits: Vec<(&'static KitDefinition, Option<PathBuf>)>,
    running: tokio::sync::Mutex<HashMap<&'static str, Arc<RunningKit>>>,
}

/// The kits of one workspace. Cheap to clone.
#[derive(Clone)]
pub struct KitManager {
    inner: Arc<Inner>,
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
            }),
        }
    }

    pub fn statuses(&self) -> Vec<KitStatus> {
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
                binary_env: kit.binary_env,
            })
            .collect()
    }

    fn definition(&self, id: &str) -> Result<&'static KitDefinition, KitError> {
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

    /// Starts the kit if it is not running and returns it.
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
            .ok_or(KitError::NotInstalled {
                name: kit.name,
                binary_env: kit.binary_env,
            })?;
        let launch_error = |detail: String| KitError::Launch {
            name: kit.name,
            detail,
        };
        let process = KitProcess::launch(LaunchOptions::new(binary, Surface::Headless))
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
        tokio::spawn(watch_changes(Arc::clone(&host), Arc::clone(&versions)));
        // The agent connection receives the same notifications; drain them.
        let drained = Arc::clone(&agent);
        tokio::spawn(async move { while drained.next_notification().await.is_some() {} });
        tracing::info!(kit = kit.id, pid = ?process.id(), "kit started");
        Ok(RunningKit {
            process: tokio::sync::Mutex::new(process),
            host,
            agent,
            versions,
        })
    }

    async fn call<M: RequestMethod>(
        &self,
        kit: &'static KitDefinition,
        caller: Caller,
        params: &M::Params,
    ) -> Result<(Arc<RunningKit>, M::Result), KitError> {
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

    /// Opens a workspace file in the kit that handles its extension.
    pub async fn open(&self, caller: Caller, path: &str) -> Result<DocumentView, KitError> {
        let kit = self
            .kit_for_path(path)
            .ok_or_else(|| KitError::InvalidPath(format!("no kit opens `{path}`")))?;
        let absolute = self.resolve(path)?;
        if !absolute.is_file() {
            return Err(KitError::InvalidPath(format!("`{path}` does not exist")));
        }
        let uri = url::Url::from_file_path(&absolute)
            .map(String::from)
            .map_err(|()| KitError::InvalidPath(format!("`{path}` is not a local file")))?;
        let params = DocumentOpenParams {
            uri,
            read_only: None,
            create: None,
        };
        let (running, state) = self
            .call::<methods::DocumentOpen>(kit, caller, &params)
            .await?;
        self.view(kit, &running, caller, state).await
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
        let target = (1..1000)
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
        let uri = url::Url::from_file_path(&target)
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
            .call::<methods::DocumentOpen>(kit, caller, &params)
            .await?;
        let saved = DocumentRef {
            document_id: state.document_id.clone(),
        };
        let (running, _) = self
            .call::<methods::DocumentSave>(kit, caller, &saved)
            .await?;
        let (_, state) = self.state(kit, caller, &saved.document_id).await?;
        self.view(kit, &running, caller, state).await
    }

    pub async fn document(
        &self,
        caller: Caller,
        kit_id: &str,
        document_id: &str,
    ) -> Result<DocumentView, KitError> {
        let kit = self.definition(kit_id)?;
        let (running, state) = self.state(kit, caller, document_id).await?;
        self.view(kit, &running, caller, state).await
    }

    async fn state(
        &self,
        kit: &'static KitDefinition,
        caller: Caller,
        document_id: &str,
    ) -> Result<(Arc<RunningKit>, DocumentState), KitError> {
        let (running, list) = self
            .call::<methods::DocumentList>(kit, caller, &Empty {})
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

    async fn view(
        &self,
        kit: &'static KitDefinition,
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
            document_id: state.document_id,
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
    pub async fn preview(
        &self,
        kit_id: &str,
        document_id: &str,
        max_size: u32,
    ) -> Result<Vec<u8>, KitError> {
        use base64::Engine as _;
        let kit = self.definition(kit_id)?;
        let params = ViewScreenshotParams {
            document_id: document_id.to_owned(),
            scope: ScreenshotScope::Canvas,
            max_size: Some(max_size.clamp(16, 4096)),
        };
        let (_, image) = self
            .call::<methods::ViewScreenshot>(kit, Caller::User, &params)
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
        let params = CommandsListParams {
            document_id: document_id.map(str::to_owned),
            groups: None,
        };
        let (_, list) = self
            .call::<methods::CommandsList>(kit, caller, &params)
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
        let request = CommandsExecuteParams {
            document_id: document_id.to_owned(),
            command: command.to_owned(),
            params,
            origin: match caller {
                Caller::User => Origin::User,
                Caller::Agent => Origin::Agent,
            },
        };
        let (_, executed) = self
            .call::<methods::CommandsExecute>(kit, caller, &request)
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
        let params = DocumentRef {
            document_id: document_id.to_owned(),
        };
        self.call::<methods::DocumentSave>(kit, caller, &params)
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
        let params = DocumentCloseParams {
            document_id: document_id.to_owned(),
            discard_changes: Some(discard_changes),
        };
        self.call::<methods::DocumentClose>(kit, Caller::User, &params)
            .await?;
        Ok(())
    }

    /// Asks every running kit to exit.
    pub async fn shutdown(&self) {
        let running: Vec<Arc<RunningKit>> = self
            .inner
            .running
            .lock()
            .await
            .drain()
            .map(|(_, kit)| kit)
            .collect();
        for kit in running {
            let _ = kit.host.call::<methods::Shutdown>(&Empty {}).await;
            let mut process = kit.process.lock().await;
            if process
                .wait_for_exit(kition_kit_protocol::launch::SHUTDOWN_TIMEOUT)
                .await
                .is_none()
            {
                process.kill().await;
            }
        }
    }

    /// Resolves a workspace-relative path without letting it leave the workspace.
    fn resolve(&self, path: &str) -> Result<PathBuf, KitError> {
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

async fn watch_changes(host: Arc<KitClient>, versions: Versions) {
    while let Some(notification) = host.next_notification().await {
        if notification.method != methods::DocumentDidChangeState::NAME {
            continue;
        }
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
}
