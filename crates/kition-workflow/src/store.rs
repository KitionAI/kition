//! JSON-file persistence: definitions (`workflow.json`), run history
//! (`workflow_runs.json`), and fire-once dedup keys.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError, RwLock};

use kition_core::{Millis, now_millis};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::types::*;

fn write_json(path: &Path, value: &impl Serialize, pretty: bool) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let bytes = if pretty {
        serde_json::to_vec_pretty(value)
    } else {
        serde_json::to_vec(value)
    }
    .map_err(|e| e.to_string())?;
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if path.as_os_str().is_empty() {
        return Ok(None);
    }
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// Partial updates; `None` leaves a field unchanged.
#[derive(Debug, Clone, Default)]
pub struct WorkflowPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub enabled: Option<bool>,
    pub trigger: Option<TriggerPatch>,
    pub action: Option<ActionPatch>,
    pub nodes: Option<Vec<NodeConfig>>,
    pub edges: Option<Vec<EdgeConfig>>,
}

#[derive(Debug, Clone, Default)]
pub struct TriggerPatch {
    pub node_id: Option<String>,
    pub trigger_type: Option<String>,
    pub document_id: Option<String>,
    pub table_id: Option<String>,
    pub schedule: Option<ScheduleConfig>,
    pub date_field: Option<DateFieldConfig>,
    /// An empty list clears the gate.
    pub required_fields: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct ActionPatch {
    pub action_type: Option<String>,
    pub connection_id: Option<String>,
    pub to: Option<String>,
    pub subject: Option<BodyTemplate>,
    pub body: Option<BodyTemplate>,
    pub add_record: Option<AddRecordConfig>,
    pub update_record: Option<UpdateRecordConfig>,
    pub lookup_record: Option<LookupRecordConfig>,
    pub transform_record: Option<TransformRecordConfig>,
}

/// Applies a patch without validating or saving it.
pub fn apply_patch(mut def: WorkflowDefinition, patch: WorkflowPatch) -> WorkflowDefinition {
    if let Some(name) = patch.name {
        def.name = name;
    }
    if let Some(description) = patch.description {
        def.description = description;
    }
    if let Some(enabled) = patch.enabled {
        def.enabled = enabled;
    }
    if let Some(trigger) = patch.trigger {
        let t = &mut def.trigger;
        if let Some(v) = trigger.node_id {
            t.node_id = v;
        }
        if let Some(v) = trigger.trigger_type {
            t.trigger_type = v;
        }
        if let Some(v) = trigger.document_id {
            t.document_id = v;
        }
        if let Some(v) = trigger.table_id {
            t.table_id = v;
        }
        if let Some(v) = trigger.schedule {
            t.schedule = Some(v);
        }
        if let Some(v) = trigger.date_field {
            t.date_field = Some(v);
        }
        if let Some(v) = trigger.required_fields {
            t.required_fields = if v.is_empty() {
                Default::default()
            } else {
                v.into()
            };
        }
    }
    if let Some(action) = patch.action {
        let a = &mut def.action;
        if let Some(v) = action.action_type {
            a.action_type = v;
        }
        if let Some(v) = action.connection_id {
            a.connection_id = v;
        }
        if let Some(v) = action.to {
            a.to = v;
        }
        if let Some(v) = action.subject {
            a.subject = v;
        }
        if let Some(v) = action.body {
            a.body = v;
        }
        if let Some(v) = action.add_record {
            a.add_record = Some(v);
        }
        if let Some(v) = action.update_record {
            a.update_record = Some(v);
        }
        if let Some(v) = action.lookup_record {
            a.lookup_record = Some(v);
        }
        if let Some(v) = action.transform_record {
            a.transform_record = Some(v);
        }
    }
    if let Some(nodes) = patch.nodes {
        def.extra_nodes = nodes
            .into_iter()
            .filter(|n| n.kind == KIND_FILTER)
            .collect();
    }
    if let Some(edges) = patch.edges {
        def.extra_edges = edges;
    }
    def
}

/// Definitions, persisted as a JSON object keyed by workflow ID.
pub struct Store {
    path: PathBuf,
    data: RwLock<BTreeMap<String, WorkflowDefinition>>,
}

pub enum UpdateError {
    NotFound,
    Invalid(String),
    Write(String),
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            data: RwLock::default(),
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, BTreeMap<String, WorkflowDefinition>> {
        self.data.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, BTreeMap<String, WorkflowDefinition>> {
        self.data.write().unwrap_or_else(PoisonError::into_inner)
    }

    /// Upgrades older files, then loads them.
    pub fn load(&self) -> Result<(), String> {
        migrate_file(&self.path, now_millis())?;
        if let Some(map) = read_json::<BTreeMap<String, WorkflowDefinition>>(&self.path)? {
            *self.write() = map;
        }
        Ok(())
    }

    fn persist(&self, snapshot: &BTreeMap<String, WorkflowDefinition>) -> Result<(), String> {
        write_json(&self.path, snapshot, true)
    }

    pub fn put(&self, def: WorkflowDefinition) -> Result<(), String> {
        def.validate()?;
        let snapshot = {
            let mut data = self.write();
            data.insert(def.id.clone(), def);
            data.clone()
        };
        self.persist(&snapshot)
    }

    pub fn get(&self, id: &str) -> Option<WorkflowDefinition> {
        self.read().get(id).cloned()
    }

    /// Sorted by name, then ID.
    pub fn list(&self) -> Vec<WorkflowDefinition> {
        let mut out: Vec<WorkflowDefinition> = self.read().values().cloned().collect();
        out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        out
    }

    pub fn list_enabled(&self) -> Vec<WorkflowDefinition> {
        self.read()
            .values()
            .filter(|d| d.enabled)
            .cloned()
            .collect()
    }

    pub fn count_by_connection(&self, connection_id: &str) -> usize {
        self.read()
            .values()
            .filter(|d| d.action.connection_id == connection_id)
            .count()
    }

    pub fn update(
        &self,
        id: &str,
        patch: WorkflowPatch,
    ) -> Result<WorkflowDefinition, UpdateError> {
        let (def, snapshot) = {
            let mut data = self.write();
            let current = data.get(id).cloned().ok_or(UpdateError::NotFound)?;
            let def = apply_patch(current, patch);
            def.validate().map_err(UpdateError::Invalid)?;
            data.insert(id.to_owned(), def.clone());
            (def, data.clone())
        };
        self.persist(&snapshot).map_err(UpdateError::Write)?;
        Ok(def)
    }

    /// False when the workflow does not exist.
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let snapshot = {
            let mut data = self.write();
            if data.remove(id).is_none() {
                return Ok(false);
            }
            data.clone()
        };
        self.persist(&snapshot)?;
        Ok(true)
    }

