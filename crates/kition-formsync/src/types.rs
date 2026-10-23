//! Form sync data shapes.

use kition_core::Millis;
use kition_core::coerce::nullable;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_SYNCING: &str = "syncing";
pub const STATUS_ERROR: &str = "error";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Field {
    #[serde(default, deserialize_with = "nullable")]
    pub key: String,
    #[serde(default, deserialize_with = "nullable")]
    pub label: String,
    #[serde(default, rename = "type", deserialize_with = "nullable")]
    pub field_type: String,
    #[serde(default, deserialize_with = "nullable")]
    pub required: bool,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FieldMapping {
    #[serde(default, deserialize_with = "nullable")]
    pub source_key: String,
    #[serde(default, deserialize_with = "nullable")]
    pub target_field_title: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DefaultValue {
    #[serde(default, deserialize_with = "nullable")]
    pub target_field_title: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Target {
    #[serde(default, deserialize_with = "nullable")]
    pub document_path: String,
    #[serde(default, deserialize_with = "nullable")]
    pub table_id: String,
    #[serde(default)]
    pub field_mappings: Option<Vec<FieldMapping>>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub defaults: Vec<DefaultValue>,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "String::is_empty"
    )]
    pub submission_id_field_title: String,
    #[serde(
        default,
        deserialize_with = "nullable",
        skip_serializing_if = "String::is_empty"
    )]
    pub submitted_at_field_title: String,
}

impl Target {
    pub fn mappings(&self) -> &[FieldMapping] {
        self.field_mappings.as_deref().unwrap_or_default()
    }

    pub fn normalized(mut self) -> Self {
        self.document_path = self.document_path.trim().to_owned();
        self.table_id = self.table_id.trim().to_owned();
        self.submission_id_field_title = self.submission_id_field_title.trim().to_owned();
        self.submitted_at_field_title = self.submitted_at_field_title.trim().to_owned();
        self
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Schedule {
    #[serde(default, deserialize_with = "nullable")]
    pub enabled: bool,
    #[serde(default, deserialize_with = "nullable")]
    pub interval_minutes: i64,
}

impl Schedule {
    pub fn normalized(mut self) -> Self {
        if self.interval_minutes <= 0 {
            self.interval_minutes = 5;
        }
        self
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SaveWorkflowInput {
    #[serde(default, deserialize_with = "nullable")]
    pub name: String,
    #[serde(default, deserialize_with = "nullable")]
    pub template_id: String,
    #[serde(default, deserialize_with = "nullable")]
    pub fields: Vec<Field>,
    #[serde(default, deserialize_with = "nullable")]
    pub target: Target,
    #[serde(default, deserialize_with = "nullable")]
    pub schedule: Schedule,
    #[serde(default)]
    pub published: Option<bool>,
}

impl SaveWorkflowInput {
    /// Forms are published unless explicitly marked otherwise.
    pub fn is_published(&self) -> bool {
        self.published.unwrap_or(true)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateWorkflowInput {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub fields: Option<Vec<Field>>,
    #[serde(default)]
    pub target: Option<Target>,
    #[serde(default)]
    pub schedule: Option<Schedule>,
    #[serde(default)]
    pub published: Option<bool>,
}

/// A `form_sync_workflows` row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Workflow {
    pub id: String,
    pub user_id: i64,
    pub name: String,
    pub template_id: String,
    pub binding_id: String,
    pub remote_source_id: String,
    pub public_url: String,
    pub published: bool,
    pub document_path: String,
    pub table_id: String,
    pub fields_json: String,
    pub target_json: String,
    pub schedule_enabled: bool,
    pub interval_minutes: i64,
    pub status: String,
    pub cursor_id: i64,
    pub last_sync_at: Option<Millis>,
    pub next_sync_at: Option<Millis>,
    pub last_error: String,
    pub synced_submissions: i64,
    pub created_at: Millis,
    pub updated_at: Millis,
}

impl Workflow {
    pub fn fields(&self) -> Vec<Field> {
        serde_json::from_str(&self.fields_json).unwrap_or_default()
    }

    pub fn target(&self) -> Target {
        serde_json::from_str(&self.target_json).unwrap_or_default()
    }

    pub fn schedule(&self) -> Schedule {
        Schedule {
            enabled: self.schedule_enabled,
            interval_minutes: self.interval_minutes,
        }
    }

    pub fn view(&self) -> WorkflowView {
        WorkflowView {
            id: self.id.clone(),
            name: self.name.clone(),
            template_id: self.template_id.clone(),
            remote_source_id: self.remote_source_id.clone(),
            public_url: self.public_url.clone(),
            published: self.published,
            fields: self.fields(),
            target: self.target(),
            schedule: self.schedule(),
            status: self.status.clone(),
            last_sync_at: self.last_sync_at,
            last_error: self.last_error.clone(),
            synced_submissions: self.synced_submissions,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowView {
    pub id: String,
    pub name: String,
    pub template_id: String,
    pub remote_source_id: String,
    pub public_url: String,
    pub published: bool,
    pub fields: Vec<Field>,
    pub target: Target,
    pub schedule: Schedule,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<Millis>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub last_error: String,
    pub synced_submissions: i64,
    pub created_at: Millis,
    pub updated_at: Millis,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncResult {
    pub workflow_id: String,
    pub imported: i64,
    pub skipped: i64,
    pub failed: i64,
    pub started_at: Millis,
    pub finished_at: Millis,
}
