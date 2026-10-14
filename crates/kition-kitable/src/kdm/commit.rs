//! The write path of [`KitableFile`]: every mutation is one KDM transaction, stored and projected
//! in one SQL transaction.
//!
//! A write takes the file's write lock (`BEGIN IMMEDIATE`), first catches up with what other
//! handles stored since this one last read the store (imports it, then repairs), runs the
//! transaction on the replica, appends its changes ([`store::append`]), projects every object
//! changed ([`project::project_changes`]), records the projected position, and compacts the log
//! when it has grown. On any failure the SQL transaction rolls back and, when the replica already
//! holds changes the store does not, the replica is reloaded from the store: memory never runs
//! ahead of the file, and an error leaves nothing behind.
//!
//! The `since` of each append is the stored version this handle last read or wrote, never the
//! in-memory replica's own version. The store's [`store::Head`] (position and a random epoch
//! every store write replaces) tells whether anything was stored since, even by another copy of
//! the file written over this one. When the store lacks changes this handle has (an older or
//! different copy replaced the file), they are stored again in a write of their own before the
//! next mutation runs, so a failing mutation never discards them. Undo and redo are repaired
//! before projecting: they can bring back what others changed meanwhile (a name since taken).

use std::collections::BTreeSet;

use kition_core::now_millis;
use kition_kdm::{ObjectId, Origin, OriginKind, Replica, Tx, Version};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

use super::model;
use super::ops::{CreateAt, TableOp};
use super::project::{self, TableChange};
use super::read::ModelView;
use super::{repair, store};
use crate::file::{self, FileIdentity};
use crate::{KitableError, KitableFile, Result};

/// What [`KitableFile::reopen_merging`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    /// Nothing differed: the handle is on the file's current content.
    Unchanged,
    /// The file held the same document; both sides' changes are now in the file and the handle.
    Merged(TableChange),
    /// The file now holds another document; the handle switched to it wholesale.
    DifferentDocument,
}

/// How a write's catch-up with the store went.
enum CatchUp {
    /// The store held nothing this handle lacked.
    Current,
    /// Changes other handles stored were imported.
    Imported,
    /// The store lacks changes this handle has (the file was replaced by an older copy, or by
    /// another copy): [`KitableFile::resync`] appends them again and rebuilds the projection.
    Diverged,
}

impl KitableFile {
    /// The origin of this handle's transactions; the default is `system:unknown`, which is no
    /// undo step.
    pub fn set_origin(&mut self, origin: Origin) {
        self.origin = origin;
    }

    pub fn origin(&self) -> &Origin {
        &self.origin
    }

    /// What the last successful write projected, once.
    pub fn take_last_change(&mut self) -> Option<TableChange> {
        self.last_change.take()
    }

