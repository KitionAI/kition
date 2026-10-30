// Copied from kition-sdk crates/kition-kit-mock/src/kit.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Mock kit state and method handlers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use kition_kdm::batch::{self, BatchError, BatchErrorCode, BatchTarget};
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Tx};

use kition_kit_protocol::launch::Surface;
use kition_kit_protocol::methods::{self, NotificationMethod, RequestMethod};
use kition_kit_protocol::transport::BoxWriter;
use kition_kit_protocol::types::*;
use kition_kit_protocol::{ErrorData, ErrorReason, Message, Notification, PROTOCOL_VERSION, Request, Response, RpcError};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

pub type Writer = Arc<tokio::sync::Mutex<BoxWriter>>;

const FORMAT: &str = "mock.text";

/// The kit id and file extension this mock answers to: `kit.mock` and `mocktext`, or what
/// `KITION_KIT_MOCK_AS=<kit id>:<extension>` names, so a test can stand it in for one of the
/// kits a host knows (the host checks the id a kit reports).
static IDENTITY: LazyLock<(String, String)> = LazyLock::new(|| {
    std::env::var("KITION_KIT_MOCK_AS")
        .ok()
        .and_then(|value| {
            let (id, extension) = value.split_once(':')?;
            Some((id.trim().to_owned(), extension.trim().to_owned()))
        })
        .filter(|(id, extension)| !id.is_empty() && !extension.is_empty())
        .unwrap_or_else(|| ("kit.mock".to_owned(), "mocktext".to_owned()))
});

/// The object model a document answers `model.describe` and `model.batch` with: the note's text
/// and a list of tags.
const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.mock", "schemaVersion": 1, "root": "Note",
  "types": {
    "Note": { "fields": { "text": { "kind": "text" }, "tags": { "kind": "list", "of": "Tag" } } },
    "Tag": { "fields": { "name": { "kind": "string" } } }
  }
}"#;
/// A 1x1 transparent PNG.
const PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    None,
    StdoutAfterReady,
    IgnoreToken,
}

impl Fault {
    pub fn from_env(value: &str) -> Self {
        match value {
            "stdout-after-ready" => Self::StdoutAfterReady,
            "ignore-token" => Self::IgnoreToken,
            _ => Self::None,
        }
    }
}

pub struct Connection {
    id: u64,
    role: Option<Role>,
    writer: Writer,
}

impl Connection {
    pub fn new(writer: Writer) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self { id: NEXT.fetch_add(1, Ordering::Relaxed), role: None, writer }
    }
}

/// What the connection loop does after a message.
#[derive(Default)]
pub struct Step {
    pub reply: Option<Response>,
    pub broadcast: Vec<(Writer, Value)>,
    pub close: bool,
    pub shutdown: bool,
}

struct Document {
    id: String,
    path: PathBuf,
    text: String,
    history: Vec<String>,
    dirty: bool,
    read_only: bool,
    /// The document's object model, made on the first `model.*` request from its text.
    model: Option<Replica>,
}

/// A document's replica as a batch runs on it: no commands, and no writes when read-only.
struct MockTarget<'a> {
    replica: &'a mut Replica,
    read_only: bool,
}

impl BatchTarget for MockTarget<'_> {
    fn replica(&mut self) -> Result<&Replica, BatchError> {
        Ok(self.replica)
    }

    fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), BatchError>) -> Result<(), BatchError> {
        batch::transact_replica(self.replica, origin, write)
    }

    fn command(&mut self, id: &str, _params: Value, _origin: &Origin) -> Result<Value, String> {
        Err(format!("`{id}` cannot run inside a batch of this kit"))
    }

    fn read_only(&self) -> bool {
        self.read_only
    }
}

