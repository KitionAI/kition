//! The host table client: how Kition's host features (workflows, the scenario builder, the
//! workspace tree and search) read and write `.ktable` files.
//!
//! Kition has no table engine of its own. Every request goes to the Table kit, as the agent's
//! table tools do: to the live editor through the Kit AI bridge when a renderer window has the
//! file open (the edit joins that document, and the person sees it at once), and to the headless
//! `kit-table` otherwise, which saves the file. Writes carry a `system:<feature>` origin
//! (`asOrigin`), so they never join the person's undo. One queue per path keeps the host's own
//! requests to a file in order.
//!
//! Requests are the kit's engine commands `table.<method>` (kition-table `docs/engine-commands.md`):
//! each answers `{ "result", "change" }`; the client answers `result`.

pub mod routes;
pub mod scenario;
mod triggers;

use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::{Arc, Mutex, PoisonError};

use kition_core::events::EventBus;
use kition_kits::{Caller, KitError, KitManager};
use serde_json::{Map, Value, json};

pub use triggers::{TriggerWatcher, record_events};

/// The Table kit.
pub const TABLE_KIT: &str = "kit.table";
/// The table file extension, without the dot.
pub const TABLE_EXTENSION: &str = "ktable";

/// A request the kit refused, or one that could not reach it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TableError {
    pub message: String,
    /// The Table kit is not installed in this build (no `kit-table`).
    pub unavailable: bool,
    /// The file or the table, record, or field it names does not exist.
    pub not_found: bool,
}

impl TableError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            unavailable: false,
            not_found: false,
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            not_found: true,
            ..Self::new(message)
        }
    }
}

impl From<KitError> for TableError {
    fn from(error: KitError) -> Self {
        let unavailable = matches!(error, KitError::NotInstalled { .. } | KitError::NoWorkspace);
        Self {
            unavailable,
            ..Self::new(error.to_string())
        }
    }
}

pub type TableResult<T> = Result<T, TableError>;

/// One engine request: `method` is the request layer's name (`records.create`), without the
/// `table.` prefix of its command.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub method: String,
    pub params: Map<String, Value>,
}

impl Step {
    pub fn new(method: &str, params: Value) -> Self {
        Self {
            method: method.to_owned(),
            params: match params {
                Value::Object(map) => map,
                _ => Map::new(),
            },
        }
    }

    fn writes(&self) -> bool {
        !matches!(
            self.method.as_str(),
            "tables.list"
                | "fields.list"
                | "views.list"
                | "records.list"
                | "records.history"
                | "links.list"
                | "csv.export"
                | "markdown.export"
                | "historyState"
                | "dashboards.list"
                | "attachments.read"
                | "changes.since"
                | "ai.prepare"
                | "import.preview"
                | "fields.linkCandidates"
        ) && !self.method.starts_with("views.get")
            && self.method != "views.listFields"
    }
}

/// A field of a table, as the host features name it.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldInfo {
    pub id: String,
    /// The engine's key for the field's values.
    pub name: String,
    /// What people call it: its title, or its name without one.
    pub title: String,
    pub field_type: String,
    pub primary: bool,
    /// The field as the kit answered it.
    pub raw: Value,
}

/// A table in a file.
#[derive(Debug, Clone, PartialEq)]
pub struct TableInfo {
    pub id: String,
    pub name: String,
    pub title: String,
    pub fields: Vec<FieldInfo>,
    /// The table's own metadata, which host features may keep things in.
    pub meta: Value,
}

impl TableInfo {
    /// Values keyed by field id, name, or title, rekeyed by the field's name (the engine's key);
    /// keys no field has are left out.
    pub fn values_by_name(&self, values: &Map<String, Value>) -> Map<String, Value> {
        let mut out = Map::new();
        for (key, value) in values {
            let field = self
                .fields
                .iter()
                .find(|field| field.id == *key)
                .or_else(|| self.fields.iter().find(|field| field.name == *key))
                .or_else(|| self.fields.iter().find(|field| field.title == *key));
            if let Some(field) = field {
                out.insert(field.name.clone(), value.clone());
            }
        }
        out
    }
}

