//! `workflows`, `sync_items`, and `sync_runs` (email sync tables).

use kition_connections::SecretStore;
use kition_core::{AppResult, Millis, now_millis};
use kition_store::Db;
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::types::{
    ACTIVE_RUN_STATUSES, ConnectionConfig, RUN_CANCELED, RUN_CANCELING, RUN_COMPLETED, RUN_FAILED,
    RUN_QUEUED, STATUS_ACTIVE, STATUS_ERROR, STATUS_PAUSED, STATUS_SYNCING, ScheduleConfig,
    SyncItem, SyncResult, SyncRun, TargetConfig, Workflow,
};

const WORKFLOW_COLUMNS: &str = "id, user_id, name, connection_json, secret_json, target_json, schedule_enabled, \
    interval_minutes, include_attachments, status, last_sync_at, next_sync_at, last_error, synced_messages, \
    cursor_uid_validity, cursor_uid, created_at, updated_at";

const RUN_COLUMNS: &str = "id, workflow_id, user_id, mode, status, discovered_messages, processed_messages, imported, \
    updated, skipped, failed, current_batch, table_path, error, cancel_requested, started_at, finished_at, created_at, updated_at";

fn workflow_from_row(row: &Row<'_>) -> rusqlite::Result<Workflow> {
    let text = |i: usize| -> rusqlite::Result<String> {
        Ok(row.get::<_, Option<String>>(i)?.unwrap_or_default())
    };
    let int = |i: usize| -> rusqlite::Result<i64> {
        Ok(row.get::<_, Option<i64>>(i)?.unwrap_or_default())
    };
    Ok(Workflow {
        id: row.get(0)?,
        user_id: int(1)?,
        name: text(2)?,
        connection_json: text(3)?,
        secret_json: text(4)?,
        target_json: text(5)?,
        schedule_enabled: int(6)? != 0,
        interval_minutes: int(7)?,
        include_attachments: int(8)? != 0,
        status: text(9)?,
        last_sync_at: row.get(10)?,
        next_sync_at: row.get(11)?,
        last_error: text(12)?,
        synced_messages: int(13)?,
        cursor_uid_validity: u32::try_from(int(14)?).unwrap_or(0),
        cursor_uid: u32::try_from(int(15)?).unwrap_or(0),
        created_at: int(16)?,
        updated_at: int(17)?,
    })
}

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<SyncRun> {
    let text = |i: usize| -> rusqlite::Result<String> {
        Ok(row.get::<_, Option<String>>(i)?.unwrap_or_default())
    };
    let int = |i: usize| -> rusqlite::Result<i64> {
        Ok(row.get::<_, Option<i64>>(i)?.unwrap_or_default())
    };
    Ok(SyncRun {
        id: row.get(0)?,
        workflow_id: text(1)?,
        user_id: int(2)?,
        mode: text(3)?,
        status: text(4)?,
        discovered_messages: int(5)?,
        processed_messages: int(6)?,
        imported: int(7)?,
        updated: int(8)?,
        skipped: int(9)?,
        failed: int(10)?,
        current_batch: int(11)?,
        table_path: text(12)?,
        error: text(13)?,
        cancel_requested: int(14)? != 0,
        started_at: row.get(15)?,
        finished_at: row.get(16)?,
        created_at: int(17)?,
        updated_at: int(18)?,
    })
}

pub fn status_for_schedule(enabled: bool) -> &'static str {
    if enabled {
        STATUS_ACTIVE
    } else {
        STATUS_PAUSED
    }
}

/// Every workflow, oldest ID first.
pub fn all_workflows(conn: &Connection) -> AppResult<Vec<Workflow>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {WORKFLOW_COLUMNS} FROM workflows ORDER BY id ASC"
    ))?;
    Ok(statement
        .query_map([], workflow_from_row)?
        .collect::<Result<Vec<_>, _>>()?)
}

/// Every run, ordered by ID.
pub fn all_runs(conn: &Connection) -> AppResult<Vec<SyncRun>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM sync_runs ORDER BY id ASC"
    ))?;
    Ok(statement
        .query_map([], run_from_row)?
        .collect::<Result<Vec<_>, _>>()?)
}

#[derive(Clone)]
pub struct Store {
    pub db: Db,
    pub secrets: SecretStore,
}

impl Store {
    fn conn(&self) -> AppResult<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>> {
        self.db.conn()
    }

