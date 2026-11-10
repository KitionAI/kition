// Copied from kition-sdk crates/kition-kit-protocol/src/types.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Parameter and result shapes, one per `$defs` entry in
//! `contracts/kit/kit-protocol.schema.json`.
//!
//! Deserialization ignores unknown fields so that clients accept additive
//! changes within a protocol version (section 12).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::jsonrpc::RequestId;
use crate::launch::Surface;

/// The empty object used by methods without parameters or results.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Empty {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Host,
    Agent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: u32,
    pub token: String,
    pub role: Role,
    pub client: ClientInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
    /// Host only: the services the host serves to the kit on this connection (section 5.1),
    /// among them [`HOST_SERVICE_FILES`], always.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub host_services: Vec<String>,
}

/// The host serves `files.*` to the kit (`KitFiles 1.1` FA12); every version 2 host does.
pub const HOST_SERVICE_FILES: &str = "files";
/// The host prints (`files.print`).
pub const HOST_SERVICE_FILES_PRINT: &str = "files.print";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KitInfo {
    pub id: String,
    pub version: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Formats {
    pub open: Vec<String>,
    pub save: Vec<String>,
    pub export: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub surfaces: Vec<Surface>,
    pub formats: Formats,
    /// Optional protocol features, for example `view.describe`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub features: Vec<String>,
    /// Optional platform capabilities of the executable, as the manifest's
    /// `headless.capabilities` lists them, for example [`DOCUMENT_TEXT_CAPABILITY`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
}

/// The capability of a kit that answers `document.text` (`KitText 1.0`).
pub const DOCUMENT_TEXT_CAPABILITY: &str = "document-text";

/// The `limit` of a `document.text` request without one, in Unicode scalar values.
pub const DOCUMENT_TEXT_LIMIT: u64 = 1_048_576;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: u32,
    pub kit: KitInfo,
    pub capabilities: Capabilities,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetPreferencesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelRequestParams {
    pub id: RequestId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentState {
    pub document_id: String,
    /// The file's display name, its last segment only (`KitFiles 1.1` FA3).
    pub name: String,
    pub title: String,
    pub format: String,
    pub read_only: bool,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    /// The file changed since the kit read it while the document has unsaved edits: the next
    /// `document.save` fails `file_conflict` (section 5). `document.reload`, `saveAs` or a close
    /// without saving resolves it.
    pub conflict: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CreateDocument {
    pub format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentOpenParams {
    /// A file handle: `read`, plus `write` unless `read_only`; with `create`, a handle whose
    /// file does not exist yet, with `create` (and `write` for the saves after the first).
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create: Option<CreateDocument>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentListResult {
    pub documents: Vec<DocumentState>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRef {
    pub document_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSaveAsParams {
    pub document_id: String,
    /// A `create` or `write` handle; the document then lives in its file.
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentExportParams {
    pub document_id: String,
    /// A `create` handle: an export never replaces a file.
    pub file: String,
    pub format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Map<String, Value>>,
}

/// What `document.save`, `document.saveAs` and `document.export` wrote: the file's display name
/// and the version its commit answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentWritten {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCloseParams {
    pub document_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discard_changes: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDidSaveParams {
    pub document_id: String,
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandInfo {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub group: String,
    /// JSON Schema (draft 2020-12) for `commands.execute` params.
    pub params: Value,
    /// JSON Schema (draft 2020-12) for the command's result, when the kit says (KHP A1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    pub mutates: bool,
    pub enabled: bool,
    /// Where the command sits in the kit's menus, for example `["Layer", "New"]`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub menu: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
    /// Words a command search finds it by that its id, title and description do not say (the
    /// effect names `effect.apply` takes); searched, not shown.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandsListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandsListResult {
    pub commands: Vec<CommandInfo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    User,
    Agent,
    /// A change the host makes on the person's behalf (`links.retarget` after a rename); only
    /// from the host connection.
    System,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandsExecuteParams {
    pub document_id: String,
    pub command: String,
    pub params: Map<String, Value>,
    pub origin: Origin,
    /// With origin `system`: the host feature that writes (`emailsync`), for the document's
    /// history; [`SYSTEM_LABEL`] when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_label: Option<String>,
}

/// The label of a `system` change whose host names no feature.
pub const SYSTEM_LABEL: &str = "host";

/// Whether `label` may name a host feature: 1 to 64 ASCII letters, digits, `-`, `_` and `.`.
pub fn is_origin_label(label: &str) -> bool {
    !label.is_empty() && label.len() <= 64 && label.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandsExecuteResult {
    pub changed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandsDidChangeEnabledParams {
    pub document_id: String,
    pub enabled: Vec<String>,
    pub disabled: Vec<String>,
}

/// A PNG image with base64 `data`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub data: String,
}

impl Image {
    pub const PNG: &'static str = "image/png";

    pub fn png(width: u32, height: u32, base64_data: String) -> Self {
        Self { mime_type: Self::PNG.to_owned(), width, height, data: base64_data }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenshotScope {
    Canvas,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewScreenshotParams {
    pub document_id: String,
    pub scope: ScreenshotScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_size: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewDescribeResult {
    pub summary: String,
    pub state: Map<String, Value>,
}

/// `document.text` (`KitText 1.0`): the document's words, read-only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTextParams {
    pub document_id: String,
    /// The most Unicode scalar values to answer; [`DOCUMENT_TEXT_LIMIT`] when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentTextResult {
    /// Plain text in reading order, blocks separated by newlines, at most `limit` characters.
    pub text: String,
    /// Whether the document has more words than `text` holds.
    pub truncated: bool,
    /// Labelled ranges of `text` (pages, slides, layers), counted in Unicode scalar values.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<TextPart>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextPart {
    pub label: String,
    pub start: u64,
    /// Exclusive.
    pub end: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProgressParams {
    /// The id of the request this progress belongs to.
    pub token: RequestId,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
    pub done: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogParams {
    pub level: LogLevel,
    pub message: String,
}

/// The rights a file handle carries (`KitFiles 1.1` FA2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileRight {
    Read,
    Create,
    Write,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Folder,
}

/// A handle's stat (`KitFiles 1.1` FA3): never a path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileStat {
    pub handle: String,
    /// The last path segment only; untrusted text for the kit.
    pub name: String,
    pub kind: FileKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// The host's opaque version stamp; `None` for a file not committed yet.
    pub version: Option<String>,
    pub rights: Vec<FileRight>,
}

/// The most bytes one `files.read` answers or one `files.write` carries (section 2).
pub const FILE_CHUNK: usize = 8 << 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRef {
    pub handle: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesReadParams {
    pub handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    /// At most [`FILE_CHUNK`]; the host may answer fewer bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesReadResult {
    /// Base64.
    pub data: String,
    pub version: String,
    /// The whole file's size.
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesListResult {
    pub files: Vec<FileStat>,
}

/// One chunk of a staged write (`KitFiles 1.1` FA9).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesWriteParams {
    pub handle: String,
    /// Base64, at most [`FILE_CHUNK`] bytes.
    pub data: String,
    /// The bytes staged so far.
    pub offset: u64,
    /// Commits the staged bytes atomically.
    #[serde(default, rename = "final", skip_serializing_if = "Option::is_none")]
    pub last: Option<bool>,
    /// On the final chunk of a replacing write: the version the kit read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
}

/// `{}`, or the committed version after the final chunk.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesWriteResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesCreateParams {
    pub suggested_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// A folder handle with `create`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Creates beside this document's file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
}

/// `files.resolve`: a `read` handle for a file the document refers to (a lent file, E5). The
/// document is named by its id, or by its file's handle while it is still opening.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesResolveParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// The path as the document stores it.
    pub link: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesReleaseParams {
    pub handles: Vec<String>,
}
