//! Reads of the `kit.table` document: plain data with object ids.
//!
//! Readers skip what a merge can leave behind: list entries naming deleted objects, repeated
//! entries (the first counts; [`crate::kdm::repair`] never removes them), cells of deleted or
//! computed fields, links whose ends are gone or not listed, repeated links, and extra links of
//! single-target fields (the lowest id counts), so they show what repair will leave.

use std::cell::OnceCell;
use std::collections::{BTreeMap, HashMap, HashSet};

use kition_kdm::{ObjectId, Replica};
use serde_json::{Map, Value};

use super::model::{BASE, DASHBOARD, FIELD, LINK, RECORD, TABLE, VIEW, is_computed};
use crate::{KitableError, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct BaseData {
    pub id: ObjectId,
    pub title: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    /// `null` when unset.
    pub meta: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableData {
    pub id: ObjectId,
    pub name: String,
    pub title: String,
    pub description: String,
    /// `null` when unset.
    pub meta: Value,
    /// `None` when unset or naming a field that is gone.
    pub primary_field: Option<ObjectId>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FieldData {
    pub id: ObjectId,
    pub name: String,
    pub title: String,
    pub field_type: String,
    pub required: bool,
    pub readonly: bool,
    /// `null` when unset.
    pub options: Value,
    pub formula: String,
    pub ai_prompt: String,
    /// `null` when unset.
    pub meta: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ViewData {
    pub id: ObjectId,
    pub view_type: String,
    pub title: String,
    pub locked: bool,
    /// The UI's view configuration, keyed by field names; `null` when unset.
    pub config: Value,
    /// Column widths by field id.
    pub widths: BTreeMap<ObjectId, i64>,
    /// Column visibility by field id: `true` hidden, `false` shown.
    pub hidden: BTreeMap<ObjectId, bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordData {
    /// The record's `row_key`.
    pub id: ObjectId,
    /// Unix milliseconds.
    pub created_at: i64,
    pub created_by: String,
    /// Stored cells by field id.
    pub cells: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkData {
    pub id: ObjectId,
    pub from: ObjectId,
    pub field: ObjectId,
    pub to: ObjectId,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashboardData {
    pub id: ObjectId,
    pub name: String,
    /// Everything about the dashboard but its widgets; `null` when unset.
    pub config: Value,
    /// Widgets by widget id.
    pub widgets: Map<String, Value>,
}

/// A read view of one replica. Indexes of records and links are built on first use, once per
/// view (O(records + objects)); make a new view after the replica changes.
pub struct ModelView<'a> {
    replica: &'a Replica,
    structure: OnceCell<Structure>,
    links: OnceCell<LinkIndex>,
}

/// Where each listed record and field lives, and each table's stored (not computed) fields.
struct Structure {
    record_table: HashMap<ObjectId, ObjectId>,
    field_table: HashMap<ObjectId, ObjectId>,
    stored: HashMap<ObjectId, HashSet<String>>,
}

/// The links readers show, sorted by link id (creation order).
struct LinkIndex {
    all: Vec<LinkData>,
    from: HashMap<(ObjectId, ObjectId), Vec<ObjectId>>,
    to: HashMap<ObjectId, Vec<(ObjectId, ObjectId)>>,
}

impl<'a> ModelView<'a> {
    pub fn new(replica: &'a Replica) -> Self {
        Self {
            replica,
            structure: OnceCell::new(),
            links: OnceCell::new(),
        }
    }

    pub fn replica(&self) -> &'a Replica {
        self.replica
    }

    /// The document's base: the one with the lowest id, should several exist.
    pub fn base(&self) -> Option<ObjectId> {
        self.replica.objects_of_type(BASE).into_iter().next()
    }

    pub fn base_data(&self) -> Result<Option<BaseData>> {
        let Some(id) = self.base() else {
            return Ok(None);
        };
        Ok(Some(BaseData {
            title: self.string(&id, "title")?,
            description: self.string(&id, "description")?,
            icon: self.string(&id, "icon")?,
            color: self.string(&id, "color")?,
            meta: self.replica.get(&id, "meta")?,
            id,
        }))
    }

    /// The base's tables in order.
    pub fn tables(&self) -> Result<Vec<ObjectId>> {
        match self.base() {
            Some(base) => self.live(&base, "tables"),
            None => Ok(Vec::new()),
        }
    }

    pub fn table(&self, id: &ObjectId) -> Result<TableData> {
        self.expect(id, TABLE)?;
        let primary = self.replica.get(id, "primaryField")?;
        let primary_field = primary
            .as_str()
            .map(ObjectId::from_string)
            .filter(|field| self.is(field, FIELD));
        Ok(TableData {
            id: id.clone(),
            name: self.string(id, "name")?,
            title: self.string(id, "title")?,
            description: self.string(id, "description")?,
            meta: self.replica.get(id, "meta")?,
            primary_field,
        })
    }

    /// The table's fields in order.
    pub fn fields(&self, table: &ObjectId) -> Result<Vec<FieldData>> {
        self.expect(table, TABLE)?;
        self.live(table, "fields")?
            .iter()
            .map(|field| self.field(field))
            .collect()
    }

    pub fn field(&self, id: &ObjectId) -> Result<FieldData> {
        self.expect(id, FIELD)?;
        Ok(FieldData {
            id: id.clone(),
            name: self.string(id, "name")?,
            title: self.string(id, "title")?,
            field_type: self.string(id, "type")?,
            required: self.replica.get(id, "required")? == Value::Bool(true),
            readonly: self.replica.get(id, "readonly")? == Value::Bool(true),
            options: self.replica.get(id, "options")?,
            formula: self.string(id, "formula")?,
            ai_prompt: self.string(id, "aiPrompt")?,
            meta: self.replica.get(id, "meta")?,
        })
    }

    /// The field of the table named `name`.
    pub fn field_by_name(&self, table: &ObjectId, name: &str) -> Result<Option<ObjectId>> {
        self.expect(table, TABLE)?;
        for field in self.live(table, "fields")? {
            if self.string(&field, "name")? == name {
                return Ok(Some(field));
            }
        }
        Ok(None)
    }

    /// The table's views in order; widths and visibility only of the table's live fields.
    pub fn views(&self, table: &ObjectId) -> Result<Vec<ViewData>> {
        self.expect(table, TABLE)?;
        let fields: HashSet<String> = self
            .live(table, "fields")?
            .into_iter()
            .map(|field| field.to_string())
            .collect();
        self.live(table, "views")?
            .iter()
            .map(|view| self.view_of(view, |key| fields.contains(key)))
            .collect()
    }

    /// One view; widths and visibility of every listed field.
    pub fn view(&self, id: &ObjectId) -> Result<ViewData> {
        let structure = self.structure()?;
        self.view_of(id, |key| {
            structure
                .field_table
                .contains_key(&ObjectId::from_string(key))
        })
    }

    /// The table's record ids (row keys) in order.
    pub fn record_ids(&self, table: &ObjectId) -> Result<Vec<ObjectId>> {
        self.expect(table, TABLE)?;
        self.live(table, "records")
    }

    /// The table that lists `record`.
    pub fn table_of_record(&self, record: &ObjectId) -> Result<Option<ObjectId>> {
        Ok(self.structure()?.record_table.get(record).cloned())
    }

    /// One record with its cells, as [`ModelView::cells`] reads them.
    pub fn record(&self, id: &ObjectId) -> Result<RecordData> {
        let cells = self.cells(id)?;
        self.record_data(id, cells)
    }

    /// The table's records in order, with the cells of the table's stored fields.
    pub fn records(&self, table: &ObjectId) -> Result<Vec<RecordData>> {
        let ids = self.record_ids(table)?;
        let stored = self.stored_fields(table)?;
        ids.iter()
            .map(|record| {
                let cells = self.cells_where(record, |key| stored.contains(key))?;
                self.record_data(record, cells)
            })
            .collect()
    }

    /// A record's stored cells by field id: only cells of its own table's live fields that are
    /// not computed. A record no table lists is [`KitableError::NotFound`].
    pub fn cells(&self, record: &ObjectId) -> Result<Map<String, Value>> {
        let structure = self.structure()?;
        let table = structure
            .record_table
            .get(record)
            .ok_or(KitableError::NotFound)?;
        let empty = HashSet::new();
        let stored = structure.stored.get(table).unwrap_or(&empty);
        self.cells_where(record, |key| stored.contains(key))
    }

    /// Every link readers show: ends that exist and are listed, once per `(from, field, to)`,
    /// one per `(from, field)` for single-target fields; sorted by link id (creation order).
    pub fn links(&self) -> Result<Vec<LinkData>> {
        Ok(self.link_index()?.all.clone())
    }

    /// The records `record` links to through `field`, in link creation order.
    pub fn links_from(&self, record: &ObjectId, field: &ObjectId) -> Result<Vec<ObjectId>> {
        let index = self.link_index()?;
        Ok(index
            .from
            .get(&(record.clone(), field.clone()))
            .cloned()
            .unwrap_or_default())
    }

    /// The `(from record, field)` pairs that link to `record`, in link creation order.
    pub fn links_to(&self, record: &ObjectId) -> Result<Vec<(ObjectId, ObjectId)>> {
        let index = self.link_index()?;
        Ok(index.to.get(record).cloned().unwrap_or_default())
    }

    /// The links of one field, grouped by source record, targets in link creation order.
    pub fn links_of_field(&self, field: &ObjectId) -> Result<HashMap<ObjectId, Vec<ObjectId>>> {
        let index = self.link_index()?;
        Ok(index
            .from
            .iter()
            .filter(|((_, link_field), _)| link_field == field)
            .map(|((from, _), targets)| (from.clone(), targets.clone()))
            .collect())
    }

    /// The base's dashboards in order.
    pub fn dashboards(&self) -> Result<Vec<DashboardData>> {
        let Some(base) = self.base() else {
            return Ok(Vec::new());
        };
        self.live(&base, "dashboards")?
            .into_iter()
            .map(|id| {
                self.expect(&id, DASHBOARD)?;
                Ok(DashboardData {
                    name: self.string(&id, "name")?,
                    config: self.replica.get(&id, "config")?,
                    widgets: self
                        .replica
                        .map_entries(&id, "widgets")?
                        .into_iter()
                        .collect(),
                    id,
                })
            })
            .collect()
    }

    fn structure(&self) -> Result<&Structure> {
        if let Some(structure) = self.structure.get() {
            return Ok(structure);
        }
        let mut built = Structure {
            record_table: HashMap::new(),
            field_table: HashMap::new(),
            stored: HashMap::new(),
        };
        for table in self.tables()? {
            for record in self.live(&table, "records")? {
                built
                    .record_table
                    .entry(record)
                    .or_insert_with(|| table.clone());
            }
            for field in self.live(&table, "fields")? {
                built
                    .field_table
                    .entry(field)
                    .or_insert_with(|| table.clone());
            }
            let stored = self.stored_fields(&table)?;
            built.stored.insert(table, stored);
        }
        Ok(self.structure.get_or_init(|| built))
    }

    fn link_index(&self) -> Result<&LinkIndex> {
        if let Some(index) = self.links.get() {
            return Ok(index);
        }
        let structure = self.structure()?;
        let mut index = LinkIndex {
            all: Vec::new(),
            from: HashMap::new(),
            to: HashMap::new(),
        };
        let mut seen = HashSet::new();
        let mut single: HashMap<ObjectId, bool> = HashMap::new();
        for id in self.replica.objects_of_type(LINK) {
            let end = |name: &str| -> Result<ObjectId> {
                Ok(ObjectId::from_string(
                    self.replica.get(&id, name)?.as_str().unwrap_or_default(),
                ))
            };
            let link = LinkData {
                from: end("from")?,
                field: end("field")?,
                to: end("to")?,
                id: id.clone(),
            };
            let listed = structure.record_table.contains_key(&link.from)
                && structure.record_table.contains_key(&link.to)
                && structure.field_table.contains_key(&link.field);
            if !listed || !seen.insert((link.from.clone(), link.field.clone(), link.to.clone())) {
                continue;
            }
            let is_single = match single.get(&link.field) {
                Some(found) => *found,
                None => {
                    let found = self
                        .replica
                        .get(&link.field, "options")?
                        .get("allow_multiple")
                        == Some(&Value::Bool(false));
                    single.insert(link.field.clone(), found);
                    found
                }
            };
            let targets = index
                .from
                .entry((link.from.clone(), link.field.clone()))
                .or_default();
            if is_single && !targets.is_empty() {
                continue;
            }
            targets.push(link.to.clone());
            index
                .to
                .entry(link.to.clone())
                .or_default()
                .push((link.from.clone(), link.field.clone()));
            index.all.push(link);
        }
        Ok(self.links.get_or_init(|| index))
    }

    fn view_of(&self, id: &ObjectId, keep: impl Fn(&str) -> bool) -> Result<ViewData> {
        self.expect(id, VIEW)?;
        let widths = self
            .replica
            .map_entries(id, "widths")?
            .into_iter()
            .filter(|(key, _)| keep(key))
            .filter_map(|(key, value)| Some((ObjectId::from_string(key), value.as_i64()?)))
            .collect();
        let hidden = self
            .replica
            .map_entries(id, "hidden")?
            .into_iter()
            .filter(|(key, _)| keep(key))
            .filter_map(|(key, value)| Some((ObjectId::from_string(key), value.as_bool()?)))
            .collect();
        Ok(ViewData {
            id: id.clone(),
            view_type: self.string(id, "type")?,
            title: self.string(id, "title")?,
            locked: self.replica.get(id, "locked")? == Value::Bool(true),
            config: self.replica.get(id, "config")?,
            widths,
            hidden,
        })
    }

    fn record_data(&self, id: &ObjectId, cells: Map<String, Value>) -> Result<RecordData> {
        Ok(RecordData {
            id: id.clone(),
            created_at: self
                .replica
                .get(id, "createdAt")?
                .as_i64()
                .unwrap_or_default(),
            created_by: self.string(id, "createdBy")?,
            cells,
        })
    }

    fn cells_where(
        &self,
        record: &ObjectId,
        keep: impl Fn(&str) -> bool,
    ) -> Result<Map<String, Value>> {
        self.expect(record, RECORD)?;
        Ok(self
            .replica
            .map_entries(record, "cells")?
            .into_iter()
            .filter(|(key, _)| keep(key))
            .collect())
    }

    /// The ids of the table's live fields that are not computed.
    fn stored_fields(&self, table: &ObjectId) -> Result<HashSet<String>> {
        let mut stored = HashSet::new();
        for field in self.live(table, "fields")? {
            if !is_computed(&self.string(&field, "type")?) {
                stored.insert(field.to_string());
            }
        }
        Ok(stored)
    }

    /// The items of a list naming existing objects, first occurrence only.
    fn live(&self, id: &ObjectId, field: &str) -> Result<Vec<ObjectId>> {
        let mut seen = HashSet::new();
        Ok(self
            .replica
            .list(id, field)?
            .into_iter()
            .filter(|item| self.replica.exists(item) && seen.insert(item.clone()))
            .collect())
    }

    fn is(&self, id: &ObjectId, ty: &str) -> bool {
        self.replica.object_type(id).is_ok_and(|found| found == ty)
    }

    fn expect(&self, id: &ObjectId, ty: &str) -> Result<()> {
        if self.is(id, ty) {
            Ok(())
        } else {
            Err(KitableError::NotFound)
        }
    }

    fn string(&self, id: &ObjectId, field: &str) -> Result<String> {
        Ok(self
            .replica
            .get(id, field)?
            .as_str()
            .unwrap_or_default()
            .to_owned())
    }
}