/// A record's id, values (keyed by field name), and creation time.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordInfo {
    pub id: String,
    pub values: Map<String, Value>,
    pub created_at: i64,
}

/// A dashboard in a file.
#[derive(Debug, Clone, PartialEq)]
pub struct DashboardInfo {
    pub id: String,
    pub name: String,
}

/// A table file, as the workspace lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct FileInfo {
    pub path: String,
    /// The document's stable identity: the id of its KDM root object, which a rename keeps.
    pub document_id: Option<String>,
    pub tables: Vec<TableInfo>,
    pub dashboards: Vec<DashboardInfo>,
}

fn id_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn display(title: String, name: String) -> String {
    if title.trim().is_empty() { name } else { title }
}

fn items(answer: &Value) -> Vec<Value> {
    answer
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| answer.as_array().cloned())
        .unwrap_or_default()
}

pub fn field_info(field: &Value) -> FieldInfo {
    let name = text(field, "name");
    FieldInfo {
        id: id_text(&field["id"]),
        title: display(text(field, "title"), name.clone()),
        name,
        field_type: text(field, "type"),
        primary: field["is_primary"] == true,
        raw: field.clone(),
    }
}

pub fn table_info(table: &Value) -> TableInfo {
    let name = text(table, "name");
    TableInfo {
        id: id_text(&table["id"]),
        title: display(text(table, "title"), name.clone()),
        name,
        fields: table["fields"]
            .as_array()
            .map(|fields| fields.iter().map(field_info).collect())
            .unwrap_or_default(),
        meta: table.get("meta").cloned().unwrap_or(Value::Null),
    }
}

pub fn record_info(record: &Value) -> RecordInfo {
    RecordInfo {
        id: id_text(&record["id"]),
        values: record["values"].as_object().cloned().unwrap_or_default(),
        created_at: record["created_at"].as_i64().unwrap_or_default(),
    }
}

/// A numeric engine id from its text, as the request layer takes it.
fn engine_id(id: &str) -> Value {
    id.trim()
        .parse::<i64>()
        .map_or_else(|_| Value::String(id.trim().to_owned()), Value::from)
}

/// Whether `path` names a table file inside the workspace: relative, no `..`, no hidden part.
pub fn is_table_path(path: &str) -> bool {
    let relative = Path::new(path);
    !path.trim().is_empty()
        && relative.extension().and_then(|ext| ext.to_str()) == Some(TABLE_EXTENSION)
        && relative.components().all(|part| match part {
            Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
            _ => false,
        })
}

/// Where the triggers keep each table file's `changes.since` cursor, in the workspace's own
/// store: a restart reports the edits made after the last report, and never one twice.
const CURSORS_FILE: &str = ".kition/tables/changes.json";

/// The cursors file: `{ "files": { "<path>": "<version>" } }`.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Cursors {
    #[serde(default)]
    files: HashMap<String, String>,
}

fn read_cursors(file: Option<&Path>) -> HashMap<String, String> {
    file.and_then(|file| std::fs::read(file).ok())
        .and_then(|bytes| serde_json::from_slice::<Cursors>(&bytes).ok())
        .map(|cursors| cursors.files)
        .unwrap_or_default()
}

/// Writes the cursors beside the file, then moves them over it, so a crash leaves the old ones.
fn write_cursors(file: &Path, files: &HashMap<String, String>) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(&Cursors {
        files: files.clone(),
    })?;
    let staged = file.with_extension("json.tmp");
    std::fs::write(&staged, bytes)?;
    std::fs::rename(&staged, file)
}

struct Inner {
    kits: KitManager,
    events: EventBus,
    queues: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// The version of each file the triggers last reported changes up to, kept in
    /// `cursors_file` across restarts.
    versions: Mutex<HashMap<String, String>>,
    cursors_file: Option<std::path::PathBuf>,
    /// Each closed file's description, with the modification time it was read at.
    described: Mutex<HashMap<String, (std::time::SystemTime, FileInfo)>>,
}

