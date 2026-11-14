// Copied from kition-sdk crates/kition-kit-mock/src/kit.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Mock kit state and method handlers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use kition_kdm::batch::{self, BatchError, BatchErrorCode, BatchTarget};
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Tx};

use kition_kit_process_protocol::framing::{self, write_frame_async};
use kition_kit_process_protocol::launch::{REQUEST_TIMEOUT, Surface};
use kition_kit_process_protocol::methods::{self, HostServiceMethod, NotificationMethod, RequestMethod};
use kition_kit_process_protocol::transport::BoxWriter;
use kition_kit_process_protocol::types::*;
use kition_kit_process_protocol::{ErrorData, ErrorReason, Message, Notification, PROTOCOL_VERSION, Request, RequestId, Response, RpcError, base64};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

pub type Writer = Arc<tokio::sync::Mutex<BoxWriter>>;

const FORMAT: &str = "mock.text";

/// The kit id, file extension and new-document format this mock answers to: `kit.mock`,
/// `mocktext` and `mock.text`, or what `KITION_KIT_MOCK_AS=<kit id>:<extension>[:<format>]` names,
/// so a test can stand it in for one of the kits a host knows (the host checks the id a kit
/// reports, and creates documents in the format its manifest declares).
static IDENTITY: LazyLock<(String, String, String)> = LazyLock::new(|| {
    std::env::var("KITION_KIT_MOCK_AS")
        .ok()
        .and_then(|value| {
            let mut parts = value.split(':').map(str::trim);
            let (id, extension) = (parts.next()?, parts.next()?);
            Some((id.to_owned(), extension.to_owned(), parts.next().unwrap_or(FORMAT).to_owned()))
        })
        .filter(|(id, extension, format)| !id.is_empty() && !extension.is_empty() && !format.is_empty())
        .unwrap_or_else(|| ("kit.mock".to_owned(), "mocktext".to_owned(), FORMAT.to_owned()))
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

    pub fn id(&self) -> u64 {
        self.id
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
    /// The handle of the document's file (section 5).
    file: String,
    /// The file's display name.
    name: String,
    /// The version last read or written: a save replaces only it.
    version: Option<String>,
    /// The file changed since `version` while the text has unsaved edits.
    conflict: bool,
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
            name: self.name.clone(),
            title: self.name.clone(),
            format: FORMAT.to_owned(),
            read_only: self.read_only,
            dirty: self.dirty,
            can_undo: !self.history.is_empty(),
            can_redo: false,
            conflict: self.conflict,
        }
    }
}

#[derive(Default)]
struct State {
    host_connected: bool,
    documents: Vec<Document>,
    next_document: u64,
    clients: HashMap<u64, Writer>,
}

/// The kit's requests to its host (`files.*`, section 5.1) and their answers.
#[derive(Default)]
struct HostLine {
    /// The host connection's id and writer.
    host: Option<(u64, Writer)>,
    pending: HashMap<i64, std::sync::mpsc::Sender<Result<Value, RpcError>>>,
    next: i64,
}

pub struct Kit {
    token: String,
    fault: Fault,
    wrote_fault_output: AtomicBool,
    state: Mutex<State>,
    host: Mutex<HostLine>,
}

type Handled = Result<Value, RpcError>;

