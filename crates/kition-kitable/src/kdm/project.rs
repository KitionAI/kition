//! The projector: writes a table document's KDM replica into the relational tables of its
//! `.kitable` file, which the API reads.
//!
//! [`project_changes`] projects the objects one or more transactions or imports changed (as
//! [`Replica::take_changed`] reports them); [`rebuild`] projects the whole replica. Both only
//! write rows, inside the caller's SQL transaction: the caller appends the replica's changes
//! ([`super::store::append`]) and then records the projected position
//! ([`super::store::set_projected_position`]) in the same transaction, so a crash keeps both or
//! neither.
//!
//! # Failures
//!
//! On any error the caller must roll the SQL transaction back **and** reload the replica from the
//! store ([`super::store::load`]), or otherwise restore the change set it passed: the replica
//! already holds the changes and [`Replica::take_changed`] already handed them out, so neither
//! retrying with an empty change set nor keeping the in-memory replica would ever project them.
//! Imports must be repaired ([`super::repair::run`]) before projecting, with the repair's own
//! changes included in `changed`: the relational unique indexes require unique table names and
//! unique field names per table, and an unrepaired replica that breaks them is refused with
//! [`KitableError::Invalid`] ("unrepaired replica: duplicate ... name").
//!
//! # What is projected
//!
//! The projection is what the legacy write path writes, from the replica as [`ModelView`] reads
//! it:
//!
//! - Integer ids are local to the file. Rows are matched to objects by `kdm_id` (tables, fields,
//!   views, links) or `row_key` (records) and keep their id; a deleted row whose object comes back
//!   (an undo) is revived with its id; new objects get new ids.
//! - Positions follow list order and keep the gaps legacy positions have: a delete renumbers
//!   nothing, and an insert or a move rewrites only the rows whose position must change.
//! - Deletes are soft (`deleted_at`) except links, as in the legacy code. Deleting a table
//!   soft-deletes its fields, views, and records, without record history (as legacy
//!   `delete_table` does).
//! - Options name tables and fields by integer id ([`super::options::options_from_kdm`]): the id
//!   of the object's live row, else of its latest deleted row, else `null`.
//! - A record's `values_json` holds its stored cells by field name and its derived values
//!   (formula, lookup, rollup, `link_to_record` chips), computed by the legacy derivation over the
//!   projected rows in field order; a formula reading a value derived after it is evaluated again
//!   until nothing changes (at most once per derived field), which is what a legacy record shows
//!   after being saved again. Records are recomputed in dependency order: a record when it
//!   changes, when its links change, when its table's fields change in a way that affects
//!   values, and when a record it reads changes a value it reads (transitively), so lookups,
//!   rollups, and chips never go stale (see `derive`). Derived fields that depend on themselves
//!   (a cycle of `(record, field)` pairs, which the model refuses but concurrent edits can merge
//!   into) read the other fields of their cycle as missing, so their values stay bounded. Field
//!   types the legacy code does not derive (`auto_number`, created and last-modified time and by)
//!   have no value, as before.
//! - History: one `update` row per stored cell that changed, in field-name order, and the whole
//!   record on `create` and `delete`, with the caller's actor; before values come from the row
//!   being replaced. A rebuild writes no history.
//! - Dashboards are not relational; [`TableChange::dashboards`] says when they changed (the
//!   projected list of dashboards is kept in `kition_meta` to notice reorders).

mod derive;
mod positions;

use std::cell::Cell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::rc::Rc;

use kition_kdm::{ObjectId, Replica};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use self::derive::Seed;
use self::positions::place;
use super::model::{BASE, DASHBOARD, FIELD, LINK, RECORD, TABLE, VIEW, is_computed};
use super::options::options_from_kdm;
use super::read::{LinkData, ModelView};
use crate::computed::formula_references;
use crate::history::{HistoryAction, HistoryWrite, insert_history};
use crate::source::{FIELD_COLUMNS, Field, field_from_row};
use crate::{KitableError, Result, file, json};

/// What one projection changed in the relational tables, by integer id. Every list is sorted and
/// holds no repeats.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChange {
    /// Tables whose own row changed: created, deleted, renamed, moved, or given a new primary
    /// field.
    pub tables: Vec<i64>,
    /// Tables whose fields were added, removed, updated, or reordered.
    pub schema: Vec<i64>,
    /// Views created, deleted, updated, or reordered, or whose column widths or visibility
    /// changed.
    pub views: Vec<i64>,
    /// `(table id, row key)` of records created or whose values changed, derived values included.
    pub records_upserted: Vec<(i64, String)>,
    pub records_deleted: Vec<(i64, String)>,
    /// Tables whose records' positions changed.
    pub records_reordered: Vec<i64>,
    /// A dashboard, or the base's list of them, changed.
    pub dashboards: bool,
}

/// Projects the objects in `changed` (what [`Replica::take_changed`] reported) into the
/// relational tables, inside the caller's SQL transaction. `actor` labels the history rows;
/// `now` (Unix milliseconds) stamps the rows written. Does not record the projected position.
/// See the module documentation for what the caller must do on failure.
pub fn project_changes(
    conn: &Connection,
    replica: &Replica,
    changed: &BTreeSet<ObjectId>,
    actor: &str,
    now: i64,
) -> Result<TableChange> {
    let mut projector = Projector::new(conn, replica, actor, now, false)?;
    let outcome = projector
        .classify(changed)
        .and_then(|plan| projector.run(plan));
    LAST_RECOMPUTES.with(|count| count.set(projector.recomputed));
    outcome.map_err(unrepaired)?;
    Ok(projector.out.finish())
}

/// Projects the whole replica, inside the caller's SQL transaction: afterwards the relational
/// tables hold what [`project_changes`] would have written from an empty file, with the ids of
/// rows that already existed kept, and rows of objects the replica deleted deleted. Writes no
/// history. Does not record the projected position.
///
/// Refuses ([`KitableError::Invalid`]) to delete rows the replica never knew: live tables,
/// fields, or views without a `kdm_id`, links between live records without one, and live records
/// whose `row_key` is no record of the replica. A file written by the legacy code is migrated
/// first ([`super::migrate::upgrade`] records every `kdm_id`), and a rebuild right after keeps
/// every row.
pub fn rebuild(conn: &Connection, replica: &Replica, now: i64) -> Result<()> {
    unknown_rows(conn, replica)?;
    let mut projector = Projector::new(conn, replica, "", now, true)?;
    let outcome = projector.run(Plan {
        full: true,
        base: true,
        dashboards: true,
        ..Plan::default()
    });
    LAST_RECOMPUTES.with(|count| count.set(projector.recomputed));
    outcome.map_err(unrepaired)
}

thread_local! {
    static LAST_RECOMPUTES: Cell<u64> = const { Cell::new(0) };
}

/// How many record recomputations the last projection on this thread ran. For tests and
/// diagnostics.
#[doc(hidden)]
pub fn last_recompute_count() -> u64 {
    LAST_RECOMPUTES.with(Cell::get)
}

/// A unique-index violation on table or field names: the replica was not repaired.
fn unrepaired(error: KitableError) -> KitableError {
    let KitableError::Sql(rusqlite::Error::SqliteFailure(failure, message)) = &error else {
        return error;
    };
    if failure.extended_code != rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE {
        return error;
    }
    let message = message.clone().unwrap_or_default();
    let kind = if message.contains("kition_fields") {
        "field"
    } else if message.contains("kition_tables") {
        "table"
    } else {
        return error;
    };
    KitableError::invalid(format!(
        "unrepaired replica: duplicate {kind} name ({message}); repair the replica before projecting"
    ))
}

