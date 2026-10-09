//! Workflow management, syncing, and background runs.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use kition_core::now_millis;

use crate::imap::{Cursor, MailboxFetcher, SyncError, validate_connection};
use crate::message::parse_message;
use crate::store::{Store, status_for_schedule};
use crate::types::{
    ConnectionConfig, MODE_FULL, MODE_INCREMENTAL, MODE_SCHEDULED, RUN_CANCELED, RUN_CANCELING,
    RUN_COMPLETED, RUN_FAILED, RUN_INTERRUPTED, RUN_QUEUED, RUN_RUNNING, RUN_SCANNING,
    SaveWorkflowInput, ScheduleConfig, SyncItem, SyncResult, SyncRun, TargetConfig, TestResult,
    Workflow, WorkflowView,
};
use crate::workspace::{WorkspaceWriter, normalize_relative_folder, normalize_relative_path};

pub const ALREADY_RUNNING: &str = "email sync is already running";
const RUN_CANCELED_MESSAGE: &str = "email sync run canceled";

/// A failed service call, mapped to HTTP by the routes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceError {
    /// 409: a run is already active.
    RunActive,
    /// 502 with an error code.
    Sync(SyncError),
    /// 400.
    Invalid(String),
    /// 500.
    Internal(String),
}

impl ServiceError {
    pub fn message(&self) -> String {
        match self {
            ServiceError::RunActive => ALREADY_RUNNING.into(),
            ServiceError::Sync(err) => err.message.clone(),
            ServiceError::Invalid(message) | ServiceError::Internal(message) => message.clone(),
        }
    }
}

fn internal(err: impl std::fmt::Display) -> ServiceError {
    ServiceError::Internal(err.to_string())
}

#[derive(Clone)]
pub struct Service {
    pub store: Store,
    pub fetcher: Arc<dyn MailboxFetcher>,
    pub writer: WorkspaceWriter,
    locks: Arc<Mutex<HashSet<String>>>,
    run_lock: Arc<tokio::sync::Mutex<()>>,
}

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

/// Reports batch progress; returns false to request cancellation.
type ProgressReport<'a> = &'a (dyn Fn(Progress, &SyncResult) -> bool + Sync);

#[derive(Default, Clone, Copy)]
struct Progress {
    available: i64,
    processed: i64,
}

fn validate_values(
    name: &str,
    connection: &ConnectionConfig,
    password: &str,
    target: &TargetConfig,
    schedule: ScheduleConfig,
) -> Result<(), String> {
    if name.is_empty() {
        return Err("workflow name is required".into());
    }
    validate_connection(connection, password)?;
    normalize_relative_path(&target.table_path, ".kitable")?;
    if target.table_id < 0 {
        return Err("destination table ID must be positive".into());
    }
    normalize_relative_folder(&target.content_folder)?;
    normalize_relative_folder(&target.attachment_folder)?;
    if !(5..=1440).contains(&schedule.interval_minutes) {
        return Err("schedule interval must be between 5 and 1440 minutes".into());
    }
    Ok(())
}