/// The host table client. Cheap to clone.
#[derive(Clone)]
pub struct TableClient {
    inner: Arc<Inner>,
}

impl TableClient {
    pub fn new(kits: KitManager, events: EventBus) -> Self {
        let cursors_file = kits.workspace_dir().map(|dir| dir.join(CURSORS_FILE));
        let versions = read_cursors(cursors_file.as_deref());
        Self {
            inner: Arc::new(Inner {
                kits,
                events,
                queues: Mutex::default(),
                versions: Mutex::new(versions),
                cursors_file,
                described: Mutex::default(),
            }),
        }
    }

    pub fn kits(&self) -> &KitManager {
        &self.inner.kits
    }

    pub fn events(&self) -> &EventBus {
        &self.inner.events
    }

    fn queue(&self, path: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .queues
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(path.to_owned())
            .or_default()
            .clone()
    }

    pub(crate) fn version(&self, path: &str) -> Option<String> {
        self.inner
            .versions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(path)
            .cloned()
    }

    pub(crate) fn set_version(&self, path: &str, version: String) {
        self.update_versions(|versions| {
            if versions.get(path) == Some(&version) {
                return false;
            }
            versions.insert(path.to_owned(), version);
            true
        });
    }

    /// Changes the cursors and, when `change` answers that it changed them, saves them.
    fn update_versions(&self, change: impl FnOnce(&mut HashMap<String, String>) -> bool) {
        let mut versions = self
            .inner
            .versions
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !change(&mut versions) {
            return;
        }
        if let Some(file) = &self.inner.cursors_file
            && let Err(error) = write_cursors(file, &versions)
        {
            tracing::warn!(%error, "the table triggers' cursors were not saved");
        }
    }

    /// Runs `steps` on the table file `path`, in order, and answers each step's `result`. With
    /// `write_as` (`system:<feature>`), every step writes as that origin. In an open editor the
    /// edits join its document, which is saved only when it had no unsaved edits of the person's
    /// own; on the headless kit they are saved to the file.
    pub async fn run(
        &self,
        path: &str,
        steps: Vec<Step>,
        write_as: Option<&str>,
    ) -> TableResult<Vec<Value>> {
        if !is_table_path(path) {
            return Err(TableError::new(format!("`{path}` is not a table file")));
        }
        let steps: Vec<Step> = steps
            .into_iter()
            .map(|mut step| {
                if let Some(origin) = write_as.filter(|_| step.writes()) {
                    step.params
                        .insert("asOrigin".into(), Value::String(origin.to_owned()));
                }
                step
            })
            .collect();
        let writes = steps.iter().any(Step::writes);
        // The first request to a file also learns its version, from which the triggers report
        // other people's edits (`triggers.rs`).
        let prime = self.version(path).is_none();
        let mut steps = steps;
        if prime {
            steps.push(Step::new("changes.since", json!({ "version": "" })));
        }
        let mut answers = self.run_steps(path, &steps, writes).await?;
        if prime
            && let Some(since) = answers.pop()
            && let Some(version) = since["version"].as_str()
        {
            self.set_version(path, version.to_owned());
        }
        Ok(answers)
    }

