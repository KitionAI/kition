//! Creating, updating, and syncing form workflows.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use kition_core::cloud::CloudSessionProvider;
use kition_core::{Millis, now_millis};
use kition_store::Db;
use regex::Regex;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::cloud::{CloudClient, CloudSubmission};
use crate::store;
use crate::types::{
    STATUS_ACTIVE, STATUS_ERROR, STATUS_SYNCING, SaveWorkflowInput, SyncResult, Target,
    UpdateWorkflowInput, Workflow, WorkflowView,
};

#[derive(Debug, Clone)]
pub struct TableField {
    pub id: String,
    /// Display name (title).
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct TableRecord {
    pub id: String,
    pub fields: Map<String, Value>,
}

/// Table access, implemented over data documents.
pub trait TableWriter: Send + Sync {
    fn fields(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
    ) -> Result<Vec<TableField>, String>;
    fn records(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
    ) -> Result<Vec<TableRecord>, String>;
    /// Creates a record from values keyed by field ID; returns the record ID.
    fn create(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
        values: &Map<String, Value>,
    ) -> Result<String, String>;
}

#[derive(Clone)]
pub struct Service {
    pub db: Db,
    pub cloud: CloudClient,
    pub session: CloudSessionProvider,
    pub writer: Arc<dyn TableWriter>,
    locks: Arc<Mutex<HashSet<String>>>,
}

/// Releases a per-workflow lock when dropped.
struct LockGuard {
    locks: Arc<Mutex<HashSet<String>>>,
    id: String,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        self.locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id);
    }
}

fn template_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*$").unwrap_or_else(|err| panic!("{err}"))
    })
}

fn normalize_title(value: &str) -> String {
    value.trim().to_lowercase()
}

pub fn binding_id(user_id: i64, template_id: &str, document_id: &str, table_id: &str) -> String {
    let digest =
        Sha256::digest(format!("{user_id}:{template_id}:{document_id}:{table_id}").as_bytes());
    format!("desktop_{}", hex::encode(&digest[..16]))
}

fn validate(mut input: SaveWorkflowInput) -> Result<SaveWorkflowInput, String> {
    input.name = input.name.trim().to_owned();
    input.template_id = input.template_id.trim().to_owned();
    input.target = input.target.normalized();
    input.schedule = input.schedule.normalized();
    if input.name.is_empty()
        || !template_pattern().is_match(&input.template_id)
        || input.fields.is_empty()
        || input.target.document_id.is_empty()
        || input.target.table_id.is_empty()
        || input.target.mappings().is_empty()
    {
        return Err("invalid form sync workflow".into());
    }
    let mut keys = HashSet::new();
    for field in &input.fields {
        let key = field.key.trim().to_owned();
        if key.is_empty() || !keys.insert(key) {
            return Err("invalid form sync field definitions".into());
        }
    }
    for mapping in input.target.mappings() {
        if !keys.contains(&mapping.source_key) || mapping.target_field_title.trim().is_empty() {
            return Err("invalid form sync field mapping".into());
        }
    }
    Ok(input)
}

impl Service {
    pub fn new(db: Db, session: CloudSessionProvider, writer: Arc<dyn TableWriter>) -> Self {
        Self {
            db,
            cloud: CloudClient::default(),
            session,
            writer,
            locks: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    fn try_lock(&self, id: &str) -> Option<LockGuard> {
        let mut locks = self
            .locks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks.insert(id.to_owned()).then(|| LockGuard {
            locks: self.locks.clone(),
            id: id.to_owned(),
        })
    }

    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Service) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let service = self.clone();
        tokio::task::spawn_blocking(move || work(&service))
            .await
            .map_err(|e| e.to_string())?
    }

    fn with_conn<T>(
        &self,
        work: impl FnOnce(&rusqlite::Connection) -> kition_core::AppResult<T>,
    ) -> Result<T, String> {
        let conn = self.db.conn().map_err(|e| e.to_string())?;
        work(&conn).map_err(|e| e.to_string())
    }