    /// Removes workflows that read from or write to a document.
    pub fn delete_by_document_id(&self, document_id: &str) -> Result<usize, String> {
        let document_id = document_id.trim();
        if document_id.is_empty() {
            return Ok(0);
        }
        let (removed, snapshot) = {
            let mut data = self.write();
            let before = data.len();
            data.retain(|_, def| {
                let target = def
                    .action
                    .add_record
                    .as_ref()
                    .map(|c| c.target_document_id.trim())
                    .unwrap_or_default();
                def.trigger.document_id.trim() != document_id && target != document_id
            });
            (before - data.len(), data.clone())
        };
        if removed > 0 {
            self.persist(&snapshot)?;
        }
        Ok(removed)
    }
}

/// Rewrites `workflow.json` in the current schema when any entry is older,
/// keeping a `.bak.<nanos>` copy. Unreadable files are an error and are not
/// touched.
pub fn migrate_file(path: &Path, now: Millis) -> Result<usize, String> {
    if path.as_os_str().is_empty() {
        return Ok(0);
    }
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(format!("workflow migrate: read {}: {err}", path.display())),
    };
    let entries: Map<String, Value> = serde_json::from_slice(&raw)
        .map_err(|err| format!("workflow migrate: parse {}: {err}", path.display()))?;
    let mut defs = BTreeMap::new();
    let mut migrated = 0;
    for (id, entry) in entries {
        let schema_ver = entry.get("schemaVer").and_then(Value::as_i64).unwrap_or(0);
        let mut def: WorkflowDefinition = serde_json::from_value(entry)
            .map_err(|err| format!("workflow migrate: parse entry {id:?}: {err}"))?;
        if def.id.is_empty() {
            def.id = id;
        }
        if schema_ver < SCHEMA_VER_CURRENT {
            migrated += 1;
        }
        defs.insert(def.id.clone(), def);
    }
    if migrated == 0 {
        return Ok(0);
    }
    let backup = format!("{}.bak.{}", path.display(), now.saturating_mul(1_000_000));
    std::fs::write(&backup, &raw)
        .map_err(|err| format!("workflow migrate: write backup {backup}: {err}"))?;
    write_json(path, &defs, true).map_err(|err| format!("workflow migrate: {err}"))?;
    Ok(migrated)
}

const MAX_RUNS_PER_WORKFLOW: usize = 200;
const BODY_LIMIT: usize = 4096;
const SUBJECT_LIMIT: usize = 256;
const SENSITIVE_KEYS: [&str; 11] = [
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "api_key",
    "private_key",
    "privatekey",
    "credential",
    "authorization",
    "auth_token",
];