impl Kit {
    pub fn new(token: String, fault: Fault) -> Self {
        Self { token, fault, wrote_fault_output: AtomicBool::new(false), state: Mutex::new(State::default()), host: Mutex::default() }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn host_line(&self) -> std::sync::MutexGuard<'_, HostLine> {
        self.host.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The connection `connection` closed: a host's waiting requests fail at once. Answers whether
    /// it was the host's.
    pub fn disconnect(&self, connection: u64) -> bool {
        let mut line = self.host_line();
        let host = line.host.as_ref().is_some_and(|(id, _)| *id == connection);
        if host {
            line.host = None;
            line.pending.clear();
        }
        drop(line);
        let mut state = self.state();
        state.clients.remove(&connection);
        if host {
            state.host_connected = false;
        }
        host
    }

    /// An answer on connection `connection`: the host's answer to one of the kit's requests.
    pub fn answer(&self, connection: u64, response: Response) {
        let Some(RequestId::Number(id)) = response.id else { return };
        let mut line = self.host_line();
        if line.host.as_ref().is_none_or(|(host, _)| *host != connection) {
            return;
        }
        if let Some(waiting) = line.pending.remove(&id) {
            let _ = waiting.send(response.outcome);
        }
    }

    /// A request to the host, from the blocking thread a message is handled on.
    fn ask<M: HostServiceMethod>(&self, params: &M::Params) -> Result<M::Result, RpcError> {
        let (tx, rx) = std::sync::mpsc::channel();
        let (writer, id) = {
            let mut line = self.host_line();
            let writer = line
                .host
                .as_ref()
                .map(|(_, writer)| Arc::clone(writer))
                .ok_or_else(|| RpcError::kit_detail(ErrorReason::IoError, "the host is not connected"))?;
            line.next += 1;
            let id = line.next;
            line.pending.insert(id, tx);
            (writer, id)
        };
        let params = serde_json::to_value(params).map_err(|error| RpcError::internal(error.to_string()))?;
        let request = Request { id: RequestId::Number(id), method: M::NAME.to_owned(), params: Some(params) }.to_value();
        let frame = framing::encode(&request).map_err(|error| RpcError::internal(error.to_string()))?;
        tokio::runtime::Handle::current().block_on(async {
            let mut writer = writer.lock().await;
            let _ = write_frame_async(&mut *writer, &frame).await;
        });
        let outcome = match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(outcome) => outcome,
            Err(_) => {
                self.host_line().pending.remove(&id);
                Err(RpcError::kit_detail(ErrorReason::IoError, format!("the host did not answer {}", M::NAME)))
            }
        }?;
        serde_json::from_value(outcome).map_err(|error| RpcError::kit_detail(ErrorReason::IoError, format!("the host's answer to {}: {error}", M::NAME)))
    }

    /// A whole file, as text, and its version (a mock document is small: one chunk at a time).
    fn read_file(&self, handle: &str) -> Result<(String, String), RpcError> {
        let mut bytes = Vec::new();
        loop {
            let read = self.ask::<methods::FilesRead>(&FilesReadParams { handle: handle.to_owned(), offset: Some(bytes.len() as u64), length: None })?;
            let chunk = base64::decode(&read.data).ok_or_else(|| RpcError::kit_detail(ErrorReason::IoError, "the host sent bytes that are not base64"))?;
            let done = chunk.is_empty() || (bytes.len() + chunk.len()) as u64 >= read.size;
            bytes.extend(chunk);
            if done {
                let text = String::from_utf8(bytes).map_err(|_| RpcError::kit_detail(ErrorReason::UnsupportedFormat, "the file is not UTF-8 text"))?;
                return Ok((text, read.version));
            }
        }
    }

    /// Writes `text` to the file of `handle` and commits it; answers the committed version.
    fn write_file(&self, handle: &str, text: &str, expected: Option<String>) -> Result<String, RpcError> {
        let chunk = FilesWriteParams { handle: handle.to_owned(), data: base64::encode(text.as_bytes()), offset: 0, last: Some(true), expected };
        self.ask::<methods::FilesWrite>(&chunk)?.version.ok_or_else(|| RpcError::kit_detail(ErrorReason::IoError, "the host committed no version"))
    }