    pub async fn list(&self, user_id: i64) -> Result<Vec<WorkflowView>, String> {
        self.blocking(move |s| s.with_conn(|c| store::list(c, user_id)))
            .await
            .map(|rows| rows.iter().map(Workflow::view).collect())
    }

    /// Checks that every field the target refers to exists; returns fields by
    /// normalized title.
    fn resolve_target_fields(
        &self,
        user_id: i64,
        target: &Target,
    ) -> Result<HashMap<String, crate::service::TableField>, String> {
        let fields = self
            .writer
            .fields(user_id, &target.document_id, &target.table_id)?;
        let by_title: HashMap<String, TableField> = fields
            .into_iter()
            .map(|f| (normalize_title(&f.name), f))
            .collect();
        let mut required: Vec<&str> = target
            .mappings()
            .iter()
            .map(|m| m.target_field_title.as_str())
            .collect();
        required.extend(
            target
                .defaults
                .iter()
                .map(|d| d.target_field_title.as_str()),
        );
        required.push(&target.submission_id_field_title);
        required.push(&target.submitted_at_field_title);
        for title in required {
            if !title.trim().is_empty() && !by_title.contains_key(&normalize_title(title)) {
                return Err(format!("form sync target field not found: {title}"));
            }
        }
        Ok(by_title)
    }

    pub async fn create(
        &self,
        user_id: i64,
        input: SaveWorkflowInput,
    ) -> Result<WorkflowView, String> {
        let normalized = validate(input)?;
        let lookup = normalized.clone();
        let existing = self
            .blocking(move |s| {
                let found = s.with_conn(|c| {
                    store::get_by_target(
                        c,
                        user_id,
                        &lookup.template_id,
                        &lookup.target.document_id,
                        &lookup.target.table_id,
                    )
                })?;
                if found.is_none() {
                    s.resolve_target_fields(user_id, &lookup.target)?;
                }
                Ok(found)
            })
            .await?;
        if let Some(existing) = existing {
            return Ok(existing.view());
        }
        let binding = binding_id(
            user_id,
            &normalized.template_id,
            &normalized.target.document_id,
            &normalized.target.table_id,
        );
        let (mut remote_source_id, mut public_url) = (String::new(), String::new());
        if normalized.is_published() {
            let session = (self.session)()?;
            let source = self
                .cloud
                .ensure_source(&session, &binding, &normalized)
                .await?;
            remote_source_id = source.id;
            public_url = source.public_url;
        }
        let mut workflow = Workflow {
            id: format!("formsync_{}", uuid::Uuid::new_v4().simple()),
            user_id,
            name: normalized.name.clone(),
            template_id: normalized.template_id.clone(),
            binding_id: binding,
            remote_source_id,
            public_url,
            published: normalized.is_published(),
            document_id: normalized.target.document_id.clone(),
            table_id: normalized.target.table_id.clone(),
            fields_json: serde_json::to_string(&normalized.fields).map_err(|e| e.to_string())?,
            target_json: serde_json::to_string(&normalized.target).map_err(|e| e.to_string())?,
            schedule_enabled: normalized.schedule.enabled,
            interval_minutes: normalized.schedule.interval_minutes,
            status: STATUS_ACTIVE.into(),
            next_sync_at: normalized
                .schedule
                .enabled
                .then(|| now_millis() + normalized.schedule.interval_minutes * 60_000),
            ..Workflow::default()
        };
        self.blocking(move |s| {
            s.with_conn(|c| store::insert(c, &mut workflow))?;
            Ok(workflow.view())
        })
        .await
    }