    async fn run_steps(&self, path: &str, steps: &[Step], writes: bool) -> TableResult<Vec<Value>> {
        let queue = self.queue(path);
        let _turn = queue.lock().await;
        let kits = &self.inner.kits;
        if let Some(document) = kits.bridge().find(path).await
            && document.kit == TABLE_KIT
        {
            let commands: Vec<Value> = steps
                .iter()
                .map(|step| json!({ "command": format!("table.{}", step.method), "params": step.params }))
                .collect();
            let answer = kits
                .bridge()
                .call(
                    &document,
                    "run",
                    json!({ "steps": commands, "save": writes && !document.dirty }),
                )
                .await
                .map_err(|failure| TableError::new(failure.message))?;
            return Ok(answer["completed"]
                .as_array()
                .map(|completed| {
                    completed
                        .iter()
                        .map(|step| step["result"]["result"].clone())
                        .collect()
                })
                .unwrap_or_default());
        }
        if !kits
            .workspace_dir()
            .is_some_and(|dir| dir.join(path).is_file())
        {
            return Err(TableError::not_found(format!("`{path}` does not exist")));
        }
        let already_open = kits
            .open_files()
            .await
            .iter()
            .any(|(kit, open)| *kit == TABLE_KIT && open == path);
        let view = kits.open(Caller::User, path).await?;
        let outcome = self.run_headless(&view.document_id, steps).await;
        let saved = match (&outcome, writes) {
            (Ok(_), true) => kits
                .save(Caller::User, TABLE_KIT, &view.document_id)
                .await
                .map(|_| ())
                .map_err(TableError::from),
            _ => Ok(()),
        };
        if !already_open {
            // A failed write leaves the file as it was: the unsaved edits go with the document.
            let _ = kits.close(TABLE_KIT, &view.document_id, true).await;
        }
        saved?;
        outcome
    }

    async fn run_headless(&self, document_id: &str, steps: &[Step]) -> TableResult<Vec<Value>> {
        let mut answers = Vec::new();
        for step in steps {
            let executed = self
                .inner
                .kits
                .execute(
                    Caller::User,
                    TABLE_KIT,
                    document_id,
                    &format!("table.{}", step.method),
                    step.params.clone(),
                )
                .await?;
            answers.push(
                executed
                    .result
                    .map(|answer| answer["result"].clone())
                    .unwrap_or(Value::Null),
            );
        }
        Ok(answers)
    }

    /// One request; answers its `result`.
    pub async fn request(
        &self,
        path: &str,
        method: &str,
        params: Value,
        write_as: Option<&str>,
    ) -> TableResult<Value> {
        let mut answers = self
            .run(path, vec![Step::new(method, params)], write_as)
            .await?;
        Ok(answers.pop().unwrap_or(Value::Null))
    }

    /// The file's tables, with their fields.
    pub async fn tables(&self, path: &str) -> TableResult<Vec<TableInfo>> {
        let answer = self.request(path, "tables.list", json!({}), None).await?;
        Ok(items(&answer).iter().map(table_info).collect())
    }

    /// One table of the file, with its fields.
    pub async fn table(&self, path: &str, table_id: &str) -> TableResult<TableInfo> {
        self.tables(path)
            .await?
            .into_iter()
            .find(|table| table.id == table_id.trim())
            .ok_or_else(|| TableError::not_found(format!("`{path}` has no table {table_id}")))
    }

    /// Every record of a table, values keyed by field name.
    pub async fn records(&self, path: &str, table_id: &str) -> TableResult<Vec<RecordInfo>> {
        let answer = self
            .request(
                path,
                "records.list",
                json!({ "tableId": engine_id(table_id) }),
                None,
            )
            .await?;
        Ok(items(&answer).iter().map(record_info).collect())
    }

    /// The table's records as the kit answers them, at most `limit` from `offset` (all with 0).
    pub async fn records_page(
        &self,
        path: &str,
        table_id: &str,
        limit: u64,
        offset: u64,
    ) -> TableResult<Value> {
        let mut params = json!({ "tableId": engine_id(table_id) });
        if limit > 0 {
            params["limit"] = json!(limit);
        }
        if offset > 0 {
            params["offset"] = json!(offset);
        }
        self.request(path, "records.list", params, None).await
    }

    /// Creates a record from values keyed by field id, name, or title, as `write_as`; publishes
    /// `RecordCreated`. Answers the record.
    pub async fn create_record(
        &self,
        path: &str,
        table_id: &str,
        values: &Map<String, Value>,
        write_as: &str,
    ) -> TableResult<RecordInfo> {
        let table = self.table(path, table_id).await?;
        let answer = self
            .request(
                path,
                "records.create",
                json!({ "tableId": engine_id(table_id), "values": table.values_by_name(values) }),
                Some(write_as),
            )
            .await?;
        let record = record_info(&answer);
        self.publish_created(path, &table.id, &record);
        Ok(record)
    }

