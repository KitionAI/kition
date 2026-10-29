//! Headless drafts (KHP A12 to A15 without an open editor): when `kition-kits-mcp` runs
//! with no Kition, an agent's `draft: true` edits go to a draft the headless kit holds, and the
//! person reviews it later through the server's `drafts` command (`list`, `compare`, `merge`,
//! `discard`), never through a tool.
//!
//! A draft of `<path>` lives in the workspace, in `.kition/drafts/<key>/` (`key`: the first 16
//! hex digits of the SHA-256 of `path`), in one of two modes:
//!
//! - `replica`, when the kit's headless executable opens replicas (`model.open`): the draft is
//!   a fork of the file's replica. `base.kdm` is the file's replica when the draft forked,
//!   `draft.kdm` and `blobs.bin` the draft's replica after its last edit and the media it
//!   references (`model.export`'s encoding). Its comparison has the object-level difference.
//! - `file`, for kits that cannot open replicas yet: the draft is a copy of the file,
//!   `draft.<ext>`, beside `base.<ext>`, the file when the draft forked. Its comparison has both
//!   sides rendered and summarized, without the object difference.
//!
//! `draft.json` is `{ "version": 1, "path", "kit", "mode": "replica" | "file", "state": "open" |
//! "ready", "baseSha256", "created", "updated" }` (times in Unix milliseconds); `baseSha256` is
//! the file's SHA-256 when the draft forked.
//!
//! A file's replica is built afresh each time a kit opens the file, so a draft can only be
//! merged onto the state it forked from: merging writes the draft as the file when the file is
//! unchanged since the fork, which is the state a CRDT merge would give (A14) as nothing else
//! changed. When the file changed since, the merge is refused as `stale` unless the person asks
//! to overwrite the file's newer edits.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::manager::{Caller, FileWrite, KitDefinition, KitError, KitManager};
use crate::tools::{ErrorCode, KitToolError};

/// The folder of the workspace's drafts.
pub const DRAFTS_DIR: &str = ".kition/drafts";
const META: &str = "draft.json";
const BASE: &str = "base.kdm";
const DRAFT: &str = "draft.kdm";
const BLOBS: &str = "blobs.bin";
const PREVIEW_SIZE: u32 = 1024;

/// A draft's state (A12): the agent is working on it, or asks for review.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftState {
    Open,
    Ready,
}

impl DraftState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Ready => "ready",
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

pub(crate) fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn io(path: &str, error: &std::io::Error) -> KitToolError {
    KitToolError::new(
        ErrorCode::Failed,
        format!(
            "the draft of `{path}` could not be stored: {}",
            error.kind()
        ),
    )
}

fn decode(value: &Value, what: &str) -> Result<Vec<u8>, KitToolError> {
    let text = value
        .as_str()
        .ok_or_else(|| KitToolError::new(ErrorCode::Failed, format!("the kit sent no {what}")))?;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|error| {
            KitToolError::new(
                ErrorCode::Failed,
                format!("the kit sent unreadable {what}: {error}"),
            )
        })
}

