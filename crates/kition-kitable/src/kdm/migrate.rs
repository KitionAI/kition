//! Builds a table document's KDM replica from its schema-3 relational data: the migration.
//!
//! [`replica_from_relational`] only reads the file; [`upgrade`] does the one-time, idempotent
//! write into it (`ensure_tables`, build, record `kdm_id` on every live row, `save_initial`).
//! Neither function is wired into [`crate::KitableFile::open`] yet, and neither bumps
//! `SCHEMA_VERSION`: the legacy relational writers stay the source of truth until a later task
//! wires this migration into `open` and starts projecting the replica back onto the relational
//! tables.
//!
//! Tables, fields, and views get fresh object ids; a record's object id is its `row_key` (already
//! a KDM-shaped id by construction, but checked, since nothing else can tell a bad one apart from
//! a merge conflict later). Options and dashboard configs name tables and fields by relational
//! integer id; they are built in a first pass with those references stripped (so a table or field
//! referenced out of order does not need to exist yet), then resolved to object ids in a second
//! pass once every table and field has one, converting with
//! [`options_to_kdm`](super::options::options_to_kdm).

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use kition_core::now_millis;
use kition_kdm::{ActorId, DocId, KdmError, ObjectId, Origin, Replica, Tx};

use super::model::{self, RECORD, is_computed};
use super::options::{self, IdKind};
use super::{schema, store};
use crate::json;
use crate::source::{FieldSpec, TablePatch, TableSpec, ViewSpec};
use crate::{KitableError, Result};

/// The form of an object id the KDM accepts (mirrors a private check of `kition_kdm::tx`): a
/// record's `row_key` becomes its object id as is, so it must already match this pattern.
fn is_object_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && id.len() <= 128
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

/// Builds the replica of a schema-3 file's content (one creating commit, origin `system:migrate`).
///
/// The document id is the file's `kition_meta.document_id` when it parses as a UUID; otherwise a
/// new id is minted and the original string is kept at `Base.meta.legacy_document_id`.
pub fn replica_from_relational(conn: &Connection, actor: ActorId) -> Result<Replica> {
    Ok(build(conn, actor)?.replica)
}

/// Upgrades the file in place inside one SQL transaction: [`super::store::ensure_tables`], builds
/// the replica, records `kdm_id` on every live table, field, view, and link row (records already
/// use `row_key`), then [`super::store::save_initial`] (generation 1) and
/// [`super::store::set_projected_position`] to the replica's stored position. A failure anywhere
/// (for instance a record whose `row_key` is not a valid object id) leaves the file exactly as it
/// was: nothing commits.
///
/// Does not bump `SCHEMA_VERSION` (a later task does, together with wiring this into `open`). Does
/// not touch the normalised view-configuration tables (filter groups and conditions, sorts,
/// groups): a view's `config` already carries the UI's own representation, and those tables stay
/// in place.
///
/// Idempotent: a file that already has a `kition_kdm` row is left unchanged.
pub fn upgrade(conn: &mut Connection, actor: ActorId) -> Result<()> {
    if already_upgraded(conn)? {
        return Ok(());
    }
    let tx = conn.transaction()?;
    store::ensure_tables(&tx)?;
    let built = build(&tx, actor)?;
    for (id, object) in &built.assigned.tables {
        tx.execute(
            "UPDATE kition_tables SET kdm_id = ?1 WHERE id = ?2",
            params![object.as_str(), id],
        )?;
    }
    for (id, object) in &built.assigned.fields {
        tx.execute(
            "UPDATE kition_fields SET kdm_id = ?1 WHERE id = ?2",
            params![object.as_str(), id],
        )?;
    }
    for (id, object) in &built.assigned.views {
        tx.execute(
            "UPDATE kition_views SET kdm_id = ?1 WHERE id = ?2",
            params![object.as_str(), id],
        )?;
    }
    for (id, object) in &built.assigned.links {
        tx.execute(
            "UPDATE kition_record_links SET kdm_id = ?1 WHERE id = ?2",
            params![object.as_str(), id],
        )?;
    }
    store::save_initial(&tx, &built.replica, now_millis())?;
    let position = store::stored_position(&tx)?;
    store::set_projected_position(&tx, position)?;
    tx.commit()?;
    Ok(())
}