impl Service {
    pub fn new(store: Store, fetcher: Arc<dyn MailboxFetcher>, writer: WorkspaceWriter) -> Self {
        Self {
            store,
            fetcher,
            writer,
            locks: Arc::new(Mutex::new(HashSet::new())),
            run_lock: Arc::new(tokio::sync::Mutex::new(())),
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
        work: impl FnOnce(&Service) -> Result<T, ServiceError> + Send + 'static,
    ) -> Result<T, ServiceError> {
        let service = self.clone();
        tokio::task::spawn_blocking(move || work(&service))
            .await
            .map_err(internal)?
    }

    pub async fn list(&self, user_id: i64) -> Result<Vec<WorkflowView>, ServiceError> {
        self.blocking(move |s| {
            let workflows = s.store.list(user_id).map_err(internal)?;
            for workflow in &workflows {
                s.writer
                    .migrate_legacy_documents(workflow, &s.store)
                    .map_err(ServiceError::Internal)?;
            }
            Ok(workflows.iter().map(Workflow::view).collect())
        })
        .await
    }

    pub async fn create(
        &self,
        user_id: i64,
        input: SaveWorkflowInput,
    ) -> Result<WorkflowView, ServiceError> {
        let (
            Some(name),
            Some(connection),
            Some(password),
            Some(target),
            Some(schedule),
            Some(include_attachments),
        ) = (
            input.name,
            input.connection,
            input.password,
            input.target,
            input.schedule,
            input.include_attachments,
        )
        else {
            return Err(ServiceError::Invalid(
                "name, connection, password, target, schedule, and include_attachments are required".into(),
            ));
        };
        let name = name.trim().to_owned();
        let connection = connection.normalized();
        let target = target.normalized();
        let schedule = schedule.normalized();
        validate_values(&name, &connection, &password, &target, schedule)
            .map_err(ServiceError::Invalid)?;
        self.fetcher
            .test(&connection, &password)
            .await
            .map_err(ServiceError::Sync)?;
        self.blocking(move |s| {
            s.store
                .create(
                    user_id,
                    &name,
                    &connection,
                    &password,
                    &target,
                    schedule,
                    include_attachments,
                )
                .map(|w| w.view())
                .map_err(ServiceError::Invalid)
        })
        .await
    }

    /// `Ok(None)` when the workflow does not exist.
    pub async fn update(
        &self,
        user_id: i64,
        id: &str,
        input: SaveWorkflowInput,
    ) -> Result<Option<WorkflowView>, ServiceError> {
        let Some(_guard) = self.try_lock(id) else {
            return Err(ServiceError::Invalid(ALREADY_RUNNING.into()));
        };
        let id = id.to_owned();
        let Some(mut workflow) = self
            .blocking(move |s| s.store.get(user_id, &id).map_err(internal))
            .await?
        else {
            return Ok(None);
        };
        let mut connection = workflow.connection();
        let mut target = workflow.target();
        let mut schedule = workflow.schedule();
        let mut name = workflow.name.clone();
        let mut include_attachments = workflow.include_attachments;
        let mut should_test = false;
        if let Some(value) = input.name {
            name = value.trim().to_owned();
        }
        if let Some(value) = input.connection {
            connection = value.normalized();
            should_test = true;
        }
        if let Some(value) = input.target {
            target = value.normalized();
        }
        if let Some(value) = input.schedule {
            schedule = value.normalized();
        }
        if let Some(value) = input.include_attachments {
            include_attachments = value;
        }
        let mut password = self
            .store
            .password(&workflow)
            .map_err(ServiceError::Invalid)?;
        let new_password = input.password.filter(|p| !p.trim().is_empty());
        if let Some(value) = &new_password {
            password = value.clone();
            should_test = true;
        }
        validate_values(&name, &connection, &password, &target, schedule)
            .map_err(ServiceError::Invalid)?;
        if should_test {
            self.fetcher
                .test(&connection, &password)
                .await
                .map_err(ServiceError::Sync)?;
        }
        workflow.name = name;
        workflow.connection_json = serde_json::to_string(&connection).map_err(internal)?;
        if let Some(value) = new_password {
            let mut bag = kition_connections::SecretBag::new();
            bag.insert("password".into(), value);
            workflow.secret_json = self
                .store
                .secrets
                .seal(&bag)
                .map_err(ServiceError::Invalid)?;
        }
        workflow.target_json = serde_json::to_string(&target).map_err(internal)?;
        workflow.schedule_enabled = schedule.enabled;
        workflow.interval_minutes = schedule.interval_minutes;
        workflow.next_sync_at = schedule
            .enabled
            .then(|| now_millis() + schedule.interval_minutes * 60_000);
        workflow.status = status_for_schedule(schedule.enabled).into();
        workflow.include_attachments = include_attachments;
        self.blocking(move |s| {
            s.store
                .save(&mut workflow)
                .map_err(|e| ServiceError::Invalid(e.message.clone()))?;
            Ok(Some(workflow.view()))
        })
        .await
    }

    pub async fn delete(&self, user_id: i64, id: &str) -> Result<bool, ServiceError> {
        let Some(_guard) = self.try_lock(id) else {
            return Err(ServiceError::Internal(ALREADY_RUNNING.into()));
        };
        let id = id.to_owned();
        self.blocking(move |s| s.store.delete(user_id, &id).map_err(internal))
            .await
    }

    pub async fn test(&self, user_id: i64, id: &str) -> Result<Option<TestResult>, ServiceError> {
        let id = id.to_owned();
        let Some(workflow) = self
            .blocking(move |s| s.store.get(user_id, &id).map_err(internal))
            .await?
        else {
            return Ok(None);
        };
        let password = self
            .store
            .password(&workflow)
            .map_err(ServiceError::Internal)?;
        let connection = workflow.connection();
        Ok(Some(
            match self.fetcher.test(&connection, &password).await {
                Ok(()) => TestResult {
                    ok: true,
                    mailbox: connection.mailbox,
                    message: "Connection verified".into(),
                    error_code: String::new(),
                },
                Err(err) => TestResult {
                    ok: false,
                    mailbox: connection.mailbox,
                    message: err.message.clone(),
                    error_code: err.code_or_default().into(),
                },
            },
        ))
    }

    /// `Ok(None)` when the workflow does not exist; `Err` carries the partial
    /// result.
    pub async fn sync(
        &self,
        user_id: i64,
        id: &str,
        all: bool,
    ) -> Result<Option<SyncResult>, (String, SyncResult)> {
        let Some(_guard) = self.try_lock(id) else {
            return Err((ALREADY_RUNNING.into(), SyncResult::default()));
        };
        let id = id.to_owned();
        let workflow = self
            .blocking(move |s| s.store.get(user_id, &id).map_err(internal))
            .await
            .map_err(|e| (e.message(), SyncResult::default()))?;
        let Some(mut workflow) = workflow else {
            return Ok(None);
        };
        if !all {
            return self.sync_workflow(&mut workflow, None).await.map(Some);
        }
        workflow.cursor_uid_validity = 0;
        workflow.cursor_uid = 0;
        let mut total = SyncResult {
            workflow_id: workflow.id.clone(),
            table_path: workflow.target().table_path,
            started_at: now_millis(),
            ..SyncResult::default()
        };
        loop {
            let outcome = self.sync_workflow(&mut workflow, None).await;
            let batch = match &outcome {
                Ok(batch) | Err((_, batch)) => batch.clone(),
            };
            total.imported += batch.imported;
            total.updated += batch.updated;
            total.skipped += batch.skipped;
            total.failed += batch.failed;
            total.finished_at = batch.finished_at;
            if let Err((message, _)) = outcome {
                return Err((message, total));
            }
            if batch.imported + batch.updated + batch.skipped == 0 {
                return Ok(Some(total));
            }
        }
    }

    /// One batch. `report` returns false to request cancellation.
    async fn sync_workflow(
        &self,
        workflow: &mut Workflow,
        report: Option<ProgressReport<'_>>,
    ) -> Result<SyncResult, (String, SyncResult)> {
        let mut result = SyncResult {
            workflow_id: workflow.id.clone(),
            table_path: workflow.target().table_path,
            started_at: now_millis(),
            ..SyncResult::default()
        };
        if let Err(err) = self.store.mark_syncing(workflow) {
            result.finished_at = now_millis();
            return Err((err.message.clone(), result));
        }
        let finish_with = |workflow: &mut Workflow,
                           result: &mut SyncResult,
                           validity: u32,
                           cursor: u32,
                           error: Option<&str>| {
            result.finished_at = now_millis();
            let _ = self
                .store
                .mark_sync_result(workflow, result, validity, cursor, error);
        };
        let password = match self.store.password(workflow) {
            Ok(password) => password,
            Err(message) => {
                let (validity, cursor) = (workflow.cursor_uid_validity, workflow.cursor_uid);
                finish_with(workflow, &mut result, validity, cursor, Some(&message));
                return Err((message, result));
            }
        };
        let cursor = Cursor {
            uid_validity: workflow.cursor_uid_validity,
            uid: workflow.cursor_uid,
        };
        let batch = match self
            .fetcher
            .fetch(&workflow.connection(), &password, cursor)
            .await
        {
            Ok(batch) => batch,
            Err(err) => {
                let (validity, cursor) = (workflow.cursor_uid_validity, workflow.cursor_uid);
                finish_with(workflow, &mut result, validity, cursor, Some(&err.message));
                return Err((err.message, result));
            }
        };
        let available = i64::try_from(batch.total.max(batch.messages.len())).unwrap_or(i64::MAX);
        let mut progress = Progress {
            available,
            processed: 0,
        };
        if let Some(report) = report
            && !report(progress, &result)
        {
            let cursor = workflow.cursor_uid;
            finish_with(workflow, &mut result, batch.uid_validity, cursor, None);
            return Err((RUN_CANCELED_MESSAGE.into(), result));
        }
        let mut cursor_uid = workflow.cursor_uid;
        if workflow.cursor_uid_validity == 0 || workflow.cursor_uid_validity != batch.uid_validity {
            cursor_uid = 0;
        }
        let mailbox = workflow.connection().mailbox;
        let mut error: Option<String> = None;
        for fetched in &batch.messages {
            let item_key = SyncItem {
                workflow_id: workflow.id.clone(),
                mailbox: mailbox.clone(),
                uid_validity: batch.uid_validity,
                uid: fetched.uid,
                ..SyncItem::default()
            };
            match self
                .store
                .get_item(&workflow.id, &mailbox, batch.uid_validity, fetched.uid)
            {
                Err(err) => {
                    error = Some(err.message.clone());
                    result.failed += 1;
                    break;
                }
                Ok(Some(item)) if item.status == "complete" => {
                    result.skipped += 1;
                    cursor_uid = fetched.uid;
                    progress.processed += 1;
                    if let Some(report) = report
                        && !report(progress, &result)
                    {
                        error = Some(RUN_CANCELED_MESSAGE.into());
                        break;
                    }
                    continue;
                }
                Ok(_) => {}
            }
            let parsed = match parse_message(&fetched.raw, fetched.internal_date) {
                Ok(parsed) => parsed,
                Err(parse_error) => {
                    let message = format!("parse message UID {}: {parse_error}", fetched.uid);
                    result.failed += 1;
                    let failed = SyncItem {
                        status: "failed".into(),
                        last_error: message.clone(),
                        ..item_key.clone()
                    };
                    if let Err(err) = self.store.upsert_item(&failed) {
                        error = Some(format!("{message}\n{}", err.message));
                        break;
                    }
                    cursor_uid = fetched.uid;
                    progress.processed += 1;
                    if let Some(report) = report
                        && !report(progress, &result)
                    {
                        error = Some(RUN_CANCELED_MESSAGE.into());
                        break;
                    }
                    continue;
                }
            };
            let written = {
                let (writer, workflow_copy, validity, uid) = (
                    self.writer.clone(),
                    workflow.clone(),
                    batch.uid_validity,
                    fetched.uid,
                );
                tokio::task::spawn_blocking(move || {
                    writer.write_message(&workflow_copy, validity, uid, &parsed)
                })
                .await
                .unwrap_or_else(|e| Err(e.to_string()))
            };
            let written = match written {
                Ok(written) => written,
                Err(write_error) => {
                    let message = format!("import message UID {}: {write_error}", fetched.uid);
                    result.failed += 1;
                    let _ = self.store.upsert_item(&SyncItem {
                        status: "failed".into(),
                        last_error: message.clone(),
                        ..item_key.clone()
                    });
                    error = Some(message);
                    break;
                }
            };
            let complete = SyncItem {
                document_path: written.document_path.clone(),
                status: "complete".into(),
                completed_at: Some(now_millis()),
                ..item_key.clone()
            };
            if let Err(err) = self.store.upsert_item(&complete) {
                error = Some(err.message.clone());
                result.failed += 1;
                break;
            }
            if written.updated {
                result.updated += 1;
            } else {
                result.imported += 1;
            }
            cursor_uid = fetched.uid;
            progress.processed += 1;
            if let Some(report) = report
                && !report(progress, &result)
            {
                error = Some(RUN_CANCELED_MESSAGE.into());
                break;
            }
        }
        let stored_error = error.as_deref().filter(|e| *e != RUN_CANCELED_MESSAGE);
        finish_with(
            workflow,
            &mut result,
            batch.uid_validity,
            cursor_uid,
            stored_error,
        );
        match error {
            Some(message) => Err((message, result)),
            None => Ok(result),
        }
    }

    pub async fn create_run(
        &self,
        user_id: i64,
        id: &str,
        mode: &str,
        start: bool,
    ) -> Result<Option<SyncRun>, ServiceError> {
        let mode = match mode.trim().to_lowercase().as_str() {
            "" => MODE_INCREMENTAL.to_owned(),
            other => other.to_owned(),
        };
        if ![MODE_INCREMENTAL, MODE_FULL, MODE_SCHEDULED].contains(&mode.as_str()) {
            return Err(ServiceError::Invalid(
                "email sync run mode must be incremental, full, or scheduled".into(),
            ));
        }
        let _run_guard = self.run_lock.lock().await;
        let id = id.to_owned();
        let run = self
            .blocking(move |s| {
                let Some(workflow) = s.store.get(user_id, &id).map_err(internal)? else {
                    return Ok(None);
                };
                if s.store
                    .active_run_for_workflow(user_id, &id)
                    .map_err(|e| ServiceError::Invalid(e.message.clone()))?
                    .is_some()
                {
                    return Err(ServiceError::RunActive);
                }
                s.store
                    .create_run(user_id, &workflow, &mode)
                    .map(Some)
                    .map_err(|e| ServiceError::Invalid(e.message.clone()))
            })
            .await?;
        if start && let Some(run) = &run {
            let service = self.clone();
            let run_id = run.id.clone();
            tokio::spawn(async move { service.execute_run(&run_id).await });
        }
        Ok(run)
    }

    pub async fn retry_run(&self, user_id: i64, id: &str) -> Result<Option<SyncRun>, ServiceError> {
        let id = id.to_owned();
        let Some(run) = self
            .blocking(move |s| s.store.get_run(user_id, &id).map_err(internal))
            .await?
        else {
            return Ok(None);
        };
        if ![RUN_FAILED, RUN_CANCELED, RUN_INTERRUPTED].contains(&run.status.as_str()) {
            return Err(ServiceError::Invalid(
                "only failed, canceled, or interrupted email sync runs can be retried".into(),
            ));
        }
        self.create_run(user_id, &run.workflow_id, &run.mode, true)
            .await
    }

    /// Resumes runs left active by a previous process.
    pub async fn recover_runs(&self) -> Result<(), String> {
        let runs = self
            .store
            .list_recoverable_runs()
            .map_err(|e| e.message.clone())?;
        for mut run in runs {
            if run.status == RUN_CANCELING || run.cancel_requested {
                run.status = RUN_CANCELED.into();
                run.finished_at = Some(now_millis());
                self.store
                    .save_run(&mut run)
                    .map_err(|e| e.message.clone())?;
                continue;
            }
            run.status = RUN_QUEUED.into();
            self.store
                .save_run(&mut run)
                .map_err(|e| e.message.clone())?;
            let service = self.clone();
            tokio::spawn(async move { service.execute_run(&run.id).await });
        }
        Ok(())
    }

    fn finish_run(&self, run: &mut SyncRun, status: &str, error: Option<&str>) {
        run.status = status.into();
        run.finished_at = Some(now_millis());
        run.error = error.unwrap_or_default().to_owned();
        let _ = self.store.save_run(run);
    }

    pub async fn execute_run(&self, run_id: &str) {
        let Ok(Some(mut run)) = self.store.get_run_by_id(run_id) else {
            return;
        };
        let workflow = match self.store.get(run.user_id, &run.workflow_id) {
            Ok(Some(workflow)) => workflow,
            _ => {
                self.finish_run(&mut run, RUN_FAILED, Some("email sync workflow not found"));
                return;
            }
        };
        let Some(_guard) = self.try_lock(&workflow.id) else {
            self.finish_run(&mut run, RUN_FAILED, Some(ALREADY_RUNNING));
            return;
        };
        let mut workflow = workflow;
        run.status = RUN_SCANNING.into();
        run.started_at = Some(now_millis());
        run.error.clear();
        if self.store.save_run(&mut run).is_err() {
            return;
        }
        if run.mode == MODE_FULL {
            workflow.cursor_uid_validity = 0;
            workflow.cursor_uid = 0;
        }
        loop {
            match self.store.cancellation_requested(&run.id) {
                Err(err) => return self.finish_run(&mut run, RUN_FAILED, Some(&err.message)),
                Ok(true) => return self.finish_run(&mut run, RUN_CANCELED, None),
                Ok(false) => {}
            }
            let batch_number = run.current_batch + 1;
            let base = run.clone();
            let shared = Mutex::new(run.clone());
            let report = |progress: Progress, partial: &SyncResult| -> bool {
                let mut current = shared
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if progress.available > 0 || progress.processed > 0 {
                    current.current_batch = batch_number;
                }
                let Ok(requested) = self.store.cancellation_requested(&current.id) else {
                    return false;
                };
                current.cancel_requested = requested;
                current.status = if requested {
                    RUN_CANCELING
                } else {
                    RUN_RUNNING
                }
                .into();
                let discovered = base.processed_messages + progress.available;
                if discovered > current.discovered_messages {
                    current.discovered_messages = discovered;
                }
                current.processed_messages = base.processed_messages + progress.processed;
                current.imported = base.imported + partial.imported;
                current.updated = base.updated + partial.updated;
                current.skipped = base.skipped + partial.skipped;
                current.failed = base.failed + partial.failed;
                if self.store.save_run(&mut current).is_err() {
                    return false;
                }
                !requested
            };
            let outcome = self.sync_workflow(&mut workflow, Some(&report)).await;
            run = shared
                .into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let batch = match &outcome {
                Ok(batch) | Err((_, batch)) => batch.clone(),
            };
            if let Err((message, _)) = &outcome
                && message == RUN_CANCELED_MESSAGE
            {
                return self.finish_run(&mut run, RUN_CANCELED, None);
            }
            run.processed_messages = base.processed_messages
                + batch.imported
                + batch.updated
                + batch.skipped
                + batch.failed;
            run.imported = base.imported + batch.imported;
            run.updated = base.updated + batch.updated;
            run.skipped = base.skipped + batch.skipped;
            run.failed = base.failed + batch.failed;
            if let Err((message, _)) = outcome {
                return self.finish_run(&mut run, RUN_FAILED, Some(&message));
            }
            if run.mode != MODE_FULL || batch.imported + batch.updated + batch.skipped == 0 {
                return self.finish_run(&mut run, RUN_COMPLETED, None);
            }
        }
    }

    /// Starts a scheduled run for every due workflow without an active run.
    pub async fn sync_due(&self) -> Result<(), String> {
        let due = self
            .store
            .list_due(now_millis())
            .map_err(|e| e.message.clone())?;
        let mut errors = Vec::new();
        for workflow in due {
            let run = {
                let _guard = self.run_lock.lock().await;
                match self
                    .store
                    .active_run_for_workflow(workflow.user_id, &workflow.id)
                {
                    Err(err) => Err(err.message.clone()),
                    Ok(Some(_)) => Ok(None),
                    Ok(None) => self
                        .store
                        .create_run(workflow.user_id, &workflow, MODE_SCHEDULED)
                        .map(Some)
                        .map_err(|e| e.message.clone()),
                }
            };
            match run {
                Ok(Some(run)) => self.execute_run(&run.id).await,
                Ok(None) => {}
                Err(err) => errors.push(err),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("\n"))
        }
    }
}