    /// Returns `Ok(None)` when the workflow does not exist.
    pub async fn update(
        &self,
        user_id: i64,
        id: &str,
        input: UpdateWorkflowInput,
    ) -> Result<Option<WorkflowView>, String> {
        let Some(_guard) = self.try_lock(id) else {
            return Err("form sync is already running".into());
        };
        let id_owned = id.to_owned();
        let Some(mut workflow) = self
            .blocking(move |s| s.with_conn(|c| store::get(c, user_id, &id_owned)))
            .await?
        else {
            return Ok(None);
        };
        let current = workflow.target();
        let merged = SaveWorkflowInput {
            name: input.name.unwrap_or_else(|| workflow.name.clone()),
            template_id: workflow.template_id.clone(),
            fields: input.fields.unwrap_or_else(|| workflow.fields()),
            target: input.target.unwrap_or_else(|| current.clone()),
            schedule: input.schedule.unwrap_or_else(|| workflow.schedule()),
            published: Some(input.published.unwrap_or(workflow.published)),
        };
        let normalized = validate(merged)?;
        if normalized.target.document_id != current.document_id
            || normalized.target.table_id != current.table_id
        {
            return Err("form sync target table cannot be changed".into());
        }
        let target = normalized.target.clone();
        self.blocking(move |s| s.resolve_target_fields(user_id, &target).map(|_| ()))
            .await?;
        let published = normalized.is_published();
        let should_update_cloud =
            published || (workflow.published && !workflow.remote_source_id.is_empty());
        if should_update_cloud {
            let session = (self.session)()?;
            if workflow.remote_source_id.is_empty() {
                let source = self
                    .cloud
                    .ensure_source(&session, &workflow.binding_id, &normalized)
                    .await?;
                workflow.remote_source_id = source.id;
                workflow.public_url = source.public_url;
            } else {
                let source = self
                    .cloud
                    .update_source(
                        &session,
                        &workflow.remote_source_id,
                        &normalized.name,
                        &normalized.fields,
                        published,
                    )
                    .await?;
                workflow.public_url = source.public_url;
            }
        }
        workflow.name = normalized.name.clone();
        workflow.fields_json =
            serde_json::to_string(&normalized.fields).map_err(|e| e.to_string())?;
        workflow.target_json =
            serde_json::to_string(&normalized.target).map_err(|e| e.to_string())?;
        workflow.schedule_enabled = normalized.schedule.enabled;
        workflow.interval_minutes = normalized.schedule.interval_minutes;
        workflow.published = published;
        workflow.next_sync_at = workflow
            .schedule_enabled
            .then(|| now_millis() + workflow.interval_minutes * 60_000);
        self.blocking(move |s| {
            s.with_conn(|c| store::save(c, &mut workflow))?;
            Ok(Some(workflow.view()))
        })
        .await
    }

    /// Returns `Ok(None)` when the workflow does not exist; `Err` carries the
    /// partial result.
    pub async fn sync(
        &self,
        user_id: i64,
        id: &str,
    ) -> Result<Option<SyncResult>, (String, SyncResult)> {
        let Some(_guard) = self.try_lock(id) else {
            return Err(("form sync is already running".into(), SyncResult::default()));
        };
        let id_owned = id.to_owned();
        let workflow = self
            .blocking(move |s| s.with_conn(|c| store::get(c, user_id, &id_owned)))
            .await
            .map_err(|e| (e, SyncResult::default()))?;
        let Some(mut workflow) = workflow else {
            return Ok(None);
        };
        self.sync_workflow(&mut workflow).await.map(Some)
    }

    /// Syncs every published, scheduled workflow whose time has come.
    pub async fn sync_due(&self) -> Result<(), String> {
        let due = self
            .blocking(|s| s.with_conn(|c| store::list_due(c, now_millis())))
            .await?;
        for mut workflow in due {
            let Some(_guard) = self.try_lock(&workflow.id) else {
                continue;
            };
            let _ = self.sync_workflow(&mut workflow).await;
        }
        Ok(())
    }

    async fn save(&self, workflow: &Workflow) -> Result<Workflow, String> {
        let mut copy = workflow.clone();
        self.blocking(move |s| {
            s.with_conn(|c| store::save(c, &mut copy))?;
            Ok(copy)
        })
        .await
    }