/// Whether [`upgrade`] has already run: `kition_kdm` exists and holds its one row. Tolerates a
/// file that predates the KDM tables entirely (no such table yet).
fn already_upgraded(conn: &Connection) -> Result<bool> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kition_kdm'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Ok(false);
    }
    Ok(conn
        .query_row("SELECT id FROM kition_kdm WHERE id = 1", [], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?
        .is_some())
}

/// The relational id of each table, field, view, and migrated link, paired with the object id
/// [`build`] assigned it, in creation order. Records are not here: their object id is their
/// `row_key`, already known without building anything.
#[derive(Default)]
struct Assigned {
    tables: Vec<(i64, ObjectId)>,
    fields: Vec<(i64, ObjectId)>,
    views: Vec<(i64, ObjectId)>,
    links: Vec<(i64, ObjectId)>,
}

struct Built {
    replica: Replica,
    assigned: Assigned,
}

fn to_kdm_error(err: KitableError) -> KdmError {
    KdmError::Engine(err.to_string())
}

fn build(conn: &Connection, actor: ActorId) -> Result<Built> {
    let document = document_row(conn)?;
    let (doc_id, legacy_document_id) = parse_doc_id(&document.id);
    let mut assigned = Assigned::default();
    let origin = Origin::system("migrate");
    let (replica, ()) = Replica::create_with(schema(), doc_id, actor, &origin, |tx| {
        build_content(
            tx,
            conn,
            &document,
            legacy_document_id.as_deref(),
            &mut assigned,
        )
        .map_err(to_kdm_error)
    })?;
    Ok(Built { replica, assigned })
}

fn parse_doc_id(document_id: &str) -> (DocId, Option<String>) {
    match DocId::parse(document_id) {
        Ok(id) => (id, None),
        Err(_) => (DocId::new(), Some(document_id.to_owned())),
    }
}