/// An object-model failure as the Kit Protocol answers it: `data.model` is `{ code, index, message }`.
fn model_error(error: &BatchError) -> RpcError {
    let reason = match error.code {
        BatchErrorCode::ReadOnly => ErrorReason::CommandDisabled,
        _ => ErrorReason::InvalidParams,
    };
    let mut rpc = RpcError::kit_detail(reason, error.to_string());
    if let Some(Value::Object(data)) = rpc.data.as_mut() {
        data.insert("model".into(), error.to_json());
    }
    rpc
}

impl Document {
    /// The object model, current with the text (a command may have changed it since).
    fn model(&mut self) -> Result<&mut Replica, RpcError> {
        let internal = |error: kition_kdm::KdmError| RpcError::internal(error.to_string());
        if self.model.is_none() {
            let schema = Arc::new(Schema::parse(SCHEMA).map_err(internal)?);
            let text = self.text.clone();
            let (replica, ()) = Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
                let root = tx.create("Note", Map::new())?;
                tx.text_insert(&root, "text", 0, &text)
            })
            .map_err(internal)?;
            self.model = Some(replica);
        }
        let replica = self.model.as_mut().ok_or_else(|| RpcError::internal("no model"))?;
        let root = batch::root_id(replica).ok_or_else(|| RpcError::internal("no root"))?;
        if replica.text(&root, "text").map_err(internal)? != self.text {
            let text = self.text.clone();
            replica
                .transact(&Origin::system("text"), |tx| {
                    let length = tx.text_len(&root, "text")?;
                    if length > 0 {
                        tx.text_delete(&root, "text", 0, length)?;
                    }
                    tx.text_insert(&root, "text", 0, &text)
                })
                .map_err(internal)?;
        }
        Ok(replica)
    }

    /// Runs a batch; answers whether the text changed, and the batch's answer.
    fn batch(&mut self, request: &Value) -> Result<(bool, Value), RpcError> {
        let read_only = self.read_only;
        let before = self.text.clone();
        let replica = self.model()?;
        let answer = batch::run(&mut MockTarget { replica, read_only }, request).map_err(|error| model_error(&error))?;
        let root: ObjectId = batch::root_id(replica).ok_or_else(|| RpcError::internal("no root"))?;
        let text = replica.text(&root, "text").map_err(|error| RpcError::internal(error.to_string()))?;
        let writes = request["ops"].as_array().is_some_and(|ops| !ops.is_empty());
        if writes {
            self.history.push(before);
            self.text = text;
            self.dirty = true;
        }
        Ok((writes, answer))
    }

    fn state(&self) -> DocumentState {
        DocumentState {
            document_id: self.id.clone(),
            uri: file_uri(&self.path),
            title: self.path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
            format: FORMAT.to_owned(),
            read_only: self.read_only,
            dirty: self.dirty,
            can_undo: !self.history.is_empty(),
            can_redo: false,
        }
    }
}

#[derive(Default)]
struct State {
    host_connected: bool,
    roots: Vec<PathBuf>,
    documents: Vec<Document>,
    next_document: u64,
    clients: HashMap<u64, Writer>,
}

pub struct Kit {
    token: String,
    fault: Fault,
    wrote_fault_output: AtomicBool,
    state: Mutex<State>,
}

type Handled = Result<Value, RpcError>;

