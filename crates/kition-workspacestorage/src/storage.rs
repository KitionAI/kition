//! Workspace inventory, portability verification, and migration of legacy
//! `/uploads/...` references into content-addressed workspace assets.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use kition_core::{AppError, AppResult, now_millis};
use kition_kitable::KitableFile;
use kition_workspace::assets::Asset;
use kition_workspace::fsutil::write_atomic;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::state::StateMirror;

pub const SCHEMA_VERSION: i64 = 1;
pub const CAPABILITY: &str = "workspace_portable_storage_v1";

static LEGACY_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/uploads/[A-Za-z0-9._~!$&'()*+,;=:@%/\-]+")
        .unwrap_or_else(|_| unreachable!("valid pattern"))
});

#[derive(Debug, Clone, Default, Serialize)]
pub struct Summary {
    pub documents: i64,
    pub kitables: i64,
    pub assets: i64,
    pub workflows: i64,
    pub agent_sessions: i64,
    pub sync_states: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    pub code: &'static str,
    pub severity: &'static str,
    pub message: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reference: String,
}

impl Issue {
    fn new(
        code: &'static str,
        severity: &'static str,
        message: &'static str,
        workspace_path: &str,
        reference: &str,
    ) -> Self {
        Self {
            code,
            severity,
            message,
            workspace_path: workspace_path.to_owned(),
            reference: reference.to_owned(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub schema_version: i64,
    pub storage_version: i64,
    pub workspace_id: String,
    pub capability: &'static str,
    pub migration_state: &'static str,
    pub portable: bool,
    pub summary: Summary,
    pub issues: Vec<Issue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InventoryItem {
    pub kind: &'static str,
    pub workspace_path: String,
    pub size_bytes: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Inventory {
    pub status: Status,
    pub items: Vec<InventoryItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationResult {
    pub dry_run: bool,
    pub migrated_assets: usize,
    pub updated_references: usize,
    pub migrated_state_records: usize,
    pub status: Status,
}

pub fn classify_path(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.starts_with(".kition/assets/sha256/") {
        "asset"
    } else if lower.starts_with(".kition/agents/") && lower.ends_with("/session.json") {
        "agent_session"
    } else if lower.starts_with(".kition/agents/") && lower.ends_with("/session-events.jsonl") {
        "agent_session_events"
    } else if lower.starts_with(".kition/sync/") {
        "sync_state"
    } else if lower == "workflow.json"
        || (lower.contains("/workflows/") && lower.ends_with("definition.json"))
    {
        "workflow"
    } else if lower == "workflow_runs.json" || lower.contains("/runs/") {
        "workflow_run"
    } else if lower.ends_with(".kitable") {
        "kitable"
    } else if lower.ends_with(".md") || lower.ends_with(".markdown") {
        "document"
    } else if lower == ".kition/workspace.json" || lower == ".kition/metadata.json" {
        "workspace_metadata"
    } else {
        ""
    }
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Every file below `root` in lexical order, skipping `skip` directories.
fn walk(root: &Path, skip: &dyn Fn(&str) -> bool) -> AppResult<Vec<(std::path::PathBuf, String)>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
        for entry in entries {
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if entry.file_type()?.is_dir() {
                if !skip(&relative) {
                    stack.push(path);
                }
            } else {
                out.push((path, relative));
            }
        }
    }
    Ok(out)
}

fn unique_legacy_urls(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    LEGACY_URL
        .find_iter(text)
        .map(|m| m.as_str().to_owned())
        .filter(|url| seen.insert(url.clone()))
        .collect()
}

fn str_field<'a>(map: &'a serde_json::Map<String, Value>, key: &str) -> &'a str {
    map.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn collect_references(
    value: &Value,
    source: &str,
    issues: &mut Vec<Issue>,
    references: &mut Vec<String>,
) {
    match value {
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_references(item, source, issues, references)),
        Value::Object(map) => {
            let url = str_field(map, "url").trim();
            let workspace_path = str_field(map, "workspacePath").trim().replace('\\', "/");
            if url.starts_with("/uploads/") {
                issues.push(Issue::new(
                    "legacy_upload_url",
                    "warning",
                    "Table cell references an asset outside the workspace",
                    source,
                    url,
                ));
            } else if ["data:", "blob:", "file:", "http://", "https://"]
                .iter()
                .any(|p| url.starts_with(p))
            {
                issues.push(Issue::new(
                    "absolute_path",
                    "error",
                    "Table cell contains a non-portable asset reference",
                    source,
                    url,
                ));
            }
            if !workspace_path.is_empty() {
                references.push(workspace_path);
            }
            map.values()
                .for_each(|nested| collect_references(nested, source, issues, references));
        }
        _ => {}
    }
}

fn inspect_kitable(path: &Path, workspace_path: &str) -> AppResult<(Vec<Issue>, Vec<String>)> {
    let Ok(file) = KitableFile::open(path) else {
        return Ok((
            vec![Issue::new(
                "migration_incomplete",
                "error",
                "Data document could not be inspected",
                workspace_path,
                "",
            )],
            Vec::new(),
        ));
    };
    let mut issues = Vec::new();
    let mut references = Vec::new();
    let conn = file.conn();
    let mut statement =
        conn.prepare("SELECT values_json FROM kition_records WHERE deleted_at IS NULL")?;
    for raw in statement.query_map([], |r| r.get::<_, String>(0))? {
        if let Ok(value) = serde_json::from_str::<Value>(&raw?) {
            collect_references(&value, workspace_path, &mut issues, &mut references);
        }
    }
    let mut statement =
        conn.prepare("SELECT path FROM kition_attachments WHERE deleted_at IS NULL")?;
    for path_value in statement.query_map([], |r| r.get::<_, String>(0))? {
        let path_value = path_value?;
        if path_value.starts_with("/uploads/") {
            issues.push(Issue::new(
                "legacy_upload_url",
                "warning",
                "Table attachment metadata references device-local storage",
                workspace_path,
                &path_value,
            ));
        } else if path_value.starts_with(".kition/assets/") {
            references.push(path_value.replace('\\', "/"));
        } else if Path::new(&path_value).is_absolute() {
            issues.push(Issue::new(
                "absolute_path",
                "error",
                "Table attachment metadata contains an absolute path",
                workspace_path,
                &path_value,
            ));
        }
    }
    Ok((issues, references))
}

impl StateMirror {
    pub fn build_inventory(&self, include_items: bool, running: bool) -> AppResult<Inventory> {
        let manifest = self.assets.ensure_manifest()?;
        let root = self.assets.workspace_dir();
        let mut items = Vec::new();
        let mut summary = Summary::default();
        let mut issues = Vec::new();
        let mut asset_references = HashSet::new();
        let mut asset_paths = BTreeMap::new();
        let skip = |relative: &str| {
            relative == ".git" || relative.starts_with(".git/") || relative == ".kition/assets/.tmp"
        };
        for (path, relative) in walk(root, &skip)? {
            let kind = classify_path(&relative);
            if kind.is_empty() {
                continue;
            }
            let data = std::fs::read(&path)?;
            let digest = sha256_hex(&data);
            let size = i64::try_from(data.len()).unwrap_or(i64::MAX);
            summary.total_bytes += size;
            match kind {
                "document" => {
                    summary.documents += 1;
                    for url in unique_legacy_urls(&String::from_utf8_lossy(&data)) {
                        issues.push(Issue::new(
                            "legacy_upload_url",
                            "warning",
                            "Document references an asset outside the workspace",
                            &relative,
                            &url,
                        ));
                    }
                }
                "kitable" => {
                    summary.kitables += 1;
                    let (found, references) = inspect_kitable(&path, &relative)?;
                    issues.extend(found);
                    asset_references.extend(references);
                }
                "asset" => {
                    summary.assets += 1;
                    asset_paths.insert(relative.clone(), ());
                    let name = Path::new(&relative)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let expected = name.split('.').next().unwrap_or_default();
                    if expected.len() != 64 || expected != digest {
                        issues.push(Issue::new(
                            "hash_mismatch",
                            "error",
                            "Workspace asset content does not match its content-addressed path",
                            &relative,
                            "",
                        ));
                    }
                }
                "workflow" | "workflow_run" => summary.workflows += 1,
                "agent_session" => summary.agent_sessions += 1,
                "sync_state" => summary.sync_states += 1,
                _ => {}
            }
            if include_items {
                items.push(InventoryItem {
                    kind,
                    workspace_path: relative,
                    size_bytes: size,
                    sha256: digest,
                });
            }
        }
        for reference in &asset_references {
            if !asset_paths.contains_key(reference) {
                issues.push(Issue::new(
                    "missing_asset",
                    "error",
                    "Attachment references a missing workspace asset",
                    reference,
                    "",
                ));
            }
        }
        for asset in asset_paths.keys() {
            if !asset_references.contains(asset) {
                issues.push(Issue::new(
                    "orphan_asset",
                    "info",
                    "Workspace asset is not referenced by a table attachment",
                    asset,
                    "",
                ));
            }
        }
        if self.external_session_count() > 0 && summary.agent_sessions == 0 {
            issues.push(Issue::new(
                "external_workspace_state",
                "warning",
                "Agent sessions still exist only in device-local storage",
                "",
                "",
            ));
        }
        issues.sort_by(|a, b| {
            a.code
                .cmp(b.code)
                .then_with(|| a.workspace_path.cmp(&b.workspace_path))
        });
        let portable = !issues
            .iter()
            .any(|i| i.severity == "warning" || i.severity == "error");
        let migration_state = match (running, portable) {
            (true, _) => "running",
            (false, true) => "ready",
            (false, false) => "required",
        };
        items.sort_by(|a, b| a.workspace_path.cmp(&b.workspace_path));
        Ok(Inventory {
            status: Status {
                schema_version: SCHEMA_VERSION,
                storage_version: manifest.storage_version,
                workspace_id: manifest.workspace_id,
                capability: CAPABILITY,
                migration_state,
                portable,
                summary,
                issues,
            },
            items,
        })
    }

    pub fn run_migration(&self, dry_run: bool, include_state: bool) -> AppResult<MigrationResult> {
        let root = self.assets.workspace_dir().to_path_buf();
        let mut migration = Migration {
            mirror: self,
            dry_run,
            assets: HashMap::new(),
            updated_references: 0,
        };
        let skip = |relative: &str| relative == ".git" || relative == ".kition/assets";
        for (path, _) in walk(&root, &skip)? {
            let extension = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            match extension.as_str() {
                "kitable" => migration.migrate_kitable(&path)?,
                "md" | "markdown" => migration.migrate_markdown(&path)?,
                _ => {}
            }
        }
        let mut migrated_state_records = 0;
        if include_state && !dry_run {
            self.export()?;
            migrated_state_records = self.count_state_files();
        }
        let inventory = self.build_inventory(false, false)?;
        Ok(MigrationResult {
            dry_run,
            migrated_assets: migration.assets.len(),
            updated_references: migration.updated_references,
            migrated_state_records,
            status: inventory.status,
        })
    }
}

struct Migration<'a> {
    mirror: &'a StateMirror,
    dry_run: bool,
    assets: HashMap<String, Asset>,
    updated_references: usize,
}

fn mime_for(name: &str) -> String {
    mime_guess::from_path(name)
        .first()
        .map(|m| m.essence_str().to_owned())
        .unwrap_or_default()
}

impl Migration<'_> {
    fn migrate_url(&mut self, raw_url: &str, name: &str, mime_type: &str) -> AppResult<Asset> {
        if let Some(existing) = self.assets.get(raw_url) {
            return Ok(existing.clone());
        }
        let absolute = self.mirror.assets.resolve_url(raw_url)?;
        let data = std::fs::read(&absolute)?;
        let name = if name.trim().is_empty() {
            absolute
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            name.to_owned()
        };
        let mut mime_type = if mime_type.trim().is_empty() {
            mime_for(&name)
        } else {
            mime_type.to_owned()
        };
        if mime_type.is_empty() {
            mime_type = "application/octet-stream".into();
        }
        let asset = if self.dry_run {
            let digest = sha256_hex(&data);
            Asset {
                url: String::new(),
                name,
                mime_type,
                size_bytes: i64::try_from(data.len()).unwrap_or(i64::MAX),
                asset_id: digest.clone(),
                sha256: digest,
                workspace_path: String::new(),
            }
        } else {
            self.mirror.assets.save_bytes(&data, &name, &mime_type)?
        };
        self.assets.insert(raw_url.to_owned(), asset.clone());
        Ok(asset)
    }

    fn migrate_value(&mut self, value: &mut Value) -> AppResult<bool> {
        let mut changed = false;
        match value {
            Value::Array(items) => {
                for item in items {
                    changed |= self.migrate_value(item)?;
                }
            }
            Value::Object(map) => {
                let url = str_field(map, "url").trim().to_owned();
                if url.starts_with("/uploads/") {
                    let asset =
                        self.migrate_url(&url, str_field(map, "name"), str_field(map, "mimeType"))?;
                    self.updated_references += 1;
                    if !self.dry_run {
                        map.insert("url".into(), asset.url.into());
                        map.insert("name".into(), asset.name.into());
                        map.insert("mimeType".into(), asset.mime_type.into());
                        map.insert("sizeBytes".into(), asset.size_bytes.into());
                        map.insert("assetId".into(), asset.asset_id.into());
                        map.insert("sha256".into(), asset.sha256.into());
                        map.insert("workspacePath".into(), asset.workspace_path.into());
                    }
                    changed = true;
                }
                for nested in map.values_mut() {
                    changed |= self.migrate_value(nested)?;
                }
            }
            _ => {}
        }
        Ok(changed)
    }

    fn migrate_kitable(&mut self, path: &Path) -> AppResult<()> {
        let file = KitableFile::open(path).map_err(AppError::unhandled)?;
        let mut record_updates = Vec::new();
        {
            let conn = file.conn();
            let mut statement = conn
                .prepare("SELECT id, values_json FROM kition_records WHERE deleted_at IS NULL")?;
            let rows = statement
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            for (id, raw) in rows {
                let Ok(mut value) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                if self.migrate_value(&mut value)? && !self.dry_run {
                    record_updates.push((id, value.to_string()));
                }
            }
        }
        let mut attachment_updates = Vec::new();
        {
            let conn = file.conn();
            let mut statement = conn.prepare(
                "SELECT id, path, name, mime_type FROM kition_attachments WHERE deleted_at IS NULL",
            )?;
            let rows = statement
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (id, url, name, mime_type) in rows {
                if !url.starts_with("/uploads/") {
                    continue;
                }
                let asset = self.migrate_url(&url, &name, &mime_type)?;
                self.updated_references += 1;
                if !self.dry_run {
                    attachment_updates.push((
                        id,
                        asset.workspace_path.clone(),
                        serde_json::to_string(&asset)?,
                    ));
                }
            }
        }
        if self.dry_run || record_updates.is_empty() && attachment_updates.is_empty() {
            return Ok(());
        }
        let tx = file.conn().unchecked_transaction()?;
        let now = now_millis();
        for (id, raw) in record_updates {
            tx.execute(
                "UPDATE kition_records SET values_json = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![raw, now, id],
            )?;
        }
        for (id, path, meta) in attachment_updates {
            tx.execute(
                "UPDATE kition_attachments SET path = ?1, meta_json = ?2 WHERE id = ?3",
                rusqlite::params![path, meta, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn migrate_markdown(&mut self, path: &Path) -> AppResult<()> {
        let original = std::fs::read_to_string(path)?;
        let mut updated = String::with_capacity(original.len());
        let mut last = 0;
        for found in LEGACY_URL.find_iter(&original) {
            let url = found.as_str();
            let name = Path::new(url)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let asset = self.migrate_url(url, &name, &mime_for(url))?;
            self.updated_references += 1;
            updated.push_str(&original[last..found.start()]);
            updated.push_str(if self.dry_run { url } else { &asset.url });
            last = found.end();
        }
        updated.push_str(&original[last..]);
        if self.dry_run || updated == original {
            return Ok(());
        }
        write_atomic(path, updated.as_bytes())
    }
}