/// Builds the whole document in `tx`: the base, then each table's fields, views, and records in
/// relational position order, then (once every table and field has an object id) the id-valued
/// options those fields hold, then the record links.
fn build_content(
    tx: &mut Tx<'_>,
    conn: &Connection,
    document: &DocumentRow,
    legacy_document_id: Option<&str>,
    assigned: &mut Assigned,
) -> Result<()> {
    let mut meta = json::object(&document.meta_json);
    if let Some(legacy_id) = legacy_document_id {
        meta.insert(
            "legacy_document_id".to_owned(),
            Value::String(legacy_id.to_owned()),
        );
    }
    let base = model::create_base(
        tx,
        &model::BaseSpec {
            title: document.title.clone(),
            description: document.description.clone(),
            icon: document.icon.clone(),
            color: document.color.clone(),
            meta: Value::Object(meta),
        },
    )?;

    let mut table_object_by_id: HashMap<i64, ObjectId> = HashMap::new();
    let mut field_object_by_id: HashMap<i64, ObjectId> = HashMap::new();
    let mut record_object_by_id: HashMap<i64, ObjectId> = HashMap::new();
    // Field options that named a table or field by relational id, deferred until every table and
    // field of the document has an object id (a link may target a table not created yet).
    let mut pending_options: Vec<(ObjectId, Value)> = Vec::new();

    for table in table_rows(conn)? {
        let fields = field_rows(conn, table.id)?;
        let field_specs: Vec<FieldSpec> = fields
            .iter()
            .map(|field| FieldSpec {
                name: field.name.clone(),
                title: field.title.clone(),
                field_type: field.field_type.clone(),
                primary: false,
                required: field.required,
                readonly: field.readonly,
                options: strip_relational_ids(&field.options),
                formula: field.formula.clone(),
                ai_prompt: field.ai_prompt.clone(),
                meta: Value::Object(json::object(&field.meta_json)),
                order: None,
            })
            .collect();
        let views = view_rows(conn, table.id)?;
        let view_specs: Vec<ViewSpec> = views
            .iter()
            .map(|view| ViewSpec {
                title: view.title.clone(),
                view_type: view.view_type.clone(),
                config: view.config.clone(),
            })
            .collect();
        let table_spec = TableSpec {
            name: table.name.clone(),
            title: table.title.clone(),
            description: table.description.clone(),
            fields: field_specs,
            views: view_specs,
            meta: Value::Object(json::object(&table.meta_json)),
        };
        let ids = model::create_table(tx, &base, &table_spec, None)?;
        table_object_by_id.insert(table.id, ids.table.clone());
        assigned.tables.push((table.id, ids.table.clone()));

        for (field, object) in fields.iter().zip(&ids.fields) {
            field_object_by_id.insert(field.id, object.clone());
            assigned.fields.push((field.id, object.clone()));
            if options::relational_key(&field.options).is_some() {
                pending_options.push((object.clone(), field.options.clone()));
            }
        }
        if let Some(primary_id) = table.primary_field_id
            && let Some(primary) = field_object_by_id.get(&primary_id)
        {
            model::update_table(tx, &ids.table, &TablePatch::default(), Some(primary))?;
        }

        for (view, object) in views.iter().zip(&ids.views) {
            assigned.views.push((view.id, object.clone()));
            if view.locked {
                tx.set(object, "locked", Value::Bool(true))?;
            }
            for layout in view_field_rows(conn, view.id)? {
                let Some(field_object) = field_object_by_id.get(&layout.field_id) else {
                    continue;
                };
                model::set_view_width(tx, object, field_object, layout.width)?;
                if !layout.visible {
                    model::set_view_hidden(tx, object, field_object, true)?;
                }
            }
        }

        for (index, record) in record_rows(conn, table.id)?.into_iter().enumerate() {
            if !is_object_id(&record.row_key) {
                return Err(KitableError::invalid(format!(
                    "record {} of table {:?} has a row_key that is not a valid KDM object id",
                    record.row_key, table.title
                )));
            }
            let id = ObjectId::from_string(record.row_key.clone());
            let mut created = Map::new();
            created.insert("createdAt".to_owned(), json!(record.created_at));
            created.insert(
                "createdBy".to_owned(),
                Value::String(record.created_by.clone()),
            );
            tx.create_with_id(RECORD, &id, created)?;
            tx.list_insert(&ids.table, "records", index, &id)?;
            for (name, value) in &record.values {
                if value.is_null() {
                    continue;
                }
                let Some(field) = fields.iter().find(|field| &field.name == name) else {
                    continue;
                };
                if is_computed(&field.field_type) {
                    continue;
                }
                let Some(field_object) = field_object_by_id.get(&field.id) else {
                    continue;
                };
                tx.map_set(&id, "cells", field_object.as_str(), value.clone())?;
            }
            record_object_by_id.insert(record.id, id);
        }
    }

    for (field_object, raw_options) in pending_options {
        let resolved = options::options_to_kdm(&raw_options, |kind, id| match kind {
            IdKind::Table => table_object_by_id.get(&id).cloned(),
            IdKind::Field => field_object_by_id.get(&id).cloned(),
        })?;
        tx.set(&field_object, "options", resolved)?;
    }

    for link in link_rows(conn)? {
        let (Some(from), Some(field), Some(to)) = (
            record_object_by_id.get(&link.from_record_id),
            field_object_by_id.get(&link.from_field_id),
            record_object_by_id.get(&link.to_record_id),
        ) else {
            // One of the ends is a soft-deleted record or field: not migrated, so neither is this
            // link.
            continue;
        };
        let object = model::add_link(tx, from, field, to)?;
        assigned.links.push((link.id, object));
    }

    Ok(())
}