fn encode(bytes: &[u8]) -> Value {
    Value::String(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn key(path: &str) -> String {
    sha256(path.as_bytes())[..16].to_owned()
}

/// The folder of the draft of `path`.
pub fn folder(workspace: &Path, path: &str) -> PathBuf {
    workspace.join(DRAFTS_DIR).join(key(path))
}

/// The workspace path of a `file` draft's copy (`side` is `draft` or `base`).
fn copy_path(path: &str, side: &str) -> String {
    let extension = path.rsplit_once('.').map_or("", |(_, extension)| extension);
    format!("{DRAFTS_DIR}/{}/{side}.{extension}", key(path))
}

fn workspace(kits: &KitManager) -> Result<&Path, KitToolError> {
    kits.workspace_dir()
        .ok_or_else(|| KitToolError::new(ErrorCode::Failed, "drafts need a workspace folder"))
}

fn read_meta(dir: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(dir.join(META)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_meta(dir: &Path, path: &str, meta: &Value) -> Result<(), KitToolError> {
    let text = serde_json::to_string_pretty(meta).unwrap_or_default();
    std::fs::write(dir.join(META), text).map_err(|error| io(path, &error))
}

fn is_file_mode(meta: &Value) -> bool {
    meta["mode"] == "file"
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn draft_required(path: &str) -> KitToolError {
    KitToolError::new(
        ErrorCode::DraftRequired,
        format!("`{path}` has no draft yet: edit it with `draft: true` first."),
    )
}

/// The draft document the headless kit holds for `path`, opening it from its folder when the
/// kit does not hold it yet. With `create`, a file without a draft forks one; without, it is
/// `draft-required`.
pub(crate) async fn document(
    kits: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    create: bool,
) -> Result<String, KitToolError> {
    let held = kits.inner.draft_documents.lock().await.get(path).cloned();
    if let Some(id) = held
        && kits.document(Caller::Agent, kit.id, &id).await.is_ok()
    {
        return Ok(id);
    }
    let dir = folder(workspace(kits)?, path);
    let id = match read_meta(&dir) {
        Some(meta) if is_file_mode(&meta) => {
            kits.open(Caller::Agent, &copy_path(path, "draft"))
                .await?
                .document_id
        }
        Some(_) => {
            let snapshot = std::fs::read(dir.join(DRAFT)).map_err(|error| io(path, &error))?;
            let blobs = std::fs::read(dir.join(BLOBS)).ok();
            open_replica(kits, kit, path, &snapshot, blobs.as_deref()).await?
        }
        None if create => {
            let forked = fork(kits, kit, path, &dir).await;
            if forked.is_err() {
                let _ = std::fs::remove_dir_all(&dir);
            }
            forked?
        }
        None => return Err(draft_required(path)),
    };
    kits.inner
        .draft_documents
        .lock()
        .await
        .insert(path.to_owned(), id.clone());
    Ok(id)
}

async fn open_replica(
    kits: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    snapshot: &[u8],
    blobs: Option<&[u8]>,
) -> Result<String, KitToolError> {
    let mut params = json!({ "name": file_name(path), "snapshot": encode(snapshot) });
    if let Some(blobs) = blobs.filter(|blobs| !blobs.is_empty()) {
        params["blobs"] = encode(blobs);
    }
    let opened = kits
        .headless_request(Caller::Agent, kit, "model.open", params)
        .await?;
    opened["documentId"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| KitToolError::new(ErrorCode::Failed, "the kit opened no draft"))
}

/// Forks a draft from the file as it is now: a replica fork when the kit opens replicas, else a
/// copy of the file.
async fn fork(
    kits: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    dir: &Path,
) -> Result<String, KitToolError> {
    let bytes = std::fs::read(kits.resolve(path)?).map_err(|error| io(path, &error))?;
    std::fs::create_dir_all(dir).map_err(|error| io(path, &error))?;
    let replica = fork_replica(kits, kit, path, dir).await;
    let (mode, id) = match replica {
        Ok(id) => ("replica", id),
        Err(_) => {
            for side in ["base", "draft"] {
                std::fs::write(kits.resolve(&copy_path(path, side))?, &bytes)
                    .map_err(|error| io(path, &error))?;
            }
            let view = kits.open(Caller::Agent, &copy_path(path, "draft")).await?;
            ("file", view.document_id)
        }
    };
    let time = now();
    write_meta(
        dir,
        path,
        &json!({
            "version": 1,
            "path": path,
            "kit": kit.id,
            "mode": mode,
            "state": DraftState::Open.as_str(),
            "baseSha256": sha256(&bytes),
            "created": time,
            "updated": time,
        }),
    )?;
    Ok(id)
}

/// The file's replica now, stored as the base and as the draft, and opened as the draft.
async fn fork_replica(
    kits: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    dir: &Path,
) -> Result<String, KitToolError> {
    let view = kits.open(Caller::Agent, path).await?;
    let exported = kits
        .model(
            Caller::Agent,
            kit.id,
            &view.document_id,
            "model.export",
            serde_json::Map::new(),
        )
        .await?;
    let base = decode(&exported["changes"], "replica")?;
    let blobs = match exported.get("blobs") {
        Some(blobs) if blobs.is_string() => decode(blobs, "blobs")?,
        _ => Vec::new(),
    };
    let id = open_replica(kits, kit, path, &base, Some(&blobs)).await?;
    for (name, content) in [(BASE, &base), (DRAFT, &base), (BLOBS, &blobs)] {
        std::fs::write(dir.join(name), content).map_err(|error| io(path, &error))?;
    }
    Ok(id)
}

/// Stores the draft after an edit, and makes it `open` again (A12).
pub(crate) async fn persist(
    kits: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    id: &str,
) -> Result<(), KitToolError> {
    let dir = folder(workspace(kits)?, path);
    let meta = read_meta(&dir).ok_or_else(|| draft_required(path))?;
    if is_file_mode(&meta) {
        kits.save(Caller::Agent, kit.id, id).await?;
    } else {
        let exported = kits
            .model(
                Caller::Agent,
                kit.id,
                id,
                "model.export",
                serde_json::Map::new(),
            )
            .await?;
        let draft = decode(&exported["changes"], "replica")?;
        std::fs::write(dir.join(DRAFT), &draft).map_err(|error| io(path, &error))?;
        if let Some(blobs) = exported.get("blobs").filter(|blobs| blobs.is_string()) {
            let blobs = decode(blobs, "blobs")?;
            std::fs::write(dir.join(BLOBS), blobs).map_err(|error| io(path, &error))?;
        }
    }
    set_state(kits, path, DraftState::Open)
}

/// Marks the draft of `path` `ready` (the agent asks for review) or `open` (takes it back).
pub(crate) fn set_state(
    kits: &KitManager,
    path: &str,
    state: DraftState,
) -> Result<(), KitToolError> {
    let dir = folder(workspace(kits)?, path);
    let mut meta = read_meta(&dir).ok_or_else(|| draft_required(path))?;
    meta["state"] = Value::String(state.as_str().to_owned());
    meta["updated"] = json!(now());
    write_meta(&dir, path, &meta)
}

/// Whether `path` has a stored draft.
pub(crate) fn exists(kits: &KitManager, path: &str) -> bool {
    kits.workspace_dir()
        .is_some_and(|workspace| folder(workspace, path).join(META).is_file())
}

// The person's side: what `kition-kits-mcp drafts` runs. None of it is a tool (A14).

/// A refused `drafts` command: `code` is `not-found` (no draft), `stale` (the file changed
/// since the draft forked), or a kit tool's error code.
#[derive(Clone, Debug)]
pub struct DraftError {
    pub code: &'static str,
    pub message: String,
}

impl DraftError {
    fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }

    /// `{ "error": { code, message } }`, as the command prints it.
    pub fn to_json(&self) -> Value {
        json!({ "error": { "code": self.code, "message": self.message } })
    }
}

impl From<KitToolError> for DraftError {
    fn from(error: KitToolError) -> Self {
        Self::new(error.code.as_str(), error.message)
    }
}

impl From<KitError> for DraftError {
    fn from(error: KitError) -> Self {
        KitToolError::from(error).into()
    }
}

/// The workspace's drafts, oldest first, each `draft.json` plus whether the file changed since
/// the draft forked (`stale`).
pub fn list(workspace: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(workspace.join(DRAFTS_DIR)) else {
        return Vec::new();
    };
    let mut drafts: Vec<Value> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| read_meta(&entry.path()))
        .map(|mut meta| {
            let path = meta["path"].as_str().unwrap_or_default().to_owned();
            let current = std::fs::read(workspace.join(&path))
                .ok()
                .map(|bytes| sha256(&bytes));
            meta["stale"] = Value::Bool(current.as_deref() != meta["baseSha256"].as_str());
            meta
        })
        .collect();
    drafts.sort_by_key(|meta| meta["created"].as_u64().unwrap_or_default());
    drafts
}

fn stored(kits: &KitManager, path: &str) -> Result<(PathBuf, Value), DraftError> {
    let dir = folder(workspace(kits)?, path);
    let meta = read_meta(&dir)
        .ok_or_else(|| DraftError::new("not-found", format!("`{path}` has no draft")))?;
    Ok((dir, meta))
}

fn kit_of(kits: &KitManager, path: &str) -> Result<&'static KitDefinition, KitToolError> {
    kits.kit_for_path(path)
        .ok_or_else(|| KitToolError::invalid(format!("no kit opens `{path}`")))
}

fn is_stale(kits: &KitManager, path: &str, meta: &Value) -> Result<bool, KitToolError> {
    let bytes = std::fs::read(kits.resolve(path)?).map_err(|error| io(path, &error))?;
    Ok(Some(sha256(&bytes).as_str()) != meta["baseSha256"].as_str())
}

/// The canonical state of a stored replica, read with the kit's schema.
fn state_of(schema: &kition_kdm::Schema, bytes: &[u8]) -> Result<Value, String> {
    let replica = kition_kdm::Replica::load(
        std::sync::Arc::new(schema.clone()),
        bytes,
        kition_kdm::ActorId::random(),
    )
    .map_err(|error| format!("the replica does not read: {error}"))?;
    replica
        .state_json()
        .map_err(|error| format!("the replica's state does not read: {error}"))
}

/// The schema's types from the described ones: each field keeps what the schema declares, and
/// its marks (named in the description) expand after, which only editing reads.
fn schema_types(described: &Value) -> Value {
    const FIELD_KEYS: [&str; 5] = ["kind", "of", "values", "optional", "readOnly"];
    let mut types = serde_json::Map::new();
    for (name, ty) in described.as_object().into_iter().flatten() {
        let mut fields = serde_json::Map::new();
        for (field, def) in ty["fields"].as_object().into_iter().flatten() {
            let mut kept: serde_json::Map<String, Value> = FIELD_KEYS
                .iter()
                .filter_map(|key| {
                    def.get(*key)
                        .map(|value| ((*key).to_owned(), value.clone()))
                })
                .collect();
            if let Some(marks) = def.get("marks").and_then(Value::as_array) {
                let marks: serde_json::Map<String, Value> = marks
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|mark| (mark.to_owned(), json!({ "expand": "after" })))
                    .collect();
                kept.insert("marks".into(), Value::Object(marks));
            }
            fields.insert(field.clone(), Value::Object(kept));
        }
        let mut kept = json!({ "fields": fields });
        for key in ["readOnly", "readOnlyWhen"] {
            if let Some(value) = ty.get(key) {
                kept[key] = value.clone();
            }
        }
        types.insert(name.clone(), kept);
    }
    Value::Object(types)
}

/// The kit's document schema, from what its `model.describe` answers (`kit`, `schemaVersion`,
/// `root`, `types`: the schema's own fields).
async fn schema(
    kits: &KitManager,
    kit: &'static KitDefinition,
    id: &str,
) -> Result<kition_kdm::Schema, String> {
    let described = kits
        .model(
            Caller::User,
            kit.id,
            id,
            "model.describe",
            serde_json::Map::new(),
        )
        .await
        .map_err(|error| format!("the kit does not describe its objects: {error}"))?;
    let field = |name: &str| {
        described
            .get(name)
            .cloned()
            .ok_or_else(|| format!("the kit's description has no `{name}`"))
    };
    let schema = json!({
        "kdm": kition_kdm::KDM_VERSION,
        "kit": field("kit")?,
        "schemaVersion": field("schemaVersion")?,
        "root": field("root")?,
        "types": schema_types(&field("types")?),
    });
    serde_json::from_value(schema)
        .map_err(|error| format!("the kit's described schema does not read: {error}"))
}

/// The comparison a person reviews before merging (A13): `{ path, kit, mode, state, stale, diff,
/// summary: { base, draft } }`. `diff` is `{ created, changed, deleted, texts }` between the
/// file as the draft forked from it and the draft, for `replica` drafts whose kit reports its
/// schema (`null` otherwise). With `previews`, both sides rendered by the kit as base64 PNG
/// (`previews: { base, draft }`).
pub async fn compare(kits: &KitManager, path: &str, previews: bool) -> Result<Value, DraftError> {
    let (dir, meta) = stored(kits, path)?;
    let kit = kit_of(kits, path)?;
    let stale = is_stale(kits, path, &meta)?;
    let mut opened = Vec::new();
    let mut diff = Value::Null;
    let mut unavailable = Some("a copy of the file has no replica history to compare".to_owned());
    if is_file_mode(&meta) {
        for side in ["base", "draft"] {
            let view = kits.open(Caller::User, &copy_path(path, side)).await?;
            opened.push((side, view.document_id));
        }
    } else {
        let read = |name: &str| std::fs::read(dir.join(name)).map_err(|error| io(path, &error));
        let (base, draft) = (read(BASE)?, read(DRAFT)?);
        let blobs = std::fs::read(dir.join(BLOBS)).ok();
        opened.push((
            "base",
            open_replica(kits, kit, path, &base, blobs.as_deref()).await?,
        ));
        opened.push((
            "draft",
            open_replica(kits, kit, path, &draft, blobs.as_deref()).await?,
        ));
        let compared = match schema(kits, kit, &opened[1].1).await {
            Ok(schema) => state_of(&schema, &base).and_then(|before| {
                state_of(&schema, &draft)
                    .map(|after| kition_kdm::diff::diff_states(&before, &after).to_json())
            }),
            Err(reason) => Err(reason),
        };
        match compared {
            Ok(found) => diff = found,
            Err(reason) => unavailable = Some(reason),
        }
    }
    let mut summaries = serde_json::Map::new();
    let mut images = serde_json::Map::new();
    for (side, id) in &opened {
        if let Ok(view) = kits.document(Caller::User, kit.id, id).await {
            summaries.insert((*side).into(), Value::String(view.summary));
        }
        if previews && let Ok(png) = kits.preview(kit.id, id, PREVIEW_SIZE).await {
            images.insert((*side).into(), encode(&png));
        }
        // The agent's own draft document stays open; the comparison's copies close.
        if !(*side == "draft" && is_file_mode(&meta)) {
            let _ = kits.close(kit.id, id, true).await;
        }
    }
    let mut answer = json!({
        "path": path,
        "kit": kit.id,
        "mode": meta["mode"],
        "state": meta["state"],
        "stale": stale,
        "diff": diff,
        "summary": summaries,
    });
    if let Some(reason) = unavailable.filter(|_| diff.is_null()) {
        answer["diffUnavailable"] = Value::String(reason);
    }
    if previews {
        answer["previews"] = Value::Object(images);
    }
    Ok(answer)
}

/// Merges the draft of `path` (A14): writes the draft as the file and closes the draft. Refused
/// as `stale` when the file changed since the draft forked, unless `overwrite`, which drops the
/// file's newer edits.
pub async fn merge(kits: &KitManager, path: &str, overwrite: bool) -> Result<Value, DraftError> {
    let (dir, meta) = stored(kits, path)?;
    let kit = kit_of(kits, path)?;
    if is_stale(kits, path, &meta)? && !overwrite {
        return Err(DraftError::new(
            "stale",
            format!(
                "`{path}` changed since the draft forked from it: merging would drop those edits. Discard the draft, or merge with overwrite to replace them."
            ),
        ));
    }
    let bytes = if is_file_mode(&meta) {
        let copy = kits.resolve(&copy_path(path, "draft"))?;
        std::fs::read(copy).map_err(|error| io(path, &error))?
    } else {
        let draft = std::fs::read(dir.join(DRAFT)).map_err(|error| io(path, &error))?;
        let blobs = std::fs::read(dir.join(BLOBS)).ok();
        let id = open_replica(kits, kit, path, &draft, blobs.as_deref()).await?;
        let saved = kits
            .headless_request(Caller::User, kit, "model.save", json!({ "documentId": id }))
            .await;
        let _ = kits.close(kit.id, &id, true).await;
        decode(&saved?["data"], "file")?
    };
    kits.write_file(path, &bytes, FileWrite::Save { document: path })?;
    // Documents the kits hold of the file are now behind it; the next open reads it again.
    kits.close_file(path).await;
    discard_folder(kits, path, &dir).await;
    Ok(json!({ "path": path, "merged": true, "sha256": sha256(&bytes) }))
}

/// Discards the draft of `path` (A14): the file stays as it is.
pub async fn discard(kits: &KitManager, path: &str) -> Result<Value, DraftError> {
    let (dir, _) = stored(kits, path)?;
    discard_folder(kits, path, &dir).await;
    Ok(json!({ "path": path, "discarded": true }))
}

async fn discard_folder(kits: &KitManager, path: &str, dir: &Path) {
    if let Some(id) = kits.inner.draft_documents.lock().await.remove(path)
        && let Some(kit) = kits.kit_for_path(path)
    {
        let _ = kits.close(kit.id, &id, true).await;
    }
    for side in ["base", "draft"] {
        kits.close_file(&copy_path(path, side)).await;
    }
    let _ = std::fs::remove_dir_all(dir);
}
