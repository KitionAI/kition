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
//! The projection is what the legacy write path writes, from the replica as [`ModelView`] reads
//! it:
//!
//! - Integer ids are local to the file. Rows are matched to objects by `kdm_id` (tables, fields,
//!   views, links) or `row_key` (records) and keep their id; a deleted row whose object comes back
//!   (an undo) is revived with its id; new objects get new ids.
//! - Positions are 1-based indexes of the live, distinct list items.
//! - Deletes are soft (`deleted_at`) except links, as in the legacy code. Deleting a table
//!   soft-deletes its fields, views, and records, without record history (as legacy
//!   `delete_table` does).
//! - Options name tables and fields by integer id ([`super::options::options_from_kdm`]): the id
//!   of the object's live row, else of its latest deleted row, else `null`.
//! - A record's `values_json` holds its stored cells by field name and its derived values
//!   (formula, lookup, rollup, `link_to_record` chips), computed by the legacy derivation over the
//!   projected rows. A record is recomputed when it changes, when its links change, when its
//!   table's fields change in a way that affects values, and when a record it links to changes
//!   value (transitively), so lookups and chips never go stale. Field types the legacy code does
//!   not derive (`auto_number`, created and last-modified time and by) have no value, as before.
//! - History: one `update` row per stored cell that changed, in field-name order, and the whole
//!   record on `create` and `delete`, with the caller's actor; before values come from the row
//!   being replaced. A rebuild writes no history.
//! - Dashboards are not relational; [`TableChange::dashboards`] says when they changed (the
//!   projected list of dashboards is kept in `kition_meta` to notice reorders).
//!
//! The projection expects a repaired replica ([`super::repair`]): table names and field names
//! unique, as the relational unique indexes require.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::rc::Rc;

use kition_kdm::{ObjectId, Replica};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use super::model::{BASE, DASHBOARD, FIELD, LINK, RECORD, TABLE, VIEW, is_computed};
use super::options::options_from_kdm;
use super::read::{LinkData, ModelView};
use crate::computed::Deriver;
use crate::history::{HistoryAction, HistoryWrite, insert_history};
use crate::source::{FIELD_COLUMNS, Field, field_from_row};
use crate::{KitableError, Result, file, json};

/// What one projection changed in the relational tables, by integer id. Every list is sorted and
/// holds no repeats.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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
pub fn project_changes(
    conn: &Connection,
    replica: &Replica,
    changed: &BTreeSet<ObjectId>,
    actor: &str,
    now: i64,
) -> Result<TableChange> {
    let mut projector = Projector::new(conn, replica, actor, now, false)?;
    let plan = projector.classify(changed)?;
    projector.run(plan)?;
    Ok(projector.out.finish())
}

/// Projects the whole replica, inside the caller's SQL transaction: afterwards the relational
/// tables hold exactly what [`project_changes`] would have written from an empty file, with the
/// ids of rows that already existed kept, and rows of objects that are gone deleted. Writes no
/// history. Does not record the projected position.
pub fn rebuild(conn: &Connection, replica: &Replica, now: i64) -> Result<()> {
    let mut projector = Projector::new(conn, replica, "", now, true)?;
    let plan = Projector::everything();
    projector.run(plan)?;
    Ok(())
}

/// Each record is recomputed at most this many times per projection, which bounds lookups that
/// feed each other in a cycle.
const MAX_RECOMPUTES: u32 = 8;