/// `options` with every id-valued key of [`options::ID_KEYS`] removed (top-level and inside
/// `ai_config`), so [`model::create_field`] accepts it before the second pass resolves ids that
/// may name a table or field created later. Everything else is kept.
fn strip_relational_ids(options: &Value) -> Value {
    let Value::Object(map) = options else {
        return options.clone();
    };
    let mut out = map.clone();
    for id_key in options::ID_KEYS {
        match id_key.parent {
            None => {
                out.remove(id_key.relational);
            }
            Some(parent) => {
                if let Some(Value::Object(inner)) = out.get_mut(parent) {
                    inner.remove(id_key.relational);
                }
            }
        }
    }
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// Relational rows.

struct DocumentRow {
    id: String,
    title: String,
    description: String,
    icon: String,
    color: String,
    meta_json: String,
}

struct TableRow {
    id: i64,
    name: String,
    title: String,
    description: String,
    meta_json: String,
    primary_field_id: Option<i64>,
}

struct FieldRow {
    id: i64,
    name: String,
    title: String,
    field_type: String,
    required: bool,
    readonly: bool,
    options: Value,
    formula: String,
    ai_prompt: String,
    meta_json: String,
}

struct ViewRow {
    id: i64,
    title: String,
    view_type: String,
    locked: bool,
    config: Value,
}

struct ViewFieldRow {
    field_id: i64,
    visible: bool,
    width: i64,
}

struct RecordRow {
    id: i64,
    row_key: String,
    values: Map<String, Value>,
    created_at: i64,
    created_by: String,
}

struct LinkRow {
    id: i64,
    from_record_id: i64,
    from_field_id: i64,
    to_record_id: i64,
}

fn document_row(conn: &Connection) -> Result<DocumentRow> {
    let document_id: String = conn.query_row(
        "SELECT value FROM kition_meta WHERE key = 'document_id'",
        [],
        |row| row.get(0),
    )?;
    Ok(conn.query_row(
        "SELECT id, title, description, icon, color, meta_json FROM kition_documents \
         WHERE id = ?1 AND deleted_at IS NULL",
        [&document_id],
        |row| {
            Ok(DocumentRow {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                icon: row.get(3)?,
                color: row.get(4)?,
                meta_json: row.get(5)?,
            })
        },
    )?)
}

fn table_rows(conn: &Connection) -> Result<Vec<TableRow>> {
    let mut statement = conn.prepare(
        "SELECT id, name, title, description, meta_json, primary_field_id FROM kition_tables \
         WHERE deleted_at IS NULL ORDER BY position ASC, id ASC",
    )?;
    Ok(statement
        .query_map([], |row| {
            Ok(TableRow {
                id: row.get(0)?,
                name: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                meta_json: row.get(4)?,
                primary_field_id: row.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn field_rows(conn: &Connection, table_id: i64) -> Result<Vec<FieldRow>> {
    let mut statement = conn.prepare(
        "SELECT id, name, title, type, required, readonly, options_json, formula, ai_prompt, meta_json \
         FROM kition_fields WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position ASC, id ASC",
    )?;
    Ok(statement
        .query_map([table_id], |row| {
            let options_json: String = row.get(6)?;
            Ok(FieldRow {
                id: row.get(0)?,
                name: row.get(1)?,
                title: row.get(2)?,
                field_type: row.get(3)?,
                required: row.get::<_, i64>(4)? != 0,
                readonly: row.get::<_, i64>(5)? != 0,
                options: Value::Object(json::object(&options_json)),
                formula: row.get(7)?,
                ai_prompt: row.get(8)?,
                meta_json: row.get(9)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn view_rows(conn: &Connection, table_id: i64) -> Result<Vec<ViewRow>> {
    let mut statement = conn.prepare(
        "SELECT id, title, type, locked, config_json FROM kition_views \
         WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position ASC, id ASC",
    )?;
    Ok(statement
        .query_map([table_id], |row| {
            let config_json: String = row.get(4)?;
            Ok(ViewRow {
                id: row.get(0)?,
                title: row.get(1)?,
                view_type: row.get(2)?,
                locked: row.get::<_, i64>(3)? != 0,
                config: Value::Object(json::object(&config_json)),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn view_field_rows(conn: &Connection, view_id: i64) -> Result<Vec<ViewFieldRow>> {
    let mut statement =
        conn.prepare("SELECT field_id, visible, width FROM kition_view_fields WHERE view_id = ?1")?;
    Ok(statement
        .query_map([view_id], |row| {
            Ok(ViewFieldRow {
                field_id: row.get(0)?,
                visible: row.get::<_, i64>(1)? != 0,
                width: row.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn record_rows(conn: &Connection, table_id: i64) -> Result<Vec<RecordRow>> {
    let mut statement = conn.prepare(
        "SELECT id, row_key, values_json, created_at, created_by FROM kition_records \
         WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position ASC, id ASC",
    )?;
    Ok(statement
        .query_map([table_id], |row| {
            let values_json: String = row.get(2)?;
            Ok(RecordRow {
                id: row.get(0)?,
                row_key: row.get(1)?,
                values: json::object(&values_json),
                created_at: row.get(3)?,
                created_by: row.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn link_rows(conn: &Connection) -> Result<Vec<LinkRow>> {
    let mut statement = conn.prepare(
        "SELECT id, from_record_id, from_field_id, to_record_id FROM kition_record_links \
         ORDER BY id ASC",
    )?;
    Ok(statement
        .query_map([], |row| {
            Ok(LinkRow {
                id: row.get(0)?,
                from_record_id: row.get(1)?,
                from_field_id: row.get(2)?,
                to_record_id: row.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}