impl Kit {
    pub fn new(token: String, fault: Fault) -> Self {
        Self { token, fault, wrote_fault_output: AtomicBool::new(false), state: Mutex::new(State::default()) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn disconnect(&self, connection: &Connection) {
        let mut state = self.state();
        state.clients.remove(&connection.id);
        if connection.role == Some(Role::Host) {
            state.host_connected = false;
        }
    }

    pub fn handle(&self, connection: &mut Connection, message: Message) -> Step {
        if self.fault == Fault::StdoutAfterReady && !self.wrote_fault_output.swap(true, Ordering::SeqCst) {
            println!("unexpected output");
        }
        match message {
            Message::Request(request) => self.handle_request(connection, request),
            Message::Notification(notification) => self.handle_notification(connection, notification),
            Message::Response(_) => Step::default(),
        }
    }

    fn handle_request(&self, connection: &mut Connection, request: Request) -> Step {
        let mut step = Step::default();
        let params = request.params.unwrap_or_else(|| json!({}));
        let outcome = match connection.role {
            None if request.method == methods::Initialize::NAME => {
                let outcome = self.initialize(connection, params);
                step.close = outcome.as_ref().is_err_and(|error| error.reason() == Some(ErrorReason::Unauthorized));
                outcome
            }
            None => Err(RpcError::kit(ErrorReason::NotInitialized)),
            Some(Role::Agent) if methods::is_host_only(&request.method) => Err(RpcError::kit(ErrorReason::RoleForbidden)),
            Some(role) => self.dispatch(role, &request.method, params, &mut step),
        };
        step.reply = Some(Response { id: Some(request.id), outcome });
        step
    }

    fn handle_notification(&self, connection: &Connection, notification: Notification) -> Step {
        let mut step = Step::default();
        if connection.role == Some(Role::Host)
            && notification.method == methods::DocumentDidChangeOnDisk::NAME
            && let Ok(params) = parse::<DocumentRef>(notification.params.unwrap_or_else(|| json!({})))
        {
            self.reload(&params.document_id, &mut step);
        }
        step
    }

    fn initialize(&self, connection: &mut Connection, params: Value) -> Handled {
        let params: InitializeParams = parse(params)?;
        if params.protocol_version != PROTOCOL_VERSION {
            return Err(RpcError::kit(ErrorReason::UnsupportedProtocol));
        }
        if params.token != self.token && self.fault != Fault::IgnoreToken {
            return Err(RpcError::kit(ErrorReason::Unauthorized));
        }
        let mut state = self.state();
        match params.role {
            Role::Host if state.host_connected => {
                return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "a host is already connected"));
            }
            Role::Agent if !state.host_connected => {
                return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "the host has not initialized"));
            }
            Role::Host => {
                let mut roots = Vec::new();
                for root in &params.workspace_roots {
                    let path = uri_to_path(root)?;
                    roots.push(std::fs::canonicalize(&path).unwrap_or(path));
                }
                state.roots = roots;
                state.host_connected = true;
            }
            Role::Agent => {}
        }
        state.clients.insert(connection.id, Arc::clone(&connection.writer));
        connection.role = Some(params.role);
        to_value(InitializeResult {
            protocol_version: PROTOCOL_VERSION,
            kit: KitInfo { id: IDENTITY.0.clone(), version: env!("CARGO_PKG_VERSION").to_owned() },
            capabilities: Capabilities {
                surfaces: vec![Surface::Headless],
                formats: Formats { open: vec![FORMAT.to_owned()], save: vec![FORMAT.to_owned()], export: vec![FORMAT.to_owned()] },
                features: vec!["view.describe".to_owned(), "model.describe".to_owned(), "model.batch".to_owned()],
            },
        })
    }

    fn dispatch(&self, role: Role, method: &str, params: Value, step: &mut Step) -> Handled {
        match method {
            methods::Ping::NAME | methods::SetPreferences::NAME => to_value(Empty {}),
            methods::Shutdown::NAME => {
                step.shutdown = true;
                to_value(Empty {})
            }
            methods::DocumentOpen::NAME => self.open(role, parse(params)?, step),
            methods::DocumentList::NAME => {
                let documents = self.state().documents.iter().map(Document::state).collect();
                to_value(DocumentListResult { documents })
            }
            methods::DocumentActivate::NAME => {
                let params: DocumentRef = parse(params)?;
                self.with_document(&params.document_id, |_| Ok(()))?;
                to_value(Empty {})
            }
            methods::DocumentSave::NAME => {
                let params: DocumentRef = parse(params)?;
                self.save(&params.document_id, None, step)
            }
            methods::DocumentSaveAs::NAME | methods::DocumentExport::NAME => {
                let params: DocumentSaveAsParams = parse(params)?;
                if params.format.as_deref().is_some_and(|format| format != FORMAT) {
                    return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
                }
                let target = self.granted_path(role, &params.uri)?;
                if method == methods::DocumentExport::NAME {
                    let text = self.with_document(&params.document_id, |document| Ok(document.text.clone()))?;
                    std::fs::write(&target, text).map_err(io_error)?;
                    return to_value(DocumentUriResult { uri: params.uri });
                }
                self.save(&params.document_id, Some(target), step)
            }
            methods::DocumentClose::NAME => {
                let params: DocumentCloseParams = parse(params)?;
                let mut state = self.state();
                let index = state
                    .documents
                    .iter()
                    .position(|document| document.id == params.document_id)
                    .ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
                if state.documents[index].dirty && params.discard_changes != Some(true) {
                    return Err(RpcError::kit(ErrorReason::DocumentDirty));
                }
                state.documents.remove(index);
                to_value(Empty {})
            }
            methods::CommandsList::NAME => {
                let params: CommandsListParams = parse(params)?;
                self.list_commands(&params)
            }
            methods::CommandsExecute::NAME => self.execute(parse(params)?, step),
            methods::ViewScreenshot::NAME => {
                let params: ViewScreenshotParams = parse(params)?;
                self.with_document(&params.document_id, |_| Ok(()))?;
                to_value(Image::png(1, 1, PIXEL_PNG.to_owned()))
            }
            methods::ViewDescribe::NAME => {
                let params: DocumentRef = parse(params)?;
                let text = self.with_document(&params.document_id, |document| Ok(document.text.clone()))?;
                to_value(ViewDescribeResult {
                    summary: format!("{} characters", text.chars().count()),
                    state: Map::from_iter([("text".to_owned(), json!(text)), ("length".to_owned(), json!(text.chars().count()))]),
                })
            }
            "model.describe" => {
                let id = document_param(&params)?;
                self.with_document(&id, |document| {
                    let mut described = batch::describe(document.model()?);
                    described["kit"] = json!(IDENTITY.0);
                    described["commands"] = json!(["text.append", "text.clear", "edit.undo"]);
                    Ok(described)
                })
            }
            "model.batch" => {
                let id = document_param(&params)?;
                let (changed, answer) = self.with_document(&id, |document| document.batch(&params))?;
                if changed {
                    let state = self.with_document(&id, |document| Ok(document.state()))?;
                    self.broadcast::<methods::DocumentDidChangeState>(&state, step);
                }
                Ok(answer)
            }
            method => Err(RpcError::method_not_found(method)),
        }
    }

    fn open(&self, role: Role, params: DocumentOpenParams, step: &mut Step) -> Handled {
        let path = match role {
            Role::Agent => self.granted_path(role, &params.uri)?,
            Role::Host => uri_to_path(&params.uri)?,
        };
        if path.extension().and_then(|extension| extension.to_str()) != Some(IDENTITY.1.as_str()) {
            return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
        }
        if let Some(create) = &params.create
            && create.format != FORMAT
        {
            return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
        }
        let mut state = self.state();
        if let Some(document) = state.documents.iter().find(|document| document.path == path) {
            return to_value(document.state());
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && params.create.is_some() => String::new(),
            Err(error) => return Err(io_error(error)),
        };
        state.next_document += 1;
        let document = Document {
            id: format!("doc-{}", state.next_document),
            path,
            dirty: params.create.is_some(),
            text,
            history: Vec::new(),
            read_only: params.read_only == Some(true),
            model: None,
        };
        let document_state = document.state();
        state.documents.push(document);
        drop(state);
        self.broadcast::<methods::DocumentDidChangeState>(&document_state, step);
        to_value(document_state)
    }

    fn save(&self, document_id: &str, target: Option<PathBuf>, step: &mut Step) -> Handled {
        let saved = self.with_document(document_id, |document| {
            if document.read_only && target.is_none() {
                return Err(RpcError::kit_detail(ErrorReason::IoError, "the document is read-only"));
            }
            let path = target.clone().unwrap_or_else(|| document.path.clone());
            std::fs::write(&path, &document.text).map_err(io_error)?;
            document.path = path;
            document.dirty = false;
            Ok(document.state())
        })?;
        let uri = saved.uri.clone().unwrap_or_default();
        self.broadcast::<methods::DocumentDidSave>(&DocumentDidSaveParams { document_id: document_id.to_owned(), uri: uri.clone() }, step);
        self.broadcast::<methods::DocumentDidChangeState>(&saved, step);
        to_value(DocumentUriResult { uri })
    }

    fn reload(&self, document_id: &str, step: &mut Step) {
        let reloaded = self.with_document(document_id, |document| {
            if document.dirty {
                return Ok(None);
            }
            document.text = std::fs::read_to_string(&document.path).map_err(io_error)?;
            document.history.clear();
            Ok(Some(document.state()))
        });
        if let Ok(Some(state)) = reloaded {
            self.broadcast::<methods::DocumentDidChangeState>(&state, step);
        }
    }

    fn list_commands(&self, params: &CommandsListParams) -> Handled {
        let (empty, can_undo, read_only) = match &params.document_id {
            Some(id) => self.with_document(id, |document| Ok((document.text.is_empty(), !document.history.is_empty(), document.read_only)))?,
            None => (true, false, false),
        };
        let commands = [
            CommandInfo {
                // Searched, never listed (an agent finds the command by words its title lacks).
                keywords: vec!["Boilerplate".to_owned(), "Lorem ipsum".to_owned()],
                id: "text.append".to_owned(),
                title: "Append text".to_owned(),
                description: Some("Appends text to the end of the document.".to_owned()),
                group: "text".to_owned(),
                params: json!({
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["text"],
                    "properties": { "text": { "type": "string", "minLength": 1 } }
                }),
                output: None,
                mutates: true,
                enabled: !read_only,
                menu: Vec::new(),
                shortcut: None,
            },
            CommandInfo {
                keywords: Vec::new(),
                id: "text.clear".to_owned(),
                title: "Clear".to_owned(),
                description: Some("Removes all text.".to_owned()),
                group: "text".to_owned(),
                params: json!({ "type": "object", "additionalProperties": false }),
                output: None,
                mutates: true,
                enabled: !read_only && !empty,
                menu: Vec::new(),
                shortcut: None,
            },
            CommandInfo {
                keywords: Vec::new(),
                id: "edit.undo".to_owned(),
                title: "Undo".to_owned(),
                description: None,
                group: "edit".to_owned(),
                // Engine contract 2 E14a: the undo scope, else the origin's.
                params: json!({ "type": "object", "additionalProperties": false, "properties": { "scope": { "enum": ["person", "agent"] } } }),
                output: None,
                mutates: true,
                enabled: !read_only && can_undo,
                menu: Vec::new(),
                shortcut: None,
            },
        ];
        let commands = commands.into_iter().filter(|command| params.groups.as_ref().is_none_or(|groups| groups.contains(&command.group))).collect();
        to_value(CommandsListResult { commands })
    }

    fn execute(&self, params: CommandsExecuteParams, step: &mut Step) -> Handled {
        let allowed: &[&str] = match params.command.as_str() {
            "text.append" => &["text"],
            "text.clear" => &[],
            "edit.undo" => &["scope"],
            _ => return Err(RpcError::kit(ErrorReason::CommandNotFound)),
        };
        let unknown: Vec<Value> =
            params.params.keys().filter(|key| !allowed.contains(&key.as_str())).map(|key| json!(format!("unknown parameter `{key}`"))).collect();
        if !unknown.is_empty() {
            return Err(invalid_command_params(unknown));
        }
        let appended = match params.command.as_str() {
            "text.append" => match params.params.get("text").and_then(Value::as_str) {
                Some(text) if !text.is_empty() => Some(text.to_owned()),
                _ => {
                    return Err(invalid_command_params(vec![json!("`text` must be a non-empty string")]));
                }
            },
            _ => None,
        };
        let state = self.with_document(&params.document_id, |document| {
            if document.read_only {
                return Err(RpcError::kit(ErrorReason::CommandDisabled));
            }
            match params.command.as_str() {
                "text.append" => {
                    document.history.push(document.text.clone());
                    document.text.push_str(appended.as_deref().unwrap_or_default());
                }
                "text.clear" if !document.text.is_empty() => {
                    document.history.push(std::mem::take(&mut document.text));
                }
                "edit.undo" => match document.history.pop() {
                    Some(previous) => document.text = previous,
                    None => return Err(RpcError::kit(ErrorReason::CommandDisabled)),
                },
                _ => return Err(RpcError::kit(ErrorReason::CommandDisabled)),
            }
            document.dirty = true;
            Ok(document.state())
        })?;
        self.broadcast::<methods::DocumentDidChangeState>(&state, step);
        to_value(CommandsExecuteResult { changed: true, result: None })
    }

    fn with_document<T>(&self, id: &str, action: impl FnOnce(&mut Document) -> Result<T, RpcError>) -> Result<T, RpcError> {
        let mut state = self.state();
        let document = state.documents.iter_mut().find(|document| document.id == id).ok_or_else(|| RpcError::kit(ErrorReason::DocumentNotFound))?;
        action(document)
    }

    /// Resolves a URI and, for agents, checks that it lies inside a
    /// workspace root. The file itself may not exist yet.
    fn granted_path(&self, role: Role, uri: &str) -> Result<PathBuf, RpcError> {
        let path = uri_to_path(uri)?;
        if role == Role::Host {
            return Ok(path);
        }
        let resolved = resolve(&path).ok_or_else(|| RpcError::kit(ErrorReason::UriNotGranted))?;
        if self.state().roots.iter().any(|root| resolved.starts_with(root)) { Ok(path) } else { Err(RpcError::kit(ErrorReason::UriNotGranted)) }
    }

    fn broadcast<N: NotificationMethod>(&self, params: &N::Params, step: &mut Step) {
        let Ok(params) = serde_json::to_value(params) else {
            return;
        };
        let notification = Notification::new(N::NAME, Some(params)).to_value();
        for writer in self.state().clients.values() {
            step.broadcast.push((Arc::clone(writer), notification.clone()));
        }
    }
}