/// Refuses a rebuild that would delete rows the replica never knew.
fn unknown_rows(conn: &Connection, replica: &Replica) -> Result<()> {
    let count = |sql: &str| -> Result<i64> { Ok(conn.query_row(sql, [], |row| row.get(0))?) };
    let tables =
        count("SELECT COUNT(*) FROM kition_tables WHERE deleted_at IS NULL AND kdm_id IS NULL")?;
    let fields = count(
        "SELECT COUNT(*) FROM kition_fields f JOIN kition_tables t ON t.id = f.table_id \
         WHERE f.deleted_at IS NULL AND t.deleted_at IS NULL AND f.kdm_id IS NULL",
    )?;
    let views = count(
        "SELECT COUNT(*) FROM kition_views v JOIN kition_tables t ON t.id = v.table_id \
         WHERE v.deleted_at IS NULL AND t.deleted_at IS NULL AND v.kdm_id IS NULL",
    )?;
    let links = count(
        "SELECT COUNT(*) FROM kition_record_links l \
         JOIN kition_records a ON a.id = l.from_record_id JOIN kition_records b ON b.id = l.to_record_id \
         JOIN kition_fields f ON f.id = l.from_field_id \
         WHERE l.kdm_id IS NULL AND a.deleted_at IS NULL AND b.deleted_at IS NULL AND f.deleted_at IS NULL",
    )?;
    let mut records = 0_i64;
    {
        let mut statement = conn.prepare(
            "SELECT r.row_key FROM kition_records r JOIN kition_tables t ON t.id = r.table_id \
             WHERE r.deleted_at IS NULL AND t.deleted_at IS NULL",
        )?;
        for key in statement.query_map([], |row| row.get::<_, String>(0))? {
            let key = ObjectId::from_string(key?);
            if !replica.object_type(&key).is_ok_and(|ty| ty == RECORD) {
                records += 1;
            }
        }
    }
    if tables + fields + views + links + records == 0 {
        return Ok(());
    }
    let plural = |count: i64, word: &str| {
        if count == 1 {
            format!("{count} {word}")
        } else {
            format!("{count} {word}s")
        }
    };
    Err(KitableError::invalid(format!(
        "rebuild would delete rows the replica does not know: {}, {}, {}, {}, {}; migrate the file first",
        plural(tables, "table"),
        plural(fields, "field"),
        plural(views, "view"),
        plural(links, "link"),
        plural(records, "record"),
    )))
}

const DASHBOARDS_KEY: &str = "kdm_projected_dashboards";

/// The base's object id, so a projection need not scan every object to find it.
const BASE_KEY: &str = "kdm_base_id";

#[derive(Default)]
struct Out {
    tables: BTreeSet<i64>,
    schema: BTreeSet<i64>,
    views: BTreeSet<i64>,
    upserted: BTreeSet<(i64, String)>,
    deleted: BTreeSet<(i64, String)>,
    reordered: BTreeSet<i64>,
    dashboards: bool,
}

impl Out {
    fn finish(self) -> TableChange {
        TableChange {
            tables: self.tables.into_iter().collect(),
            schema: self.schema.into_iter().collect(),
            views: self.views.into_iter().collect(),
            records_upserted: self.upserted.into_iter().collect(),
            records_deleted: self.deleted.into_iter().collect(),
            records_reordered: self.reordered.into_iter().collect(),
            dashboards: self.dashboards,
        }
    }
}

/// What to project: changed objects by type, and the live rows of objects that are gone.
#[derive(Default)]
struct Plan {
    /// Project everything: every table is reconciled and rows of missing objects are deleted.
    full: bool,
    base: bool,
    /// The Base objects that changed.
    bases: Vec<ObjectId>,
    dashboards: bool,
    tables: BTreeSet<ObjectId>,
    fields: BTreeSet<ObjectId>,
    views: BTreeSet<ObjectId>,
    records: BTreeSet<ObjectId>,
    links: BTreeSet<ObjectId>,
    gone_tables: Vec<i64>,
    gone_fields: Vec<i64>,
    gone_views: Vec<i64>,
    gone_records: Vec<i64>,
    gone_links: Vec<i64>,
}

/// A table's live fields as projected, in order.
pub(crate) struct TableSchema {
    fields: Vec<Field>,
    /// Stored (not computed) fields: name by object id.
    stored: HashMap<String, String>,
    /// Stored fields `(name, id)` in name order, for history.
    stored_by_name: Vec<(String, i64)>,
    /// A formula comes before another derived field, so it may read a value derived after it.
    forward_formulas: bool,
}

struct FieldRow {
    id: i64,
    table_id: i64,
    name: String,
    title: String,
    field_type: String,
    required: bool,
    readonly: bool,
    options_json: String,
    formula: String,
    ai_prompt: String,
    meta_json: String,
}

struct Projector<'a> {
    conn: &'a Connection,
    replica: &'a Replica,
    view: ModelView<'a>,
    actor: &'a str,
    now: i64,
    /// Rebuilds write no history.
    history: bool,
    document_id: String,
    out: Out,

    /// The document's base: the Base with the lowest id, as [`ModelView::base`] answers.
    base: Option<ObjectId>,
    /// The base's live tables in order, and each one's live fields and views.
    tables: Vec<ObjectId>,
    table_fields: HashMap<ObjectId, Vec<ObjectId>>,
    table_views: HashMap<ObjectId, Vec<ObjectId>>,
    field_table: HashMap<ObjectId, ObjectId>,
    view_table: HashMap<ObjectId, ObjectId>,

    /// Live table rows by object id.
    table_ids: HashMap<ObjectId, i64>,
    /// Live field rows by object id; loaded on first use after the fields are projected.
    field_ids: Option<HashMap<ObjectId, i64>>,
    schemas: HashMap<i64, Rc<TableSchema>>,
    /// Tables whose lists of fields, views, and records are reconciled.
    reconcile: BTreeSet<ObjectId>,
    /// Tables whose every record is recomputed.
    recompute_tables: BTreeSet<i64>,
    /// Fields that appeared, disappeared, or changed in a way that affects values: lookups and
    /// rollups naming them are recomputed.
    fields_changed: HashSet<i64>,
    /// Tables whose primary field changed: records linking to them are recomputed.
    primary_changed: BTreeSet<i64>,
    /// Link fields whose options changed: their links are reconciled.
    link_fields: BTreeSet<ObjectId>,
    /// Records to recompute, with what may have changed in them.
    seeds: HashMap<i64, Vec<Seed>>,
    /// Records created or revived by this projection.
    created: HashSet<i64>,
    /// Records whose object changed.
    touched: HashSet<i64>,
    /// Record recomputations run.
    recomputed: u64,
}

impl<'a> Projector<'a> {
    fn new(
        conn: &'a Connection,
        replica: &'a Replica,
        actor: &'a str,
        now: i64,
        rebuild: bool,
    ) -> Result<Self> {
        let document_id = file::get_meta(conn, "document_id")?
            .ok_or_else(|| KitableError::invalid("kitable file has no document_id"))?;
        Ok(Self {
            conn,
            replica,
            view: ModelView::new(replica),
            actor,
            now,
            history: !rebuild,
            document_id,
            out: Out::default(),
            base: None,
            tables: Vec::new(),
            table_fields: HashMap::new(),
            table_views: HashMap::new(),
            field_table: HashMap::new(),
            view_table: HashMap::new(),
            table_ids: HashMap::new(),
            field_ids: None,
            schemas: HashMap::new(),
            reconcile: BTreeSet::new(),
            recompute_tables: BTreeSet::new(),
            fields_changed: HashSet::new(),
            primary_changed: BTreeSet::new(),
            link_fields: BTreeSet::new(),
            seeds: HashMap::new(),
            created: HashSet::new(),
            touched: HashSet::new(),
            recomputed: 0,
        })
    }

    fn seed(&mut self, record: i64, seed: Seed) {
        self.seeds.entry(record).or_default().push(seed);
    }

    // -----------------------------------------------------------------------
    // Planning.

    fn classify(&self, changed: &BTreeSet<ObjectId>) -> Result<Plan> {
        let mut plan = Plan::default();
        for id in changed {
            let Ok(ty) = self.replica.object_type(id) else {
                self.classify_gone(id, &mut plan)?;
                continue;
            };
            match ty.as_str() {
                BASE => {
                    plan.base = true;
                    plan.bases.push(id.clone());
                }
                TABLE => {
                    plan.tables.insert(id.clone());
                }
                FIELD => {
                    plan.fields.insert(id.clone());
                }
                VIEW => {
                    plan.views.insert(id.clone());
                }
                RECORD => {
                    plan.records.insert(id.clone());
                }
                LINK => {
                    plan.links.insert(id.clone());
                }
                DASHBOARD => plan.dashboards = true,
                _ => {}
            }
        }
        Ok(plan)
    }

    /// Finds the live row a deleted object projected to, if any.
    fn classify_gone(&self, id: &ObjectId, plan: &mut Plan) -> Result<()> {
        let key = id.as_str();
        let find = |sql: &str| -> Result<Option<i64>> {
            Ok(self
                .conn
                .prepare_cached(sql)?
                .query_row([key], |row| row.get(0))
                .optional()?)
        };
        if let Some(row) =
            find("SELECT id FROM kition_records WHERE row_key = ?1 AND deleted_at IS NULL")?
        {
            plan.gone_records.push(row);
        } else if let Some(row) =
            find("SELECT id FROM kition_tables WHERE kdm_id = ?1 AND deleted_at IS NULL")?
        {
            plan.gone_tables.push(row);
        } else if let Some(row) =
            find("SELECT id FROM kition_fields WHERE kdm_id = ?1 AND deleted_at IS NULL")?
        {
            plan.gone_fields.push(row);
        } else if let Some(row) =
            find("SELECT id FROM kition_views WHERE kdm_id = ?1 AND deleted_at IS NULL")?
        {
            plan.gone_views.push(row);
        } else if let Some(row) = find("SELECT id FROM kition_record_links WHERE kdm_id = ?1")? {
            plan.gone_links.push(row);
        }
        Ok(())
    }