const DASHBOARDS_KEY: &str = "kdm_projected_dashboards";

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
struct TableSchema {
    fields: Vec<Field>,
    /// Stored (not computed) fields: name by object id.
    stored: HashMap<String, String>,
    /// Stored fields `(name, id)` in name order, for history.
    stored_by_name: Vec<(String, i64)>,
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
    /// Tables whose primary field changed: records linking to them are recomputed.
    primary_changed: BTreeSet<i64>,
    /// Link fields whose options changed: their links are reconciled.
    link_fields: BTreeSet<ObjectId>,
    /// Records to recompute, in order.
    seeds: Vec<i64>,
    /// Records created or revived by this projection.
    created: HashSet<i64>,
    /// Records whose object changed.
    touched: HashSet<i64>,
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
            primary_changed: BTreeSet::new(),
            link_fields: BTreeSet::new(),
            seeds: Vec::new(),
            created: HashSet::new(),
            touched: HashSet::new(),
        })
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
                BASE => plan.base = true,
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

    /// A plan covering the whole replica.
    fn everything() -> Plan {
        Plan {
            full: true,
            base: true,
            dashboards: true,
            ..Plan::default()
        }
    }

    fn run(&mut self, mut plan: Plan) -> Result<()> {
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
        self.project_primary_fields(&plan)?;
        self.project_views(&plan)?;
        self.project_records(&mut plan)?;
        self.project_links(&plan)?;
        self.derive()
    }

    fn load_structure(&mut self) -> Result<()> {
        if let Some(base) = self.view.base() {
            self.tables = live(self.replica, &base, "tables")?;
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
        let Some(base) = self.view.base_data()? else {
            return Ok(());
        };
        let meta = json_text(&base.meta);
        let current: Option<(String, String, String, String, String, bool)> = self
            .conn
            .query_row(
                "SELECT title, description, icon, color, meta_json, deleted_at IS NULL FROM kition_documents WHERE id = ?1",
                [&self.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .optional()?;
        let wanted = (
            base.title.clone(),
            base.description.clone(),
            base.icon.clone(),
            base.color.clone(),
            meta.clone(),
            true,
        );
        match current {
            Some(current) if current == wanted => {}
            Some(_) => {
                self.conn.execute(
                    "UPDATE kition_documents SET title = ?1, description = ?2, icon = ?3, color = ?4, meta_json = ?5, \
                     updated_at = ?6, deleted_at = NULL WHERE id = ?7",
                    params![base.title, base.description, base.icon, base.color, meta, self.now, self.document_id],
                )?;
            }
            None => {
                self.conn.execute(
                    "INSERT INTO kition_documents (id, title, description, icon, color, meta_json, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                    params![self.document_id, base.title, base.description, base.icon, base.color, meta, self.now],
                )?;
            }
        }
        Ok(())
    }

    /// Compares the base's dashboards with the list last projected.
    fn check_dashboards(&mut self) -> Result<()> {
        let listed: Vec<String> = match self.view.base() {
            Some(base) => live(self.replica, &base, "dashboards")?
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
        let listed: HashMap<ObjectId, usize> = self
            .tables
            .iter()
            .enumerate()
            .map(|(index, id)| (id.clone(), index))
            .collect();
        let mut doomed: BTreeSet<i64> = plan.gone_tables.iter().copied().collect();
        for table in &plan.tables {
            if !listed.contains_key(table)
                && let Some(id) = self.table_ids.get(table)
            {
                doomed.insert(*id);
            }
        }
        if plan.base {
            for (kdm, id) in &self.table_ids {
                if !listed.contains_key(kdm) {
                    doomed.insert(*id);
                }
            }
        }
        if plan.full {
            let mut statement = self.conn.prepare_cached(
                "SELECT id FROM kition_tables WHERE deleted_at IS NULL AND kdm_id IS NULL",
            )?;
            for id in statement.query_map([], |row| row.get::<_, i64>(0))? {
                doomed.insert(id?);
            }
        }
        for id in doomed {
            self.delete_table(id)?;
        }
        self.table_ids.retain(|kdm, _| listed.contains_key(kdm));

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
        for table in &data {
            let position = listed.get(&table.id).map_or(0, |index| *index as i64 + 1);
            let meta = json_text(&table.meta);
            let id = match self.table_ids.get(&table.id) {
                Some(id) => *id,
                None => {
                    let id = self.revive_or_insert_table(table, position, &meta)?;
                    self.table_ids.insert(table.id.clone(), id);
                    self.out.tables.insert(id);
                    self.reconcile.insert(table.id.clone());
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
        if plan.base || !self.reconcile.is_empty() {
            for (index, table) in self.tables.iter().enumerate() {
                let Some(id) = self.table_ids.get(table) else {
                    continue;
                };
                let moved = self
                    .conn
                    .prepare_cached(
                        "UPDATE kition_tables SET position = ?1 WHERE id = ?2 AND position != ?1",
                    )?
                    .execute(params![index as i64 + 1, id])?;
                if moved > 0 {
                    self.out.tables.insert(*id);
                }
            }
        }
        Ok(())
    }

    fn revive_or_insert_table(
        &self,
        table: &super::read::TableData,
        position: i64,
        meta: &str,
    ) -> Result<i64> {
        if let Some(id) = latest_row(self.conn, "kition_tables", table.id.as_str())? {
            self.conn.execute(
                "UPDATE kition_tables SET document_id = ?1, name = ?2, title = ?3, description = ?4, position = ?5, \
                 meta_json = ?6, updated_at = ?7, deleted_at = NULL WHERE id = ?8",
                params![self.document_id, table.name, table.title, table.description, position, meta, self.now, id],
            )?;
            return Ok(id);
        }
        self.conn.execute(
            "INSERT INTO kition_tables (document_id, name, title, description, position, meta_json, created_at, updated_at, kdm_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
            params![self.document_id, table.name, table.title, table.description, position, meta, self.now, table.id.as_str()],
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
        let mut statement = self.conn.prepare(
            "SELECT DISTINCT from_record_id FROM kition_record_links WHERE to_table_id = ?1 AND from_table_id != ?1",
        )?;
        for record in statement.query_map([id], |row| row.get::<_, i64>(0))? {
            self.seeds.push(record?);
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
        // Live field rows of the document, by object id.
        let mut rows: HashMap<ObjectId, FieldRow> = HashMap::new();
        let mut unlinked: Vec<(i64, i64)> = Vec::new();
        {
            let mut statement = self.conn.prepare_cached(
                "SELECT id, kdm_id, table_id, name, title, type, required, readonly, options_json, formula, ai_prompt, meta_json \
                 FROM kition_fields WHERE deleted_at IS NULL",
            )?;
            let found = statement.query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(1)?,
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
                match kdm {
                    Some(kdm) => {
                        rows.insert(ObjectId::from_string(kdm), row);
                    }
                    None => unlinked.push((row.id, row.table_id)),
                }
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
        if plan.full {
            doomed.extend(unlinked.iter().copied());
        } else {
            doomed.extend(
                unlinked
                    .iter()
                    .filter(|(_, table)| reconciled.contains(table))
                    .copied(),
            );
        }
        for (id, table) in &doomed {
            let count = self.conn.execute(
                "UPDATE kition_fields SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![self.now, id],
            )?;
            if count > 0 {
                self.field_changed(*table, true);
            }
        }
        let doomed_ids: HashSet<i64> = doomed.iter().map(|(id, _)| *id).collect();
        rows.retain(|_, row| !doomed_ids.contains(&row.id));

        // Targets: changed listed fields, and listed fields of reconciled tables without a row.
        let mut targets: Vec<(ObjectId, i64, i64)> = Vec::new();
        for table in &self.tables {
            let Some(table_id) = self.table_ids.get(table).copied() else {
                continue;
            };
            let reconciled = self.reconcile.contains(table);
            for (index, field) in self
                .table_fields
                .get(table)
                .into_iter()
                .flatten()
                .enumerate()
            {
                if self.field_table.get(field) != Some(table) {
                    continue;
                }
                if plan.full
                    || plan.fields.contains(field)
                    || (reconciled && !rows.contains_key(field))
                {
                    targets.push((field.clone(), table_id, index as i64 + 1));
                }
            }
        }
        let mut data = Vec::with_capacity(targets.len());
        for (field, _, _) in &targets {
            data.push(self.view.field(field)?);
        }
        // Names are unique per table: move renamed rows out of the way first.
        for ((field, table_id, _), wanted) in targets.iter().zip(&data) {
            if let Some(row) = rows.get(field)
                && (row.name != wanted.name || row.table_id != *table_id)
            {
                self.conn
                    .prepare_cached("UPDATE kition_fields SET name = ?1 WHERE id = ?2")?
                    .execute(params![temporary_name(field), row.id])?;
            }
        }
        // New rows first, so options can name them.
        for ((field, table_id, position), wanted) in targets.iter().zip(&data) {
            if rows.contains_key(field) {
                continue;
            }
            let id = self.revive_or_insert_field(field, *table_id, *position, wanted)?;
            self.field_changed(*table_id, true);
            rows.insert(
                field.clone(),
                FieldRow {
                    id,
                    table_id: *table_id,
                    name: wanted.name.clone(),
                    title: String::new(),
                    field_type: String::new(),
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
        for ((field, table_id, _), wanted) in targets.iter().zip(&data) {
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
            let affects_values = row.table_id != *table_id
                || row.name != wanted.name
                || row.field_type != wanted.field_type
                || row.options_json != options_json
                || row.formula != wanted.formula;
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
            if wanted.field_type == "link_to_record" || row.field_type == "link_to_record" {
                self.link_fields.insert(field.clone());
            }
        }
        // Positions follow each reconciled table's list; the order of derivation follows them.
        let reconcile: Vec<ObjectId> = self.reconcile.iter().cloned().collect();
        for table in reconcile {
            let Some(table_id) = self.table_ids.get(&table).copied() else {
                continue;
            };
            let fields = self.table_fields.get(&table).cloned().unwrap_or_default();
            let mut moved = false;
            for (index, field) in fields.iter().enumerate() {
                let Some(id) = field_ids.get(field) else {
                    continue;
                };
                moved |= self
                    .conn
                    .prepare_cached(
                        "UPDATE kition_fields SET position = ?1 WHERE id = ?2 AND position != ?1",
                    )?
                    .execute(params![index as i64 + 1, id])?
                    > 0;
            }
            if moved {
                self.field_changed(table_id, true);
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

    fn revive_or_insert_field(
        &self,
        field: &ObjectId,
        table_id: i64,
        position: i64,
        wanted: &super::read::FieldData,
    ) -> Result<i64> {
        if let Some(id) = latest_row(self.conn, "kition_fields", field.as_str())? {
            self.conn.execute(
                "UPDATE kition_fields SET table_id = ?1, name = ?2, position = ?3, options_json = '', updated_at = ?4, \
                 deleted_at = NULL WHERE id = ?5",
                params![table_id, wanted.name, position, self.now, id],
            )?;
            return Ok(id);
        }
        // Everything but the name and position is written by the update that follows.
        self.conn.execute(
            "INSERT INTO kition_fields (document_id, table_id, name, title, type, position, options_json, created_at, updated_at, kdm_id) \
             VALUES (?1, ?2, ?3, '', '', ?4, '', ?5, ?5, ?6)",
            params![self.document_id, table_id, wanted.name, position, self.now, field.as_str()],
        )?;
        Ok(self.conn.last_insert_rowid())
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
        // Live view rows of the reconciled tables and of the changed views, by object id.
        let mut rows: HashMap<ObjectId, (i64, i64)> = HashMap::new();
        let mut unlinked: Vec<(i64, i64)> = Vec::new();
        {
            let mut statement = self.conn.prepare_cached(
                "SELECT id, kdm_id, table_id FROM kition_views WHERE deleted_at IS NULL",
            )?;
            let found = statement.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for item in found {
                let (id, kdm, table) = item?;
                match kdm {
                    Some(kdm) => {
                        rows.insert(ObjectId::from_string(kdm), (id, table));
                    }
                    None => unlinked.push((id, table)),
                }
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
        doomed.extend(
            unlinked
                .iter()
                .filter(|(_, table)| plan.full || reconciled.contains(table))
                .map(|(id, _)| *id),
        );
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

        let mut targets: Vec<(ObjectId, ObjectId, i64, i64)> = Vec::new();
        for table in &self.tables {
            let Some(table_id) = self.table_ids.get(table).copied() else {
                continue;
            };
            let reconciled = self.reconcile.contains(table);
            for (index, view) in self
                .table_views
                .get(table)
                .into_iter()
                .flatten()
                .enumerate()
            {
                if self.view_table.get(view) != Some(table) {
                    continue;
                }
                if plan.full
                    || plan.views.contains(view)
                    || (reconciled && !rows.contains_key(view))
                {
                    targets.push((view.clone(), table.clone(), table_id, index as i64 + 1));
                }
            }
        }
        for (view, table, table_id, position) in &targets {
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
                                "UPDATE kition_views SET document_id = ?1, table_id = ?2, title = ?3, type = ?4, position = ?5, \
                                 locked = ?6, config_json = ?7, updated_at = ?8, deleted_at = NULL WHERE id = ?9",
                                params![self.document_id, table_id, data.title, data.view_type, position, data.locked, config, self.now, id],
                            )?;
                            id
                        }
                        None => {
                            self.conn.execute(
                                "INSERT INTO kition_views (document_id, table_id, title, type, position, locked, config_json, created_at, updated_at, kdm_id) \
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
                                params![self.document_id, table_id, data.title, data.view_type, position, data.locked, config, self.now, view.as_str()],
                            )?;
                            self.conn.last_insert_rowid()
                        }
                    };
                    rows.insert(view.clone(), (id, *table_id));
                    self.out.views.insert(id);
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
            for (index, view) in self
                .table_views
                .get(table)
                .into_iter()
                .flatten()
                .enumerate()
            {
                let Some((id, _)) = rows.get(view) else {
                    continue;
                };
                let moved = self
                    .conn
                    .prepare_cached(
                        "UPDATE kition_views SET position = ?1 WHERE id = ?2 AND position != ?1",
                    )?
                    .execute(params![index as i64 + 1, id])?;
                if moved > 0 {
                    self.out.views.insert(*id);
                }
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
            if self.history {
                self.write_cell_history(id, table_id, &record, &before)?;
            }
            self.seeds.push(id);
        }
        Ok(())
    }

    /// Inserts, revives, deletes, and renumbers a table's record rows to match its list.
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
        let mut reordered = false;
        for (index, record) in listed.iter().enumerate() {
            let position = index as i64 + 1;
            match existing.remove(record.as_str()) {
                Some((id, current)) => {
                    if current != position {
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

    /// Soft-deletes a live record row, drops its links, and queues the records that linked to it.
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
        {
            let mut statement = self.conn.prepare_cached(
                "SELECT DISTINCT from_record_id FROM kition_record_links WHERE to_table_id = ?1 AND to_record_id = ?2",
            )?;
            for record in statement.query_map(params![table_id, id], |row| row.get::<_, i64>(0))? {
                let record = record?;
                if record != id {
                    self.seeds.push(record);
                }
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

    /// History of a changed record: the whole record when it was created, else one row per
    /// stored cell that differs from the row being replaced.
    fn write_cell_history(
        &mut self,
        id: i64,
        table_id: i64,
        record: &ObjectId,
        before: &str,
    ) -> Result<()> {
        let schema = self.schema(table_id)?;
        let cells = self.stored_values(&schema, record)?;
        if self.created.contains(&id) {
            return insert_history(
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
            );
        }
        let before = json::object(before);
        for (name, field_id) in &schema.stored_by_name {
            let old = before.get(name).unwrap_or(&Value::Null);
            let new = cells.get(name).unwrap_or(&Value::Null);
            if json::equal(old, new) {
                continue;
            }
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
        Ok(())
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
        let schema = Rc::new(TableSchema {
            fields,
            stored,
            stored_by_name,
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
        if plan.links.is_empty()
            && plan.gone_links.is_empty()
            && self.link_fields.is_empty()
            && !plan.full
        {
            return Ok(());
        }
        let mut groups: BTreeSet<(ObjectId, ObjectId)> = BTreeSet::new();
        for link in &plan.links {
            let end = |name: &str| -> Result<ObjectId> {
                Ok(ObjectId::from_string(
                    self.replica.get(link, name)?.as_str().unwrap_or_default(),
                ))
            };
            groups.insert((end("from")?, end("field")?));
        }
        for id in &plan.gone_links {
            if let Some(group) = self.delete_link_row(*id)? {
                groups.insert(group);
            }
        }
        let shown = self.view.links()?;
        let mut by_group: HashMap<(ObjectId, ObjectId), Vec<LinkData>> = HashMap::new();
        for link in shown {
            if plan.full || self.link_fields.contains(&link.field) {
                groups.insert((link.from.clone(), link.field.clone()));
            }
            by_group
                .entry((link.from.clone(), link.field.clone()))
                .or_default()
                .push(link);
        }
        if plan.full {
            // Rows of links that are gone or not shown.
            let keep: HashSet<String> = by_group
                .values()
                .flatten()
                .map(|link| link.id.to_string())
                .collect();
            let mut doomed = Vec::new();
            {
                let mut statement = self
                    .conn
                    .prepare_cached("SELECT id, kdm_id FROM kition_record_links")?;
                let rows = statement.query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
                })?;
                for row in rows {
                    let (id, kdm) = row?;
                    if kdm.is_none_or(|kdm| !keep.contains(&kdm)) {
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
        let empty = Vec::new();
        for (from, field) in groups {
            let wanted = by_group
                .get(&(from.clone(), field.clone()))
                .unwrap_or(&empty);
            self.reconcile_links(&from, &field, wanted)?;
        }
        Ok(())
    }

    /// Deletes a link row and queues its source record. Answers the row's `(from record, field)`
    /// as object ids, so the group is reconciled too.
    fn delete_link_row(&mut self, id: i64) -> Result<Option<(ObjectId, ObjectId)>> {
        let row: Option<(i64, String, Option<String>)> = self
            .conn
            .prepare_cached(
                "SELECT l.from_record_id, r.row_key, f.kdm_id FROM kition_record_links l \
                 JOIN kition_records r ON r.id = l.from_record_id JOIN kition_fields f ON f.id = l.from_field_id \
                 WHERE l.id = ?1",
            )?
            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .optional()?;
        self.conn
            .prepare_cached("DELETE FROM kition_record_links WHERE id = ?1")?
            .execute([id])?;
        let Some((from_id, from, field)) = row else {
            return Ok(None);
        };
        self.seeds.push(from_id);
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
        self.seeds.push(from_id);
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

    // -----------------------------------------------------------------------
    // Derived values.

    fn derive(&mut self) -> Result<()> {
        let mut queue: VecDeque<i64> = VecDeque::new();
        let mut queued: HashSet<i64> = HashSet::new();
        for id in std::mem::take(&mut self.seeds) {
            push(&mut queue, &mut queued, id);
        }
        for table in self.recompute_tables.clone() {
            let mut statement = self.conn.prepare_cached(
                "SELECT id FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position ASC, id ASC",
            )?;
            for id in statement.query_map([table], |row| row.get::<_, i64>(0))? {
                push(&mut queue, &mut queued, id?);
            }
        }
        for table in self.primary_changed.clone() {
            let mut statement = self.conn.prepare_cached(
                "SELECT DISTINCT from_record_id FROM kition_record_links WHERE to_table_id = ?1",
            )?;
            for id in statement.query_map([table], |row| row.get::<_, i64>(0))? {
                push(&mut queue, &mut queued, id?);
            }
        }
        let deriver = Deriver::new(self.conn, true);
        let mut runs: HashMap<i64, u32> = HashMap::new();
        while let Some(id) = queue.pop_front() {
            queued.remove(&id);
            let count = runs.entry(id).or_insert(0);
            *count += 1;
            if *count > MAX_RECOMPUTES {
                continue;
            }
            let row: Option<(i64, String, String)> = self
                .conn
                .prepare_cached(
                    "SELECT table_id, row_key, values_json FROM kition_records WHERE id = ?1 AND deleted_at IS NULL",
                )?
                .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .optional()?;
            let Some((table_id, key, current)) = row else {
                continue;
            };
            let schema = self.schema(table_id)?;
            let stored = self.stored_values(&schema, &ObjectId::from_string(key.clone()))?;
            let (values, _) = deriver.recompute(&schema.fields, id, &stored)?;
            let values = Value::Object(values);
            if json::equal(&Value::Object(json::object(&current)), &values) {
                if self.created.contains(&id) {
                    self.out.upserted.insert((table_id, key));
                }
                continue;
            }
            if self.touched.contains(&id) {
                self.conn
                    .prepare_cached(
                        "UPDATE kition_records SET values_json = ?1, updated_by = ?2, updated_at = ?3 WHERE id = ?4",
                    )?
                    .execute(params![values.to_string(), self.actor, self.now, id])?;
            } else {
                self.conn
                    .prepare_cached(
                        "UPDATE kition_records SET values_json = ?1, updated_at = ?2 WHERE id = ?3",
                    )?
                    .execute(params![values.to_string(), self.now, id])?;
            }
            self.out.upserted.insert((table_id, key));
            let mut statement = self.conn.prepare_cached(
                "SELECT DISTINCT from_record_id FROM kition_record_links WHERE to_table_id = ?1 AND to_record_id = ?2",
            )?;
            for linker in statement.query_map(params![table_id, id], |row| row.get::<_, i64>(0))? {
                push(&mut queue, &mut queued, linker?);
            }
        }
        Ok(())
    }
}

fn push(queue: &mut VecDeque<i64>, queued: &mut HashSet<i64>, id: i64) {
    if queued.insert(id) {
        queue.push_back(id);
    }
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
