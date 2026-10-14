//! Typed writes of the `kit.table` document, on a [`Tx`] of its replica.
//!
//! The document is one `Base` holding ordered lists of `Table`s and `Dashboard`s. A `Table` holds
//! ordered lists of its `Field`s, `View`s, and `Record`s, and names its primary field. A
//! `Record`'s cells are a map keyed by field object id; record links are `Link` objects
//! `(from record, field, to record)`, so concurrent link edits merge as a set.
//!
//! Every function here only stages operations: run them inside [`transact`] (or
//! [`kition_kdm::Replica::transact`]) so a failure anywhere leaves the document unchanged. Object
//! ids are UUID v7 except a record's, which is its `row_key` (a UUID v4). Options and configs
//! name tables and fields by object id; see [`super::options`] for the relational form.
//!
//! Lists can hold an id more than once after a merge (two replicas inserting one object); the
//! first occurrence counts and later ones are ignored, by readers and by positions here
//! ("the n-th field" counts live, distinct items). Functions that look up links scan the
//! document's `Link` objects once per call, O(objects); batch link edits go through
//! [`replace_links_many`].

use std::collections::{HashMap, HashSet};

use kition_kdm::{KdmError, ObjectId, Origin, Replica, Tx};
use serde_json::{Map, Value, json};

use crate::json::{self, fallback};
use crate::source::{
    FIELD_TYPES, FieldPatch, FieldSpec, TablePatch, TableSpec, VIEW_TYPES, ViewPatch, ViewSpec,
};
use crate::{KitableError, Result};

pub const BASE: &str = "Base";
pub const TABLE: &str = "Table";
pub const FIELD: &str = "Field";
pub const VIEW: &str = "View";
pub const RECORD: &str = "Record";
pub const LINK: &str = "Link";
pub const DASHBOARD: &str = "Dashboard";

/// Field types whose values are derived, never stored in `Record.cells`. A `link_to_record`'s
/// display value is derived from its `Link` objects.
pub const COMPUTED_FIELD_TYPES: [&str; 9] = [
    "formula",
    "lookup",
    "rollup",
    "link_to_record",
    "auto_number",
    "created_time",
    "last_modified_time",
    "created_by",
    "last_modified_by",
];

/// The column width range of a view, as the relational view configuration clamps it.
pub const MIN_WIDTH: i64 = 40;
pub const MAX_WIDTH: i64 = 1200;

/// Whether values of `field_type` are derived rather than stored.
pub fn is_computed(field_type: &str) -> bool {
    COMPUTED_FIELD_TYPES.contains(&field_type)
}

#[derive(Debug, Clone, Default)]
pub struct BaseSpec {
    pub title: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub meta: Value,
}

/// The objects [`create_table`] created, in list order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableIds {
    pub table: ObjectId,
    pub fields: Vec<ObjectId>,
    pub views: Vec<ObjectId>,
}

/// Where [`create_records`] inserts, relative to a record of the table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Anchor {
    Before(ObjectId),
    After(ObjectId),
}