    /// Updates a record from values keyed by field id, name, or title, as `write_as`; publishes
    /// `RecordUpdated`. Answers the record's values after the update.
    pub async fn update_record(
        &self,
        path: &str,
        table_id: &str,
        record_id: &str,
        values: &Map<String, Value>,
        write_as: &str,
    ) -> TableResult<Map<String, Value>> {
        let table = self.table(path, table_id).await?;
        let previous = self
            .records(path, table_id)
            .await?
            .into_iter()
            .find(|record| record.id == record_id.trim())
            .ok_or_else(|| {
                TableError::not_found(format!("table {table_id} has no record {record_id}"))
            })?;
        let answer = self
            .request(
                path,
                "records.update",
                json!({
                    "tableId": engine_id(table_id),
                    "recordId": engine_id(record_id),
                    "values": table.values_by_name(values),
                }),
                Some(write_as),
            )
            .await?;
        let record = record_info(&answer);
        self.inner.events.publish(record_events::updated(
            path,
            &table.id,
            &record,
            Some(previous.values),
        ));
        Ok(record.values)
    }

    pub(crate) fn publish_created(&self, path: &str, table_id: &str, record: &RecordInfo) {
        self.inner
            .events
            .publish(record_events::created(path, table_id, record));
    }

    /// Adds a table (`title`, and `fields` as the request layer's field seeds) as `write_as`.
    pub async fn create_table(
        &self,
        path: &str,
        title: &str,
        fields: Vec<Value>,
        write_as: &str,
    ) -> TableResult<TableInfo> {
        let mut params = json!({ "title": title });
        if !fields.is_empty() {
            params["fields"] = Value::Array(fields);
        }
        let answer = self
            .request(path, "tables.create", params, Some(write_as))
            .await?;
        Ok(table_info(&answer))
    }

    /// Renames a table, and replaces its metadata, as `write_as`.
    pub async fn update_table(
        &self,
        path: &str,
        table_id: &str,
        title: Option<&str>,
        meta: Option<Value>,
        write_as: &str,
    ) -> TableResult<TableInfo> {
        let mut params = json!({ "tableId": engine_id(table_id) });
        if let Some(title) = title {
            params["title"] = json!(title);
        }
        if let Some(meta) = meta {
            params["meta"] = meta;
        }
        self.request(path, "tables.update", params, Some(write_as))
            .await?;
        self.table(path, table_id).await
    }