/// Canonicalizes a path whose last component may not exist yet.
fn resolve(path: &Path) -> Option<PathBuf> {
    if let Ok(path) = std::fs::canonicalize(path) {
        return Some(path);
    }
    let parent = std::fs::canonicalize(path.parent()?).ok()?;
    Some(parent.join(path.file_name()?))
}

fn uri_to_path(uri: &str) -> Result<PathBuf, RpcError> {
    url::Url::parse(uri)
        .ok()
        .filter(|url| url.scheme() == "file")
        .and_then(|url| url.to_file_path().ok())
        .ok_or_else(|| RpcError::invalid_params(format!("not a file URI: {uri}")))
}

fn file_uri(path: &Path) -> Option<String> {
    url::Url::from_file_path(path).ok().map(String::from)
}

/// The `documentId` of an object-model request.
fn document_param(params: &Value) -> Result<String, RpcError> {
    params["documentId"].as_str().map(str::to_owned).ok_or_else(|| RpcError::invalid_params("`documentId` is a string"))
}

fn parse<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|error| RpcError::invalid_params(error.to_string()))
}

fn to_value<T: Serialize>(value: T) -> Handled {
    serde_json::to_value(value).map_err(|error| RpcError::internal(error.to_string()))
}

fn io_error(error: std::io::Error) -> RpcError {
    RpcError::kit_detail(ErrorReason::IoError, error.kind().to_string())
}

fn invalid_command_params(errors: Vec<Value>) -> RpcError {
    RpcError::kit_data(ErrorData { reason: ErrorReason::InvalidParams, detail: None, errors: Some(errors) })
}