    /// Runs `f` as one transaction with this handle's origin. See the module documentation.
    pub(crate) fn commit<R>(
        &mut self,
        f: impl FnOnce(&mut Tx<'_>) -> Result<R>,
    ) -> Result<(R, TableChange)> {
        let origin = self.origin.clone();
        self.commit_as(&origin, f)
    }

    /// [`KitableFile::commit`] with another origin.
    pub(crate) fn commit_as<R>(
        &mut self,
        origin: &Origin,
        f: impl FnOnce(&mut Tx<'_>) -> Result<R>,
    ) -> Result<(R, TableChange)> {
        let label = origin.encode();
        self.write(&label, false, |replica| model::transact(replica, origin, f))
    }

    /// The history label of this handle's writes: the principal, or nothing for `system` writes
    /// (as the legacy writers left it).
    pub(crate) fn actor(&self) -> String {
        if self.origin.kind == OriginKind::System {
            String::new()
        } else {
            self.origin.principal.clone()
        }
    }

    fn write<R>(
        &mut self,
        label: &str,
        repair_after: bool,
        step: impl FnOnce(&mut Replica) -> Result<R>,
    ) -> Result<(R, TableChange)> {
        self.writable()?;
        if self.stale {
            self.reload()?;
        }
        let actor = self.actor();
        let now = now_millis();
        // A store that lacks changes of this handle (the file was replaced by an older copy) gets
        // them back in a write of their own first, so a failing step can never discard them.
        let resynced = self.resync(now)?;
        let mut since = self.since.clone();
        let mut head = self.head.clone();
        let outcome = (|| {
            let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
            if matches!(
                catch_up(&tx, &mut self.replica, &mut since, &mut head)?,
                CatchUp::Diverged
            ) {
                // Replaced again since the resync. Nothing is written, and `since` stays where
                // the handle left it, so the next write resyncs.
                return Ok(None);
            }
            let written = write_in(
                &tx,
                &mut self.replica,
                &since,
                &head,
                label,
                &actor,
                now,
                repair_after,
                step,
            )?;
            tx.commit()?;
            Ok(Some(written))
        })();
        match outcome {
            Ok(None) => Err(KitableError::invalid(
                "the kitable file was replaced during the write; try again",
            )),
            Ok(Some((value, change, written_head))) => {
                self.since = self.replica.version();
                self.head = written_head;
                self.identity = FileIdentity::of(&self.path);
                if self.base.is_none() {
                    self.base = ModelView::new(&self.replica).base();
                }
                let change = match resynced {
                    Some(earlier) => merge_changes(earlier, change),
                    None => change,
                };
                self.last_change = Some(change.clone());
                Ok((value, change))
            }
            Err(err) => {
                // The store holds `since` (the catch-up imported only stored changes); anything
                // beyond it in memory is this failed write's own.
                if !since.includes(&self.replica.version()) {
                    if self.reload().is_err() {
                        self.stale = true;
                    }
                } else {
                    self.since = since;
                    self.head = head;
                }
                Err(err)
            }
        }
    }

    /// Refuses writes on a handle opened read-only.
    pub(crate) fn writable(&self) -> Result<()> {
        match &self.read_only {
            Some(reason) => Err(KitableError::ReadOnly(reason.clone())),
            None => Ok(()),
        }
    }

    /// Brings this handle up to the store before a write. When other handles stored changes,
    /// they are imported (they are already projected). When the store lacks changes this handle
    /// has, they are appended again, repaired, and the projection rebuilt, in a committed write
    /// of their own; on failure nothing in memory is discarded, so the next write retries.
    /// Answers what a resync projected.
    fn resync(&mut self, now: i64) -> Result<Option<TableChange>> {
        if store::head(&self.conn)? == self.head {
            return Ok(None);
        }
        let mut since = self.since.clone();
        let mut head = self.head.clone();
        let outcome = (|| -> Result<Option<(TableChange, store::Head)>> {
            let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
            let caught = catch_up(&tx, &mut self.replica, &mut since, &mut head)?;
            if !matches!(caught, CatchUp::Diverged) {
                // Imported changes were projected by the handle that stored them.
                self.replica.take_changed();
                tx.commit()?;
                return Ok(None);
            }
            let changed = self.replica.take_changed();
            repair::run(&mut self.replica, &changed)?;
            self.replica.take_changed();
            let label = Origin::system("resync").encode();
            store::append(&tx, &self.replica, &since, &label, now)?;
            project::rebuild(&tx, &self.replica, now)?;
            let change = everything(&tx)?;
            let position = store::stored_position(&tx)?;
            store::set_projected_position(&tx, position)?;
            let written = store::head(&tx)?;
            tx.commit()?;
            Ok(Some((change, written)))
        })();
        match outcome? {
            None => {
                self.since = since;
                self.head = head;
                Ok(None)
            }
            Some((change, written)) => {
                self.since = self.replica.version();
                self.head = written;
                Ok(Some(change))
            }
        }
    }

    /// Replaces the replica with the stored one (under a new actor: the discarded replica's
    /// counters must never be reused). Undo history is lost.
    pub(crate) fn reload(&mut self) -> Result<()> {
        let (head, replica) = file::load_consistent(&self.conn)?;
        self.head = head;
        self.since = replica.version();
        self.base = ModelView::new(&replica).base();
        self.replica = replica;
        self.stale = false;
        Ok(())
    }

    /// Applies every op as one transaction (one change row, one undo step). Answers the row keys
    /// `records.create` ops created, in order, and what the write projected.
    pub fn transact(&mut self, ops: &[TableOp]) -> Result<(Vec<String>, TableChange)> {
        self.writable()?;
        let resolved = ops
            .iter()
            .map(|op| self.resolve_op(op))
            .collect::<Result<Vec<_>>>()?;
        let now = now_millis();
        let created_by = self.actor();
        self.commit(|tx| {
            let mut created = Vec::new();
            for op in &resolved {
                match op {
                    Resolved::Cells(table, edits) => model::set_cells_many(tx, table, edits)?,
                    Resolved::Create(table, at, rows) => {
                        for id in
                            model::create_records(tx, table, at.as_ref(), rows, now, &created_by)?
                        {
                            created.push(id.to_string());
                        }
                    }
                    Resolved::Delete(table, records) => {
                        model::delete_records(tx, table, records)?;
                    }
                    Resolved::Move(table, records, before) => {
                        model::move_records(tx, table, records, before.as_ref())?;
                    }
                    Resolved::MoveFields(table, fields, to_index) => {
                        model::move_fields(tx, table, fields, *to_index)?;
                    }
                }
            }
            Ok(created)
        })
    }

    fn resolve_op(&self, op: &TableOp) -> Result<Resolved> {
        Ok(match op {
            TableOp::CellsSet { table_id, records } => {
                let table = table_object(&self.conn, *table_id)?;
                let names = field_objects_by_name(&self.conn, *table_id)?;
                let edits = records
                    .iter()
                    .map(|edit| {
                        (
                            ObjectId::from_string(edit.row_key.clone()),
                            by_field_id(&names, &edit.values),
                        )
                    })
                    .collect();
                Resolved::Cells(table, edits)
            }
            TableOp::RecordsCreate {
                table_id,
                at,
                records,
            } => {
                let table = table_object(&self.conn, *table_id)?;
                let names = field_objects_by_name(&self.conn, *table_id)?;
                let at = at.as_ref().map(|at| match at {
                    CreateAt::Before(key) => model::Anchor::Before(ObjectId::from_string(key)),
                    CreateAt::After(key) => model::Anchor::After(ObjectId::from_string(key)),
                });
                let rows = records
                    .iter()
                    .map(|values| by_field_id(&names, values))
                    .collect();
                Resolved::Create(table, at, rows)
            }
            TableOp::RecordsDelete { table_id, row_keys } => Resolved::Delete(
                table_object(&self.conn, *table_id)?,
                row_keys.iter().map(ObjectId::from_string).collect(),
            ),
            TableOp::RecordsMove {
                table_id,
                row_keys,
                before,
            } => Resolved::Move(
                table_object(&self.conn, *table_id)?,
                row_keys.iter().map(ObjectId::from_string).collect(),
                before.as_ref().map(ObjectId::from_string),
            ),
            TableOp::FieldsMove {
                table_id,
                field_ids,
                to_index,
            } => Resolved::MoveFields(
                table_object(&self.conn, *table_id)?,
                field_ids
                    .iter()
                    .map(|id| field_object(&self.conn, *table_id, *id))
                    .collect::<Result<Vec<_>>>()?,
                *to_index,
            ),
        })
    }

    /// Undoes this handle's last undo step; `false` when there was none.
    pub fn undo(&mut self) -> Result<(bool, TableChange)> {
        self.writable()?;
        let label = self.origin.clone().with_label("undo").encode();
        // An undo can bring back what others changed meanwhile (a name since taken): repaired.
        self.write(&label, true, |replica| Ok(replica.undo()?))
    }

    /// Redoes the last undone step; `false` when there was none.
    pub fn redo(&mut self) -> Result<(bool, TableChange)> {
        self.writable()?;
        let label = self.origin.clone().with_label("redo").encode();
        self.write(&label, true, |replica| Ok(replica.redo()?))
    }

    pub fn can_undo(&self) -> bool {
        self.replica.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.replica.can_redo()
    }

    /// The writes until [`KitableFile::end_undo_group`] undo as one step (each is still its own
    /// change row). Groups do not nest.
    pub fn begin_undo_group(&mut self) -> Result<()> {
        Ok(self.replica.begin_undo_group()?)
    }

    pub fn end_undo_group(&mut self) {
        self.replica.end_undo_group();
    }

    /// Whether the file on disk is no longer the one this handle last opened or wrote: replaced
    /// (another inode), or written by someone else (size or modification time).
    pub fn changed_on_disk(&self) -> bool {
        FileIdentity::of(&self.path) != self.identity
    }

    /// Opens the file at this handle's path afresh and moves the handle onto it. When it holds
    /// the same document, every change this handle has that the file lacks is merged into it
    /// (imported, repaired, projected, appended); when it holds another document, the handle
    /// simply switches to it. Undo history does not survive.
    pub fn reopen_merging(&mut self) -> Result<MergeOutcome> {
        if !self.changed_on_disk() {
            return Ok(MergeOutcome::Unchanged);
        }
        let mut fresh = KitableFile::open(&self.path)?;
        fresh.origin = self.origin.clone();
        if fresh.replica.doc_id() != self.replica.doc_id() {
            *self = fresh;
            return Ok(MergeOutcome::DifferentDocument);
        }
        let ours = self.replica.version();
        let theirs = fresh.replica.version();
        let file_lacks = !theirs.includes(&ours);
        let we_lack = !ours.includes(&theirs);
        if !file_lacks && !we_lack {
            *self = fresh;
            return Ok(MergeOutcome::Unchanged);
        }
        let mut change = TableChange::default();
        if file_lacks {
            let bytes = self.replica.export_changes(&theirs)?;
            let import = Origin::new(OriginKind::Import, "import");
            fresh.origin = import.clone();
            let merged = fresh.write(&import.encode(), false, |replica| {
                let changed = replica.import_changes(&bytes)?;
                repair::run(replica, &changed)?;
                Ok(())
            });
            fresh.origin = self.origin.clone();
            change = merged?.1;
        }
        if we_lack {
            // This handle's state is behind the file's: whatever the file holds may differ.
            change = everything(&fresh.conn)?;
        }
        let old_records = live_record_keys(&self.conn)?;
        let new_records = live_record_keys(&fresh.conn)?;
        for key in old_records.difference(&new_records) {
            change.records_deleted.push(key.clone());
        }
        change.records_deleted.sort();
        change.records_deleted.dedup();
        fresh.last_change = Some(change.clone());
        *self = fresh;
        Ok(MergeOutcome::Merged(change))
    }
}

/// The body of one write, inside its SQL transaction, after the catch-up: `since` and `head`
/// are what the store holds. Answers the step's value, what the projection changed, and the
/// store's head afterwards.
#[allow(clippy::too_many_arguments)]
fn write_in<R>(
    conn: &Connection,
    replica: &mut Replica,
    since: &Version,
    head: &store::Head,
    label: &str,
    actor: &str,
    now: i64,
    repair_after: bool,
    step: impl FnOnce(&mut Replica) -> Result<R>,
) -> Result<(R, TableChange, store::Head)> {
    // Changes imported by the catch-up were projected by the handle that stored them; projecting
    // them again is harmless and keeps this write's change complete.
    let mut changed: BTreeSet<ObjectId> = replica.take_changed();
    let value = step(replica)?;
    let stepped = replica.take_changed();
    if repair_after {
        repair::run(replica, &stepped)?;
    }
    changed.extend(stepped);
    changed.extend(replica.take_changed());
    if since.includes(&replica.version()) && changed.is_empty() {
        return Ok((value, TableChange::default(), head.clone()));
    }
    store::append(conn, replica, since, label, now)?;
    let change = project::project_changes(conn, replica, &changed, actor, now)?;
    if store::should_compact(conn)? {
        store::compact(conn, replica, now)?;
    }
    let stored = store::stored_position(conn)?;
    store::set_projected_position(conn, stored)?;
    Ok((value, change, store::head(conn)?))
}

/// Imports what other handles stored since `head`, and moves `since` and `head` to the store's
/// current state.
fn catch_up(
    conn: &Connection,
    replica: &mut Replica,
    since: &mut Version,
    head: &mut store::Head,
) -> Result<CatchUp> {
    let stored = store::head(conn)?;
    if stored == *head {
        return Ok(CatchUp::Current);
    }
    let file = file::load_replica(conn)?;
    if file.doc_id() != replica.doc_id() {
        return Err(KitableError::invalid(
            "the kitable file now holds another document; reopen it",
        ));
    }
    let theirs = file.version();
    let ours = replica.version();
    if !ours.includes(&theirs) {
        replica.import_changes(&file.export_changes(&ours)?)?;
    }
    let diverged = !theirs.includes(&ours);
    *since = theirs;
    *head = stored;
    Ok(if diverged {
        CatchUp::Diverged
    } else {
        CatchUp::Imported
    })
}

/// Both changes in one, every list sorted and without repeats.
fn merge_changes(mut a: TableChange, b: TableChange) -> TableChange {
    fn join<T: Ord>(a: &mut Vec<T>, b: Vec<T>) {
        a.extend(b);
        a.sort();
        a.dedup();
    }
    join(&mut a.tables, b.tables);
    join(&mut a.schema, b.schema);
    join(&mut a.views, b.views);
    join(&mut a.records_upserted, b.records_upserted);
    join(&mut a.records_deleted, b.records_deleted);
    join(&mut a.records_reordered, b.records_reordered);
    a.dashboards |= b.dashboards;
    a
}

/// A change naming every live table, view, and record: for when the state a reader holds may
/// differ from the file's anywhere.
fn everything(conn: &Connection) -> Result<TableChange> {
    let ids = |sql: &str| -> Result<Vec<i64>> {
        let mut statement = conn.prepare(sql)?;
        let rows = statement
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<i64>, _>>()?;
        Ok(rows)
    };
    let tables = ids("SELECT id FROM kition_tables WHERE deleted_at IS NULL ORDER BY id")?;
    let views = ids("SELECT id FROM kition_views WHERE deleted_at IS NULL ORDER BY id")?;
    let mut records: Vec<(i64, String)> = live_record_keys(conn)?.into_iter().collect();
    records.sort();
    Ok(TableChange {
        tables: tables.clone(),
        schema: tables.clone(),
        views,
        records_upserted: records,
        records_deleted: Vec::new(),
        records_reordered: tables,
        dashboards: true,
    })
}

fn live_record_keys(conn: &Connection) -> Result<BTreeSet<(i64, String)>> {
    let mut statement = conn.prepare(
        "SELECT r.table_id, r.row_key FROM kition_records r JOIN kition_tables t ON t.id = r.table_id \
         WHERE r.deleted_at IS NULL AND t.deleted_at IS NULL",
    )?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    Ok(rows)
}

/// An op with its integer ids and field names resolved to object ids.
enum Resolved {
    Cells(
        ObjectId,
        Vec<(ObjectId, serde_json::Map<String, serde_json::Value>)>,
    ),
    Create(
        ObjectId,
        Option<model::Anchor>,
        Vec<serde_json::Map<String, serde_json::Value>>,
    ),
    Delete(ObjectId, Vec<ObjectId>),
    Move(ObjectId, Vec<ObjectId>, Option<ObjectId>),
    MoveFields(ObjectId, Vec<ObjectId>, usize),
}

/// `values` keyed by field name, re-keyed by field object id; unknown names are dropped.
pub(crate) fn by_field_id(
    names: &std::collections::HashMap<String, ObjectId>,
    values: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    values
        .iter()
        .filter_map(|(name, value)| names.get(name).map(|id| (id.to_string(), value.clone())))
        .collect()
}

// ---------------------------------------------------------------------------
// Integer ids and object ids.

fn object_or_not_found(found: Option<Option<String>>) -> Result<ObjectId> {
    match found {
        Some(Some(id)) => Ok(ObjectId::from_string(id)),
        _ => Err(KitableError::NotFound),
    }
}

/// The object a live table row projects.
pub(crate) fn table_object(conn: &Connection, table_id: i64) -> Result<ObjectId> {
    object_or_not_found(
        conn.prepare_cached(
            "SELECT kdm_id FROM kition_tables WHERE id = ?1 AND deleted_at IS NULL",
        )?
        .query_row([table_id], |row| row.get(0))
        .optional()?,
    )
}

/// The object a live field row of the table projects.
pub(crate) fn field_object(conn: &Connection, table_id: i64, field_id: i64) -> Result<ObjectId> {
    object_or_not_found(
        conn.prepare_cached(
            "SELECT kdm_id FROM kition_fields WHERE id = ?1 AND table_id = ?2 AND deleted_at IS NULL",
        )?
        .query_row([field_id, table_id], |row| row.get(0))
        .optional()?,
    )
}

/// The object a live view row of the table projects.
pub(crate) fn view_object(conn: &Connection, table_id: i64, view_id: i64) -> Result<ObjectId> {
    object_or_not_found(
        conn.prepare_cached(
            "SELECT kdm_id FROM kition_views WHERE id = ?1 AND table_id = ?2 AND deleted_at IS NULL",
        )?
        .query_row([view_id, table_id], |row| row.get(0))
        .optional()?,
    )
}

/// The object (its row key) of a live record row of the table.
pub(crate) fn record_object(conn: &Connection, table_id: i64, record_id: i64) -> Result<ObjectId> {
    object_or_not_found(
        conn.prepare_cached(
            "SELECT row_key FROM kition_records WHERE id = ?1 AND table_id = ?2 AND deleted_at IS NULL",
        )?
        .query_row([record_id, table_id], |row| row.get(0))
        .optional()?,
    )
}

fn live_id(conn: &Connection, sql: &str, key: &str) -> Result<i64> {
    conn.prepare_cached(sql)?
        .query_row([key], |row| row.get(0))
        .optional()?
        .ok_or(KitableError::NotFound)
}

pub(crate) fn table_id_of(conn: &Connection, object: &ObjectId) -> Result<i64> {
    live_id(
        conn,
        "SELECT id FROM kition_tables WHERE kdm_id = ?1 AND deleted_at IS NULL",
        object.as_str(),
    )
}

pub(crate) fn field_id_of(conn: &Connection, object: &ObjectId) -> Result<i64> {
    live_id(
        conn,
        "SELECT id FROM kition_fields WHERE kdm_id = ?1 AND deleted_at IS NULL",
        object.as_str(),
    )
}

pub(crate) fn view_id_of(conn: &Connection, object: &ObjectId) -> Result<i64> {
    live_id(
        conn,
        "SELECT id FROM kition_views WHERE kdm_id = ?1 AND deleted_at IS NULL",
        object.as_str(),
    )
}

pub(crate) fn record_id_of(conn: &Connection, row_key: &str) -> Result<i64> {
    live_id(
        conn,
        "SELECT id FROM kition_records WHERE row_key = ?1 AND deleted_at IS NULL",
        row_key,
    )
}

/// The table's live fields: object id by name.
pub(crate) fn field_objects_by_name(
    conn: &Connection,
    table_id: i64,
) -> Result<std::collections::HashMap<String, ObjectId>> {
    let mut statement = conn.prepare_cached(
        "SELECT name, kdm_id FROM kition_fields WHERE table_id = ?1 AND deleted_at IS NULL AND kdm_id IS NOT NULL",
    )?;
    let rows = statement
        .query_map([table_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ObjectId::from_string(row.get::<_, String>(1)?),
            ))
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// The object id of any table or field row, live or deleted (`None`: no such row, or one the
/// replica never knew).
pub(crate) fn any_object(conn: &Connection, table: &str, id: i64) -> Result<Option<ObjectId>> {
    let found: Option<Option<String>> = conn
        .prepare_cached(&format!("SELECT kdm_id FROM {table} WHERE id = ?1"))?
        .query_row([id], |row| row.get(0))
        .optional()?;
    Ok(found.flatten().map(ObjectId::from_string))
}