/// Runs `f` as one transaction of `replica`, like [`Replica::transact`] but with this crate's
/// errors: an error from `f` aborts the transaction (nothing is applied) and is returned as is.
pub fn transact<R>(
    replica: &mut Replica,
    origin: &Origin,
    f: impl FnOnce(&mut Tx<'_>) -> Result<R>,
) -> Result<R> {
    let mut failure = None;
    let outcome = replica.transact(origin, |tx| {
        f(tx).map_err(|err| {
            failure = Some(err);
            KdmError::Engine("the transaction was aborted".into())
        })
    });
    outcome.map_err(|err| failure.take().unwrap_or_else(|| err.into()))
}

// ---------------------------------------------------------------------------
// Base.

pub fn create_base(tx: &mut Tx<'_>, spec: &BaseSpec) -> Result<ObjectId> {
    let mut fields = registers(json!({
        "title": spec.title.trim(),
        "description": spec.description.trim(),
        "icon": spec.icon.trim(),
        "color": spec.color.trim(),
    }));
    put_json(&mut fields, "meta", &spec.meta)?;
    Ok(tx.create(BASE, fields)?)
}

// ---------------------------------------------------------------------------
// Tables.

/// Creates a table at `index` of the base's tables (`None` or past the end: last). Without
/// `spec.fields` it gets a required primary "Title" text field; without `spec.views`, an "All"
/// grid view. The primary field is the last field spec marked `primary`, else the first field.
pub fn create_table(
    tx: &mut Tx<'_>,
    base: &ObjectId,
    spec: &TableSpec,
    index: Option<usize>,
) -> Result<TableIds> {
    create_table_as(tx, base, spec, index, true)
}

/// [`create_table`] without seeding a default field or view when `spec` has none: for migrations
/// and other bulk builds that must reproduce a source exactly, including a table a user left with
/// no live fields or no live views.
pub fn create_table_unseeded(
    tx: &mut Tx<'_>,
    base: &ObjectId,
    spec: &TableSpec,
    index: Option<usize>,
) -> Result<TableIds> {
    create_table_as(tx, base, spec, index, false)
}

fn create_table_as(
    tx: &mut Tx<'_>,
    base: &ObjectId,
    spec: &TableSpec,
    index: Option<usize>,
    seed: bool,
) -> Result<TableIds> {
    require(tx, base, BASE)?;
    let tables = Listing::read(tx, base, "tables")?;
    let title = fallback(&spec.title, "Table");
    let taken = names_of(tx, &tables.ids())?;
    let name = unique_name(&json::internal_name(&fallback(&spec.name, &title)), &taken);
    let mut fields = registers(json!({
        "name": name,
        "title": title,
        "description": spec.description.trim(),
    }));
    put_json(&mut fields, "meta", &spec.meta)?;
    let table = tx.create(TABLE, fields)?;
    let at = tables.insert_index(index.unwrap_or(usize::MAX));
    tx.list_insert(base, "tables", at, &table)?;

    let default_fields = [FieldSpec {
        title: "Title".to_owned(),
        field_type: "text".to_owned(),
        primary: true,
        required: true,
        ..FieldSpec::default()
    }];
    let field_specs: &[FieldSpec] = if spec.fields.is_empty() && seed {
        &default_fields
    } else {
        &spec.fields
    };
    let mut primary = false;
    for field_spec in field_specs {
        // A migration reproduces the source as it is, circular references included.
        create_field_as(tx, &table, field_spec, seed)?;
        primary |= field_spec.primary;
    }
    // Fields inserted at an `order` may not be in creation order.
    let in_order = tx.list_items(&table, "fields")?;
    if !primary && let Some(first) = in_order.first() {
        tx.set(&table, "primaryField", json!(first.as_str()))?;
    }

    let default_views = [ViewSpec {
        title: "All".to_owned(),
        view_type: "grid".to_owned(),
        config: Value::Null,
    }];
    let view_specs: &[ViewSpec] = if spec.views.is_empty() && seed {
        &default_views
    } else {
        &spec.views
    };
    let mut views = Vec::with_capacity(view_specs.len());
    for view_spec in view_specs {
        views.push(create_view(tx, &table, view_spec)?);
    }
    Ok(TableIds {
        table,
        fields: in_order,
        views,
    })
}

/// Patches a table. The primary field is `primary_field`, which must be one of the table's
/// fields ([`KitableError::NotFound`] otherwise); `None` keeps the current one.
/// `TablePatch::primary_field_id` is a relational id and is refused ([`KitableError::Invalid`]):
/// resolve it to the field's object id and pass that.
pub fn update_table(
    tx: &mut Tx<'_>,
    table: &ObjectId,
    patch: &TablePatch,
    primary_field: Option<&ObjectId>,
) -> Result<()> {
    require(tx, table, TABLE)?;
    if patch.primary_field_id.is_some() {
        return Err(KitableError::invalid(
            "primary_field_id is a relational id; pass the primary field's object id",
        ));
    }
    if let Some(title) = patch.title.as_deref().map(str::trim)
        && !title.is_empty()
    {
        set_if_changed(tx, table, "title", json!(title))?;
    }
    if let Some(description) = &patch.description {
        set_if_changed(tx, table, "description", json!(description))?;
    }
    if let Some(meta) = &patch.meta {
        set_if_changed(tx, table, "meta", decode_json(meta)?)?;
    }
    if let Some(primary) = primary_field {
        if !Listing::read(tx, table, "fields")?.contains(primary) {
            return Err(KitableError::NotFound);
        }
        set_if_changed(tx, table, "primaryField", json!(primary.as_str()))?;
    }
    Ok(())
}

/// Deletes a table with its fields, views, records, and every link from, to, or through them.
pub fn delete_table(tx: &mut Tx<'_>, base: &ObjectId, table: &ObjectId) -> Result<()> {
    require(tx, base, BASE)?;
    require(tx, table, TABLE)?;
    if !remove_all(tx, base, "tables", table)? {
        return Err(KitableError::NotFound);
    }
    let fields = tx.list_items(table, "fields")?;
    let views = tx.list_items(table, "views")?;
    let records = tx.list_items(table, "records")?;
    let field_set: HashSet<&ObjectId> = fields.iter().collect();
    let record_set: HashSet<&ObjectId> = records.iter().collect();
    for link in all_links(tx)? {
        if field_set.contains(&link.field)
            || record_set.contains(&link.from)
            || record_set.contains(&link.to)
        {
            tx.delete(&link.id)?;
        }
    }
    let mut seen = HashSet::new();
    for id in fields.iter().chain(&views).chain(&records) {
        if seen.insert(id) && tx.exists(id) {
            tx.delete(id)?;
        }
    }
    tx.delete(table)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Fields.

/// Creates a field. Its name is `spec.name` (else its title) as an internal name, suffixed
/// `_2`, `_3`, ... until unique in the table. `spec.order` is a 1-based position as in
/// [`crate::KitableFile::create_field`]: the field becomes the `order`-th field (clamped);
/// `None` appends. `spec.primary` makes it the table's primary field.
///
/// Field names are immutable internal keys: view configs and formulas name fields by them. Two
/// replicas can still create one name concurrently; [`super::repair`] then renames the field with
/// the higher id (`status` to `status_2`), which can happen again in a later merge (`status_2`
/// to `status_3`), and references by name follow the field that keeps the name.
///
/// A derived field whose value would depend on itself is refused ([`KitableError::Invalid`],
/// "circular reference"); see [`check_acyclic`].
pub fn create_field(tx: &mut Tx<'_>, table: &ObjectId, spec: &FieldSpec) -> Result<ObjectId> {
    create_field_as(tx, table, spec, true)
}

fn create_field_as(
    tx: &mut Tx<'_>,
    table: &ObjectId,
    spec: &FieldSpec,
    check_cycles: bool,
) -> Result<ObjectId> {
    require(tx, table, TABLE)?;
    let field_type = fallback(&spec.field_type, "text");
    check_field_type(&field_type)?;
    let title = fallback(&spec.title, "Field");
    let fields = Listing::read(tx, table, "fields")?;
    let taken = names_of(tx, &fields.ids())?;
    let name = unique_name(&json::internal_name(&fallback(&spec.name, &title)), &taken);
    let readonly = spec.readonly || forces_readonly(&field_type);
    let mut values = registers(json!({
        "name": name,
        "title": title,
        "type": field_type,
        "required": spec.required,
        "readonly": readonly,
        "formula": spec.formula.trim(),
        "aiPrompt": spec.ai_prompt.trim(),
    }));
    put_json(
        &mut values,
        "options",
        &object_ids_only(decode_json(&spec.options)?)?,
    )?;
    put_json(&mut values, "meta", &spec.meta)?;
    let field = tx.create(FIELD, values)?;
    let position = match spec.order {
        Some(order) => usize::try_from(order.max(1) - 1).unwrap_or(usize::MAX),
        None => usize::MAX,
    };
    tx.list_insert(table, "fields", fields.insert_index(position), &field)?;
    if spec.primary {
        tx.set(table, "primaryField", json!(field.as_str()))?;
    }
    if check_cycles {
        check_acyclic(tx, &field)?;
    }
    Ok(field)
}

/// Patches a field. Field names are immutable. `is_primary: Some(true)` makes it its table's
/// primary field; `Some(false)` on the primary field is refused ([`KitableError::Invalid`]), and
/// so is a change that makes a derived field depend on itself ([`check_acyclic`]).
pub fn update_field(tx: &mut Tx<'_>, field: &ObjectId, patch: &FieldPatch) -> Result<()> {
    require(tx, field, FIELD)?;
    if let Some(title) = patch.title.as_deref().map(str::trim)
        && !title.is_empty()
    {
        set_if_changed(tx, field, "title", json!(title))?;
    }
    let mut field_type = string(tx, field, "type")?;
    if let Some(requested) = patch
        .field_type
        .as_deref()
        .map(str::trim)
        .filter(|requested| !requested.is_empty())
    {
        check_field_type(requested)?;
        field_type = requested.to_owned();
        set_if_changed(tx, field, "type", json!(requested))?;
    }
    if let Some(required) = patch.required {
        set_if_changed(tx, field, "required", json!(required))?;
    }
    let readonly = patch
        .readonly
        .unwrap_or(tx.get(field, "readonly")? == json!(true));
    set_if_changed(
        tx,
        field,
        "readonly",
        json!(readonly || forces_readonly(&field_type)),
    )?;
    if let Some(options) = &patch.options {
        set_if_changed(
            tx,
            field,
            "options",
            object_ids_only(decode_json(options)?)?,
        )?;
    }
    if let Some(formula) = &patch.formula {
        set_if_changed(tx, field, "formula", json!(formula))?;
    }
    if let Some(prompt) = &patch.ai_prompt {
        set_if_changed(tx, field, "aiPrompt", json!(prompt))?;
    }
    if let Some(meta) = &patch.meta {
        set_if_changed(tx, field, "meta", decode_json(meta)?)?;
    }
    if let Some(primary) = patch.is_primary {
        let table = table_of_field(tx, field)?.ok_or(KitableError::NotFound)?;
        let is_primary = tx.get(&table, "primaryField")? == json!(field.as_str());
        if primary {
            set_if_changed(tx, &table, "primaryField", json!(field.as_str()))?;
        } else if is_primary {
            return Err(KitableError::invalid(
                "primary field cannot be unset directly",
            ));
        }
    }
    if patch.field_type.is_some() || patch.options.is_some() || patch.formula.is_some() {
        check_acyclic(tx, field)?;
    }
    Ok(())
}

/// Refuses ([`KitableError::Invalid`], "circular reference") when the derived value of `field`
/// depends on itself through the document's field dependencies, as spreadsheets refuse circular
/// references. A formula depends on the fields of its table it names; a lookup on its target
/// field; a rollup on its target field, or without one on every field of its link field's target
/// table; a `link_to_record` field on the primary field of its target table. The graph is per
/// field, not per record: a running total (a rollup of the previous record's formula that adds
/// the rollup) is refused too. Concurrent edits can still merge into a cycle; the projector
/// gives such fields bounded values ([`super::project`]).
pub fn check_acyclic(tx: &Tx<'_>, field: &ObjectId) -> Result<()> {
    if !is_a(tx, field, FIELD) {
        return Ok(());
    }
    let derived = |ty: &str| matches!(ty, "formula" | "lookup" | "rollup" | "link_to_record");
    if !derived(&string(tx, field, "type")?) {
        return Ok(());
    }
    struct Node {
        table: ObjectId,
        name: String,
        ty: String,
        options: Value,
        formula: String,
    }
    let mut nodes: HashMap<ObjectId, Node> = HashMap::new();
    let mut table_fields: HashMap<ObjectId, Vec<ObjectId>> = HashMap::new();
    let mut primaries: HashMap<ObjectId, ObjectId> = HashMap::new();
    for base in tx.objects_of_type(BASE) {
        for table in Listing::read(tx, &base, "tables")?.ids() {
            let fields = Listing::read(tx, &table, "fields")?.ids();
            for id in &fields {
                nodes.entry(id.clone()).or_insert(Node {
                    table: table.clone(),
                    name: string(tx, id, "name")?,
                    ty: string(tx, id, "type")?,
                    options: tx.get(id, "options")?,
                    formula: string(tx, id, "formula")?,
                });
            }
            if let Some(primary) = tx.get(&table, "primaryField")?.as_str() {
                primaries.insert(table.clone(), ObjectId::from_string(primary));
            }
            table_fields.insert(table, fields);
        }
    }
    let option = |node: &Node, key: &str| -> Option<ObjectId> {
        node.options
            .get(key)
            .and_then(Value::as_str)
            .map(ObjectId::from_string)
    };
    let edges = |id: &ObjectId| -> Vec<ObjectId> {
        let Some(node) = nodes.get(id) else {
            return Vec::new();
        };
        let table_of_link = |link: Option<ObjectId>| -> Option<ObjectId> {
            option(nodes.get(&link?)?, "target_table")
        };
        match node.ty.as_str() {
            "formula" => {
                let names = crate::computed::formula_references(&node.formula);
                table_fields
                    .get(&node.table)
                    .into_iter()
                    .flatten()
                    .filter(|other| {
                        nodes
                            .get(*other)
                            .is_some_and(|other| names.contains(&other.name))
                    })
                    .cloned()
                    .collect()
            }
            "lookup" => option(node, "target_field").into_iter().collect(),
            "rollup" => match option(node, "target_field").filter(|f| nodes.contains_key(f)) {
                Some(target) => vec![target],
                None => table_of_link(option(node, "link_field"))
                    .and_then(|table| table_fields.get(&table).cloned())
                    .unwrap_or_default(),
            },
            "link_to_record" => option(node, "target_table")
                .and_then(|table| primaries.get(&table).cloned())
                .into_iter()
                .collect(),
            _ => Vec::new(),
        }
    };
    let mut seen = HashSet::new();
    let mut stack = edges(field);
    while let Some(next) = stack.pop() {
        if next == *field {
            let name = nodes
                .get(field)
                .map(|node| node.name.clone())
                .unwrap_or_default();
            return Err(KitableError::invalid(format!(
                "circular reference: field {name} depends on itself"
            )));
        }
        if seen.insert(next.clone()) {
            stack.extend(edges(&next));
        }
    }
    Ok(())
}

/// Deletes a field and the links through it. The primary field is refused
/// ([`KitableError::Invalid`]).
///
/// Its cells stay in the records: readers ignore cells of fields that are gone. Clearing them
/// would cost a write per record and would not merge cleanly with concurrent cell edits, which
/// another replica may still be making; keeping them keeps every concurrent edit mergeable.
pub fn delete_field(tx: &mut Tx<'_>, table: &ObjectId, field: &ObjectId) -> Result<()> {
    require(tx, table, TABLE)?;
    if !Listing::read(tx, table, "fields")?.contains(field) {
        return Err(KitableError::NotFound);
    }
    if tx.get(table, "primaryField")? == json!(field.as_str()) {
        return Err(KitableError::invalid("primary field cannot be deleted"));
    }
    remove_all(tx, table, "fields", field)?;
    for link in all_links(tx)? {
        if link.field == *field {
            tx.delete(&link.id)?;
        }
    }
    tx.delete(field)?;
    Ok(())
}

/// Moves `fields` (in the given order) so that the first becomes the `to_index`-th of the
/// table's other fields (past the end: last). Every field must be in the table
/// ([`KitableError::NotFound`]).
pub fn move_fields(
    tx: &mut Tx<'_>,
    table: &ObjectId,
    fields: &[ObjectId],
    to_index: usize,
) -> Result<()> {
    require(tx, table, TABLE)?;
    let listing = Listing::read(tx, table, "fields")?;
    let moved = distinct(fields);
    if moved.iter().any(|field| !listing.contains(field)) {
        return Err(KitableError::NotFound);
    }
    let moving: HashSet<&ObjectId> = moved.iter().collect();
    let anchor = listing
        .ids()
        .into_iter()
        .filter(|item| !moving.contains(item))
        .nth(to_index);
    place(tx, table, "fields", listing.raw, &moved, anchor)
}

// ---------------------------------------------------------------------------
// Views.

/// Creates a view at the end of the table's views. An unknown view type becomes `grid`.
pub fn create_view(tx: &mut Tx<'_>, table: &ObjectId, spec: &ViewSpec) -> Result<ObjectId> {
    require(tx, table, TABLE)?;
    let mut view_type = fallback(&spec.view_type, "grid");
    if !VIEW_TYPES.contains(&view_type.as_str()) {
        view_type = "grid".to_owned();
    }
    let mut values = registers(json!({
        "type": view_type,
        "title": fallback(&spec.title, "All"),
        "locked": false,
    }));
    put_json(&mut values, "config", &spec.config)?;
    let view = tx.create(VIEW, values)?;
    let len = tx.list_items(table, "views")?.len();
    tx.list_insert(table, "views", len, &view)?;
    Ok(view)
}

/// Patches a view. An unknown view type is refused ([`KitableError::Invalid`]).
pub fn update_view(tx: &mut Tx<'_>, view: &ObjectId, patch: &ViewPatch) -> Result<()> {
    require(tx, view, VIEW)?;
    if let Some(title) = patch.title.as_deref().map(str::trim)
        && !title.is_empty()
    {
        set_if_changed(tx, view, "title", json!(title))?;
    }
    if let Some(requested) = patch
        .view_type
        .as_deref()
        .map(str::trim)
        .filter(|requested| !requested.is_empty())
    {
        if !VIEW_TYPES.contains(&requested) {
            return Err(KitableError::invalid(format!(
                "unsupported view type {requested:?}"
            )));
        }
        set_if_changed(tx, view, "type", json!(requested))?;
    }
    if let Some(config) = &patch.config {
        set_if_changed(tx, view, "config", decode_json(config)?)?;
    }
    Ok(())
}

/// Sets a column width, clamped to [`MIN_WIDTH`]`..=`[`MAX_WIDTH`].
pub fn set_view_width(
    tx: &mut Tx<'_>,
    view: &ObjectId,
    field: &ObjectId,
    width: i64,
) -> Result<()> {
    require(tx, view, VIEW)?;
    let width = json!(width.clamp(MIN_WIDTH, MAX_WIDTH));
    if tx.map_get(view, "widths", field.as_str())? != width {
        tx.map_set(view, "widths", field.as_str(), width)?;
    }
    Ok(())
}

/// Hides or shows a column. Both states are stored, so the latest choice wins under concurrency.
pub fn set_view_hidden(
    tx: &mut Tx<'_>,
    view: &ObjectId,
    field: &ObjectId,
    hidden: bool,
) -> Result<()> {
    require(tx, view, VIEW)?;
    if tx.map_get(view, "hidden", field.as_str())? != json!(hidden) {
        tx.map_set(view, "hidden", field.as_str(), json!(hidden))?;
    }
    Ok(())
}

pub fn delete_view(tx: &mut Tx<'_>, table: &ObjectId, view: &ObjectId) -> Result<()> {
    require(tx, table, TABLE)?;
    if !remove_all(tx, table, "views", view)? {
        return Err(KitableError::NotFound);
    }
    if tx.exists(view) {
        tx.delete(view)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Records.

/// Creates one record per row at `at` (`None`: at the end), in order, with `createdAt = now`
/// (Unix milliseconds) and `createdBy = created_by`. Rows are keyed by field object id; keys that
/// are not stored fields of the table (unknown or computed) and `null` values are skipped.
/// Required fields are not checked here. An anchor that is not a record of the table is
/// [`KitableError::NotFound`].
pub fn create_records(
    tx: &mut Tx<'_>,
    table: &ObjectId,
    at: Option<&Anchor>,
    rows: &[Map<String, Value>],
    now: i64,
    created_by: &str,
) -> Result<Vec<ObjectId>> {
    require(tx, table, TABLE)?;
    let stored = stored_fields(tx, table)?;
    let records = Listing::read(tx, table, "records")?;
    let raw_of = |anchor: &ObjectId| records.raw_index(anchor).ok_or(KitableError::NotFound);
    let mut index = match at {
        None => records.raw.len(),
        Some(Anchor::Before(anchor)) => raw_of(anchor)?,
        Some(Anchor::After(anchor)) => raw_of(anchor)? + 1,
    };
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        let id = ObjectId::from_string(uuid::Uuid::new_v4().to_string());
        let values = registers(json!({ "createdAt": now, "createdBy": created_by }));
        tx.create_with_id(RECORD, &id, values)?;
        tx.list_insert(table, "records", index, &id)?;
        index += 1;
        for (key, value) in row {
            if !value.is_null() && stored.contains(key.as_str()) {
                tx.map_set(&id, "cells", key, value.clone())?;
            }
        }
        ids.push(id);
    }
    Ok(ids)
}

/// Writes cells of one record of `table`, keyed by field object id: one write per cell whose
/// value differs from the stored one (`null` clears). Keys that are not stored fields of the
/// table (unknown or computed) are skipped. A record the table does not list is
/// [`KitableError::NotFound`].
pub fn set_cells(
    tx: &mut Tx<'_>,
    table: &ObjectId,
    record: &ObjectId,
    cells: &Map<String, Value>,
) -> Result<()> {
    set_cells_many(tx, table, &[(record.clone(), cells.clone())])
}

/// [`set_cells`] for many records of one table, reading the table once.
pub fn set_cells_many(
    tx: &mut Tx<'_>,
    table: &ObjectId,
    edits: &[(ObjectId, Map<String, Value>)],
) -> Result<()> {
    require(tx, table, TABLE)?;
    let records = Listing::read(tx, table, "records")?;
    let stored = stored_fields(tx, table)?;
    for (record, cells) in edits {
        if !records.contains(record) {
            return Err(KitableError::NotFound);
        }
        for (key, value) in cells {
            if !stored.contains(key.as_str()) {
                continue;
            }
            let current = tx.map_get(record, "cells", key)?;
            if value.is_null() {
                if !current.is_null() {
                    tx.map_delete(record, "cells", key)?;
                }
            } else if !json::equal(&current, value) {
                tx.map_set(record, "cells", key, value.clone())?;
            }
        }
    }
    Ok(())
}

/// Deletes records of the table and every link from or to them. Ids that are not records of the
/// table are skipped. Answers how many records were deleted.
pub fn delete_records(tx: &mut Tx<'_>, table: &ObjectId, records: &[ObjectId]) -> Result<usize> {
    require(tx, table, TABLE)?;
    let doomed: HashSet<&ObjectId> = records.iter().collect();
    let items = tx.list_items(table, "records")?;
    let mut deleted = HashSet::new();
    for (index, item) in items.iter().enumerate().rev() {
        if doomed.contains(item) {
            tx.list_remove(table, "records", index)?;
            deleted.insert(item.clone());
        }
    }
    if deleted.is_empty() {
        return Ok(0);
    }
    for link in all_links(tx)? {
        if deleted.contains(&link.from) || deleted.contains(&link.to) {
            tx.delete(&link.id)?;
        }
    }
    let mut count = 0;
    for record in &deleted {
        if tx.exists(record) {
            tx.delete(record)?;
            count += 1;
        }
    }
    Ok(count)
}

/// Moves `records` (in the given order) to just before `before` (`None`: to the end), with one
/// list move per record that is not already in place. Every record, and `before`, must be in the
/// table ([`KitableError::NotFound`]); a `before` among the moved records means the first record
/// after it that is not moved.
pub fn move_records(
    tx: &mut Tx<'_>,
    table: &ObjectId,
    records: &[ObjectId],
    before: Option<&ObjectId>,
) -> Result<()> {
    require(tx, table, TABLE)?;
    let listing = Listing::read(tx, table, "records")?;
    let moved = distinct(records);
    if moved.iter().any(|record| !listing.contains(record)) {
        return Err(KitableError::NotFound);
    }
    let moving: HashSet<&ObjectId> = moved.iter().collect();
    let anchor = match before {
        None => None,
        Some(before) => {
            let live = listing.ids();
            let start = live
                .iter()
                .position(|item| item == before)
                .ok_or(KitableError::NotFound)?;
            live.into_iter()
                .skip(start)
                .find(|item| !moving.contains(item))
        }
    };
    place(tx, table, "records", listing.raw, &moved, anchor)
}

// ---------------------------------------------------------------------------
// Links.

/// Makes the links of `field` from `from` go to `targets` (duplicates ignored), creating and
/// deleting `Link` objects only for the difference. Links read back in creation order, so new
/// targets follow kept ones. `field` must be a `link_to_record` field
/// ([`KitableError::Invalid`]); `from` and every target must be records
/// ([`KitableError::NotFound`]).
///
/// Concurrent replaces of one field of one record merge as a union: each replica only adds and
/// removes its own difference. For a single-target field (`allow_multiple: false`),
/// [`super::repair`] then keeps the link with the lowest id.
pub fn replace_links(
    tx: &mut Tx<'_>,
    from: &ObjectId,
    field: &ObjectId,
    targets: &[ObjectId],
) -> Result<()> {
    replace_links_many(tx, field, &[(from.clone(), targets.to_vec())])
}

/// [`replace_links`] for many records and one field, scanning the links once.
pub fn replace_links_many(
    tx: &mut Tx<'_>,
    field: &ObjectId,
    edits: &[(ObjectId, Vec<ObjectId>)],
) -> Result<()> {
    require(tx, field, FIELD)?;
    if string(tx, field, "type")? != "link_to_record" {
        return Err(KitableError::invalid(format!(
            "field {} is not link_to_record",
            string(tx, field, "name")?
        )));
    }
    let single = is_single_target(tx, field)?;
    let mut existing: HashMap<ObjectId, Vec<LinkEnds>> = HashMap::new();
    for link in all_links(tx)? {
        if link.field == *field {
            existing.entry(link.from.clone()).or_default().push(link);
        }
    }
    for (from, targets) in edits {
        require(tx, from, RECORD)?;
        let targets = distinct(targets);
        if single && targets.len() > 1 {
            return Err(KitableError::invalid(
                "field does not allow multiple link targets",
            ));
        }
        for target in &targets {
            require(tx, target, RECORD)?;
        }
        let wanted: HashSet<&ObjectId> = targets.iter().collect();
        let mut kept = HashSet::new();
        for link in existing.remove(from).unwrap_or_default() {
            if wanted.contains(&link.to) && !kept.contains(&link.to) {
                kept.insert(link.to);
            } else {
                tx.delete(&link.id)?;
            }
        }
        for target in &targets {
            if !kept.contains(target) {
                add_link(tx, from, field, target)?;
            }
        }
    }
    Ok(())
}

/// Creates one `Link` object without looking at existing links: for bulk builds (imports,
/// migrations) that know they create each link once. Edits use [`replace_links`].
pub fn add_link(
    tx: &mut Tx<'_>,
    from: &ObjectId,
    field: &ObjectId,
    to: &ObjectId,
) -> Result<ObjectId> {
    let values = registers(json!({
        "from": from.as_str(),
        "field": field.as_str(),
        "to": to.as_str(),
    }));
    Ok(tx.create(LINK, values)?)
}

/// A `Link` object's ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinkEnds {
    pub id: ObjectId,
    pub from: ObjectId,
    pub field: ObjectId,
    pub to: ObjectId,
}

/// Every link of the document, sorted by id. One scan of the document's objects.
pub(crate) fn all_links(tx: &Tx<'_>) -> Result<Vec<LinkEnds>> {
    let mut links = Vec::new();
    for id in tx.objects_of_type(LINK) {
        let end = |name: &str| -> Result<ObjectId> {
            Ok(ObjectId::from_string(
                tx.get(&id, name)?.as_str().unwrap_or_default(),
            ))
        };
        let (from, field, to) = (end("from")?, end("field")?, end("to")?);
        links.push(LinkEnds {
            id,
            from,
            field,
            to,
        });
    }
    Ok(links)
}

/// Whether a link field takes one target (`options.allow_multiple: false`).
pub(crate) fn is_single_target(tx: &Tx<'_>, field: &ObjectId) -> Result<bool> {
    Ok(tx.get(field, "options")?.get("allow_multiple") == Some(&Value::Bool(false)))
}

// ---------------------------------------------------------------------------
// Dashboards.

/// Creates or updates a dashboard of the base. `config` is the dashboard without its widgets
/// (title, order, layout, `source_table` as an object id; see [`super::options`]); `widgets` are
/// keyed by widget id and unordered, so their order belongs in `config` (its layout).
/// `id: None` creates one with a new id; an id that names no object creates one under that id
/// (it must match the KDM object id pattern). On update, `name` and `config` are set when they
/// differ and widgets are diffed key by key: changed widgets are written, missing ones deleted.
/// `null` widgets are skipped. A dashboard missing from the base's list is (re)listed last.
pub fn upsert_dashboard(
    tx: &mut Tx<'_>,
    base: &ObjectId,
    id: Option<&ObjectId>,
    name: &str,
    config: Value,
    widgets: &Map<String, Value>,
) -> Result<ObjectId> {
    require(tx, base, BASE)?;
    let config = object_ids_only(decode_json(&config)?)?;
    let dashboard = match id {
        Some(id) if tx.exists(id) => {
            require(tx, id, DASHBOARD)?;
            set_if_changed(tx, id, "name", json!(name))?;
            set_if_changed(tx, id, "config", config)?;
            for (key, _) in tx.map_entries(id, "widgets")? {
                if widgets.get(&key).is_none_or(Value::is_null) {
                    tx.map_delete(id, "widgets", &key)?;
                }
            }
            for (key, widget) in widgets {
                if widget.is_null() {
                    continue;
                }
                let current = tx.map_get(id, "widgets", key)?;
                if !json::equal(&current, widget) {
                    tx.map_set(id, "widgets", key, widget.clone())?;
                }
            }
            id.clone()
        }
        chosen => {
            let mut values = registers(json!({ "name": name }));
            if !config.is_null() {
                values.insert("config".into(), config);
            }
            let id = match chosen {
                Some(id) => tx.create_with_id(DASHBOARD, id, values)?,
                None => tx.create(DASHBOARD, values)?,
            };
            for (key, widget) in widgets {
                if !widget.is_null() {
                    tx.map_set(&id, "widgets", key, widget.clone())?;
                }
            }
            id
        }
    };
    let listed = tx.list_items(base, "dashboards")?;
    if !listed.contains(&dashboard) {
        tx.list_insert(base, "dashboards", listed.len(), &dashboard)?;
    }
    Ok(dashboard)
}

pub fn delete_dashboard(tx: &mut Tx<'_>, base: &ObjectId, id: &ObjectId) -> Result<()> {
    require(tx, base, BASE)?;
    if !remove_all(tx, base, "dashboards", id)? {
        return Err(KitableError::NotFound);
    }
    if tx.exists(id) {
        tx.delete(id)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers shared with `repair`.

/// A list as the model reads it: the raw items, and the live ones (naming existing objects,
/// first occurrence only) with their raw index.
pub(crate) struct Listing {
    pub raw: Vec<ObjectId>,
    pub live: Vec<(usize, ObjectId)>,
    first: HashMap<ObjectId, usize>,
}

impl Listing {
    pub fn read(tx: &Tx<'_>, id: &ObjectId, field: &str) -> Result<Self> {
        let raw = tx.list_items(id, field)?;
        let mut first = HashMap::with_capacity(raw.len());
        let mut live = Vec::with_capacity(raw.len());
        for (index, item) in raw.iter().enumerate() {
            if !first.contains_key(item) && tx.exists(item) {
                first.insert(item.clone(), index);
                live.push((index, item.clone()));
            }
        }
        Ok(Self { raw, live, first })
    }

    /// The live items in order.
    pub fn ids(&self) -> Vec<ObjectId> {
        self.live.iter().map(|(_, id)| id.clone()).collect()
    }

    pub fn contains(&self, id: &ObjectId) -> bool {
        self.first.contains_key(id)
    }

    /// The raw index of a live item.
    pub fn raw_index(&self, id: &ObjectId) -> Option<usize> {
        self.first.get(id).copied()
    }

    /// The raw index at which an insert makes the new item the `position`-th live item (past
    /// the end: last).
    pub fn insert_index(&self, position: usize) -> usize {
        self.live
            .get(position)
            .map_or(self.raw.len(), |(index, _)| *index)
    }
}

/// Whether `id` is a live object of type `ty`.
pub(crate) fn is_a(tx: &Tx<'_>, id: &ObjectId, ty: &str) -> bool {
    tx.object_type(id).is_ok_and(|found| found == ty)
}

/// [`KitableError::NotFound`] unless `id` is a live object of type `ty`.
pub(crate) fn require(tx: &Tx<'_>, id: &ObjectId, ty: &str) -> Result<()> {
    if is_a(tx, id, ty) {
        Ok(())
    } else {
        Err(KitableError::NotFound)
    }
}

pub(crate) fn string(tx: &Tx<'_>, id: &ObjectId, field: &str) -> Result<String> {
    Ok(tx.get(id, field)?.as_str().unwrap_or_default().to_owned())
}

/// `base`, or `base_2`, `base_3`, ... : the first that is not taken.
pub(crate) fn unique_name(base: &str, taken: &HashSet<String>) -> String {
    let mut name = base.to_owned();
    let mut suffix = 2;
    while taken.contains(&name) {
        name = format!("{base}_{suffix}");
        suffix += 1;
    }
    name
}

/// Sets a register unless it already holds an equal value.
pub(crate) fn set_if_changed(
    tx: &mut Tx<'_>,
    id: &ObjectId,
    field: &str,
    value: Value,
) -> Result<()> {
    if !json::equal(&tx.get(id, field)?, &value) {
        tx.set(id, field, value)?;
    }
    Ok(())
}

/// The names of the objects `ids`.
fn names_of(tx: &Tx<'_>, ids: &[ObjectId]) -> Result<HashSet<String>> {
    ids.iter().map(|id| string(tx, id, "name")).collect()
}

/// The ids of the table's live fields whose values are stored in cells.
fn stored_fields(tx: &Tx<'_>, table: &ObjectId) -> Result<HashSet<String>> {
    let mut stored = HashSet::new();
    for field in Listing::read(tx, table, "fields")?.ids() {
        if !is_computed(&string(tx, &field, "type")?) {
            stored.insert(field.to_string());
        }
    }
    Ok(stored)
}

/// The table whose fields list holds `field`.
fn table_of_field(tx: &Tx<'_>, field: &ObjectId) -> Result<Option<ObjectId>> {
    for table in tx.objects_of_type(TABLE) {
        if tx.list_items(&table, "fields")?.contains(field) {
            return Ok(Some(table));
        }
    }
    Ok(None)
}

/// Removes every occurrence of `item` from a list; answers whether there was one.
fn remove_all(tx: &mut Tx<'_>, id: &ObjectId, field: &str, item: &ObjectId) -> Result<bool> {
    let items = tx.list_items(id, field)?;
    let mut found = false;
    for (index, current) in items.iter().enumerate().rev() {
        if current == item {
            tx.list_remove(id, field, index)?;
            found = true;
        }
    }
    Ok(found)
}

/// Moves `moved` (in order, all in `items`, `items` being the list's raw content) to just before
/// `anchor` (an item not moved; `None`: the end), with at most one list move per occurrence.
/// Each moved item, from the last, is placed right before its successor in the target order, so
/// items not moved keep their order. Every occurrence of a moved item moves, so its first
/// occurrence (the one readers use) is where it was put; no occurrence is removed, which keeps
/// concurrent moves from losing an item.
fn place(
    tx: &mut Tx<'_>,
    id: &ObjectId,
    field: &str,
    mut items: Vec<ObjectId>,
    moved: &[ObjectId],
    anchor: Option<ObjectId>,
) -> Result<()> {
    let first = |items: &[ObjectId], wanted: &ObjectId| {
        items
            .iter()
            .position(|item| item == wanted)
            .ok_or(KitableError::NotFound)
    };
    let mut successor = anchor;
    for item in moved.iter().rev() {
        let count = items.iter().filter(|current| *current == item).count();
        for placed in 0..count {
            let before = match &successor {
                Some(next) => first(&items, next)?,
                None => items.len(),
            };
            // The occurrences already placed sit just before `before`.
            let block = before.saturating_sub(placed)..before;
            let from = items
                .iter()
                .enumerate()
                .position(|(index, current)| current == item && !block.contains(&index))
                .ok_or(KitableError::NotFound)?;
            let to = if from < before { before - 1 } else { before };
            if from != to {
                tx.list_move(id, field, from, to)?;
                let value = items.remove(from);
                items.insert(to, value);
            }
        }
        successor = Some(item.clone());
    }
    Ok(())
}

/// The ids, first occurrence only.
fn distinct(ids: &[ObjectId]) -> Vec<ObjectId> {
    let mut seen = HashSet::new();
    ids.iter().filter(|id| seen.insert(*id)).cloned().collect()
}

fn check_field_type(field_type: &str) -> Result<()> {
    if FIELD_TYPES.contains(&field_type) {
        Ok(())
    } else {
        Err(KitableError::invalid(format!(
            "unsupported field type {field_type:?}"
        )))
    }
}

/// Formula and AI values are written by Kition, never typed in.
fn forces_readonly(field_type: &str) -> bool {
    field_type == "formula" || field_type == "ai"
}

/// The registers of a new object, from a JSON object literal.
fn registers(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Adds an optional JSON register unless it is empty.
fn put_json(values: &mut Map<String, Value>, field: &str, value: &Value) -> Result<()> {
    let value = decode_json(value)?;
    if !value.is_null() {
        values.insert(field.to_owned(), value);
    }
    Ok(())
}

/// Refuses options or a config naming tables or fields by relational id
/// ([`KitableError::Invalid`]): the document holds object ids; convert with
/// [`super::options::options_to_kdm`].
fn object_ids_only(value: Value) -> Result<Value> {
    if let Some(key) = super::options::relational_key(&value) {
        return Err(KitableError::invalid(format!(
            "option {key} is a relational id; convert options with options_to_kdm"
        )));
    }
    Ok(value)
}

/// A JSON document as the relational API accepts it: a value, or a string holding encoded JSON
/// (blank: none). `null` means none. An invalid string is [`KitableError::Invalid`].
fn decode_json(value: &Value) -> Result<Value> {
    match value {
        Value::String(raw) => {
            let raw = raw.trim();
            if raw.is_empty() {
                return Ok(Value::Null);
            }
            serde_json::from_str(raw).map_err(|_| KitableError::invalid("invalid json string"))
        }
        other => Ok(other.clone()),
    }
}