    fn run(&mut self, mut plan: Plan) -> Result<()> {
        self.find_base(&plan)?;
        self.load_structure()?;
        if plan.base {
            self.project_document()?;
            self.check_dashboards()?;
        }
        if plan.dashboards {
            self.out.dashboards = true;
        }
        self.project_tables(&plan)?;
        self.project_fields(&plan)?;
        self.recompute_users_of_changed_fields()?;
        self.project_primary_fields(&plan)?;
        self.project_views(&plan)?;
        self.project_records(&mut plan)?;
        self.project_links(&plan)?;
        self.derive()
    }

    /// Finds the base: the one remembered in `kition_meta` while it is still a Base and no other
    /// Base changed, else the lowest id of the Base objects (one pass over every object).
    fn find_base(&mut self, plan: &Plan) -> Result<()> {
        let stored = file::get_meta(self.conn, BASE_KEY)?;
        if !plan.full
            && let Some(stored) = &stored
        {
            let id = ObjectId::from_string(stored.clone());
            let still = self.replica.object_type(&id).is_ok_and(|ty| ty == BASE);
            if still && plan.bases.iter().all(|base| *base == id) {
                self.base = Some(id);
                return Ok(());
            }
        }
        self.base = self.view.base();
        match &self.base {
            Some(base) if stored.as_deref() != Some(base.as_str()) => {
                file::set_meta(self.conn, BASE_KEY, base.as_str())?;
            }
            _ => {}
        }
        Ok(())
    }