    /// Stores `bytes` in the file as a blob for `table_id`; answers the attachment value a file
    /// field holds.
    pub async fn put_attachment(
        &self,
        path: &str,
        table_id: &str,
        name: &str,
        mime: &str,
        bytes: &[u8],
        write_as: &str,
    ) -> TableResult<Value> {
        use base64::Engine as _;
        self.request(
            path,
            "attachments.put",
            json!({
                "tableId": engine_id(table_id),
                "name": name,
                "mime_type": mime,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
            Some(write_as),
        )
        .await
    }

    /// The file's identity, tables, and dashboards.
    pub async fn describe(&self, path: &str) -> TableResult<FileInfo> {
        let answers = self
            .run(
                path,
                vec![
                    Step::new("tables.list", json!({})),
                    Step::new("dashboards.list", json!({})),
                ],
                None,
            )
            .await?;
        let tables = answers.first().map(items).unwrap_or_default();
        let dashboards = answers.get(1).map(items).unwrap_or_default();
        Ok(FileInfo {
            path: path.to_owned(),
            document_id: self.document_id(path).await,
            tables: tables.iter().map(table_info).collect(),
            dashboards: dashboards
                .iter()
                .map(|dashboard| DashboardInfo {
                    id: id_text(&dashboard["id"]),
                    name: display(text(dashboard, "name"), text(dashboard, "title")),
                })
                .collect(),
        })
    }

    /// `describe`, remembered for a file no editor has open until the file changes.
    pub async fn describe_cached(&self, path: &str) -> TableResult<FileInfo> {
        let modified = self
            .inner
            .kits
            .workspace_dir()
            .and_then(|dir| std::fs::metadata(dir.join(path)).ok())
            .and_then(|meta| meta.modified().ok());
        let live = self.inner.kits.bridge().find(path).await.is_some();
        if let (Some(modified), false) = (modified, live)
            && let Some((when, file)) = self
                .inner
                .described
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(path)
            && *when == modified
        {
            return Ok(file.clone());
        }
        let file = self.describe(path).await?;
        if let (Some(modified), false) = (modified, live) {
            self.inner
                .described
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(path.to_owned(), (modified, file.clone()));
        }
        Ok(file)
    }

    /// Drops what the client remembers of `path`, a deleted file or folder.
    pub fn forget(&self, path: &str) {
        let under = |known: &String| known == path || known.starts_with(&format!("{path}/"));
        self.inner
            .described
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|known, _| !under(known));
        self.update_versions(|versions| {
            let before = versions.len();
            versions.retain(|known, _| !under(known));
            versions.len() != before
        });
    }

    /// Follows a file or folder renamed from `from` to `to`: its description is read again, and
    /// the triggers' cursors move with it (a rename keeps the document and its versions).
    pub fn moved(&self, from: &str, to: &str) {
        let (from, to) = (from.trim_end_matches('/'), to.trim_end_matches('/'));
        let under = |known: &String| known == from || known.starts_with(&format!("{from}/"));
        self.inner
            .described
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|known, _| !under(known));
        self.update_versions(|versions| {
            let moving: Vec<String> = versions
                .keys()
                .filter(|known| under(known))
                .cloned()
                .collect();
            for known in &moving {
                if let Some(version) = versions.remove(known) {
                    versions.insert(format!("{to}{}", &known[from.len()..]), version);
                }
            }
            !moving.is_empty()
        });
    }

    /// The document's KDM root object id, from the headless kit's object model.
    async fn document_id(&self, path: &str) -> Option<String> {
        // An open editor's document has the same root as its file.
        let kits = &self.inner.kits;
        let queue = self.queue(path);
        let _turn = queue.lock().await;
        let already_open = kits
            .open_files()
            .await
            .iter()
            .any(|(kit, open)| *kit == TABLE_KIT && open == path);
        let view = kits.open(Caller::User, path).await.ok()?;
        let described = kits
            .model(
                Caller::User,
                TABLE_KIT,
                &view.document_id,
                "model.describe",
                Map::new(),
            )
            .await
            .ok();
        if !already_open {
            let _ = kits.close(TABLE_KIT, &view.document_id, true).await;
        }
        described.and_then(|described| described["rootId"].as_str().map(str::to_owned))
    }