    pub fn handle(&self, connection: &mut Connection, message: Message) -> Step {
        if self.fault == Fault::StdoutAfterReady && !self.wrote_fault_output.swap(true, Ordering::SeqCst) {
            println!("unexpected output");
        }
        match message {
            Message::Request(request) => self.handle_request(connection, request),
            Message::Notification(notification) => self.handle_notification(connection, notification),
            // Answers are routed by the connection loop before a message gets here.
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
            return Err(RpcError::kit_detail(ErrorReason::UnsupportedProtocol, format!("this kit speaks Kit Process Protocol version {PROTOCOL_VERSION}")));
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
                state.host_connected = true;
                state.documents.clear();
                *self.host_line() = HostLine { host: Some((connection.id, Arc::clone(&connection.writer))), pending: HashMap::new(), next: 0 };
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
                capabilities: Vec::new(),
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
            methods::DocumentOpen::NAME => self.open(parse(params)?, step),
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
            methods::DocumentSaveAs::NAME => {
                let params: DocumentSaveAsParams = parse(params)?;
                if params.format.as_deref().is_some_and(|format| format != FORMAT) {
                    return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
                }
                self.save(&params.document_id, Some(params.file), step)
            }
            methods::DocumentExport::NAME => {
                let params: DocumentExportParams = parse(params)?;
                if params.format != FORMAT {
                    return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
                }
                let text = self.with_document(&params.document_id, |document| Ok(document.text.clone()))?;
                let stat = self.ask::<methods::FilesStat>(&FileRef { handle: params.file.clone() })?;
                let version = self.write_file(&params.file, &text, None)?;
                to_value(DocumentWritten { name: stat.name, version })
            }
            methods::DocumentReload::NAME => {
                let params: DocumentRef = parse(params)?;
                let state = self.read_again(&params.document_id)?;
                self.broadcast::<methods::DocumentDidChangeState>(&state, step);
                to_value(state)
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
            methods::CommandsExecute::NAME => {
                let params: CommandsExecuteParams = parse(params)?;
                if params.origin == kition_kit_process_protocol::types::Origin::System && role != Role::Host {
                    return Err(RpcError::kit_detail(ErrorReason::RoleForbidden, "only the host sends origin system"));
                }
                self.execute(params, step)
            }
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

    fn open(&self, params: DocumentOpenParams, step: &mut Step) -> Handled {
        if let Some(document) = self.state().documents.iter().find(|document| document.file == params.file) {
            return to_value(document.state());
        }
        let stat = self.ask::<methods::FilesStat>(&FileRef { handle: params.file.clone() })?;
        if stat.name.rsplit_once('.').map(|(_, extension)| extension) != Some(IDENTITY.1.as_str()) {
            return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
        }
        if let Some(create) = &params.create
            && create.format != IDENTITY.2
        {
            return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
        }
        let created = params.create.is_some() && stat.version.is_none();
        let (text, version) = if created { (String::new(), None) } else { self.read_file(&params.file).map(|(text, version)| (text, Some(version)))? };
        let mut state = self.state();
        state.next_document += 1;
        let document = Document {
            id: format!("doc-{}", state.next_document),
            file: params.file,
            name: stat.name,
            version,
            conflict: false,
            dirty: created,
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

    /// Writes the document to its file (or to `target`'s, which it then lives in), committed with
    /// the version it read: a file changed meanwhile is the host's `file_conflict`.
    fn save(&self, document_id: &str, target: Option<String>, step: &mut Step) -> Handled {
        // A failed save of the document's own file is a conflict (saving elsewhere is not).
        let own_file = target.is_none();
        let (text, handle, name, expected) = self.with_document(document_id, |document| {
            if document.read_only && target.is_none() {
                return Err(RpcError::kit_detail(ErrorReason::IoError, "the document is read-only"));
            }
            Ok((document.text.clone(), document.file.clone(), document.name.clone(), document.version.clone()))
        })?;
        let (handle, name, expected) = match target {
            Some(target) => {
                let stat = self.ask::<methods::FilesStat>(&FileRef { handle: target.clone() })?;
                (target, stat.name, stat.version)
            }
            None => (handle, name, expected),
        };
        let version = match self.write_file(&handle, &text, expected) {
            Ok(version) => version,
            Err(error) => {
                if error.reason() == Some(ErrorReason::FileConflict) && own_file {
                    let _ = self.with_document(document_id, |document| {
                        document.conflict = true;
                        Ok(())
                    });
                }
                return Err(error);
            }
        };
        let saved = self.with_document(document_id, |document| {
            document.conflict = false;
            document.file = handle;
            document.name = name.clone();
            document.version = Some(version.clone());
            document.dirty = document.text != text;
            Ok(document.state())
        })?;
        let written = DocumentWritten { name, version };
        self.broadcast::<methods::DocumentDidSave>(
            &DocumentDidSaveParams { document_id: document_id.to_owned(), name: written.name.clone(), version: written.version.clone() },
            step,
        );
        self.broadcast::<methods::DocumentDidChangeState>(&saved, step);
        to_value(written)
    }

    /// `document.didChangeOnDisk`: a clean text is read again; one with unsaved edits keeps them
    /// and is in conflict when the file's version moved.
    fn reload(&self, document_id: &str, step: &mut Step) {
        let Ok((file, dirty, version, conflict)) =
            self.with_document(document_id, |document| Ok((document.file.clone(), document.dirty, document.version.clone(), document.conflict)))
        else {
            return;
        };
        if dirty {
            let Ok(stat) = self.ask::<methods::FilesStat>(&FileRef { handle: file }) else { return };
            if conflict || stat.version == version {
                return;
            }
            if let Ok(state) = self.with_document(document_id, |document| {
                document.conflict = true;
                Ok(document.state())
            }) {
                self.broadcast::<methods::DocumentDidChangeState>(&state, step);
            }
            return;
        }
        if let Ok(state) = self.read_again(document_id) {
            self.broadcast::<methods::DocumentDidChangeState>(&state, step);
        }
    }

    /// `document.reload`: the file's text again, its unsaved edits dropped.
    fn read_again(&self, document_id: &str) -> Result<DocumentState, RpcError> {
        let file = self.with_document(document_id, |document| Ok(document.file.clone()))?;
        let (text, version) = self.read_file(&file)?;
        self.with_document(document_id, |document| {
            document.text = text;
            document.version = Some(version);
            document.history.clear();
            document.dirty = false;
            document.conflict = false;
            Ok(document.state())
        })
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
        let unknown: Vec<Value> = params
            .params
            .keys()
            .filter(|key| !allowed.contains(&key.as_str()))
            .map(|key| json!({ "path": format!("/{key}"), "message": format!("unknown parameter `{key}`"), "expected": format!("one of the parameters {}", allowed.join(", ")) }))
            .collect();
        if !unknown.is_empty() {
            return Err(invalid_command_params(unknown));
        }
        let appended = match params.command.as_str() {
            "text.append" => match params.params.get("text").and_then(Value::as_str) {
                Some(text) if !text.is_empty() => Some(text.to_owned()),
                _ => {
                    return Err(invalid_command_params(vec![
                        json!({ "path": "/text", "message": "`text` must be a non-empty string", "expected": "a non-empty string" }),
                    ]));
                }
            },
            _ => None,
        };
        // A host's change (origin system) is no undo step; this kit keeps whole texts as its undo
        // steps, so the earlier steps go too, rather than an undo taking the host's change back.
        let system = params.origin == kition_kit_process_protocol::types::Origin::System;
        let state = self.with_document(&params.document_id, |document| {
            if document.read_only {
                return Err(RpcError::kit(ErrorReason::CommandDisabled));
            }
            if system && params.command == "edit.undo" {
                return Err(RpcError::kit_detail(ErrorReason::CommandDisabled, "the host does not undo the person's steps"));
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
            if system {
                document.history.clear();
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

fn invalid_command_params(errors: Vec<Value>) -> RpcError {
    let detail = errors.first().and_then(|error| error["message"].as_str()).map(str::to_owned);
    RpcError::kit_data(ErrorData { reason: ErrorReason::InvalidParams, detail, errors: Some(errors) })
}