/// Keeps at most `max` bytes, ending with a `… [truncated N bytes]` note.
pub fn truncate_for_history(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let suffix = format!(" … [truncated {} bytes]", text.len() - max);
    let mut keep = max.saturating_sub(suffix.len());
    while !text.is_char_boundary(keep) {
        keep -= 1;
    }
    format!("{}{suffix}", &text[..keep])
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    SENSITIVE_KEYS.iter().any(|p| lower.contains(p))
}

/// Bounds stored text and masks secret-looking trigger values.
pub fn sanitize_for_history(mut run: RunRecord) -> RunRecord {
    run.body = truncate_for_history(&run.body, BODY_LIMIT);
    run.subject = truncate_for_history(&run.subject, SUBJECT_LIMIT);
    if let Some(fields) = run.trigger_fields.as_mut() {
        for (key, value) in fields.iter_mut() {
            if is_sensitive_key(key) {
                *value = Value::String("[redacted]".into());
            }
        }
    }
    run
}

/// Recent runs per workflow, oldest first on disk.
pub struct RunHistory {
    path: PathBuf,
    data: Mutex<BTreeMap<String, Vec<RunRecord>>>,
}

impl RunHistory {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            data: Mutex::default(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<String, Vec<RunRecord>>> {
        self.data.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn load(&self) -> Result<(), String> {
        if let Some(map) = read_json(&self.path)? {
            *self.lock() = map;
        }
        Ok(())
    }

    pub fn append(&self, run: RunRecord) -> Result<(), String> {
        let run = sanitize_for_history(run);
        let snapshot = {
            let mut data = self.lock();
            let list = data.entry(run.workflow_id.clone()).or_default();
            list.push(run);
            if list.len() > MAX_RUNS_PER_WORKFLOW {
                let excess = list.len() - MAX_RUNS_PER_WORKFLOW;
                list.drain(..excess);
            }
            data.clone()
        };
        write_json(&self.path, &snapshot, true)
    }

    /// Newest first; `limit` defaults to 50 and is capped at 200.
    pub fn list(&self, workflow_id: &str, limit: i64) -> Vec<RunRecord> {
        let limit = if limit <= 0 { 50 } else { limit.min(200) } as usize;
        self.lock()
            .get(workflow_id)
            .map(|runs| runs.iter().rev().take(limit).cloned().collect())
            .unwrap_or_default()
    }

    pub fn get(&self, workflow_id: &str, run_id: &str) -> Option<RunRecord> {
        self.lock()
            .get(workflow_id)?
            .iter()
            .find(|r| r.id == run_id)
            .cloned()
    }

    /// Drops finished runs older than the cutoffs; returns (ok, error)
    /// counts.
    pub fn gc(&self, ok_before: Millis, error_before: Millis) -> Result<(usize, usize), String> {
        let (mut ok, mut error) = (0, 0);
        let snapshot = {
            let mut data = self.lock();
            for runs in data.values_mut() {
                runs.retain(|run| {
                    let at = if run.finished_at != 0 {
                        run.finished_at
                    } else {
                        run.started_at
                    };
                    match run.status.as_str() {
                        "ok" | "skipped" if at < ok_before => {
                            ok += 1;
                            false
                        }
                        "error" if at < error_before => {
                            error += 1;
                            false
                        }
                        _ => true,
                    }
                });
            }
            data.clone()
        };
        write_json(&self.path, &snapshot, true)?;
        Ok((ok, error))
    }
}

/// Keys of fires that already happened, persisted as a sorted JSON array.
pub struct Dedup {
    path: PathBuf,
    seen: Mutex<BTreeSet<String>>,
}

impl Dedup {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            seen: Mutex::default(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, BTreeSet<String>> {
        self.seen.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A corrupt snapshot starts empty (over-firing beats never firing).
    pub fn load(&self) -> Result<(), String> {
        match read_json::<Vec<String>>(&self.path) {
            Ok(Some(keys)) => *self.lock() = keys.into_iter().collect(),
            Ok(None) => {}
            Err(err) if std::fs::metadata(&self.path).is_ok() => {
                tracing::warn!(path = %self.path.display(), error = %err, "workflow dedup snapshot is corrupt; starting empty");
                self.lock().clear();
            }
            Err(err) => return Err(err),
        }
        Ok(())
    }

    pub fn seen(&self, key: &str) -> bool {
        self.lock().contains(key)
    }

    pub fn mark(&self, key: &str) -> Result<(), String> {
        let snapshot = {
            let mut seen = self.lock();
            if !seen.insert(key.to_owned()) {
                return Ok(());
            }
            seen.iter().cloned().collect::<Vec<_>>()
        };
        write_json(&self.path, &snapshot, false)
    }

    /// Drops keys whose trailing `:YYYY-MM-DD` sorts before `cutoff`.
    pub fn gc_before(&self, cutoff: &str) -> Result<(), String> {
        let snapshot = {
            let mut seen = self.lock();
            let before = seen.len();
            seen.retain(|key| match key.rfind(':') {
                Some(index) if index + 1 < key.len() => &key[index + 1..] >= cutoff,
                _ => true,
            });
            if seen.len() == before {
                return Ok(());
            }
            seen.iter().cloned().collect::<Vec<_>>()
        };
        write_json(&self.path, &snapshot, false)
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub fn dedup_key(workflow_id: &str, record_id: &str, fire_date: &str) -> String {
    format!("{workflow_id}:{record_id}:{fire_date}")
}

pub fn record_dedup_key(workflow_id: &str, record_id: &str) -> String {
    format!("rec:{workflow_id}:{record_id}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn def(id: &str, name: &str) -> WorkflowDefinition {
        WorkflowDefinition {
            id: id.into(),
            name: name.into(),
            trigger: TriggerConfig {
                node_id: "t".into(),
                ..Default::default()
            },
            action: ActionConfig {
                node_id: "a".into(),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn stores_patches_and_migrates() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = dir.path().join("workflow.json");
        std::fs::write(
            &path,
            json!({"w1": {"name": "Old", "trigger": {"nodeId": "t"}, "action": {"nodeId": "a"}}})
                .to_string(),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let store = Store::new(path.clone());
        assert!(store.load().is_ok());
        assert_eq!(store.get("w1").map(|d| d.name), Some("Old".to_owned()));
        let backups = std::fs::read_dir(dir.path())
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(backups, 2, "a backup was written");
        let migrated: Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap_or_default()).unwrap_or_default();
        assert_eq!(migrated["w1"]["schemaVer"], json!(2));
        assert_eq!(migrate_file(&path, 1).ok(), Some(0));

        assert!(store.put(def("w2", "Alpha")).is_ok());
        assert_eq!(
            store
                .list()
                .iter()
                .map(|d| d.id.as_str())
                .collect::<Vec<_>>(),
            vec!["w2", "w1"]
        );
        let patch = WorkflowPatch {
            enabled: Some(true),
            ..Default::default()
        };
        assert!(
            matches!(store.update("w2", patch), Err(UpdateError::Invalid(m)) if m == "workflow: trigger.type required")
        );
        let patch = WorkflowPatch {
            trigger: Some(TriggerPatch {
                document_id: Some("doc".into()),
                required_fields: Some(vec!["f".into()]),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(store.update("w2", patch).is_ok());
        assert!(matches!(
            store.update("nope", WorkflowPatch::default()),
            Err(UpdateError::NotFound)
        ));
        assert_eq!(store.delete_by_document_id("doc").ok(), Some(1));
        assert_eq!(store.delete("w1").ok(), Some(true));
        assert_eq!(store.delete("w1").ok(), Some(false));
    }

    #[test]
    fn keeps_bounded_sanitized_history() {
        let history = RunHistory::new(PathBuf::new());
        for i in 0..205 {
            let run = RunRecord {
                id: i.to_string(),
                workflow_id: "w".into(),
                body: "x".repeat(5000),
                trigger_fields: json!({"apiKey": "s", "name": "n"}).as_object().cloned(),
                status: "ok".into(),
                finished_at: i,
                ..Default::default()
            };
            assert!(history.append(run).is_ok());
        }
        let runs = history.list("w", 0);
        assert_eq!((runs.len(), runs[0].id.as_str()), (50, "204"));
        assert_eq!(runs[0].body.len(), 4096);
        assert!(runs[0].body.ends_with(" … [truncated 904 bytes]"));
        assert_eq!(
            runs[0]
                .trigger_fields
                .as_ref()
                .and_then(|f| f.get("apiKey")),
            Some(&json!("[redacted]"))
        );
        assert_eq!(history.list("w", 999).len(), 200);
        assert_eq!(history.gc(100, 0).ok(), Some((95, 0)));
    }

    #[test]
    fn dedups_and_collects() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = dir.path().join("d.json");
        let dedup = Dedup::new(path.clone());
        assert!(dedup.mark(&dedup_key("w", "1", "2026-01-01")).is_ok());
        assert!(dedup.mark(&dedup_key("w", "2", "2026-01-03")).is_ok());
        assert!(dedup.gc_before("2026-01-02").is_ok());
        let reloaded = Dedup::new(path.clone());
        assert!(reloaded.load().is_ok());
        assert_eq!(reloaded.len(), 1);
        std::fs::write(&path, "[oops").unwrap_or_else(|e| panic!("{e}"));
        assert!(reloaded.load().is_ok());
        assert!(reloaded.is_empty());
    }
}