    fn load_structure(&mut self) -> Result<()> {
        if let Some(base) = &self.base {
            self.tables = live(self.replica, base, "tables")?;
        }
        for table in &self.tables {
            let fields = live(self.replica, table, "fields")?;
            for field in &fields {
                self.field_table
                    .entry(field.clone())
                    .or_insert_with(|| table.clone());
            }
            self.table_fields.insert(table.clone(), fields);
            let views = live(self.replica, table, "views")?;
            for view in &views {
                self.view_table
                    .entry(view.clone())
                    .or_insert_with(|| table.clone());
            }
            self.table_views.insert(table.clone(), views);
        }
        let mut statement = self.conn.prepare_cached(
            "SELECT kdm_id, id FROM kition_tables WHERE deleted_at IS NULL AND kdm_id IS NOT NULL",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((ObjectId::from_string(row.get::<_, String>(0)?), row.get(1)?))
        })?;
        for row in rows {
            let (kdm, id) = row?;
            self.table_ids.insert(kdm, id);
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // The document and dashboards.

    fn project_document(&mut self) -> Result<()> {
        let Some(id) = &self.base else {
            return Ok(());
        };
        let text = |field: &str| -> Result<String> {
            Ok(self
                .replica
                .get(id, field)?
                .as_str()
                .unwrap_or_default()
                .to_owned())
        };
        let (title, description, icon, color) = (
            text("title")?,
            text("description")?,
            text("icon")?,
            text("color")?,
        );
        let meta = json_text(&self.replica.get(id, "meta")?);
        let current: Option<(String, String, String, String, String, bool)> = self
            .conn
            .query_row(
                "SELECT title, description, icon, color, meta_json, deleted_at IS NULL FROM kition_documents WHERE id = ?1",
                [&self.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .optional()?;
        let wanted = (
            title.clone(),
            description.clone(),
            icon.clone(),
            color.clone(),
            meta.clone(),
            true,
        );
        match current {
            Some(current) if current == wanted => {}
            Some(_) => {
                self.conn.execute(
                    "UPDATE kition_documents SET title = ?1, description = ?2, icon = ?3, color = ?4, meta_json = ?5, \
                     updated_at = ?6, deleted_at = NULL WHERE id = ?7",
                    params![title, description, icon, color, meta, self.now, self.document_id],
                )?;
            }
            None => {
                self.conn.execute(
                    "INSERT INTO kition_documents (id, title, description, icon, color, meta_json, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    params![self.document_id, title, description, icon, color, meta, self.now],
                )?;
            }
        }
        Ok(())
    }

    /// Compares the base's dashboards with the list last projected.
    fn check_dashboards(&mut self) -> Result<()> {
        let listed: Vec<String> = match &self.base {
            Some(base) => live(self.replica, base, "dashboards")?
                .into_iter()
                .map(|id| id.to_string())
                .collect(),
            None => Vec::new(),
        };
        let encoded = serde_json::to_string(&listed)?;
        let stored = file::get_meta(self.conn, DASHBOARDS_KEY)?;
        if stored.as_deref() != Some(encoded.as_str()) {
            if stored.is_some() || !listed.is_empty() {
                self.out.dashboards = true;
            }
            file::set_meta(self.conn, DASHBOARDS_KEY, &encoded)?;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Tables.

    fn project_tables(&mut self, plan: &Plan) -> Result<()> {
        let listed: HashSet<ObjectId> = self.tables.iter().cloned().collect();
        let mut doomed: BTreeSet<i64> = plan.gone_tables.iter().copied().collect();
        for table in &plan.tables {
            if !listed.contains(table)
                && let Some(id) = self.table_ids.get(table)
            {
                doomed.insert(*id);
            }
        }
        if plan.base {
            for (kdm, id) in &self.table_ids {
                if !listed.contains(kdm) {
                    doomed.insert(*id);
                }
            }
        }
        for id in doomed {
            self.delete_table(id)?;
        }
        self.table_ids.retain(|kdm, _| listed.contains(kdm));

        let targets: Vec<ObjectId> = self
            .tables
            .iter()
            .filter(|table| {
                plan.full || plan.tables.contains(*table) || !self.table_ids.contains_key(*table)
            })
            .cloned()
            .collect();
        let mut data = Vec::with_capacity(targets.len());
        for table in &targets {
            data.push(self.view.table(table)?);
        }
        // Names are unique per document: move renamed rows out of the way first.
        for table in &data {
            if let Some(id) = self.table_ids.get(&table.id) {
                self.conn
                    .prepare_cached(
                        "UPDATE kition_tables SET name = ?1 WHERE id = ?2 AND name != ?3",
                    )?
                    .execute(params![temporary_name(&table.id), id, table.name])?;
            }
        }
        let mut fresh: HashSet<i64> = HashSet::new();
        for table in &data {
            let meta = json_text(&table.meta);
            let id = match self.table_ids.get(&table.id) {
                Some(id) => *id,
                None => {
                    let id = self.revive_or_insert_table(table, &meta)?;
                    self.table_ids.insert(table.id.clone(), id);
                    self.out.tables.insert(id);
                    self.reconcile.insert(table.id.clone());
                    fresh.insert(id);
                    continue;
                }
            };
            let updated = self
                .conn
                .prepare_cached(
                    "UPDATE kition_tables SET name = ?1, title = ?2, description = ?3, meta_json = ?4, updated_at = ?5 \
                     WHERE id = ?6 AND (name != ?1 OR title != ?2 OR description != ?3 OR meta_json != ?4)",
                )?
                .execute(params![table.name, table.title, table.description, meta, self.now, id])?;
            if updated > 0 {
                self.out.tables.insert(id);
            }
        }
        for table in &targets {
            if plan.full || plan.tables.contains(table) {
                self.reconcile.insert(table.clone());
            }
        }
        // Positions follow the base's list.
        if plan.base || !fresh.is_empty() {
            let ids: Vec<i64> = self
                .tables
                .iter()
                .filter_map(|table| self.table_ids.get(table).copied())
                .collect();
            for id in self.place_rows("kition_tables", &ids, &fresh)? {
                self.out.tables.insert(id);
            }
        }
        Ok(())
    }

    /// Gives the rows `ids` (in list order) increasing positions, rewriting as few as possible;
    /// `fresh` rows' positions do not count. Answers the rows whose position changed.
    fn place_rows(&self, table: &str, ids: &[i64], fresh: &HashSet<i64>) -> Result<Vec<i64>> {
        let mut current = Vec::with_capacity(ids.len());
        {
            let mut statement = self
                .conn
                .prepare_cached(&format!("SELECT position FROM {table} WHERE id = ?1"))?;
            for id in ids {
                let position: Option<i64> =
                    statement.query_row([id], |row| row.get(0)).optional()?;
                current.push(position.filter(|_| !fresh.contains(id)));
            }
        }
        let mut moved = Vec::new();
        let mut update = self
            .conn
            .prepare_cached(&format!("UPDATE {table} SET position = ?1 WHERE id = ?2"))?;
        for ((id, before), position) in ids.iter().zip(&current).zip(place(&current)) {
            if *before != Some(position) {
                update.execute(params![position, id])?;
                if before.is_some() {
                    moved.push(*id);
                }
            }
        }
        Ok(moved)
    }

    fn revive_or_insert_table(&self, table: &super::read::TableData, meta: &str) -> Result<i64> {
        if let Some(id) = latest_row(self.conn, "kition_tables", table.id.as_str())? {
            self.conn.execute(
                "UPDATE kition_tables SET document_id = ?1, name = ?2, title = ?3, description = ?4, \
                 meta_json = ?5, updated_at = ?6, deleted_at = NULL WHERE id = ?7",
                params![self.document_id, table.name, table.title, table.description, meta, self.now, id],
            )?;
            return Ok(id);
        }
        self.conn.execute(
            "INSERT INTO kition_tables (document_id, name, title, description, position, meta_json, created_at, updated_at, kdm_id) \
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?6, ?7)",
            params![self.document_id, table.name, table.title, table.description, meta, self.now, table.id.as_str()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Soft-deletes a table with its fields, views, and records (no record history, as legacy
    /// `delete_table`), and drops links from or to its records.
    fn delete_table(&mut self, id: i64) -> Result<()> {
        let count = self.conn.execute(
            "UPDATE kition_tables SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![self.now, id],
        )?;
        if count == 0 {
            return Ok(());
        }
        self.out.tables.insert(id);
        let mut statement = self
            .conn
            .prepare("SELECT id FROM kition_fields WHERE table_id = ?1 AND deleted_at IS NULL")?;
        for field in statement.query_map([id], |row| row.get::<_, i64>(0))? {
            self.fields_changed.insert(field?);
        }
        let mut statement = self.conn.prepare(
            "SELECT row_key FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL",
        )?;
        for key in statement.query_map([id], |row| row.get::<_, String>(0))? {
            self.out.deleted.insert((id, key?));
        }
        for table in ["kition_fields", "kition_views", "kition_records"] {
            self.conn.execute(
                &format!("UPDATE {table} SET deleted_at = ?1, updated_at = ?1 WHERE table_id = ?2 AND deleted_at IS NULL"),
                params![self.now, id],
            )?;
        }
        let linkers: Vec<(i64, i64)> = {
            let mut statement = self.conn.prepare(
                "SELECT DISTINCT from_record_id, from_field_id FROM kition_record_links \
                 WHERE to_table_id = ?1 AND from_table_id != ?1",
            )?;
            statement
                .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        for (record, link) in linkers {
            self.seed(record, Seed::Link(link));
        }
        self.conn.execute(
            "DELETE FROM kition_record_links WHERE from_table_id = ?1 OR to_table_id = ?1",
            [id],
        )?;
        self.schemas.remove(&id);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Fields.

    fn project_fields(&mut self, plan: &Plan) -> Result<()> {
        if plan.fields.is_empty() && plan.gone_fields.is_empty() && self.reconcile.is_empty() {
            return Ok(());
        }
        // Live field rows linked to an object, by object id.
        let mut rows: HashMap<ObjectId, FieldRow> = HashMap::new();
        {
            let mut statement = self.conn.prepare_cached(
                "SELECT id, kdm_id, table_id, name, title, type, required, readonly, options_json, formula, ai_prompt, \
                 meta_json FROM kition_fields WHERE deleted_at IS NULL AND kdm_id IS NOT NULL",
            )?;
            let found = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    FieldRow {
                        id: row.get(0)?,
                        table_id: row.get(2)?,
                        name: row.get(3)?,
                        title: row.get(4)?,
                        field_type: row.get(5)?,
                        required: row.get(6)?,
                        readonly: row.get(7)?,
                        options_json: row.get(8)?,
                        formula: row.get(9)?,
                        ai_prompt: row.get(10)?,
                        meta_json: row.get(11)?,
                    },
                ))
            })?;
            for item in found {
                let (kdm, row) = item?;
                rows.insert(ObjectId::from_string(kdm), row);
            }
        }
        let table_of = |field: &ObjectId| -> Option<i64> {
            self.field_table
                .get(field)
                .and_then(|table| self.table_ids.get(table))
                .copied()
        };

        // Deletions: gone fields, changed fields no table lists, and rows a reconciled table
        // does not list.
        let mut doomed: Vec<(i64, i64)> = Vec::new();
        for id in &plan.gone_fields {
            let table = self
                .conn
                .query_row(
                    "SELECT table_id FROM kition_fields WHERE id = ?1",
                    [id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if let Some(table) = table {
                doomed.push((*id, table));
            }
        }
        let reconciled: HashSet<i64> = self
            .reconcile
            .iter()
            .filter_map(|table| self.table_ids.get(table).copied())
            .collect();
        for (kdm, row) in &rows {
            let listed_in = table_of(kdm);
            let unlisted = listed_in.is_none() && (plan.fields.contains(kdm) || plan.full);
            let left = reconciled.contains(&row.table_id) && listed_in != Some(row.table_id);
            if unlisted || left {
                doomed.push((row.id, row.table_id));
            }
        }
        for (id, table) in &doomed {
            let count = self.conn.execute(
                "UPDATE kition_fields SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![self.now, id],
            )?;
            if count > 0 {
                // Its values leave every record of the table.
                self.field_changed(*table, true);
                self.fields_changed.insert(*id);
            }
        }
        let doomed_ids: HashSet<i64> = doomed.iter().map(|(id, _)| *id).collect();
        rows.retain(|_, row| !doomed_ids.contains(&row.id));

        // Targets: changed listed fields, and listed fields of reconciled tables without a row.
        let mut targets: Vec<(ObjectId, i64)> = Vec::new();
        for table in &self.tables {
            let Some(table_id) = self.table_ids.get(table).copied() else {
                continue;
            };
            let reconciled = self.reconcile.contains(table);
            for field in self.table_fields.get(table).into_iter().flatten() {
                if self.field_table.get(field) != Some(table) {
                    continue;
                }
                if plan.full
                    || plan.fields.contains(field)
                    || (reconciled && !rows.contains_key(field))
                {
                    targets.push((field.clone(), table_id));
                }
            }
        }
        let mut data = Vec::with_capacity(targets.len());
        for (field, _) in &targets {
            data.push(self.view.field(field)?);
        }
        // Names are unique per table: move renamed rows out of the way first.
        for ((field, table_id), wanted) in targets.iter().zip(&data) {
            if let Some(row) = rows.get(field)
                && (row.name != wanted.name || row.table_id != *table_id)
            {
                self.conn
                    .prepare_cached("UPDATE kition_fields SET name = ?1 WHERE id = ?2")?
                    .execute(params![temporary_name(field), row.id])?;
            }
        }
        // New rows first, so options can name them.
        let mut fresh: HashSet<i64> = HashSet::new();
        let mut new_stored: Vec<(i64, String)> = Vec::new();
        for ((field, table_id), wanted) in targets.iter().zip(&data) {
            if rows.contains_key(field) {
                continue;
            }
            let (id, revived) = self.revive_or_insert_field(field, *table_id, wanted)?;
            fresh.insert(id);
            self.fields_changed.insert(id);
            // A brand-new stored field has no cells yet: only formulas naming it can change.
            if revived || is_derived_type(&wanted.field_type) {
                self.field_changed(*table_id, true);
            } else {
                self.field_changed(*table_id, false);
                new_stored.push((*table_id, wanted.name.clone()));
            }
            rows.insert(
                field.clone(),
                FieldRow {
                    id,
                    table_id: *table_id,
                    name: wanted.name.clone(),
                    title: String::new(),
                    field_type: wanted.field_type.clone(),
                    required: false,
                    readonly: false,
                    options_json: String::new(),
                    formula: String::new(),
                    ai_prompt: String::new(),
                    meta_json: String::new(),
                },
            );
        }
        self.field_ids = None;
        let field_ids = self.field_ids()?.clone();
        for ((field, table_id), wanted) in targets.iter().zip(&data) {
            let Some(row) = rows.get(field) else {
                continue;
            };
            let options = options_from_kdm(&wanted.options, |object| {
                self.table_ids
                    .get(object)
                    .or_else(|| field_ids.get(object))
                    .copied()
                    .or_else(|| {
                        latest_row(self.conn, "kition_tables", object.as_str())
                            .ok()
                            .flatten()
                    })
                    .or_else(|| {
                        latest_row(self.conn, "kition_fields", object.as_str())
                            .ok()
                            .flatten()
                    })
            });
            let options_json = json_text(&options);
            let meta_json = json_text(&wanted.meta);
            let same = row.table_id == *table_id
                && row.name == wanted.name
                && row.title == wanted.title
                && row.field_type == wanted.field_type
                && row.required == wanted.required
                && row.readonly == wanted.readonly
                && row.options_json == options_json
                && row.formula == wanted.formula
                && row.ai_prompt == wanted.ai_prompt
                && row.meta_json == meta_json;
            if same {
                continue;
            }
            let derived = is_derived_type(&row.field_type) || is_derived_type(&wanted.field_type);
            let affects_values = !fresh.contains(&row.id)
                && (row.table_id != *table_id
                    || row.name != wanted.name
                    || is_computed(&row.field_type) != is_computed(&wanted.field_type)
                    || (derived
                        && (row.field_type != wanted.field_type
                            || row.options_json != options_json
                            || row.formula != wanted.formula)));
            self.conn
                .prepare_cached(
                    "UPDATE kition_fields SET table_id = ?1, name = ?2, title = ?3, type = ?4, required = ?5, readonly = ?6, \
                     options_json = ?7, formula = ?8, ai_prompt = ?9, meta_json = ?10, updated_at = ?11 WHERE id = ?12",
                )?
                .execute(params![
                    table_id,
                    wanted.name,
                    wanted.title,
                    wanted.field_type,
                    wanted.required,
                    wanted.readonly,
                    options_json,
                    wanted.formula,
                    wanted.ai_prompt,
                    meta_json,
                    self.now,
                    row.id
                ])?;
            self.field_changed(*table_id, affects_values);
            if affects_values {
                self.fields_changed.insert(row.id);
            }
            if !fresh.contains(&row.id)
                && (wanted.field_type == "link_to_record" || row.field_type == "link_to_record")
            {
                self.link_fields.insert(field.clone());
            }
        }
        // A new stored field changes values only through formulas naming it.
        for (table_id, name) in new_stored {
            if self.formulas_name(table_id, Some(&name))? {
                self.recompute_tables.insert(table_id);
            }
        }
        // Positions follow each reconciled table's list; a reorder changes values only through
        // formulas reading values derived after them.
        let reconcile: Vec<ObjectId> = self.reconcile.iter().cloned().collect();
        for table in reconcile {
            let Some(table_id) = self.table_ids.get(&table).copied() else {
                continue;
            };
            let ids: Vec<i64> = self
                .table_fields
                .get(&table)
                .into_iter()
                .flatten()
                .filter_map(|field| field_ids.get(field).copied())
                .collect();
            let moved = self.place_rows("kition_fields", &ids, &fresh)?;
            if !moved.is_empty() {
                let formulas = self.formulas_name(table_id, None)?;
                self.field_changed(table_id, formulas);
            }
        }
        Ok(())
    }

    /// Whether a live formula of the table names `name` (`None`: whether it has formulas).
    fn formulas_name(&self, table_id: i64, name: Option<&str>) -> Result<bool> {
        let mut statement = self.conn.prepare_cached(
            "SELECT formula FROM kition_fields WHERE table_id = ?1 AND type = 'formula' AND deleted_at IS NULL",
        )?;
        for formula in statement.query_map([table_id], |row| row.get::<_, String>(0))? {
            let formula = formula?;
            match name {
                None => return Ok(true),
                Some(name) => {
                    if formula_references(&formula)
                        .iter()
                        .any(|named| named == name)
                    {
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }

    /// Recomputes the tables whose lookups or rollups name a field in [`Self::fields_changed`]:
    /// their values depend on the field even when they have no links (`null` once it is gone).
    fn recompute_users_of_changed_fields(&mut self) -> Result<()> {
        if self.fields_changed.is_empty() {
            return Ok(());
        }
        let mut statement = self.conn.prepare_cached(
            "SELECT table_id, options_json FROM kition_fields \
             WHERE type IN ('lookup', 'rollup') AND deleted_at IS NULL",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (table, options) = row?;
            let options = json::object(&options);
            let names = |key: &str| {
                self.fields_changed
                    .contains(&json::int_option(&options, key))
            };
            if names("link_field_id") || names("target_field_id") {
                self.recompute_tables.insert(table);
            }
        }
        Ok(())
    }

    fn field_changed(&mut self, table_id: i64, affects_values: bool) {
        self.out.schema.insert(table_id);
        self.schemas.remove(&table_id);
        if affects_values {
            self.recompute_tables.insert(table_id);
        }
    }

    /// Answers the row's id, and whether it is a revived deleted row (whose object may have
    /// cells in the records).
    fn revive_or_insert_field(
        &self,
        field: &ObjectId,
        table_id: i64,
        wanted: &super::read::FieldData,
    ) -> Result<(i64, bool)> {
        if let Some(id) = latest_row(self.conn, "kition_fields", field.as_str())? {
            self.conn.execute(
                "UPDATE kition_fields SET table_id = ?1, name = ?2, options_json = '', updated_at = ?3, \
                 deleted_at = NULL WHERE id = ?4",
                params![table_id, wanted.name, self.now, id],
            )?;
            return Ok((id, true));
        }
        // Everything but the name is written by the update that follows.
        self.conn.execute(
            "INSERT INTO kition_fields (document_id, table_id, name, title, type, position, options_json, created_at, updated_at, kdm_id) \
             VALUES (?1, ?2, ?3, '', '', 0, '', ?4, ?4, ?5)",
            params![self.document_id, table_id, wanted.name, self.now, field.as_str()],
        )?;
        Ok((self.conn.last_insert_rowid(), false))
    }

    /// Live field rows by object id.
    fn field_ids(&mut self) -> Result<&HashMap<ObjectId, i64>> {
        if self.field_ids.is_none() {
            let mut ids = HashMap::new();
            let mut statement = self.conn.prepare_cached(
                "SELECT kdm_id, id FROM kition_fields WHERE deleted_at IS NULL AND kdm_id IS NOT NULL",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((ObjectId::from_string(row.get::<_, String>(0)?), row.get(1)?))
            })?;
            for row in rows {
                let (kdm, id) = row?;
                ids.insert(kdm, id);
            }
            self.field_ids = Some(ids);
        }
        Ok(self.field_ids.get_or_insert_with(HashMap::new))
    }

    /// Writes the primary field of tables whose row or fields changed.
    fn project_primary_fields(&mut self, plan: &Plan) -> Result<()> {
        let tables: Vec<ObjectId> = self
            .tables
            .iter()
            .filter(|table| {
                plan.full
                    || plan.tables.contains(*table)
                    || self.reconcile.contains(*table)
                    || self
                        .table_ids
                        .get(*table)
                        .is_some_and(|id| self.out.schema.contains(id))
            })
            .cloned()
            .collect();
        for table in tables {
            let Some(table_id) = self.table_ids.get(&table).copied() else {
                continue;
            };
            let primary = self.view.table(&table)?.primary_field;
            let primary_id = match primary {
                Some(field) => self.field_ids()?.get(&field).copied(),
                None => None,
            };
            let current: Option<i64> = self.conn.query_row(
                "SELECT primary_field_id FROM kition_tables WHERE id = ?1",
                [table_id],
                |row| row.get(0),
            )?;
            if current != primary_id {
                self.conn.execute(
                    "UPDATE kition_tables SET primary_field_id = ?1, updated_at = ?2 WHERE id = ?3",
                    params![primary_id, self.now, table_id],
                )?;
                self.out.tables.insert(table_id);
                self.primary_changed.insert(table_id);
            }
            let flagged = self.conn.execute(
                "UPDATE kition_fields SET is_primary = (id IS ?1) \
                 WHERE table_id = ?2 AND deleted_at IS NULL AND is_primary != (id IS ?1)",
                params![primary_id, table_id],
            )?;
            if flagged > 0 {
                self.out.schema.insert(table_id);
                self.schemas.remove(&table_id);
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Views.

    fn project_views(&mut self, plan: &Plan) -> Result<()> {
        if plan.views.is_empty() && plan.gone_views.is_empty() && self.reconcile.is_empty() {
            return Ok(());
        }
        // Live view rows linked to an object, by object id.
        let mut rows: HashMap<ObjectId, (i64, i64)> = HashMap::new();
        {
            let mut statement = self.conn.prepare_cached(
                "SELECT id, kdm_id, table_id FROM kition_views WHERE deleted_at IS NULL AND kdm_id IS NOT NULL",
            )?;
            let found = statement.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for item in found {
                let (id, kdm, table) = item?;
                rows.insert(ObjectId::from_string(kdm), (id, table));
            }
        }
        let reconciled: HashSet<i64> = self
            .reconcile
            .iter()
            .filter_map(|table| self.table_ids.get(table).copied())
            .collect();
        let mut doomed: Vec<i64> = plan.gone_views.clone();
        for (kdm, (id, table)) in &rows {
            let listed_in = self
                .view_table
                .get(kdm)
                .and_then(|table| self.table_ids.get(table))
                .copied();
            let unlisted = listed_in.is_none() && (plan.views.contains(kdm) || plan.full);
            let left = reconciled.contains(table) && listed_in != Some(*table);
            if unlisted || left {
                doomed.push(*id);
            }
        }
        for id in &doomed {
            let count = self.conn.execute(
                "UPDATE kition_views SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![self.now, id],
            )?;
            if count > 0 {
                self.out.views.insert(*id);
            }
        }
        let doomed: HashSet<i64> = doomed.into_iter().collect();
        rows.retain(|_, (id, _)| !doomed.contains(id));

        let mut targets: Vec<(ObjectId, ObjectId, i64)> = Vec::new();
        for table in &self.tables {
            let Some(table_id) = self.table_ids.get(table).copied() else {
                continue;
            };
            let reconciled = self.reconcile.contains(table);
            for view in self.table_views.get(table).into_iter().flatten() {
                if self.view_table.get(view) != Some(table) {
                    continue;
                }
                if plan.full
                    || plan.views.contains(view)
                    || (reconciled && !rows.contains_key(view))
                {
                    targets.push((view.clone(), table.clone(), table_id));
                }
            }
        }
        let mut fresh: HashSet<i64> = HashSet::new();
        for (view, table, table_id) in &targets {
            let data = read_view(self.replica, view)?;
            let config = json_text(&data.config);
            let id = match rows.get(view) {
                Some((id, _)) => {
                    let updated = self
                        .conn
                        .prepare_cached(
                            "UPDATE kition_views SET table_id = ?1, title = ?2, type = ?3, locked = ?4, config_json = ?5, updated_at = ?6 \
                             WHERE id = ?7 AND (table_id != ?1 OR title != ?2 OR type != ?3 OR locked != ?4 OR config_json != ?5)",
                        )?
                        .execute(params![table_id, data.title, data.view_type, data.locked, config, self.now, id])?;
                    if updated > 0 {
                        self.out.views.insert(*id);
                    }
                    *id
                }
                None => {
                    let id = match latest_row(self.conn, "kition_views", view.as_str())? {
                        Some(id) => {
                            self.conn.execute(
                                "UPDATE kition_views SET document_id = ?1, table_id = ?2, title = ?3, type = ?4, \
                                 locked = ?5, config_json = ?6, updated_at = ?7, deleted_at = NULL WHERE id = ?8",
                                params![self.document_id, table_id, data.title, data.view_type, data.locked, config, self.now, id],
                            )?;
                            id
                        }
                        None => {
                            self.conn.execute(
                                "INSERT INTO kition_views (document_id, table_id, title, type, position, locked, config_json, created_at, updated_at, kdm_id) \
                                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?7, ?8)",
                                params![self.document_id, table_id, data.title, data.view_type, data.locked, config, self.now, view.as_str()],
                            )?;
                            self.conn.last_insert_rowid()
                        }
                    };
                    rows.insert(view.clone(), (id, *table_id));
                    self.out.views.insert(id);
                    fresh.insert(id);
                    id
                }
            };
            // Column layout: a row per field of the table with a width or a visibility.
            let fields: HashSet<&str> = self
                .table_fields
                .get(table)
                .into_iter()
                .flatten()
                .map(ObjectId::as_str)
                .collect();
            let mut keys: BTreeSet<&String> = data.widths.keys().collect();
            keys.extend(data.hidden.keys());
            let layout: Vec<(ObjectId, i64, bool)> = keys
                .into_iter()
                .filter(|field| fields.contains(field.as_str()))
                .map(|field| {
                    (
                        ObjectId::from_string(field.clone()),
                        data.widths.get(field).copied().unwrap_or(180),
                        !data.hidden.get(field).copied().unwrap_or(false),
                    )
                })
                .collect();
            for (field, width, visible) in layout {
                let Some(field_id) = self.field_ids()?.get(&field).copied() else {
                    continue;
                };
                let written = self
                    .conn
                    .prepare_cached(
                        "INSERT INTO kition_view_fields (view_id, field_id, visible, width, position, frozen, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?5) \
                         ON CONFLICT(view_id, field_id) DO UPDATE SET visible = excluded.visible, width = excluded.width, \
                         updated_at = excluded.updated_at WHERE visible != excluded.visible OR width != excluded.width",
                    )?
                    .execute(params![id, field_id, visible, width, self.now])?;
                if written > 0 {
                    self.out.views.insert(id);
                }
            }
        }
        for table in &self.reconcile {
            let ids: Vec<i64> = self
                .table_views
                .get(table)
                .into_iter()
                .flatten()
                .filter_map(|view| rows.get(view).map(|(id, _)| *id))
                .collect();
            for id in self.place_rows("kition_views", &ids, &fresh)? {
                self.out.views.insert(id);
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Records.

    fn project_records(&mut self, plan: &mut Plan) -> Result<()> {
        for id in plan.gone_records.clone() {
            self.delete_record(id)?;
        }
        let reconcile: Vec<ObjectId> = self.reconcile.iter().cloned().collect();
        for table in reconcile {
            self.reconcile_records(&table, plan)?;
        }
        let records: Vec<ObjectId> = plan.records.iter().cloned().collect();
        for record in records {
            let row: Option<(i64, i64, String)> = self
                .conn
                .prepare_cached(
                    "SELECT id, table_id, values_json FROM kition_records WHERE row_key = ?1 AND deleted_at IS NULL",
                )?
                .query_row([record.as_str()], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .optional()?;
            let Some((id, table_id, before)) = row else {
                continue;
            };
            self.touched.insert(id);
            if !self.history || self.created.contains(&id) {
                if self.history {
                    self.write_create_history(id, table_id, &record)?;
                }
                self.seed(id, Seed::All);
                continue;
            }
            let changed = self.write_cell_history(id, table_id, &record, &before)?;
            if !changed.is_empty() {
                self.seed(id, Seed::Names(changed));
            }
        }
        Ok(())
    }

    /// Inserts, revives, and deletes a table's record rows to match its list, and positions them.
    fn reconcile_records(&mut self, table: &ObjectId, plan: &mut Plan) -> Result<()> {
        let Some(table_id) = self.table_ids.get(table).copied() else {
            return Ok(());
        };
        let listed = live(self.replica, table, "records")?;
        let mut existing: HashMap<String, (i64, i64)> = HashMap::with_capacity(listed.len());
        {
            let mut statement = self.conn.prepare_cached(
                "SELECT row_key, id, position FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL",
            )?;
            let rows = statement.query_map([table_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
            })?;
            for row in rows {
                let (key, id, position) = row?;
                existing.insert(key, (id, position));
            }
        }
        let current: Vec<Option<i64>> = listed
            .iter()
            .map(|record| existing.get(record.as_str()).map(|(_, position)| *position))
            .collect();
        let placed = place(&current);
        let mut reordered = false;
        for ((record, before), position) in listed.iter().zip(&current).zip(placed) {
            match existing.remove(record.as_str()) {
                Some((id, _)) => {
                    if *before != Some(position) {
                        self.conn
                            .prepare_cached(
                                "UPDATE kition_records SET position = ?1 WHERE id = ?2",
                            )?
                            .execute(params![position, id])?;
                        reordered = true;
                    }
                    if plan.full {
                        plan.records.insert(record.clone());
                    }
                }
                None => {
                    let id = self.revive_or_insert_record(record, table_id, position)?;
                    self.created.insert(id);
                    plan.records.insert(record.clone());
                    self.out.upserted.insert((table_id, record.to_string()));
                }
            }
        }
        for (_, (id, _)) in existing {
            self.delete_record(id)?;
        }
        if reordered {
            self.out.reordered.insert(table_id);
        }
        Ok(())
    }

    fn revive_or_insert_record(
        &self,
        record: &ObjectId,
        table_id: i64,
        position: i64,
    ) -> Result<i64> {
        let created_at = self
            .replica
            .get(record, "createdAt")?
            .as_i64()
            .unwrap_or(self.now);
        let created_by = self
            .replica
            .get(record, "createdBy")?
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let existing: Option<i64> = self
            .conn
            .prepare_cached("SELECT id FROM kition_records WHERE row_key = ?1")?
            .query_row([record.as_str()], |row| row.get(0))
            .optional()?;
        if let Some(id) = existing {
            self.conn
                .prepare_cached(
                    "UPDATE kition_records SET document_id = ?1, table_id = ?2, position = ?3, values_json = '{}', \
                     created_by = ?4, updated_by = ?5, created_at = ?6, updated_at = ?7, deleted_at = NULL WHERE id = ?8",
                )?
                .execute(params![self.document_id, table_id, position, created_by, self.actor, created_at, self.now, id])?;
            return Ok(id);
        }
        self.conn
            .prepare_cached(
                "INSERT INTO kition_records (document_id, table_id, row_key, position, values_json, created_by, updated_by, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?6, ?7, ?8)",
            )?
            .execute(params![self.document_id, table_id, record.as_str(), position, created_by, self.actor, created_at, self.now])?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Soft-deletes a live record row, drops its links, and seeds the records that linked to it.
    /// Positions of the other records stay.
    fn delete_record(&mut self, id: i64) -> Result<()> {
        let row: Option<(i64, String, String)> = self
            .conn
            .prepare_cached(
                "SELECT table_id, row_key, values_json FROM kition_records WHERE id = ?1 AND deleted_at IS NULL",
            )?
            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .optional()?;
        let Some((table_id, key, values)) = row else {
            return Ok(());
        };
        let linkers: Vec<(i64, i64)> = {
            let mut statement = self.conn.prepare_cached(
                "SELECT DISTINCT from_record_id, from_field_id FROM kition_record_links WHERE to_table_id = ?1 AND to_record_id = ?2",
            )?;
            statement
                .query_map(params![table_id, id], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        for (record, link) in linkers {
            if record != id {
                self.seed(record, Seed::Link(link));
            }
        }
        self.conn
            .prepare_cached(
                "UPDATE kition_records SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            )?
            .execute(params![self.now, id])?;
        self.conn
            .prepare_cached(
                "DELETE FROM kition_record_links WHERE from_record_id = ?1 OR to_record_id = ?1",
            )?
            .execute([id])?;
        if self.history {
            insert_history(
                self.conn,
                &HistoryWrite {
                    document_id: &self.document_id,
                    table_id,
                    record_id: id,
                    field_id: None,
                    action: HistoryAction::Delete,
                    before: Value::Object(json::object(&values)),
                    after: Value::Null,
                    actor: self.actor,
                },
                self.now,
            )?;
        }
        self.out.deleted.insert((table_id, key));
        Ok(())
    }

    fn write_create_history(&mut self, id: i64, table_id: i64, record: &ObjectId) -> Result<()> {
        let schema = self.schema(table_id)?;
        let cells = self.stored_values(&schema, record)?;
        insert_history(
            self.conn,
            &HistoryWrite {
                document_id: &self.document_id,
                table_id,
                record_id: id,
                field_id: None,
                action: HistoryAction::Create,
                before: Value::Null,
                after: Value::Object(cells),
                actor: self.actor,
            },
            self.now,
        )
    }

    /// One history row per stored cell that differs from the row being replaced. Answers the
    /// names of those cells.
    fn write_cell_history(
        &mut self,
        id: i64,
        table_id: i64,
        record: &ObjectId,
        before: &str,
    ) -> Result<HashSet<String>> {
        let schema = self.schema(table_id)?;
        let cells = self.stored_values(&schema, record)?;
        let before = json::object(before);
        let mut changed = HashSet::new();
        for (name, field_id) in &schema.stored_by_name {
            let old = before.get(name).unwrap_or(&Value::Null);
            let new = cells.get(name).unwrap_or(&Value::Null);
            if json::equal(old, new) {
                continue;
            }
            changed.insert(name.clone());
            insert_history(
                self.conn,
                &HistoryWrite {
                    document_id: &self.document_id,
                    table_id,
                    record_id: id,
                    field_id: Some(*field_id),
                    action: HistoryAction::Update,
                    before: old.clone(),
                    after: new.clone(),
                    actor: self.actor,
                },
                self.now,
            )?;
        }
        Ok(changed)
    }

    fn schema(&mut self, table_id: i64) -> Result<Rc<TableSchema>> {
        if let Some(schema) = self.schemas.get(&table_id) {
            return Ok(Rc::clone(schema));
        }
        let mut statement = self.conn.prepare_cached(&format!(
            "SELECT {FIELD_COLUMNS}, kdm_id FROM kition_fields WHERE table_id = ?1 AND deleted_at IS NULL \
             ORDER BY position ASC, id ASC"
        ))?;
        let rows = statement.query_map([table_id], |row| {
            Ok((field_from_row(row)?, row.get::<_, Option<String>>(17)?))
        })?;
        let mut fields = Vec::new();
        let mut stored = HashMap::new();
        let mut stored_by_name = Vec::new();
        for row in rows {
            let (field, kdm) = row?;
            if !is_computed(&field.field_type)
                && let Some(kdm) = kdm
            {
                stored.insert(kdm, field.name.clone());
                stored_by_name.push((field.name.clone(), field.id));
            }
            fields.push(field);
        }
        stored_by_name.sort();
        let forward_formulas = fields
            .iter()
            .position(|field| field.field_type == "formula")
            .is_some_and(|first| {
                fields
                    .iter()
                    .skip(first)
                    .any(|field| is_derived_type(&field.field_type))
            });
        let schema = Rc::new(TableSchema {
            fields,
            stored,
            stored_by_name,
            forward_formulas,
        });
        self.schemas.insert(table_id, Rc::clone(&schema));
        Ok(schema)
    }

    /// A record's stored cells by field name.
    fn stored_values(&self, schema: &TableSchema, record: &ObjectId) -> Result<Map<String, Value>> {
        let mut values = Map::new();
        let Ok(cells) = self.replica.map_entries(record, "cells") else {
            return Ok(values);
        };
        for (key, value) in cells {
            if let Some(name) = schema.stored.get(&key) {
                values.insert(name.clone(), value);
            }
        }
        Ok(values)
    }

    // -----------------------------------------------------------------------
    // Links.

    fn project_links(&mut self, plan: &Plan) -> Result<()> {
        let scan = plan.full || !self.link_fields.is_empty();
        if plan.links.is_empty() && plan.gone_links.is_empty() && !scan {
            return Ok(());
        }
        let mut groups: BTreeSet<(ObjectId, ObjectId)> = BTreeSet::new();
        let mut changed: HashMap<(ObjectId, ObjectId), Vec<LinkData>> = HashMap::new();
        for link in &plan.links {
            let data = read_link(self.replica, link)?;
            groups.insert((data.from.clone(), data.field.clone()));
            changed
                .entry((data.from.clone(), data.field.clone()))
                .or_default()
                .push(data);
        }
        for id in &plan.gone_links {
            if let Some(group) = self.delete_link_row(*id)? {
                groups.insert(group);
            }
        }
        // A full projection or a link field's new options: the links readers show, from one
        // scan of the document.
        let mut shown: HashMap<(ObjectId, ObjectId), Vec<LinkData>> = HashMap::new();
        if scan {
            for link in self.view.links()? {
                if plan.full || self.link_fields.contains(&link.field) {
                    groups.insert((link.from.clone(), link.field.clone()));
                    shown
                        .entry((link.from.clone(), link.field.clone()))
                        .or_default()
                        .push(link);
                }
            }
        }
        if plan.full {
            // Rows of links that are gone or not shown.
            let keep: HashSet<String> = shown
                .values()
                .flatten()
                .map(|link| link.id.to_string())
                .collect();
            let mut doomed = Vec::new();
            {
                let mut statement = self.conn.prepare_cached(
                    "SELECT id, kdm_id FROM kition_record_links WHERE kdm_id IS NOT NULL",
                )?;
                let rows = statement.query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?;
                for row in rows {
                    let (id, kdm) = row?;
                    if !keep.contains(&kdm) {
                        doomed.push(id);
                    }
                }
            }
            for id in doomed {
                if let Some(group) = self.delete_link_row(id)? {
                    groups.insert(group);
                }
            }
        }
        for field in self.link_fields.clone() {
            let Some(field_id) = self.field_ids()?.get(&field).copied() else {
                continue;
            };
            let mut statement = self.conn.prepare_cached(
                "SELECT DISTINCT r.row_key FROM kition_record_links l JOIN kition_records r ON r.id = l.from_record_id \
                 WHERE l.from_field_id = ?1",
            )?;
            for key in statement.query_map([field_id], |row| row.get::<_, String>(0))? {
                groups.insert((ObjectId::from_string(key?), field.clone()));
            }
        }
        for (from, field) in groups {
            let key = (from.clone(), field.clone());
            let wanted = match shown.remove(&key) {
                Some(links) => links,
                None if plan.full || self.link_fields.contains(&field) => Vec::new(),
                None => self.group_links(&from, &field, changed.get(&key))?,
            };
            self.reconcile_links(&from, &field, &wanted)?;
        }
        Ok(())
    }

    /// The links readers show for one `(from record, field)`, from the group's projected rows
    /// and its changed links, without scanning the document: ends that are live rows, once per
    /// target, one for a single-target field, lowest id first.
    fn group_links(
        &mut self,
        from: &ObjectId,
        field: &ObjectId,
        changed: Option<&Vec<LinkData>>,
    ) -> Result<Vec<LinkData>> {
        let mut candidates: Vec<LinkData> = changed.cloned().unwrap_or_default();
        if let (Some((from_id, _)), Some(field_id)) = (
            self.live_record(from)?,
            self.field_ids()?.get(field).copied(),
        ) {
            let mut statement = self.conn.prepare_cached(
                "SELECT kdm_id FROM kition_record_links WHERE from_record_id = ?1 AND from_field_id = ?2 AND kdm_id IS NOT NULL",
            )?;
            let ids = statement
                .query_map(params![from_id, field_id], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for id in ids {
                let id = ObjectId::from_string(id);
                if self.replica.object_type(&id).is_ok_and(|ty| ty == LINK) {
                    candidates.push(read_link(self.replica, &id)?);
                }
            }
        }
        candidates.sort_by(|a, b| a.id.cmp(&b.id));
        candidates.dedup_by(|a, b| a.id == b.id);
        let single = self
            .replica
            .get(field, "options")
            .ok()
            .and_then(|options| options.get("allow_multiple").cloned())
            == Some(Value::Bool(false));
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for link in candidates {
            if link.from != *from || link.field != *field {
                continue;
            }
            if self.live_record(&link.to)?.is_none() || !seen.insert(link.to.clone()) {
                continue;
            }
            out.push(link);
            if single {
                break;
            }
        }
        Ok(out)
    }

    /// Deletes a link row and seeds its source record. Answers the row's `(from record, field)`
    /// as object ids, so the group is reconciled too.
    fn delete_link_row(&mut self, id: i64) -> Result<Option<(ObjectId, ObjectId)>> {
        let row: Option<(i64, i64, String, Option<String>)> = self
            .conn
            .prepare_cached(
                "SELECT l.from_record_id, l.from_field_id, r.row_key, f.kdm_id FROM kition_record_links l \
                 JOIN kition_records r ON r.id = l.from_record_id JOIN kition_fields f ON f.id = l.from_field_id \
                 WHERE l.id = ?1",
            )?
            .query_row([id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .optional()?;
        self.conn
            .prepare_cached("DELETE FROM kition_record_links WHERE id = ?1")?
            .execute([id])?;
        let Some((from_id, field_id, from, field)) = row else {
            return Ok(None);
        };
        self.seed(from_id, Seed::Link(field_id));
        Ok(field.map(|field| (ObjectId::from_string(from), ObjectId::from_string(field))))
    }

    /// Makes one record's link rows of one field the links readers show, in their order: new
    /// links are appended when they come after the kept ones, else the rows are rewritten.
    fn reconcile_links(
        &mut self,
        from: &ObjectId,
        field: &ObjectId,
        wanted: &[LinkData],
    ) -> Result<()> {
        let Some((from_id, from_table)) = self.live_record(from)? else {
            return Ok(());
        };
        let Some(field_id) = self.field_ids()?.get(field).copied() else {
            return Ok(());
        };
        let mut targets: Vec<(String, i64, i64)> = Vec::with_capacity(wanted.len());
        for link in wanted {
            if let Some((to_id, to_table)) = self.live_record(&link.to)? {
                targets.push((link.id.to_string(), to_id, to_table));
            }
        }
        let existing: Vec<(i64, Option<String>)> = {
            let mut statement = self.conn.prepare_cached(
                "SELECT id, kdm_id FROM kition_record_links WHERE from_record_id = ?1 AND from_field_id = ?2 ORDER BY id ASC",
            )?;
            statement
                .query_map(params![from_id, field_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let same = existing.len() == targets.len()
            && existing
                .iter()
                .zip(&targets)
                .all(|((_, kdm), (wanted, _, _))| kdm.as_deref() == Some(wanted.as_str()));
        if same {
            return Ok(());
        }
        let wanted_ids: HashSet<&str> = targets.iter().map(|(kdm, _, _)| kdm.as_str()).collect();
        let kept: Vec<&str> = existing
            .iter()
            .filter_map(|(_, kdm)| kdm.as_deref().filter(|kdm| wanted_ids.contains(kdm)))
            .collect();
        let appendable = kept.len() <= targets.len()
            && kept
                .iter()
                .zip(&targets)
                .all(|(kept, (wanted, _, _))| *kept == wanted.as_str());
        let (remove, insert_from): (Vec<i64>, usize) = if appendable {
            (
                existing
                    .iter()
                    .filter(|(_, kdm)| kdm.as_deref().is_none_or(|kdm| !wanted_ids.contains(kdm)))
                    .map(|(id, _)| *id)
                    .collect(),
                kept.len(),
            )
        } else {
            (existing.iter().map(|(id, _)| *id).collect(), 0)
        };
        for id in remove {
            self.conn
                .prepare_cached("DELETE FROM kition_record_links WHERE id = ?1")?
                .execute([id])?;
        }
        for (kdm, to_id, to_table) in targets.iter().skip(insert_from) {
            self.conn
                .prepare_cached(
                    "INSERT INTO kition_record_links (document_id, from_table_id, from_record_id, from_field_id, to_table_id, \
                     to_record_id, created_at, kdm_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )?
                .execute(params![self.document_id, from_table, from_id, field_id, to_table, to_id, self.now, kdm])?;
        }
        self.seed(from_id, Seed::Link(field_id));
        Ok(())
    }

    fn live_record(&self, record: &ObjectId) -> Result<Option<(i64, i64)>> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT id, table_id FROM kition_records WHERE row_key = ?1 AND deleted_at IS NULL",
            )?
            .query_row([record.as_str()], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?)
    }
}

fn is_derived_type(field_type: &str) -> bool {
    matches!(
        field_type,
        "formula" | "lookup" | "rollup" | "link_to_record"
    )
}

/// A `Link` object's ends.
fn read_link(replica: &Replica, id: &ObjectId) -> Result<LinkData> {
    let end = |name: &str| -> Result<ObjectId> {
        Ok(ObjectId::from_string(
            replica.get(id, name)?.as_str().unwrap_or_default(),
        ))
    };
    Ok(LinkData {
        id: id.clone(),
        from: end("from")?,
        field: end("field")?,
        to: end("to")?,
    })
}

/// A view's registers and column layout; widths and visibility keyed by field object id.
struct ViewRow {
    title: String,
    view_type: String,
    locked: bool,
    config: Value,
    widths: HashMap<String, i64>,
    hidden: HashMap<String, bool>,
}

/// Reads one view without building the document's record index (as [`ModelView::view`] does).
fn read_view(replica: &Replica, id: &ObjectId) -> Result<ViewRow> {
    let text = |field: &str| -> Result<String> {
        Ok(replica
            .get(id, field)?
            .as_str()
            .unwrap_or_default()
            .to_owned())
    };
    Ok(ViewRow {
        title: text("title")?,
        view_type: text("type")?,
        locked: replica.get(id, "locked")? == Value::Bool(true),
        config: replica.get(id, "config")?,
        widths: replica
            .map_entries(id, "widths")?
            .into_iter()
            .filter_map(|(key, value)| Some((key, value.as_i64()?)))
            .collect(),
        hidden: replica
            .map_entries(id, "hidden")?
            .into_iter()
            .filter_map(|(key, value)| Some((key, value.as_bool()?)))
            .collect(),
    })
}

/// The items of a list naming existing objects, first occurrence only, as readers see them.
fn live(replica: &Replica, id: &ObjectId, field: &str) -> Result<Vec<ObjectId>> {
    let mut seen = HashSet::new();
    Ok(replica
        .list(id, field)?
        .into_iter()
        .filter(|item| replica.exists(item) && seen.insert(item.clone()))
        .collect())
}

/// The id of the latest row, live or deleted, that projected the object `kdm_id`.
fn latest_row(conn: &Connection, table: &str, kdm_id: &str) -> Result<Option<i64>> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT id FROM {table} WHERE kdm_id = ?1 ORDER BY deleted_at IS NULL DESC, id DESC LIMIT 1"
        ))?
        .query_row([kdm_id], |row| row.get(0))
        .optional()?)
}

/// A JSON document column: `null` is `{}`.
fn json_text(value: &Value) -> String {
    if value.is_null() {
        "{}".to_owned()
    } else {
        value.to_string()
    }
}

/// A name no real table or field has, held while names are swapped.
fn temporary_name(id: &ObjectId) -> String {
    format!("~kdm~{id}")
}