    /// Makes a new table file at `path` (which must not exist) with the kit's starter table,
    /// then renames that table to `title` when one is given. Answers the file's tables.
    pub async fn create_file(
        &self,
        path: &str,
        title: Option<&str>,
    ) -> TableResult<Vec<TableInfo>> {
        if !is_table_path(path) {
            return Err(TableError::new(format!("`{path}` is not a table file")));
        }
        let kits = &self.inner.kits;
        let workspace = kits
            .workspace_dir()
            .ok_or_else(|| TableError::from(KitError::NoWorkspace))?
            .to_path_buf();
        let target = workspace.join(path);
        if target.exists() {
            return Err(TableError::new(format!("`{path}` already exists")));
        }
        let folder = Path::new(path)
            .parent()
            .map(|parent| parent.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| TableError::new(error.to_string()))?;
        }
        let made = {
            let queue = self.queue(path);
            let _turn = queue.lock().await;
            let view = kits
                .create(Caller::User, &folder, TABLE_EXTENSION, Map::new())
                .await?;
            let _ = kits.close(TABLE_KIT, &view.document_id, false).await;
            view.path
                .ok_or_else(|| TableError::new("the kit made no file"))?
        };
        if made != path {
            std::fs::rename(workspace.join(&made), &target).map_err(|error| {
                let _ = std::fs::remove_file(workspace.join(&made));
                TableError::new(error.to_string())
            })?;
        }
        let tables = self.tables(path).await?;
        if let (Some(title), Some(first)) = (
            title.filter(|title| !title.trim().is_empty()),
            tables.first(),
        ) {
            self.request(
                path,
                "tables.update",
                json!({ "tableId": engine_id(&first.id), "title": title }),
                Some("system:create"),
            )
            .await?;
            return self.tables(path).await;
        }
        Ok(tables)
    }

    /// The file's stamp, which changes whenever it is written: its modification time in
    /// milliseconds and its size. `None` when it does not exist.
    pub fn stamp(&self, path: &str) -> Option<String> {
        let meta = std::fs::metadata(self.inner.kits.workspace_dir()?.join(path)).ok()?;
        let modified = meta
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis();
        Some(format!("{modified}-{}", meta.len()))
    }

    /// Every table file in the workspace, by path, skipping hidden folders.
    pub fn table_files(&self) -> Vec<String> {
        let Some(root) = self.inner.kits.workspace_dir() else {
            return Vec::new();
        };
        let mut found = Vec::new();
        let mut folders = vec![root.to_path_buf()];
        while let Some(folder) = folders.pop() {
            let Ok(entries) = std::fs::read_dir(&folder) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                let path = entry.path();
                if path.is_dir() {
                    folders.push(path);
                } else if let Ok(relative) = path.strip_prefix(root) {
                    let relative = relative.to_string_lossy().replace('\\', "/");
                    if is_table_path(&relative) {
                        found.push(relative);
                    }
                }
            }
        }
        found.sort();
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_paths_stay_inside_the_workspace() {
        assert!(is_table_path("Leads.ktable"));
        assert!(is_table_path("crm/Leads.ktable"));
        assert!(!is_table_path("/abs/Leads.ktable"));
        assert!(!is_table_path("../Leads.ktable"));
        assert!(!is_table_path(".kition/Leads.ktable"));
        assert!(!is_table_path("Leads.kitable"));
        assert!(!is_table_path(""));
    }

    #[test]
    fn values_are_keyed_by_field_name() {
        let table = table_info(&json!({
            "id": 1, "name": "leads", "title": "Leads",
            "fields": [
                { "id": 1, "name": "title", "title": "Name", "type": "text", "is_primary": true },
                { "id": 2, "name": "email", "title": "", "type": "email" }
            ]
        }));
        assert_eq!(table.fields[1].title, "email");
        let values =
            json!({ "1": "Ada", "email": "a@example.com", "Name": "ignored?", "other": 1 });
        let keyed = table.values_by_name(values.as_object().unwrap_or(&Map::new()));
        assert_eq!(keyed.get("email"), Some(&json!("a@example.com")));
        assert!(keyed.contains_key("title"));
        assert!(!keyed.contains_key("other"));
    }

    #[test]
    fn cursors_survive_a_restart_and_follow_renames_and_deletes() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let open = || {
            TableClient::new(
                KitManager::new(Some(dir.path().to_path_buf()), Vec::new()),
                EventBus::default(),
            )
        };
        let client = open();
        client.set_version("crm/Leads.ktable", "v1".into());
        client.set_version("crm/Deals.ktable", "v2".into());
        client.set_version("Other.ktable", "v3".into());
        let restarted = open();
        assert_eq!(restarted.version("crm/Leads.ktable").as_deref(), Some("v1"));
        restarted.moved("crm", "sales");
        restarted.forget("Other.ktable");
        let again = open();
        assert_eq!(again.version("crm/Leads.ktable"), None);
        assert_eq!(again.version("sales/Leads.ktable").as_deref(), Some("v1"));
        assert_eq!(again.version("sales/Deals.ktable").as_deref(), Some("v2"));
        assert_eq!(again.version("Other.ktable"), None);
    }

    #[test]
    fn reads_only_steps_do_not_write() {
        assert!(!Step::new("records.list", json!({})).writes());
        assert!(!Step::new("views.getSorts", json!({})).writes());
        assert!(Step::new("records.create", json!({})).writes());
        assert!(Step::new("tables.update", json!({})).writes());
    }
}