    async fn sync_workflow(
        &self,
        workflow: &mut Workflow,
    ) -> Result<SyncResult, (String, SyncResult)> {
        let mut result = SyncResult {
            workflow_id: workflow.id.clone(),
            started_at: now_millis(),
            ..SyncResult::default()
        };
        workflow.status = STATUS_SYNCING.into();
        workflow.last_error.clear();
        if let Ok(saved) = self.save(workflow).await {
            *workflow = saved;
        }
        match self.sync_steps(workflow, &mut result).await {
            Ok(()) => Ok(result),
            Err(message) => Err(self.fail(workflow, result, message).await),
        }
    }

    async fn sync_steps(
        &self,
        workflow: &mut Workflow,
        result: &mut SyncResult,
    ) -> Result<(), String> {
        if workflow.remote_source_id.is_empty() {
            return Err("form must be published before it can sync".into());
        }
        let session = (self.session)()?;
        let page = self
            .cloud
            .list_submissions(
                &session,
                &workflow.remote_source_id,
                workflow.cursor_id,
                100,
            )
            .await?;
        let user_id = workflow.user_id;
        let target = workflow.target();
        let fields = {
            let target = target.clone();
            self.blocking(move |s| s.resolve_target_fields(user_id, &target))
                .await?
        };
        for submission in page.items {
            let processed = {
                let (workflow_copy, fields, submission) =
                    (workflow.clone(), fields.clone(), submission.clone());
                self.blocking(move |s| s.process_submission(&workflow_copy, &fields, &submission))
                    .await
            };
            match processed {
                Ok(true) => result.imported += 1,
                Ok(false) => result.skipped += 1,
                Err(err) => {
                    result.failed += 1;
                    return Err(err);
                }
            }
            workflow.cursor_id = submission.cursor_id;
            workflow.synced_submissions += 1;
            *workflow = self.save(workflow).await?;
        }
        let finished = now_millis();
        workflow.status = STATUS_ACTIVE.into();
        workflow.last_sync_at = Some(finished);
        workflow.last_error.clear();
        if workflow.schedule_enabled {
            workflow.next_sync_at = Some(finished + workflow.interval_minutes * 60_000);
        }
        *workflow = self.save(workflow).await?;
        result.finished_at = finished;
        Ok(())
    }

    async fn fail(
        &self,
        workflow: &mut Workflow,
        mut result: SyncResult,
        message: String,
    ) -> (String, SyncResult) {
        let finished: Millis = now_millis();
        workflow.status = STATUS_ERROR.into();
        workflow.last_error = message.clone();
        if workflow.schedule_enabled {
            workflow.next_sync_at = Some(finished + workflow.interval_minutes * 60_000);
        }
        let _ = self.save(workflow).await;
        result.finished_at = finished;
        (message, result)
    }

    /// Imports one submission unless it was already imported (or an
    /// existing record already carries its ID). Returns whether a record was
    /// created.
    fn process_submission(
        &self,
        workflow: &Workflow,
        fields: &HashMap<String, TableField>,
        submission: &CloudSubmission,
    ) -> Result<bool, String> {
        if self.with_conn(|c| store::has_item(c, &workflow.id, &submission.id))? {
            return Ok(false);
        }
        let target = workflow.target();
        if !target.submission_id_field_title.is_empty() {
            let records =
                self.writer
                    .records(workflow.user_id, &target.document_id, &target.table_id)?;
            for record in records {
                if record
                    .fields
                    .values()
                    .any(|value| sprint(value) == submission.id)
                {
                    self.with_conn(|c| {
                        store::save_item(c, &workflow.id, &submission.id, &record.id, now_millis())
                    })?;
                    return Ok(false);
                }
            }
        }
        let field_id = |title: &str| {
            fields
                .get(&normalize_title(title))
                .map(|f| f.id.clone())
                .unwrap_or_default()
        };
        let mut values = Map::new();
        for mapping in target.mappings() {
            if let Some(value) = submission.values.get(&mapping.source_key) {
                values.insert(field_id(&mapping.target_field_title), value.clone());
            }
        }
        for item in &target.defaults {
            values.insert(field_id(&item.target_field_title), item.value.clone());
        }
        if !target.submission_id_field_title.is_empty() {
            values.insert(
                field_id(&target.submission_id_field_title),
                Value::String(submission.id.clone()),
            );
        }
        if !target.submitted_at_field_title.is_empty() {
            values.insert(
                field_id(&target.submitted_at_field_title),
                Value::String(submitted_at_text(&submission.submitted_at)),
            );
        }
        let record_id = self.writer.create(
            workflow.user_id,
            &target.document_id,
            &target.table_id,
            &values,
        )?;
        self.with_conn(|c| {
            store::save_item(c, &workflow.id, &submission.id, &record_id, now_millis())
        })?;
        Ok(true)
    }
}

