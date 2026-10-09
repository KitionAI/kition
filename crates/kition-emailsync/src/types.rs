//! Email sync data shapes.

use kition_core::Millis;
use kition_core::coerce::nullable;
use serde::{Deserialize, Serialize};

pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_PAUSED: &str = "paused";
pub const STATUS_SYNCING: &str = "syncing";
pub const STATUS_ERROR: &str = "error";

pub const MODE_INCREMENTAL: &str = "incremental";
pub const MODE_FULL: &str = "full";
pub const MODE_SCHEDULED: &str = "scheduled";

pub const RUN_QUEUED: &str = "queued";
pub const RUN_SCANNING: &str = "scanning";
pub const RUN_RUNNING: &str = "running";
pub const RUN_COMPLETED: &str = "completed";
pub const RUN_FAILED: &str = "failed";
pub const RUN_CANCELING: &str = "canceling";
pub const RUN_CANCELED: &str = "canceled";
pub const RUN_INTERRUPTED: &str = "interrupted";

/// Runs that still hold or are waiting for the workflow lock.
pub const ACTIVE_RUN_STATUSES: [&str; 4] = [RUN_QUEUED, RUN_SCANNING, RUN_RUNNING, RUN_CANCELING];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionConfig {
    #[serde(default, deserialize_with = "nullable")]
    pub host: String,
    #[serde(default, deserialize_with = "nullable")]
    pub port: i64,
    #[serde(default, deserialize_with = "nullable")]
    pub tls_mode: String,
    #[serde(default, deserialize_with = "nullable")]
    pub username: String,
    #[serde(default, deserialize_with = "nullable")]
    pub mailbox: String,
}

impl ConnectionConfig {
    pub fn normalized(mut self) -> Self {
        self.host = self.host.trim().to_owned();
        self.tls_mode = self.tls_mode.trim().to_lowercase();
        self.username = self.username.trim().to_owned();
        self.mailbox = self.mailbox.trim().to_owned();
        if self.tls_mode.is_empty() {
            self.tls_mode = "tls".into();
        }
        if self.mailbox.is_empty() {
            self.mailbox = "INBOX".into();
        }
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetConfig {
    #[serde(default, deserialize_with = "nullable")]
    pub table_path: String,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "is_zero"
    )]
    pub table_id: i64,
    #[serde(default, deserialize_with = "nullable")]
    pub content_folder: String,
    #[serde(default, deserialize_with = "nullable")]
    pub attachment_folder: String,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

impl TargetConfig {
    pub fn normalized(mut self) -> Self {
        self.table_path = self.table_path.trim().to_owned();
        self.content_folder = self.content_folder.trim().to_owned();
        self.attachment_folder = self.attachment_folder.trim().to_owned();
        self
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleConfig {
    #[serde(default, deserialize_with = "nullable")]
    pub enabled: bool,
    #[serde(default, deserialize_with = "nullable")]
    pub interval_minutes: i64,
}

impl ScheduleConfig {
    pub fn normalized(mut self) -> Self {
        if self.interval_minutes == 0 {
            self.interval_minutes = 15;
        }
        self
    }
}

/// A `workflows` row (email sync).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Workflow {
    pub id: String,
    pub user_id: i64,
    pub name: String,
    pub connection_json: String,
    pub secret_json: String,
    pub target_json: String,
    pub schedule_enabled: bool,
    pub interval_minutes: i64,
    pub include_attachments: bool,
    pub status: String,
    pub last_sync_at: Option<Millis>,
    pub next_sync_at: Option<Millis>,
    pub last_error: String,
    pub synced_messages: i64,
    pub cursor_uid_validity: u32,
    pub cursor_uid: u32,
    pub created_at: Millis,
    pub updated_at: Millis,
}

impl Workflow {
    pub fn connection(&self) -> ConnectionConfig {
        serde_json::from_str(&self.connection_json).unwrap_or_default()
    }

    pub fn target(&self) -> TargetConfig {
        serde_json::from_str(&self.target_json).unwrap_or_default()
    }

    pub fn schedule(&self) -> ScheduleConfig {
        ScheduleConfig {
            enabled: self.schedule_enabled,
            interval_minutes: self.interval_minutes,
        }
    }

    pub fn view(&self) -> WorkflowView {
        WorkflowView {
            id: self.id.clone(),
            name: self.name.clone(),
            connection: self.connection(),
            target: self.target(),
            schedule: self.schedule(),
            include_attachments: self.include_attachments,
            status: self.status.clone(),
            last_sync_at: self.last_sync_at,
            last_error: self.last_error.clone(),
            synced_messages: self.synced_messages,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowView {
    pub id: String,
    pub name: String,
    pub connection: ConnectionConfig,
    pub target: TargetConfig,
    pub schedule: ScheduleConfig,
    pub include_attachments: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<Millis>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub last_error: String,
    pub synced_messages: i64,
    pub created_at: Millis,
    pub updated_at: Millis,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SaveWorkflowInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub connection: Option<ConnectionConfig>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub target: Option<TargetConfig>,
    #[serde(default)]
    pub schedule: Option<ScheduleConfig>,
    #[serde(default)]
    pub include_attachments: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub mailbox: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub message: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error_code: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncResult {
    pub workflow_id: String,
    pub imported: i64,
    pub updated: i64,
    pub skipped: i64,
    pub failed: i64,
    pub table_path: String,
    pub started_at: Millis,
    pub finished_at: Millis,
}

/// A `sync_runs` row.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncRun {
    pub id: String,
    pub workflow_id: String,
    #[serde(skip)]
    pub user_id: i64,
    pub mode: String,
    pub status: String,
    pub discovered_messages: i64,
    pub processed_messages: i64,
    pub imported: i64,
    pub updated: i64,
    pub skipped: i64,
    pub failed: i64,
    pub current_batch: i64,
    pub table_path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(skip)]
    pub cancel_requested: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Millis>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<Millis>,
    pub created_at: Millis,
    pub updated_at: Millis,
}

/// A `sync_items` row.
#[derive(Debug, Clone, Default)]
pub struct SyncItem {
    pub workflow_id: String,
    pub mailbox: String,
    pub uid_validity: u32,
    pub uid: u32,
    pub document_path: String,
    pub status: String,
    pub last_error: String,
    pub completed_at: Option<Millis>,
}
