//! Workspace inventory, portability verification, and the export of workspace
//! state into the workspace.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use kition_core::AppResult;
use regex::Regex;
use serde::Serialize;
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
    /// Table files (`.ktable`); the Table kit owns their contents.
    pub tables: i64,
    pub assets: i64,
    pub workflows: i64,
    pub agent_sessions: i64,
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
    } else if lower == "workflow.json"
        || (lower.contains("/workflows/") && lower.ends_with("definition.json"))
    {
        "workflow"
    } else if lower == "workflow_runs.json" || lower.contains("/runs/") {
        "workflow_run"
    } else if lower.ends_with(".ktable") {
        "table"
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

impl StateMirror {
    pub fn build_inventory(&self, include_items: bool, running: bool) -> AppResult<Inventory> {
        let manifest = self.assets.ensure_manifest()?;
        let root = self.assets.workspace_dir();
        let mut items = Vec::new();
        let mut summary = Summary::default();
        let mut issues = Vec::new();
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
                "table" => summary.tables += 1,
                "asset" => {
                    summary.assets += 1;
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
        let mut migrated_state_records = 0;
        if include_state && !dry_run {
            self.export()?;
            migrated_state_records = self.count_state_files();
        }
        let inventory = self.build_inventory(false, false)?;
        Ok(MigrationResult {
            dry_run,
            migrated_state_records,
            status: inventory.status,
        })
    }
}