/// `%v`-style text used to match submission IDs in existing records.
fn sprint(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "<nil>".into(),
        other => other.to_string(),
    }
}

/// RFC 3339 (seconds precision) for the submitted-at cell, from either
/// RFC 3339 text or Unix milliseconds.
fn submitted_at_text(value: &Value) -> String {
    let parsed = match value {
        Value::String(text) => chrono::DateTime::parse_from_rfc3339(text.trim()).ok(),
        Value::Number(n) => n
            .as_i64()
            .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms).map(|t| t.fixed_offset())),
        _ => None,
    };
    parsed.map_or_else(
        || "0001-01-01T00:00:00Z".to_owned(),
        |t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Field, FieldMapping};

    fn input() -> SaveWorkflowInput {
        SaveWorkflowInput {
            name: " Leads ".into(),
            template_id: "lead-form".into(),
            fields: vec![Field {
                key: "email".into(),
                ..Field::default()
            }],
            target: Target {
                document_id: " 1 ".into(),
                table_id: "2".into(),
                field_mappings: Some(vec![FieldMapping {
                    source_key: "email".into(),
                    target_field_title: "Email".into(),
                }]),
                ..Target::default()
            },
            ..SaveWorkflowInput::default()
        }
    }

    #[test]
    fn validates_input() {
        let ok = validate(input()).unwrap_or_default();
        assert_eq!(ok.name, "Leads");
        assert_eq!(ok.target.document_id, "1");
        assert_eq!(ok.schedule.interval_minutes, 5);
        let mut bad = input();
        bad.template_id = "Lead_Form".into();
        assert_eq!(
            validate(bad).err().as_deref(),
            Some("invalid form sync workflow")
        );
        let mut dup = input();
        dup.fields.push(Field {
            key: "email".into(),
            ..Field::default()
        });
        assert_eq!(
            validate(dup).err().as_deref(),
            Some("invalid form sync field definitions")
        );
        let mut mapping = input();
        mapping.target.field_mappings = Some(vec![FieldMapping {
            source_key: "x".into(),
            target_field_title: "E".into(),
        }]);
        assert_eq!(
            validate(mapping).err().as_deref(),
            Some("invalid form sync field mapping")
        );
    }

    #[test]
    fn binding_ids_are_stable() {
        assert_eq!(binding_id(1, "t", "d", "x"), binding_id(1, "t", "d", "x"));
        assert!(binding_id(1, "t", "d", "x").starts_with("desktop_"));
        assert_eq!(binding_id(1, "t", "d", "x").len(), "desktop_".len() + 32);
    }

    #[test]
    fn formats_submitted_at() {
        assert_eq!(
            submitted_at_text(&Value::String("2026-10-09T03:57:06.5Z".into())),
            "2026-10-09T03:57:06Z"
        );
        assert_eq!(
            submitted_at_text(&Value::from(1_791_518_226_000_i64)),
            "2026-10-09T03:57:06Z"
        );
    }
}