    pub fn list(&self, user_id: i64) -> AppResult<Vec<Workflow>> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(&format!(
            "SELECT {WORKFLOW_COLUMNS} FROM workflows WHERE user_id = ?1 ORDER BY created_at DESC"
        ))?;
        Ok(statement
            .query_map([user_id], workflow_from_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn list_all(&self) -> AppResult<Vec<Workflow>> {
        all_workflows(&*self.conn()?)
    }

    pub fn list_due(&self, now: Millis) -> AppResult<Vec<Workflow>> {
        let conn = self.conn()?;
        let mut statement = conn.prepare(&format!(
            "SELECT {WORKFLOW_COLUMNS} FROM workflows WHERE schedule_enabled = 1 AND next_sync_at IS NOT NULL AND next_sync_at <= ?1"
        ))?;
        Ok(statement
            .query_map([now], workflow_from_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get(&self, user_id: i64, id: &str) -> AppResult<Option<Workflow>> {
        let conn = self.conn()?;
        Ok(conn
            .query_row(
                &format!("SELECT {WORKFLOW_COLUMNS} FROM workflows WHERE user_id = ?1 AND id = ?2 LIMIT 1"),
                params![user_id, id],
                workflow_from_row,
            )
            .optional()?)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        user_id: i64,
        name: &str,
        connection: &ConnectionConfig,
        password: &str,
        target: &TargetConfig,
        schedule: ScheduleConfig,
        include_attachments: bool,
    ) -> Result<Workflow, String> {
        let mut bag = kition_connections::SecretBag::new();
        bag.insert("password".into(), password.to_owned());
        let now = now_millis();
        let mut workflow = Workflow {
            id: format!("mail_{}", uuid::Uuid::new_v4().simple()),
            user_id,
            name: name.trim().to_owned(),
            connection_json: serde_json::to_string(connection).map_err(|e| e.to_string())?,
            secret_json: self.secrets.seal(&bag)?,
            target_json: serde_json::to_string(target).map_err(|e| e.to_string())?,
            schedule_enabled: schedule.enabled,
            interval_minutes: schedule.interval_minutes,
            include_attachments,
            status: status_for_schedule(schedule.enabled).into(),
            next_sync_at: schedule
                .enabled
                .then(|| now + schedule.interval_minutes * 60_000),
            created_at: now,
            updated_at: now,
            ..Workflow::default()
        };
        self.write_workflow(&mut workflow, false)
            .map_err(|e| e.to_string())?;
        Ok(workflow)
    }

    /// Writes every column; `touch` bumps `updated_at` first.
    pub fn write_workflow(&self, w: &mut Workflow, touch: bool) -> AppResult<()> {
        if touch {
            w.updated_at = now_millis();
        }
        let conn = self.conn()?;
        conn.execute(
            &format!(
                "INSERT OR REPLACE INTO workflows ({WORKFLOW_COLUMNS}) VALUES \
                 (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)"
            ),
            params![
                w.id,
                w.user_id,
                w.name,
                w.connection_json,
                w.secret_json,
                w.target_json,
                w.schedule_enabled,
                w.interval_minutes,
                w.include_attachments,
                w.status,
                w.last_sync_at,
                w.next_sync_at,
                w.last_error,
                w.synced_messages,
                w.cursor_uid_validity,
                w.cursor_uid,
                w.created_at,
                w.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn save(&self, workflow: &mut Workflow) -> AppResult<()> {
        self.write_workflow(workflow, true)
    }

    pub fn delete(&self, user_id: i64, id: &str) -> AppResult<bool> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM sync_runs WHERE workflow_id = ?1", [id])?;
        tx.execute("DELETE FROM sync_items WHERE workflow_id = ?1", [id])?;
        let removed = tx.execute(
            "DELETE FROM workflows WHERE user_id = ?1 AND id = ?2",
            params![user_id, id],
        )?;
        tx.commit()?;
        Ok(removed > 0)
    }

    pub fn password(&self, workflow: &Workflow) -> Result<String, String> {
        let bag = self.secrets.open(&workflow.secret_json)?;
        Ok(bag.get("password").cloned().unwrap_or_default())
    }

    pub fn mark_syncing(&self, workflow: &mut Workflow) -> AppResult<()> {
        workflow.status = STATUS_SYNCING.into();
        workflow.last_error.clear();
        self.save(workflow)
    }

    /// Records a sync attempt: cursor, synced count, status, next run.
    pub fn mark_sync_result(
        &self,
        workflow: &mut Workflow,
        result: &SyncResult,
        uid_validity: u32,
        cursor_uid: u32,
        error: Option<&str>,
    ) -> AppResult<()> {
        let now = if result.finished_at == 0 {
            now_millis()
        } else {
            result.finished_at
        };
        workflow.last_sync_at = Some(now);
        workflow.cursor_uid_validity = uid_validity;
        workflow.cursor_uid = cursor_uid;
        let conn = self.conn()?;
        workflow.synced_messages = conn.query_row(
            "SELECT COUNT(*) FROM sync_items WHERE workflow_id = ?1 AND status = 'complete'",
            [&workflow.id],
            |row| row.get(0),
        )?;
        drop(conn);
        match error {
            Some(message) => {
                workflow.status = STATUS_ERROR.into();
                workflow.last_error = message.to_owned();
            }
            None => {
                workflow.status = status_for_schedule(workflow.schedule_enabled).into();
                workflow.last_error.clear();
            }
        }
        workflow.next_sync_at = workflow
            .schedule_enabled
            .then(|| now + workflow.interval_minutes * 60_000);
        self.save(workflow)
    }

    pub fn get_item(
        &self,
        workflow_id: &str,
        mailbox: &str,
        uid_validity: u32,
        uid: u32,
    ) -> AppResult<Option<SyncItem>> {
        let conn = self.conn()?;
        Ok(conn
            .query_row(
                "SELECT workflow_id, mailbox, uid_validity, uid, document_path, status, last_error, completed_at \
                 FROM sync_items WHERE workflow_id = ?1 AND mailbox = ?2 AND uid_validity = ?3 AND uid = ?4 LIMIT 1",
                params![workflow_id, mailbox, uid_validity, uid],
                |row| {
                    let text = |i: usize| -> rusqlite::Result<String> { Ok(row.get::<_, Option<String>>(i)?.unwrap_or_default()) };
                    Ok(SyncItem {
                        workflow_id: text(0)?,
                        mailbox: text(1)?,
                        uid_validity: row.get::<_, Option<u32>>(2)?.unwrap_or(0),
                        uid: row.get::<_, Option<u32>>(3)?.unwrap_or(0),
                        document_path: text(4)?,
                        status: text(5)?,
                        last_error: text(6)?,
                        completed_at: row.get(7)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn upsert_item(&self, item: &SyncItem) -> AppResult<()> {
        let conn = self.conn()?;
        let now = now_millis();
        let updated = conn.execute(
            "UPDATE sync_items SET document_path = ?5, status = ?6, last_error = ?7, completed_at = ?8, updated_at = ?9 \
             WHERE workflow_id = ?1 AND mailbox = ?2 AND uid_validity = ?3 AND uid = ?4",
            params![
                item.workflow_id,
                item.mailbox,
                item.uid_validity,
                item.uid,
                item.document_path,
                item.status,
                item.last_error,
                item.completed_at,
                now
            ],
        )?;
        if updated == 0 {
            conn.execute(
                "INSERT INTO sync_items (workflow_id, mailbox, uid_validity, uid, document_path, status, last_error, \
                 completed_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    item.workflow_id,
                    item.mailbox,
                    item.uid_validity,
                    item.uid,
                    item.document_path,
                    item.status,
                    item.last_error,
                    item.completed_at,
                    now
                ],
            )?;
        }
        Ok(())
    }

    pub fn rename_item_documents(&self, workflow_id: &str, from: &str, to: &str) -> AppResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE sync_items SET document_path = ?3, updated_at = ?4 WHERE workflow_id = ?1 AND document_path = ?2",
            params![workflow_id, from, to, now_millis()],
        )?;
        Ok(())
    }

    pub fn create_run(&self, user_id: i64, workflow: &Workflow, mode: &str) -> AppResult<SyncRun> {
        let now = now_millis();
        let mut run = SyncRun {
            id: format!("mailrun_{}", uuid::Uuid::new_v4().simple()),
            workflow_id: workflow.id.clone(),
            user_id,
            mode: mode.to_owned(),
            status: RUN_QUEUED.into(),
            table_path: workflow.target().table_path,
            created_at: now,
            updated_at: now,
            ..SyncRun::default()
        };
        self.write_run(&mut run, false)?;
        Ok(run)
    }

    pub fn write_run(&self, r: &mut SyncRun, touch: bool) -> AppResult<()> {
        if touch {
            r.updated_at = now_millis();
        }
        let conn = self.conn()?;
        conn.execute(
            &format!(
                "INSERT OR REPLACE INTO sync_runs ({RUN_COLUMNS}) VALUES \
                 (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)"
            ),
            params![
                r.id,
                r.workflow_id,
                r.user_id,
                r.mode,
                r.status,
                r.discovered_messages,
                r.processed_messages,
                r.imported,
                r.updated,
                r.skipped,
                r.failed,
                r.current_batch,
                r.table_path,
                r.error,
                r.cancel_requested,
                r.started_at,
                r.finished_at,
                r.created_at,
                r.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn save_run(&self, run: &mut SyncRun) -> AppResult<()> {
        self.write_run(run, true)
    }

    fn query_runs(
        conn: &Connection,
        sql: &str,
        args: &[&dyn rusqlite::ToSql],
    ) -> AppResult<Vec<SyncRun>> {
        let mut statement = conn.prepare(sql)?;
        Ok(statement
            .query_map(args, run_from_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get_run(&self, user_id: i64, id: &str) -> AppResult<Option<SyncRun>> {
        let conn = self.conn()?;
        Ok(Self::query_runs(
            &conn,
            &format!("SELECT {RUN_COLUMNS} FROM sync_runs WHERE user_id = ?1 AND id = ?2 LIMIT 1"),
            &[&user_id, &id],
        )?
        .into_iter()
        .next())
    }

    pub fn get_run_by_id(&self, id: &str) -> AppResult<Option<SyncRun>> {
        let conn = self.conn()?;
        Ok(Self::query_runs(
            &conn,
            &format!("SELECT {RUN_COLUMNS} FROM sync_runs WHERE id = ?1 LIMIT 1"),
            &[&id],
        )?
        .into_iter()
        .next())
    }

    pub fn list_runs(
        &self,
        user_id: i64,
        workflow_id: &str,
        limit: i64,
    ) -> AppResult<Vec<SyncRun>> {
        let limit = if limit <= 0 || limit > 100 { 50 } else { limit };
        let conn = self.conn()?;
        let workflow_id = workflow_id.trim();
        if workflow_id.is_empty() {
            Self::query_runs(
                &conn,
                &format!(
                    "SELECT {RUN_COLUMNS} FROM sync_runs WHERE user_id = ?1 ORDER BY created_at DESC LIMIT {limit}"
                ),
                &[&user_id],
            )
        } else {
            Self::query_runs(
                &conn,
                &format!(
                    "SELECT {RUN_COLUMNS} FROM sync_runs WHERE user_id = ?1 AND workflow_id = ?2 ORDER BY created_at DESC LIMIT {limit}"
                ),
                &[&user_id, &workflow_id],
            )
        }
    }

    pub fn list_all_runs(&self) -> AppResult<Vec<SyncRun>> {
        all_runs(&*self.conn()?)
    }

    fn active_list() -> String {
        ACTIVE_RUN_STATUSES
            .iter()
            .map(|s| format!("'{s}'"))
            .collect::<Vec<_>>()
            .join(", ")
    }

    pub fn active_run_for_workflow(
        &self,
        user_id: i64,
        workflow_id: &str,
    ) -> AppResult<Option<SyncRun>> {
        let conn = self.conn()?;
        Ok(Self::query_runs(
            &conn,
            &format!(
                "SELECT {RUN_COLUMNS} FROM sync_runs WHERE user_id = ?1 AND workflow_id = ?2 AND status IN ({}) \
                 ORDER BY created_at DESC LIMIT 1",
                Self::active_list()
            ),
            &[&user_id, &workflow_id],
        )?
        .into_iter()
        .next())
    }

    pub fn list_recoverable_runs(&self) -> AppResult<Vec<SyncRun>> {
        let conn = self.conn()?;
        Self::query_runs(
            &conn,
            &format!(
                "SELECT {RUN_COLUMNS} FROM sync_runs WHERE status IN ({})",
                Self::active_list()
            ),
            &[],
        )
    }

    pub fn request_cancellation(&self, user_id: i64, id: &str) -> AppResult<Option<SyncRun>> {
        let Some(mut run) = self.get_run(user_id, id)? else {
            return Ok(None);
        };
        if [RUN_COMPLETED, RUN_FAILED, RUN_CANCELED].contains(&run.status.as_str()) {
            return Ok(Some(run));
        }
        run.cancel_requested = true;
        run.status = RUN_CANCELING.into();
        self.save_run(&mut run)?;
        Ok(Some(run))
    }

    pub fn cancellation_requested(&self, id: &str) -> AppResult<bool> {
        let conn = self.conn()?;
        let flag: i64 = conn.query_row(
            "SELECT COALESCE(cancel_requested, 0) FROM sync_runs WHERE id = ?1",
            [id],
            |row| row.get(0),
        )?;
        Ok(flag != 0)
    }
}

/// Follows a table file renamed or moved from `from` to `to` (a folder moves every file under
/// it): the email sync targets that write to it write to the new path. Answers how many changed.
pub fn rename_table_path(conn: &Connection, from: &str, to: &str) -> AppResult<usize> {
    let (from, to) = (
        from.trim().trim_end_matches('/'),
        to.trim().trim_end_matches('/'),
    );
    if from.is_empty() || to.is_empty() || from == to {
        return Ok(0);
    }
    let mut changed = 0;
    for workflow in all_workflows(conn)? {
        let mut target = workflow.target();
        let path = if target.table_path == from {
            to.to_owned()
        } else if let Some(rest) = target.table_path.strip_prefix(&format!("{from}/")) {
            format!("{to}/{rest}")
        } else {
            continue;
        };
        target.table_path = path;
        let json = serde_json::to_string(&target)
            .map_err(|e| kition_core::AppError::internal(e.to_string()))?;
        conn.execute(
            "UPDATE workflows SET target_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![workflow.id, json, now_millis()],
        )?;
        changed += 1;
    }
    Ok(changed)
}
