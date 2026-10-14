//! The projector from a table's KDM replica to its relational tables.
//!
//! The equivalence test applies one seeded random operation sequence twice: through the legacy
//! `KitableFile` methods on one file, and through the model on a replica projected into a second
//! file. Both files must then read the same through the public read methods, ignoring timestamps,
//! actors, and integer ids (mapped by names and row keys). Where the legacy path is known to be
//! wrong and the KDM design fixes it, the sequence avoids the case or normalizes it, and a
//! targeted test asserts the new behavior:
//!
//! - Legacy derived values go stale: a lookup, rollup, or link chip refreshes only when its own
//!   record is saved, and a formula or schema change refreshes nothing. After each operation the
//!   test re-saves every legacy record until nothing changes, which is what the next edits of the
//!   records do; the projector refreshes dependents itself
//!   (`a_lookup_refreshes_when_its_target_record_changes`).
//! - Legacy `values_json` keeps a deleted field's value until the record is saved again (the
//!   re-save above drops it); the projection drops it at once
//!   (`deleting_a_field_drops_its_values_at_once`).
//! - Legacy positions are sparse (`MAX(position) + 1` over deleted rows too) and a move writes a
//!   raw position; the projection numbers live items 1..n. Only the order is compared, and moves
//!   go to the end, which both express.
//! - Replacing links rewrites the legacy rows in the given order; the model keeps existing links
//!   and appends new ones, so replacements here keep kept targets in their order.
//! - Field type changes between stored and computed types: the model keeps the stored cells under
//!   a computed type (they show again after changing back), legacy overwrites them. Only
//!   stored-to-stored changes are generated.
//! - Deleting a link field: legacy keeps its link rows, and lookups through it still read them;
//!   the model deletes the links. Link fields a lookup or rollup uses are not deleted.
//! - A link field whose target table is gone makes legacy derivation fail for its whole record;
//!   tables other tables link to are not deleted.
//! - Changing `allow_multiple` to false: the model shows one link per record (the single-target
//!   merge rule), legacy keeps showing all. Not generated.
//! - Options naming a deleted table or field: legacy keeps the integer id; the projection keeps it
//!   while that row exists, and a rebuild into an empty file has no such row (null). Options
//!   naming a row that is not live compare as null.
//! - A formula reading a value derived after it: legacy evaluates formulas over the record's
//!   previous derived values, so it settles after re-saves; the projection evaluates such a
//!   formula again once the later value is known (`a_formula_reads_values_derived_after_it`).
//! - A rollup whose target field is gone aggregates whole records (legacy and projection alike);
//!   over a link back to its own table such a rollup feeds on itself and never settles, and both
//!   stop at an arbitrary depth. Rollup targets are not deleted.
//! - Filter trees, sorts, and groups have their own legacy tables, which the model does not have.
//!
//! At the end of each sequence, a rebuild into an empty file and a rebuild in place must match
//! the incremental projection (ids kept), and a migrated copy of the legacy file
//! ([`migrate::upgrade`]) rebuilt in place must still read like the legacy file, with the ids the
//! migration recorded. Tables keep at least one view: the migration gives a table without views
//! a default "All" view, which a rebuild would then add.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::{Debug, Display};
use std::path::Path;
use std::time::Instant;

use kition_kdm::testing::Rng;
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Tx};
use kition_kitable::kdm::model::{self, BaseSpec, TableIds};
use kition_kitable::kdm::project::{self, TableChange};
use kition_kitable::kdm::read::ModelView;
use kition_kitable::kdm::{migrate, repair, schema, store};
use kition_kitable::{
    CreateOptions, Field, FieldPatch, FieldSpec, KitableFile, Table, TablePatch, TableSpec,
    ViewFieldPatch, ViewPatch, ViewSpec,
};
use rusqlite::params;
use serde_json::{Map, Value, json};

fn ok<T, E: Display>(result: Result<T, E>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

fn some<T>(value: Option<T>, what: &str) -> T {
    value.unwrap_or_else(|| panic!("missing {what}"))
}

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"))
}

fn person() -> Origin {
    Origin::person("user:test")
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// A new schema-3 file; with `kdm`, also the KDM tables and columns.
fn new_file(dir: &Path, name: &str, kdm: bool) -> KitableFile {
    let file = ok(KitableFile::create(
        &dir.join(name),
        &CreateOptions {
            title: "Test".into(),
            ..Default::default()
        },
    ));
    if kdm {
        ok(store::ensure_tables(file.conn()));
    }
    file
}

fn new_replica(actor: u64) -> Replica {
    ok(Replica::create(
        schema(),
        DocId::new(),
        ok(ActorId::from_u64(actor)),
    ))
}

fn write<R>(replica: &mut Replica, f: impl FnOnce(&mut Tx<'_>) -> kition_kitable::Result<R>) -> R {
    ok(model::transact(replica, &person(), f))
}

fn base_in(replica: &mut Replica) -> ObjectId {
    write(replica, |tx| {
        model::create_base(
            tx,
            &BaseSpec {
                title: "Test".into(),
                ..BaseSpec::default()
            },
        )
    })
}

/// Projects what changed in `replica` since the last call into `file`, in one SQL transaction.
fn project_into(file: &KitableFile, replica: &mut Replica, actor: &str, now: i64) -> TableChange {
    let changed = replica.take_changed();
    let tx = ok(file.conn().unchecked_transaction());
    let change = ok(project::project_changes(&tx, replica, &changed, actor, now));
    ok(tx.commit());
    change
}

fn rebuild_into(file: &KitableFile, replica: &Replica, now: i64) {
    let tx = ok(file.conn().unchecked_transaction());
    ok(project::rebuild(&tx, replica, now));
    ok(tx.commit());
}

fn field(title: &str, field_type: &str) -> FieldSpec {
    FieldSpec {
        title: title.into(),
        field_type: field_type.into(),
        ..FieldSpec::default()
    }
}

fn primary(title: &str) -> FieldSpec {
    FieldSpec {
        primary: true,
        required: true,
        ..field(title, "text")
    }
}

fn table_spec(title: &str, fields: Vec<FieldSpec>) -> TableSpec {
    TableSpec {
        title: title.into(),
        fields,
        ..TableSpec::default()
    }
}

fn nth<T: Clone + Debug>(items: &[T], index: usize) -> T {
    items
        .get(index)
        .cloned()
        .unwrap_or_else(|| panic!("no item {index} in {items:?}"))
}

// ---------------------------------------------------------------------------
// Snapshots: what the read methods show, with ids replaced by names and row keys by labels.

#[derive(Debug, PartialEq)]
struct Snapshot {
    title: String,
    tables: Vec<TableSnap>,
    /// History of records that are deleted, by record label.
    deleted: BTreeMap<String, Vec<HistorySnap>>,
}

#[derive(Debug, PartialEq)]
struct TableSnap {
    name: String,
    title: String,
    description: String,
    meta: Value,
    primary: Option<String>,
    fields: Vec<FieldSnap>,
    views: Vec<ViewSnap>,
    records: Vec<RecordSnap>,
}

#[derive(Debug, PartialEq)]
struct FieldSnap {
    name: String,
    title: String,
    field_type: String,
    required: bool,
    unique: bool,
    readonly: bool,
    is_primary: bool,
    options: Value,
    formula: String,
    ai_prompt: String,
    meta: Value,
}

#[derive(Debug, PartialEq)]
struct ViewSnap {
    title: String,
    view_type: String,
    locked: bool,
    config: Value,
    /// `(field, visible, width, position, frozen)` of live fields, by field name.
    fields: Vec<(String, bool, i64, i64, bool)>,
}

#[derive(Debug, PartialEq)]
struct RecordSnap {
    key: String,
    values: Value,
    links: Vec<(String, Vec<(String, String)>)>,
    history: Vec<HistorySnap>,
}

#[derive(Debug, PartialEq)]
struct HistorySnap {
    field: Option<String>,
    action: String,
    before: Value,
    after: Value,
}

/// Names of live tables and fields by integer id (fields as `table.field`), and the plain name of
/// every field row, live or not.
struct Names {
    tables: HashMap<i64, String>,
    fields: HashMap<i64, String>,
    any_field: HashMap<i64, String>,
}

fn names(file: &KitableFile) -> Names {
    let conn = file.conn();
    let mut tables = HashMap::new();
    let mut statement =
        ok(conn.prepare("SELECT id, name FROM kition_tables WHERE deleted_at IS NULL"));
    let rows = ok(statement.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    }));
    for row in rows {
        let (id, name) = ok(row);
        tables.insert(id, name);
    }
    let mut fields = HashMap::new();
    let mut any_field = HashMap::new();
    let mut statement = ok(conn.prepare(
        "SELECT f.id, t.name, f.name, f.deleted_at IS NULL AND t.deleted_at IS NULL \
         FROM kition_fields f JOIN kition_tables t ON t.id = f.table_id",
    ));
    let rows = ok(statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, bool>(3)?,
        ))
    }));
    for row in rows {
        let (id, table, name, live) = ok(row);
        if live {
            fields.insert(id, format!("{table}.{name}"));
        }
        any_field.insert(id, name);
    }
    Names {
        tables,
        fields,
        any_field,
    }
}

/// Row keys to labels; a key without a label stands for itself.
struct Labels(HashMap<String, String>);

impl Labels {
    fn identity() -> Self {
        Self(HashMap::new())
    }

    fn of(&self, key: &str) -> String {
        self.0.get(key).cloned().unwrap_or_else(|| key.to_owned())
    }

    /// Numbers as floats, row keys as labels, recursively.
    fn value(&self, value: &Value) -> Value {
        match value {
            Value::Number(number) => Value::from(number.as_f64().unwrap_or_default()),
            Value::String(text) => Value::String(self.of(text)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.value(item)).collect())
            }
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), self.value(item)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// A record's values: top-level nulls dropped (legacy stores cleared cells as null).
    fn values(&self, values: &Value) -> Value {
        match values {
            Value::Object(map) => Value::Object(
                map.iter()
                    .filter(|(_, value)| !value.is_null())
                    .map(|(key, value)| (key.clone(), self.value(value)))
                    .collect(),
            ),
            other => self.value(other),
        }
    }
}

fn options_snap(options: &Map<String, Value>, names: &Names, labels: &Labels) -> Value {
    let mut out = Map::new();
    for (key, value) in options {
        let id = value.as_i64();
        let named = |map: &HashMap<i64, String>| {
            id.and_then(|id| map.get(&id))
                .map_or(Value::Null, |name| Value::String(name.clone()))
        };
        let mapped = match key.as_str() {
            "target_table_id" | "source_table_id" => named(&names.tables),
            "link_field_id" | "target_field_id" | "symmetric_field_id" => named(&names.fields),
            _ => labels.value(value),
        };
        out.insert(key.clone(), mapped);
    }
    Value::Object(out)
}

fn history_snap(
    file: &KitableFile,
    table_id: i64,
    record_id: i64,
    names: &Names,
    labels: &Labels,
) -> Vec<HistorySnap> {
    let (entries, _) = ok(file.list_record_history(table_id, record_id, 0, 0));
    entries
        .into_iter()
        .map(|entry| HistorySnap {
            field: entry
                .field_id
                .map(|id| names.any_field.get(&id).cloned().unwrap_or_default()),
            action: entry.action,
            before: labels.values(&entry.before),
            after: labels.values(&entry.after),
        })
        .collect()
}

fn snapshot(file: &KitableFile, labels: &Labels, with_history: bool) -> Snapshot {
    let names = names(file);
    let mut tables = Vec::new();
    for table in ok(file.list_tables()) {
        let live: HashSet<i64> = table.fields.iter().map(|field| field.id).collect();
        let fields = table
            .fields
            .iter()
            .map(|field| FieldSnap {
                name: field.name.clone(),
                title: field.title.clone(),
                field_type: field.field_type.clone(),
                required: field.required,
                unique: field.unique,
                readonly: field.readonly,
                is_primary: field.is_primary,
                options: options_snap(&field.options, &names, labels),
                formula: field.formula.clone(),
                ai_prompt: field.ai_prompt.clone(),
                meta: Value::Object(field.meta.clone()),
            })
            .collect();
        let views = table
            .views
            .iter()
            .map(|view| {
                let mut fields: Vec<_> = ok(file.list_view_fields(view.id))
                    .into_iter()
                    .filter(|layout| live.contains(&layout.field_id))
                    .map(|layout| {
                        (
                            names
                                .fields
                                .get(&layout.field_id)
                                .cloned()
                                .unwrap_or_default(),
                            layout.visible,
                            layout.width,
                            layout.position,
                            layout.frozen,
                        )
                    })
                    .collect();
                fields.sort();
                ViewSnap {
                    title: view.title.clone(),
                    view_type: view.view_type.clone(),
                    locked: view.locked,
                    config: Value::Object(view.config.clone()),
                    fields,
                }
            })
            .collect();
        let records = ok(file.list_records(table.id))
            .into_iter()
            .map(|record| {
                let links = table
                    .fields
                    .iter()
                    .filter(|field| field.field_type == "link_to_record")
                    .map(|field| {
                        let refs = ok(file.list_record_links(table.id, record.id, field.id))
                            .into_iter()
                            .map(|link| (labels.of(&link.row_key), link.display))
                            .collect();
                        (field.name.clone(), refs)
                    })
                    .collect();
                let history = if with_history {
                    history_snap(file, table.id, record.id, &names, labels)
                } else {
                    Vec::new()
                };
                RecordSnap {
                    key: labels.of(&record.row_key),
                    values: labels.values(&Value::Object(record.values)),
                    links,
                    history,
                }
            })
            .collect();
        tables.push(TableSnap {
            primary: table
                .primary_field_id
                .and_then(|id| names.fields.get(&id).cloned()),
            name: table.name,
            title: table.title,
            description: table.description,
            meta: Value::Object(table.meta),
            fields,
            views,
            records,
        });
    }
    let mut deleted = BTreeMap::new();
    if with_history {
        let mut statement = ok(file.conn().prepare(
            "SELECT id, table_id, row_key FROM kition_records WHERE deleted_at IS NOT NULL",
        ));
        let rows = ok(statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        }));
        for row in rows {
            let (id, table_id, key) = ok(row);
            deleted.insert(
                labels.of(&key),
                history_snap(file, table_id, id, &names, labels),
            );
        }
    }
    Snapshot {
        title: ok(file.info()).title,
        tables,
        deleted,
    }
}

/// Panics with the first lines where the two snapshots differ.
fn assert_same(left: &Snapshot, right: &Snapshot, context: &str) {
    if left == right {
        return;
    }
    let left = format!("{left:#?}");
    let right = format!("{right:#?}");
    let left_lines: Vec<&str> = left.lines().collect();
    let right_lines: Vec<&str> = right.lines().collect();
    let first = left_lines
        .iter()
        .zip(&right_lines)
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| left_lines.len().min(right_lines.len()));
    let from = first.saturating_sub(25);
    let excerpt = |lines: &[&str]| {
        lines
            .iter()
            .skip(from)
            .take(40)
            .copied()
            .collect::<Vec<_>>()
            .join("\n")
    };
    panic!(
        "{context}: snapshots differ at line {first}\n--- left ---\n{}\n--- right ---\n{}",
        excerpt(&left_lines),
        excerpt(&right_lines)
    );
}

/// Integer ids of the projected rows by object id: live tables, fields, views, and records, and
/// links that have an object id.
fn projected_ids(file: &KitableFile) -> BTreeMap<String, i64> {
    connection_ids(file.conn())
}

fn connection_ids(conn: &rusqlite::Connection) -> BTreeMap<String, i64> {
    let mut ids = BTreeMap::new();
    for (table, key, filter) in [
        ("kition_tables", "kdm_id", "deleted_at IS NULL"),
        ("kition_fields", "kdm_id", "deleted_at IS NULL"),
        ("kition_views", "kdm_id", "deleted_at IS NULL"),
        ("kition_record_links", "kdm_id", "kdm_id IS NOT NULL"),
        ("kition_records", "row_key", "deleted_at IS NULL"),
    ] {
        let mut statement =
            ok(conn.prepare(&format!("SELECT {key}, id FROM {table} WHERE {filter}")));
        let rows = ok(statement.query_map([], |row| {
            Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?))
        }));
        for row in rows {
            let (key, id) = ok(row);
            ids.insert(format!("{table}:{}", key.unwrap_or_default()), id);
        }
    }
    ids
}

// ---------------------------------------------------------------------------
// The twin: one legacy file and one projected replica, driven by the same operations.

const STORED: [&str; 5] = ["text", "long_text", "number", "checkbox", "single_select"];
const TABLE_TITLES: [&str; 4] = ["Tasks", "People", "Tasks", "Projects"];
const FIELD_TITLES: [&str; 5] = ["Status", "Score", "Owner", "Due", "Status"];
const AGGREGATIONS: [&str; 8] = ["count", "sum", "avg", "max", "min", "and", "or", "concat"];

#[derive(Debug, Clone)]
enum Opts {
    None,
    Select,
    Link {
        target_table: String,
        single: bool,
    },
    Lookup {
        link_field: String,
        target_table: String,
        target_field: String,
        concat: bool,
    },
    Rollup {
        link_field: String,
        target_table: String,
        target_field: Option<String>,
        aggregation: String,
    },
}

#[derive(Debug, Clone)]
enum Op {
    CreateTable {
        title: String,
        custom: bool,
    },
    UpdateTable {
        table: String,
        title: Option<String>,
        description: Option<String>,
        meta: Option<Value>,
        primary: Option<String>,
    },
    DeleteTable {
        table: String,
    },
    CreateField {
        table: String,
        title: String,
        field_type: String,
        options: Opts,
        formula: String,
        after: Option<String>,
    },
    UpdateField {
        table: String,
        field: String,
        title: Option<String>,
        field_type: Option<String>,
        formula: Option<String>,
        options: Option<Opts>,
        primary: bool,
    },
    DeleteField {
        table: String,
        field: String,
    },
    CreateView {
        table: String,
        title: String,
        view_type: String,
        config: Value,
    },
    UpdateView {
        table: String,
        view: usize,
        title: Option<String>,
        view_type: Option<String>,
        config: Option<Value>,
    },
    DeleteView {
        table: String,
        view: usize,
    },
    ViewWidth {
        table: String,
        view: usize,
        field: String,
        width: i64,
    },
    ViewHidden {
        table: String,
        view: usize,
        field: String,
        hidden: bool,
    },
    CreateRecord {
        table: String,
        values: Map<String, Value>,
    },
    UpdateRecord {
        table: String,
        record: usize,
        values: Map<String, Value>,
    },
    DeleteRecord {
        table: String,
        record: usize,
    },
    MoveRecord {
        table: String,
        record: usize,
    },
    ReplaceLinks {
        table: String,
        record: usize,
        field: String,
        targets: Vec<usize>,
    },
}

/// A legacy table with its records' labels in order.
struct TableState {
    table: Table,
    records: Vec<usize>,
}

struct Twin {
    legacy: KitableFile,
    proj: KitableFile,
    replica: Replica,
    base: ObjectId,
    /// `(legacy row key, model row key)` per record, by label index.
    keys: Vec<(String, String)>,
    clock: i64,
}

fn pick<'a, T>(rng: &mut Rng, items: &'a [T]) -> Option<&'a T> {
    if items.is_empty() {
        None
    } else {
        items.get(rng.below(items.len()))
    }
}

fn coin(rng: &mut Rng, percent: usize) -> bool {
    rng.below(100) < percent
}

fn is_stored(field: &Field) -> bool {
    STORED.contains(&field.field_type.as_str())
}

fn value_for(rng: &mut Rng, field: &Field) -> Value {
    if field.required {
        return json!(format!("n{}", rng.below(4)));
    }
    match field.field_type.as_str() {
        "number" => json!(rng.below(6)),
        "checkbox" => json!(rng.below(2) == 1),
        "single_select" => json!(["a", "b", "c"][rng.below(3)]),
        _ => json!(format!("v{}", rng.below(4))),
    }
}

impl Twin {
    fn new(dir: &Path) -> Self {
        let legacy = new_file(dir, "legacy.kitable", false);
        let proj = new_file(dir, "proj.kitable", true);
        let mut replica = new_replica(1);
        let base = base_in(&mut replica);
        let mut twin = Self {
            legacy,
            proj,
            replica,
            base,
            keys: Vec::new(),
            clock: 1_000,
        };
        twin.project();
        twin
    }

    fn project(&mut self) -> TableChange {
        self.clock += 1;
        project_into(&self.proj, &mut self.replica, "user:test", self.clock)
    }

    fn write<R>(&mut self, f: impl FnOnce(&mut Tx<'_>) -> kition_kitable::Result<R>) -> R {
        let out = write(&mut self.replica, f);
        self.project();
        out
    }

    fn legacy_labels(&self) -> Labels {
        Labels(
            self.keys
                .iter()
                .enumerate()
                .map(|(index, (key, _))| (key.clone(), format!("r{index}")))
                .collect(),
        )
    }

    fn model_labels(&self) -> Labels {
        Labels(
            self.keys
                .iter()
                .enumerate()
                .map(|(index, (_, key))| (key.clone(), format!("r{index}")))
                .collect(),
        )
    }

    fn check(&self, context: &str) {
        let legacy = snapshot(&self.legacy, &self.legacy_labels(), true);
        let projected = snapshot(&self.proj, &self.model_labels(), true);
        assert_same(&legacy, &projected, context);
    }

    // Legacy lookups.

    fn l_table(&self, name: &str) -> Table {
        some(
            ok(self.legacy.list_tables())
                .into_iter()
                .find(|table| table.name == name),
            name,
        )
    }

    fn l_field(&self, table: &str, name: &str) -> Field {
        some(
            self.l_table(table)
                .fields
                .into_iter()
                .find(|field| field.name == name),
            name,
        )
    }

    fn l_record(&self, table_id: i64, index: usize) -> i64 {
        let key = &nth(&self.keys, index).0;
        some(
            ok(self.legacy.list_records(table_id))
                .into_iter()
                .find(|record| &record.row_key == key),
            key,
        )
        .id
    }

    fn l_options(&self, table: &str, options: &Opts) -> Value {
        match options {
            Opts::None => Value::Null,
            Opts::Select => json!({ "choices": ["a", "b", "c"] }),
            Opts::Link {
                target_table,
                single,
            } => {
                let mut out = json!({ "target_table_id": self.l_table(target_table).id });
                if *single {
                    out["allow_multiple"] = json!(false);
                }
                out
            }
            Opts::Lookup {
                link_field,
                target_table,
                target_field,
                concat,
            } => {
                let mut out = json!({
                    "link_field_id": self.l_field(table, link_field).id,
                    "target_field_id": self.l_field(target_table, target_field).id,
                });
                if *concat {
                    out["multi_value_mode"] = json!("concat");
                }
                out
            }
            Opts::Rollup {
                link_field,
                target_table,
                target_field,
                aggregation,
            } => {
                let mut out = json!({
                    "link_field_id": self.l_field(table, link_field).id,
                    "aggregation": aggregation,
                });
                if let Some(target) = target_field {
                    out["target_field_id"] = json!(self.l_field(target_table, target).id);
                }
                out
            }
        }
    }

    // Model lookups.

    fn m_table(&self, name: &str) -> ObjectId {
        let view = ModelView::new(&self.replica);
        some(
            ok(view.tables())
                .into_iter()
                .find(|table| ok(view.table(table)).name == name),
            name,
        )
    }

    fn m_field(&self, table: &str, name: &str) -> ObjectId {
        let view = ModelView::new(&self.replica);
        some(ok(view.field_by_name(&self.m_table(table), name)), name)
    }

    fn m_field_index(&self, table: &str, name: &str) -> usize {
        let view = ModelView::new(&self.replica);
        let fields = ok(view.fields(&self.m_table(table)));
        some(fields.iter().position(|field| field.name == name), name)
    }

    fn m_view(&self, table: &str, index: usize) -> ObjectId {
        let view = ModelView::new(&self.replica);
        nth(&ok(view.views(&self.m_table(table))), index).id
    }

    fn m_record(&self, index: usize) -> ObjectId {
        ObjectId::from_string(nth(&self.keys, index).1)
    }

    fn m_cells(&self, table: &str, values: &Map<String, Value>) -> Map<String, Value> {
        values
            .iter()
            .map(|(name, value)| (self.m_field(table, name).to_string(), value.clone()))
            .collect()
    }

    fn m_options(&self, table: &str, options: &Opts) -> Value {
        match options {
            Opts::None => Value::Null,
            Opts::Select => json!({ "choices": ["a", "b", "c"] }),
            Opts::Link {
                target_table,
                single,
            } => {
                let mut out = json!({ "target_table": self.m_table(target_table).as_str() });
                if *single {
                    out["allow_multiple"] = json!(false);
                }
                out
            }
            Opts::Lookup {
                link_field,
                target_table,
                target_field,
                concat,
            } => {
                let mut out = json!({
                    "link_field": self.m_field(table, link_field).as_str(),
                    "target_field": self.m_field(target_table, target_field).as_str(),
                });
                if *concat {
                    out["multi_value_mode"] = json!("concat");
                }
                out
            }
            Opts::Rollup {
                link_field,
                target_table,
                target_field,
                aggregation,
            } => {
                let mut out = json!({
                    "link_field": self.m_field(table, link_field).as_str(),
                    "aggregation": aggregation,
                });
                if let Some(target) = target_field {
                    out["target_field"] = json!(self.m_field(target_table, target).as_str());
                }
                out
            }
        }
    }

    /// Re-saves every legacy record until no derived value changes (at most eight passes).
    fn refresh_legacy(&mut self) {
        let values = |legacy: &KitableFile| -> Vec<Value> {
            ok(legacy.list_tables())
                .iter()
                .flat_map(|table| ok(legacy.list_records(table.id)))
                .map(|record| Value::Object(record.values))
                .collect()
        };
        let mut before = values(&self.legacy);
        for _ in 0..8 {
            for table in ok(self.legacy.list_tables()) {
                for record in ok(self.legacy.list_records(table.id)) {
                    ok(self
                        .legacy
                        .update_record(table.id, record.id, &Map::new(), None));
                }
            }
            let after = values(&self.legacy);
            if after == before {
                return;
            }
            before = after;
        }
    }

    fn apply(&mut self, op: &Op) {
        match op {
            Op::CreateTable { title, custom } => {
                let spec = if *custom {
                    TableSpec {
                        title: title.clone(),
                        fields: vec![
                            primary("Title"),
                            field("Count", "number"),
                            field("Done", "checkbox"),
                        ],
                        views: vec![
                            ViewSpec {
                                title: "Grid".into(),
                                view_type: "grid".into(),
                                config: Value::Null,
                            },
                            ViewSpec {
                                title: "Board".into(),
                                view_type: "kanban".into(),
                                config: json!({ "group_by": "done" }),
                            },
                        ],
                        ..TableSpec::default()
                    }
                } else {
                    table_spec(title, Vec::new())
                };
                ok(self.legacy.create_table(&spec));
                let base = self.base.clone();
                self.write(|tx| model::create_table(tx, &base, &spec, None));
            }
            Op::UpdateTable {
                table,
                title,
                description,
                meta,
                primary,
            } => {
                let legacy = self.l_table(table);
                let patch = TablePatch {
                    title: title.clone(),
                    description: description.clone(),
                    meta: meta.clone(),
                    primary_field_id: None,
                };
                let l_patch = TablePatch {
                    primary_field_id: primary.as_ref().map(|name| self.l_field(table, name).id),
                    ..patch.clone()
                };
                let m_table = self.m_table(table);
                let m_primary = primary.as_ref().map(|name| self.m_field(table, name));
                ok(self.legacy.update_table(legacy.id, &l_patch));
                self.write(|tx| model::update_table(tx, &m_table, &patch, m_primary.as_ref()));
            }
            Op::DeleteTable { table } => {
                let legacy = self.l_table(table);
                let m_table = self.m_table(table);
                ok(self.legacy.delete_table(legacy.id));
                let base = self.base.clone();
                self.write(|tx| model::delete_table(tx, &base, &m_table));
            }
            Op::CreateField {
                table,
                title,
                field_type,
                options,
                formula,
                after,
            } => {
                let legacy = self.l_table(table);
                let spec = FieldSpec {
                    formula: formula.clone(),
                    ..field(title, field_type)
                };
                let l_spec = FieldSpec {
                    options: self.l_options(table, options),
                    order: after
                        .as_ref()
                        .map(|name| self.l_field(table, name).order + 1),
                    ..spec.clone()
                };
                let m_spec = FieldSpec {
                    options: self.m_options(table, options),
                    order: after.as_ref().map(|name| {
                        i64::try_from(self.m_field_index(table, name)).unwrap_or(0) + 2
                    }),
                    ..spec
                };
                let m_table = self.m_table(table);
                ok(self.legacy.create_field(legacy.id, &l_spec));
                self.write(|tx| model::create_field(tx, &m_table, &m_spec));
            }
            Op::UpdateField {
                table,
                field: name,
                title,
                field_type,
                formula,
                options,
                primary,
            } => {
                let legacy = self.l_field(table, name);
                let patch = FieldPatch {
                    title: title.clone(),
                    field_type: field_type.clone(),
                    formula: formula.clone(),
                    is_primary: primary.then_some(true),
                    ..FieldPatch::default()
                };
                let l_patch = FieldPatch {
                    options: options
                        .as_ref()
                        .map(|options| self.l_options(table, options)),
                    ..patch.clone()
                };
                let m_patch = FieldPatch {
                    options: options
                        .as_ref()
                        .map(|options| self.m_options(table, options)),
                    ..patch
                };
                let m_field = self.m_field(table, name);
                ok(self
                    .legacy
                    .update_field(legacy.table_id, legacy.id, &l_patch));
                self.write(|tx| model::update_field(tx, &m_field, &m_patch));
            }
            Op::DeleteField { table, field: name } => {
                let legacy = self.l_field(table, name);
                let m_table = self.m_table(table);
                let m_field = self.m_field(table, name);
                ok(self.legacy.delete_field(legacy.table_id, legacy.id));
                self.write(|tx| model::delete_field(tx, &m_table, &m_field));
            }
            Op::CreateView {
                table,
                title,
                view_type,
                config,
            } => {
                let spec = ViewSpec {
                    title: title.clone(),
                    view_type: view_type.clone(),
                    config: config.clone(),
                };
                let legacy = self.l_table(table);
                let m_table = self.m_table(table);
                ok(self.legacy.create_view(legacy.id, &spec));
                self.write(|tx| model::create_view(tx, &m_table, &spec));
            }
            Op::UpdateView {
                table,
                view,
                title,
                view_type,
                config,
            } => {
                let patch = ViewPatch {
                    title: title.clone(),
                    view_type: view_type.clone(),
                    config: config.clone(),
                };
                let legacy = self.l_table(table);
                let l_view = nth(&legacy.views, *view);
                let m_view = self.m_view(table, *view);
                ok(self.legacy.update_view(legacy.id, l_view.id, &patch));
                self.write(|tx| model::update_view(tx, &m_view, &patch));
            }
            Op::DeleteView { table, view } => {
                let legacy = self.l_table(table);
                let l_view = nth(&legacy.views, *view);
                let m_table = self.m_table(table);
                let m_view = self.m_view(table, *view);
                ok(self.legacy.delete_view(legacy.id, l_view.id));
                self.write(|tx| model::delete_view(tx, &m_table, &m_view));
            }
            Op::ViewWidth {
                table,
                view,
                field: name,
                width,
            } => {
                let legacy = self.l_table(table);
                let l_view = nth(&legacy.views, *view);
                let l_field = self.l_field(table, name);
                let m_view = self.m_view(table, *view);
                let m_field = self.m_field(table, name);
                ok(self.legacy.upsert_view_field(
                    l_view.id,
                    l_field.id,
                    &ViewFieldPatch {
                        width: Some(*width),
                        ..ViewFieldPatch::default()
                    },
                ));
                self.write(|tx| model::set_view_width(tx, &m_view, &m_field, *width));
            }
            Op::ViewHidden {
                table,
                view,
                field: name,
                hidden,
            } => {
                let legacy = self.l_table(table);
                let l_view = nth(&legacy.views, *view);
                let l_field = self.l_field(table, name);
                let m_view = self.m_view(table, *view);
                let m_field = self.m_field(table, name);
                ok(self.legacy.upsert_view_field(
                    l_view.id,
                    l_field.id,
                    &ViewFieldPatch {
                        visible: Some(!hidden),
                        ..ViewFieldPatch::default()
                    },
                ));
                self.write(|tx| model::set_view_hidden(tx, &m_view, &m_field, *hidden));
            }
            Op::CreateRecord { table, values } => {
                let legacy = self.l_table(table);
                let m_table = self.m_table(table);
                let cells = self.m_cells(table, values);
                let record = ok(self.legacy.create_record(legacy.id, values));
                let now = self.clock;
                let ids = self.write(|tx| {
                    model::create_records(tx, &m_table, None, &[cells], now, "user:test")
                });
                self.keys.push((record.row_key, nth(&ids, 0).to_string()));
            }
            Op::UpdateRecord {
                table,
                record,
                values,
            } => {
                let legacy = self.l_table(table);
                let l_record = self.l_record(legacy.id, *record);
                let m_table = self.m_table(table);
                let m_record = self.m_record(*record);
                let cells = self.m_cells(table, values);
                ok(self.legacy.update_record(legacy.id, l_record, values, None));
                self.write(|tx| model::set_cells(tx, &m_table, &m_record, &cells));
            }
            Op::DeleteRecord { table, record } => {
                let legacy = self.l_table(table);
                let l_record = self.l_record(legacy.id, *record);
                let m_table = self.m_table(table);
                let m_record = self.m_record(*record);
                ok(self.legacy.delete_record(legacy.id, l_record));
                self.write(|tx| model::delete_records(tx, &m_table, &[m_record]).map(|_| ()));
            }
            Op::MoveRecord { table, record } => {
                let legacy = self.l_table(table);
                let l_record = self.l_record(legacy.id, *record);
                let last = ok(self.legacy.list_records(legacy.id))
                    .iter()
                    .map(|record| record.order)
                    .max()
                    .unwrap_or(0);
                let m_table = self.m_table(table);
                let m_record = self.m_record(*record);
                ok(self
                    .legacy
                    .update_record(legacy.id, l_record, &Map::new(), Some(last + 1)));
                self.write(|tx| model::move_records(tx, &m_table, &[m_record], None));
            }
            Op::ReplaceLinks {
                table,
                record,
                field: name,
                targets,
            } => {
                let legacy = self.l_table(table);
                let l_record = self.l_record(legacy.id, *record);
                let l_field = self.l_field(table, name);
                let l_targets: Vec<String> = targets
                    .iter()
                    .map(|index| nth(&self.keys, *index).0)
                    .collect();
                let m_record = self.m_record(*record);
                let m_field = self.m_field(table, name);
                let m_targets: Vec<ObjectId> =
                    targets.iter().map(|index| self.m_record(*index)).collect();
                ok(self
                    .legacy
                    .replace_record_links(legacy.id, l_record, l_field.id, &l_targets));
                self.write(|tx| model::replace_links(tx, &m_record, &m_field, &m_targets));
            }
        }
        self.refresh_legacy();
    }

    // Generation, from the legacy file's state.

    fn state(&self) -> Vec<TableState> {
        let labels: HashMap<&str, usize> = self
            .keys
            .iter()
            .enumerate()
            .map(|(index, (key, _))| (key.as_str(), index))
            .collect();
        ok(self.legacy.list_tables())
            .into_iter()
            .map(|table| TableState {
                records: ok(self.legacy.list_records(table.id))
                    .iter()
                    .filter_map(|record| labels.get(record.row_key.as_str()).copied())
                    .collect(),
                table,
            })
            .collect()
    }

    fn generate(&self, rng: &mut Rng) -> Option<Op> {
        const KINDS: [usize; 44] = [
            0, 0, 1, 2, 3, 3, 3, 3, 3, 4, 4, 5, 6, 7, 8, 9, 10, 11, 11, 11, 11, 11, 11, 12, 12, 12,
            12, 12, 12, 13, 13, 14, 15, 15, 15, 15, 15, 15, 16, 16, 16, 16, 16, 16,
        ];
        let state = self.state();
        let names: Vec<&str> = state.iter().map(|s| s.table.name.as_str()).collect();
        let kind = *pick(rng, &KINDS)?;
        let linking: Vec<&TableState> = state
            .iter()
            .filter(|s| {
                s.table
                    .fields
                    .iter()
                    .any(|field| field.field_type == "link_to_record")
            })
            .collect();
        let current = if kind >= 15 {
            *pick(rng, &linking)?
        } else {
            pick(rng, &state)?
        };
        let table = current.table.name.clone();
        let fields = &current.table.fields;
        let stored: Vec<&Field> = fields.iter().filter(|field| is_stored(field)).collect();
        let field_target = |table: &Table, field: &Field| -> Option<String> {
            let id = field.options.get("target_table_id")?.as_i64()?;
            let _ = table;
            state
                .iter()
                .find(|s| s.table.id == id)
                .map(|s| s.table.name.clone())
        };
        let links: Vec<(&Field, String)> = fields
            .iter()
            .filter(|field| field.field_type == "link_to_record")
            .filter_map(|field| Some((field, field_target(&current.table, field)?)))
            .collect();
        let state_of = |name: &str| state.iter().find(|s| s.table.name == name);
        let lookup_targets = |target: &str| -> Vec<String> {
            state_of(target)
                .map(|s| {
                    s.table
                        .fields
                        .iter()
                        .filter(|field| is_stored(field) || field.field_type == "formula")
                        .map(|field| field.name.clone())
                        .collect()
                })
                .unwrap_or_default()
        };
        let formula = |rng: &mut Rng| -> String {
            let names: Vec<&str> = stored.iter().map(|field| field.name.as_str()).collect();
            let a = pick(rng, &names).copied().unwrap_or("title");
            let b = pick(rng, &names).copied().unwrap_or("title");
            match rng.below(6) {
                0 => format!("{{{a}}} + 1"),
                1 => format!("concat({{{a}}}, '-', {{{b}}})"),
                2 => format!("upper({{{a}}})"),
                3 => format!("if({{{a}}}, 'y', 'n')"),
                4 => "1 +".to_owned(),
                _ => format!("len({{{b}}}) * 2"),
            }
        };
        let lookup_opts = |rng: &mut Rng| -> Option<Opts> {
            let (link, target) = pick(rng, &links)?;
            let target_field = pick(rng, &lookup_targets(target))?.clone();
            Some(Opts::Lookup {
                link_field: link.name.clone(),
                target_table: target.clone(),
                target_field,
                concat: coin(rng, 40),
            })
        };
        let rollup_opts = |rng: &mut Rng| -> Option<Opts> {
            let (link, target) = pick(rng, &links)?;
            let (target_field, aggregation) = if coin(rng, 70) {
                (
                    Some(pick(rng, &lookup_targets(target))?.clone()),
                    pick(rng, &AGGREGATIONS)?.to_string(),
                )
            } else {
                (None, "count".to_owned())
            };
            Some(Opts::Rollup {
                link_field: link.name.clone(),
                target_table: target.clone(),
                target_field,
                aggregation,
            })
        };
        let view_count = current.table.views.len();
        let op = match kind {
            0 if state.len() < 4 => Op::CreateTable {
                title: pick(rng, &TABLE_TITLES)?.to_string(),
                custom: coin(rng, 50),
            },
            1 => {
                let text: Vec<&Field> = fields
                    .iter()
                    .filter(|field| field.field_type == "text")
                    .collect();
                Op::UpdateTable {
                    table,
                    title: coin(rng, 50).then(|| format!("T{}", rng.below(5))),
                    description: coin(rng, 30).then(|| format!("d{}", rng.below(3))),
                    meta: coin(rng, 30).then(|| {
                        if coin(rng, 30) {
                            Value::Null
                        } else {
                            json!({ "icon": rng.below(3) })
                        }
                    }),
                    primary: if coin(rng, 40) {
                        pick(rng, &text).map(|field| field.name.clone())
                    } else {
                        None
                    },
                }
            }
            2 => {
                let linked = state.iter().any(|other| {
                    other.table.name != table
                        && other.table.fields.iter().any(|field| {
                            field.field_type == "link_to_record"
                                && field.options.get("target_table_id").and_then(Value::as_i64)
                                    == Some(current.table.id)
                        })
                });
                if linked || state.len() < 2 {
                    return None;
                }
                Op::DeleteTable { table }
            }
            3 if fields.len() < 10 => {
                let after = if coin(rng, 30) {
                    pick(rng, fields).map(|field| field.name.clone())
                } else {
                    None
                };
                let title = pick(rng, &FIELD_TITLES)?.to_string();
                let (field_type, options, formula) = match rng.below(10) {
                    0 | 1 => (pick(rng, &STORED)?.to_string(), Opts::None, String::new()),
                    2 => ("single_select".to_owned(), Opts::Select, String::new()),
                    3 => ("formula".to_owned(), Opts::None, formula(rng)),
                    4..=6 => (
                        "link_to_record".to_owned(),
                        Opts::Link {
                            target_table: pick(rng, &names)?.to_string(),
                            single: coin(rng, 30),
                        },
                        String::new(),
                    ),
                    7 | 8 => ("lookup".to_owned(), lookup_opts(rng)?, String::new()),
                    _ => ("rollup".to_owned(), rollup_opts(rng)?, String::new()),
                };
                Op::CreateField {
                    table,
                    title,
                    field_type,
                    options,
                    formula,
                    after,
                }
            }
            4 => {
                let target = pick(rng, fields)?;
                let mut op = Op::UpdateField {
                    table: table.clone(),
                    field: target.name.clone(),
                    title: coin(rng, 40).then(|| format!("F{}", rng.below(5))),
                    field_type: None,
                    formula: None,
                    options: None,
                    primary: false,
                };
                if let Op::UpdateField {
                    field_type,
                    formula: new_formula,
                    options,
                    primary,
                    ..
                } = &mut op
                {
                    match target.field_type.as_str() {
                        kind if STORED.contains(&kind) => {
                            if coin(rng, 50) {
                                *field_type = Some(pick(rng, &STORED)?.to_string());
                            } else if kind == "text" && !target.is_primary {
                                *primary = true;
                            }
                        }
                        "formula" => *new_formula = Some(formula(rng)),
                        "lookup" => *options = Some(lookup_opts(rng)?),
                        "rollup" => *options = Some(rollup_opts(rng)?),
                        _ => {}
                    }
                }
                op
            }
            5 => {
                let mut used: HashSet<i64> = fields
                    .iter()
                    .filter_map(|field| field.options.get("link_field_id").and_then(Value::as_i64))
                    .collect();
                // A rollup whose target is gone aggregates whole records, which over a self-link
                // feeds on itself without end.
                used.extend(
                    state
                        .iter()
                        .flat_map(|s| &s.table.fields)
                        .filter(|field| field.field_type == "rollup")
                        .filter_map(|field| {
                            field.options.get("target_field_id").and_then(Value::as_i64)
                        }),
                );
                let candidates: Vec<&Field> = fields
                    .iter()
                    .filter(|field| !field.is_primary && !used.contains(&field.id))
                    .collect();
                Op::DeleteField {
                    table,
                    field: pick(rng, &candidates)?.name.clone(),
                }
            }
            6 => Op::CreateView {
                table,
                title: format!("V{}", rng.below(3)),
                view_type: ["grid", "form", "kanban", "gallery", "bogus"][rng.below(5)].to_owned(),
                config: if coin(rng, 50) {
                    json!({ "sort": [{ "field": "title" }] })
                } else {
                    Value::Null
                },
            },
            7 if view_count > 0 => Op::UpdateView {
                table,
                view: rng.below(view_count),
                title: coin(rng, 50).then(|| format!("V{}", rng.below(3))),
                view_type: coin(rng, 30).then(|| ["grid", "calendar"][rng.below(2)].to_owned()),
                config: coin(rng, 50).then(|| json!({ "hidden": [rng.below(3)] })),
            },
            // The last view stays: migrating a table without views gives it an "All" view.
            8 if view_count > 1 => Op::DeleteView {
                table,
                view: rng.below(view_count),
            },
            9 if view_count > 0 => Op::ViewWidth {
                table,
                view: rng.below(view_count),
                field: pick(rng, fields)?.name.clone(),
                width: i64::try_from(rng.below(1500)).unwrap_or(0),
            },
            10 if view_count > 0 => Op::ViewHidden {
                table,
                view: rng.below(view_count),
                field: pick(rng, fields)?.name.clone(),
                hidden: coin(rng, 60),
            },
            11 if current.records.len() < 12 => {
                let mut values = Map::new();
                for field in &stored {
                    if field.required || coin(rng, 50) {
                        values.insert(field.name.clone(), value_for(rng, field));
                    }
                }
                Op::CreateRecord { table, values }
            }
            12 => {
                let record = *pick(rng, &current.records)?;
                let mut values = Map::new();
                for _ in 0..=rng.below(3) {
                    let field = pick(rng, &stored)?;
                    let value = if !field.required && coin(rng, 25) {
                        Value::Null
                    } else {
                        value_for(rng, field)
                    };
                    values.insert(field.name.clone(), value);
                }
                Op::UpdateRecord {
                    table,
                    record,
                    values,
                }
            }
            13 => Op::DeleteRecord {
                table,
                record: *pick(rng, &current.records)?,
            },
            14 => Op::MoveRecord {
                table,
                record: *pick(rng, &current.records)?,
            },
            15 | 16 => {
                let (link, target) = pick(rng, &links)?;
                let record = *pick(rng, &current.records)?;
                let target_records = &state_of(target)?.records;
                let labels: HashMap<&str, usize> = self
                    .keys
                    .iter()
                    .enumerate()
                    .map(|(index, (key, _))| (key.as_str(), index))
                    .collect();
                let existing: Vec<usize> = ok(self.legacy.list_record_links(
                    current.table.id,
                    self.l_record(current.table.id, record),
                    link.id,
                ))
                .iter()
                .filter_map(|link| labels.get(link.row_key.as_str()).copied())
                .collect();
                let mut targets: Vec<usize> =
                    existing.iter().copied().filter(|_| coin(rng, 70)).collect();
                for _ in 0..rng.below(3) {
                    if let Some(new) = pick(rng, target_records)
                        && !targets.contains(new)
                        && !existing.contains(new)
                    {
                        targets.push(*new);
                    }
                }
                let single = link.options.get("allow_multiple") == Some(&Value::Bool(false));
                if single {
                    targets.truncate(1);
                }
                Op::ReplaceLinks {
                    table,
                    record,
                    field: link.name.clone(),
                    targets,
                }
            }
            _ => return None,
        };
        Some(op)
    }
}

fn run_equivalence(seed: u64, steps: usize) {
    let dir = temp();
    let mut twin = Twin::new(dir.path());
    let mut rng = Rng::new(seed);
    twin.apply(&Op::CreateTable {
        title: "Tasks".into(),
        custom: true,
    });
    twin.check(&format!("seed {seed}: first table"));
    for step in 0..steps {
        let Some(op) = (0..50).find_map(|_| twin.generate(&mut rng)) else {
            continue;
        };
        twin.apply(&op);
        twin.check(&format!("seed {seed} step {step}: {op:?}"));
        if std::env::var_os("KDM_PROJECT_TRACE").is_some() {
            let kind = format!("{op:?}");
            eprintln!("{}", kind.split([' ', '{']).next().unwrap_or_default());
        }
    }
    if std::env::var_os("KDM_PROJECT_TRACE").is_some() {
        let snap = snapshot(&twin.proj, &twin.model_labels(), true);
        eprintln!("{snap:#?}");
    }

    // A rebuild into an empty file shows what the incremental projection shows.
    let labels = twin.model_labels();
    let fresh = new_file(dir.path(), "fresh.kitable", true);
    rebuild_into(&fresh, &twin.replica, twin.clock + 1);
    assert_same(
        &snapshot(&twin.proj, &labels, false),
        &snapshot(&fresh, &labels, false),
        &format!("seed {seed}: rebuild into an empty file"),
    );

    // A rebuild in place changes nothing, ids included.
    let before = snapshot(&twin.proj, &labels, true);
    let ids = projected_ids(&twin.proj);
    rebuild_into(&twin.proj, &twin.replica, twin.clock + 2);
    assert_same(
        &before,
        &snapshot(&twin.proj, &labels, true),
        &format!("seed {seed}: rebuild in place"),
    );
    assert_eq!(
        ids,
        projected_ids(&twin.proj),
        "seed {seed}: ids after rebuild"
    );

    // A migrated copy of the legacy file, rebuilt in place, reads like the legacy file and keeps
    // the ids the migration recorded.
    let copy = dir.path().join("migrated.kitable");
    ok(std::fs::copy(twin.legacy.path(), &copy));
    {
        let mut conn = ok(rusqlite::Connection::open(&copy));
        let actor = ok(ActorId::from_u64(9));
        ok(migrate::upgrade(&mut conn, actor));
        let replica = some(ok(store::load(&conn, schema(), actor)), "migrated replica");
        let migrated = connection_ids(&conn);
        let tx = ok(conn.unchecked_transaction());
        ok(project::rebuild(&tx, &replica, twin.clock + 3));
        ok(tx.commit());
        assert_eq!(
            migrated,
            connection_ids(&conn),
            "seed {seed}: ids after migrating and rebuilding"
        );
    }
    let migrated = ok(KitableFile::open(&copy));
    let labels = twin.legacy_labels();
    assert_same(
        &snapshot(&twin.legacy, &labels, true),
        &snapshot(&migrated, &labels, true),
        &format!("seed {seed}: migrated and rebuilt"),
    );
}

#[test]
fn projection_equals_the_legacy_write_path() {
    for seed in 1..=8 {
        run_equivalence(seed, 90);
    }
}

// ---------------------------------------------------------------------------
// Targeted behavior.

struct Linked {
    dir: tempfile::TempDir,
    file: KitableFile,
    replica: Replica,
    base: ObjectId,
    people: TableIds,
    tasks: TableIds,
    owner: ObjectId,
    alice: ObjectId,
    bob: ObjectId,
    task: ObjectId,
}

/// People (name) and Tasks (title, owner -> People, owner_name looking up the owner's name), with
/// one task owned by Alice, all projected.
fn linked() -> Linked {
    let dir = temp();
    let file = new_file(dir.path(), "linked.kitable", true);
    let mut replica = new_replica(1);
    let base = base_in(&mut replica);
    let people = write(&mut replica, |tx| {
        model::create_table(
            tx,
            &base,
            &table_spec("People", vec![primary("Name")]),
            None,
        )
    });
    let tasks = write(&mut replica, |tx| {
        model::create_table(
            tx,
            &base,
            &table_spec("Tasks", vec![primary("Title")]),
            None,
        )
    });
    let owner = write(&mut replica, |tx| {
        model::create_field(
            tx,
            &tasks.table,
            &FieldSpec {
                options: json!({ "target_table": people.table.as_str() }),
                ..field("Owner", "link_to_record")
            },
        )
    });
    let name = nth(&people.fields, 0);
    write(&mut replica, |tx| {
        model::create_field(
            tx,
            &tasks.table,
            &FieldSpec {
                options: json!({ "link_field": owner.as_str(), "target_field": name.as_str() }),
                ..field("Owner name", "lookup")
            },
        )
    });
    let rows = [
        object(json!({ name.as_str(): "Alice" })),
        object(json!({ name.as_str(): "Bob" })),
    ];
    let ids = write(&mut replica, |tx| {
        model::create_records(tx, &people.table, None, &rows, 5, "user:test")
    });
    let title = nth(&tasks.fields, 0);
    let task = nth(
        &write(&mut replica, |tx| {
            model::create_records(
                tx,
                &tasks.table,
                None,
                &[object(json!({ title.as_str(): "Write" }))],
                6,
                "user:test",
            )
        }),
        0,
    );
    let alice = nth(&ids, 0);
    write(&mut replica, |tx| {
        model::replace_links(tx, &task, &owner, std::slice::from_ref(&alice))
    });
    project_into(&file, &mut replica, "user:test", 10);
    Linked {
        dir,
        file,
        replica,
        base,
        people,
        tasks,
        owner,
        alice,
        bob: nth(&ids, 1),
        task,
    }
}

fn table_id(file: &KitableFile, name: &str) -> i64 {
    some(
        ok(file.list_tables())
            .into_iter()
            .find(|table| table.name == name),
        name,
    )
    .id
}

fn record_values(file: &KitableFile, table: &str, key: &ObjectId) -> Map<String, Value> {
    some(
        ok(file.list_records(table_id(file, table)))
            .into_iter()
            .find(|record| record.row_key == key.as_str()),
        key.as_str(),
    )
    .values
}

#[test]
fn a_lookup_refreshes_when_its_target_record_changes() {
    let mut t = linked();
    let values = record_values(&t.file, "tasks", &t.task);
    assert_eq!(values.get("owner_name"), Some(&json!(["Alice"])));
    assert_eq!(
        values.get("owner"),
        Some(&json!([{ "row_key": t.alice.as_str(), "display": "Alice" }]))
    );

    let name = nth(&t.people.fields, 0);
    let alice = t.alice.clone();
    let people = t.people.table.clone();
    write(&mut t.replica, |tx| {
        model::set_cells(
            tx,
            &people,
            &alice,
            &object(json!({ name.as_str(): "Alicia" })),
        )
    });
    let change = project_into(&t.file, &mut t.replica, "user:test", 11);
    let values = record_values(&t.file, "tasks", &t.task);
    assert_eq!(values.get("owner_name"), Some(&json!(["Alicia"])));
    assert_eq!(
        values.get("owner"),
        Some(&json!([{ "row_key": t.alice.as_str(), "display": "Alicia" }]))
    );
    let tasks = table_id(&t.file, "tasks");
    let people_id = table_id(&t.file, "people");
    assert!(
        change
            .records_upserted
            .contains(&(tasks, t.task.to_string()))
    );
    assert!(
        change
            .records_upserted
            .contains(&(people_id, t.alice.to_string()))
    );

    // Deleting the target empties the lookup and the chips.
    write(&mut t.replica, |tx| {
        model::delete_records(tx, &people, &[alice])
    });
    let change = project_into(&t.file, &mut t.replica, "user:test", 12);
    let values = record_values(&t.file, "tasks", &t.task);
    assert_eq!(values.get("owner_name"), Some(&json!([])));
    assert_eq!(values.get("owner"), Some(&json!([])));
    assert_eq!(
        change.records_deleted,
        vec![(people_id, t.alice.to_string())]
    );
    assert!(
        change
            .records_upserted
            .contains(&(tasks, t.task.to_string()))
    );
}

#[test]
fn chips_refresh_when_the_target_tables_primary_field_changes() {
    let mut t = linked();
    let people = t.people.table.clone();
    let nick = write(&mut t.replica, |tx| {
        model::create_field(tx, &people, &field("Nick", "text"))
    });
    let alice = t.alice.clone();
    write(&mut t.replica, |tx| {
        model::set_cells(tx, &people, &alice, &object(json!({ nick.as_str(): "Al" })))
    });
    project_into(&t.file, &mut t.replica, "user:test", 11);
    write(&mut t.replica, |tx| {
        model::update_table(tx, &people, &TablePatch::default(), Some(&nick))
    });
    project_into(&t.file, &mut t.replica, "user:test", 12);
    let values = record_values(&t.file, "tasks", &t.task);
    assert_eq!(
        values.get("owner"),
        Some(&json!([{ "row_key": t.alice.as_str(), "display": "Al" }]))
    );
    let fields = ok(t.file.list_fields(table_id(&t.file, "people")));
    let flags: Vec<(&str, bool)> = fields
        .iter()
        .map(|field| (field.name.as_str(), field.is_primary))
        .collect();
    assert_eq!(flags, vec![("name", false), ("nick", true)]);
}

#[test]
fn deleting_a_field_drops_its_values_at_once() {
    let mut t = linked();
    let tasks = t.tasks.table.clone();
    let notes = write(&mut t.replica, |tx| {
        model::create_field(tx, &tasks, &field("Notes", "text"))
    });
    let task = t.task.clone();
    write(&mut t.replica, |tx| {
        model::set_cells(tx, &tasks, &task, &object(json!({ notes.as_str(): "x" })))
    });
    project_into(&t.file, &mut t.replica, "user:test", 11);
    assert_eq!(
        record_values(&t.file, "tasks", &t.task).get("notes"),
        Some(&json!("x"))
    );

    write(&mut t.replica, |tx| model::delete_field(tx, &tasks, &notes));
    let change = project_into(&t.file, &mut t.replica, "user:test", 12);
    assert_eq!(record_values(&t.file, "tasks", &t.task).get("notes"), None);
    let tasks_id = table_id(&t.file, "tasks");
    assert_eq!(change.schema, vec![tasks_id]);
    assert!(
        change
            .records_upserted
            .contains(&(tasks_id, t.task.to_string()))
    );
    // A new field of the same name does not see the old value.
    write(&mut t.replica, |tx| {
        model::create_field(tx, &tasks, &field("Notes", "text"))
    });
    project_into(&t.file, &mut t.replica, "user:test", 13);
    assert_eq!(record_values(&t.file, "tasks", &t.task).get("notes"), None);
}

#[test]
fn a_lookup_whose_target_field_is_deleted_is_null_even_without_links() {
    let mut t = linked();
    let people = t.people.table.clone();
    let tasks = t.tasks.table.clone();
    let owner = t.owner.clone();
    let nick = write(&mut t.replica, |tx| {
        model::create_field(tx, &people, &field("Nick", "text"))
    });
    write(&mut t.replica, |tx| {
        model::create_field(
            tx,
            &tasks,
            &FieldSpec {
                options: json!({ "link_field": owner.as_str(), "target_field": nick.as_str() }),
                ..field("Owner nick", "lookup")
            },
        )
    });
    let title = nth(&t.tasks.fields, 0);
    let lonely = nth(
        &write(&mut t.replica, |tx| {
            model::create_records(
                tx,
                &tasks,
                None,
                &[object(json!({ title.as_str(): "Alone" }))],
                11,
                "",
            )
        }),
        0,
    );
    project_into(&t.file, &mut t.replica, "", 11);
    assert_eq!(
        record_values(&t.file, "tasks", &lonely).get("owner_nick"),
        Some(&json!([]))
    );
    write(&mut t.replica, |tx| model::delete_field(tx, &people, &nick));
    let change = project_into(&t.file, &mut t.replica, "", 12);
    assert_eq!(
        record_values(&t.file, "tasks", &lonely).get("owner_nick"),
        None
    );
    assert_eq!(
        record_values(&t.file, "tasks", &t.task).get("owner_nick"),
        None
    );
    let tasks_id = table_id(&t.file, "tasks");
    assert!(
        change
            .records_upserted
            .contains(&(tasks_id, lonely.to_string()))
    );
}

#[test]
fn a_formula_field_computes_for_existing_records() {
    let mut t = linked();
    let tasks = t.tasks.table.clone();
    write(&mut t.replica, |tx| {
        model::create_field(
            tx,
            &tasks,
            &FieldSpec {
                formula: "upper({title})".into(),
                ..field("Shout", "formula")
            },
        )
    });
    project_into(&t.file, &mut t.replica, "user:test", 11);
    assert_eq!(
        record_values(&t.file, "tasks", &t.task).get("shout"),
        Some(&json!("WRITE"))
    );
    // A formula error is a value.
    let shout = some(
        ok(ModelView::new(&t.replica).field_by_name(&tasks, "shout")),
        "shout",
    );
    write(&mut t.replica, |tx| {
        model::update_field(
            tx,
            &shout,
            &FieldPatch {
                formula: Some("1 +".into()),
                ..FieldPatch::default()
            },
        )
    });
    project_into(&t.file, &mut t.replica, "user:test", 12);
    let shout = record_values(&t.file, "tasks", &t.task)
        .get("shout")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    assert!(shout.starts_with("#ERROR: "), "{shout}");
}

#[test]
fn a_formula_reads_values_derived_after_it() {
    let mut t = linked();
    let tasks = t.tasks.table.clone();
    // Placed first, so it comes before the lookup it reads.
    write(&mut t.replica, |tx| {
        model::create_field(
            tx,
            &tasks,
            &FieldSpec {
                formula: "concat('by ', {owner_name})".into(),
                order: Some(1),
                ..field("Byline", "formula")
            },
        )
    });
    project_into(&t.file, &mut t.replica, "user:test", 11);
    let values = record_values(&t.file, "tasks", &t.task);
    assert_eq!(values.get("byline"), Some(&json!("by [Alice]")));
    let fresh = new_file(t.dir.path(), "fresh.kitable", true);
    rebuild_into(&fresh, &t.replica, 12);
    assert_same(
        &snapshot(&t.file, &Labels::identity(), false),
        &snapshot(&fresh, &Labels::identity(), false),
        "forward formula",
    );
}

#[test]
fn history_names_the_actor_and_records_each_cell() {
    let mut t = linked();
    let tasks = t.tasks.table.clone();
    let task = t.task.clone();
    let title = nth(&t.tasks.fields, 0);
    let notes = write(&mut t.replica, |tx| {
        model::create_field(tx, &tasks, &field("Notes", "text"))
    });
    project_into(&t.file, &mut t.replica, "user:test", 11);
    write(&mut t.replica, |tx| {
        model::set_cells(
            tx,
            &tasks,
            &task,
            &object(json!({ title.as_str(): "Read", notes.as_str(): "n" })),
        )
    });
    project_into(&t.file, &mut t.replica, "agent:helper", 12);
    let tasks_id = table_id(&t.file, "tasks");
    let record = some(
        ok(t.file.list_records(tasks_id))
            .into_iter()
            .find(|record| record.row_key == t.task.as_str()),
        "task",
    );
    let (entries, total) = ok(t.file.list_record_history(tasks_id, record.id, 0, 0));
    assert_eq!(total, 3);
    let summary: Vec<(String, String, Value, Value, i64)> = entries
        .iter()
        .map(|entry| {
            (
                entry.action.clone(),
                entry.actor.clone(),
                entry.before.clone(),
                entry.after.clone(),
                entry.created_at,
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                "update".into(),
                "agent:helper".into(),
                json!("Write"),
                json!("Read"),
                12
            ),
            (
                "update".into(),
                "agent:helper".into(),
                Value::Null,
                json!("n"),
                12
            ),
            (
                "create".into(),
                "user:test".into(),
                Value::Null,
                json!({ "title": "Write" }),
                10
            ),
        ]
    );
}

#[test]
fn table_change_reports_what_changed() {
    let mut t = linked();
    let tasks_id = table_id(&t.file, "tasks");
    let people_id = table_id(&t.file, "people");
    let tasks = t.tasks.table.clone();
    let people = t.people.table.clone();

    // A table title.
    write(&mut t.replica, |tx| {
        model::update_table(
            tx,
            &tasks,
            &TablePatch {
                title: Some("Todo".into()),
                ..TablePatch::default()
            },
            None,
        )
    });
    let change = project_into(&t.file, &mut t.replica, "", 11);
    assert_eq!(
        change,
        TableChange {
            tables: vec![tasks_id],
            ..TableChange::default()
        }
    );

    // A view width.
    let view = nth(&t.tasks.views, 0);
    let title = nth(&t.tasks.fields, 0);
    write(&mut t.replica, |tx| {
        model::set_view_width(tx, &view, &title, 300)
    });
    let change = project_into(&t.file, &mut t.replica, "", 12);
    let view_id = ok(t.file.list_tables())
        .into_iter()
        .find(|table| table.id == tasks_id)
        .map(|table| nth(&table.views, 0).id)
        .unwrap_or_default();
    assert_eq!(
        change,
        TableChange {
            views: vec![view_id],
            ..TableChange::default()
        }
    );
    let layout = ok(t.file.list_view_fields(view_id));
    assert_eq!(layout.len(), 1);
    assert_eq!(nth(&layout, 0).width, 300);
    assert!(nth(&layout, 0).visible);

    // A record move.
    let bob = t.bob.clone();
    let alice = t.alice.clone();
    write(&mut t.replica, |tx| {
        model::move_records(tx, &people, &[bob], Some(&alice))
    });
    let change = project_into(&t.file, &mut t.replica, "", 13);
    assert_eq!(change.records_reordered, vec![people_id]);
    // The table's list changed, not its row.
    assert!(change.tables.is_empty());
    let order: Vec<(String, i64)> = ok(t.file.list_records(people_id))
        .into_iter()
        .map(|record| (record.row_key, record.order))
        .collect();
    assert_eq!(
        order,
        vec![(t.bob.to_string(), 1), (t.alice.to_string(), 2)]
    );

    // A field.
    write(&mut t.replica, |tx| {
        model::create_field(tx, &people, &field("Age", "number"))
    });
    let change = project_into(&t.file, &mut t.replica, "", 14);
    assert_eq!(change.schema, vec![people_id]);
    assert!(!change.dashboards);

    // Nothing.
    let change = project_into(&t.file, &mut t.replica, "", 15);
    assert_eq!(change, TableChange::default());
}

#[test]
fn dashboards_are_reported_but_not_projected() {
    let mut t = linked();
    let base = t.base.clone();
    let tasks = t.tasks.table.clone();
    let dashboard = write(&mut t.replica, |tx| {
        model::upsert_dashboard(
            tx,
            &base,
            None,
            "Board",
            json!({ "source_table": tasks.as_str() }),
            &Map::new(),
        )
    });
    let change = project_into(&t.file, &mut t.replica, "", 11);
    assert!(change.dashboards);
    assert!(change.tables.is_empty());
    write(&mut t.replica, |tx| {
        model::delete_dashboard(tx, &base, &dashboard)
    });
    assert!(project_into(&t.file, &mut t.replica, "", 12).dashboards);
    // A table change alone is not a dashboard change.
    write(&mut t.replica, |tx| {
        model::create_table(tx, &base, &table_spec("More", Vec::new()), None)
    });
    assert!(!project_into(&t.file, &mut t.replica, "", 13).dashboards);
}

#[test]
fn deleting_a_table_soft_deletes_its_rows() {
    let mut t = linked();
    let base = t.base.clone();
    let tasks = t.tasks.table.clone();
    let tasks_id = table_id(&t.file, "tasks");
    write(&mut t.replica, |tx| model::delete_table(tx, &base, &tasks));
    let change = project_into(&t.file, &mut t.replica, "", 11);
    assert_eq!(change.tables, vec![tasks_id]);
    assert_eq!(change.records_deleted, vec![(tasks_id, t.task.to_string())]);
    let names: Vec<String> = ok(t.file.list_tables())
        .into_iter()
        .map(|table| table.name)
        .collect();
    assert_eq!(names, vec!["people".to_owned()]);
    assert_eq!(ok(t.file.count_records(tasks_id)), 0);
    let live: i64 = ok(t.file.conn().query_row(
        "SELECT COUNT(*) FROM kition_fields WHERE table_id = ?1 AND deleted_at IS NULL",
        params![tasks_id],
        |row| row.get(0),
    ));
    assert_eq!(live, 0);
    let links: i64 =
        ok(t.file
            .conn()
            .query_row("SELECT COUNT(*) FROM kition_record_links", [], |row| {
                row.get(0)
            }));
    assert_eq!(links, 0);
}

#[test]
fn undo_of_a_delete_restores_the_same_rows() {
    let mut t = linked();
    let tasks = t.tasks.table.clone();
    let task = t.task.clone();
    let before = projected_ids(&t.file);
    write(&mut t.replica, |tx| {
        model::delete_records(tx, &tasks, &[task])
    });
    project_into(&t.file, &mut t.replica, "", 11);
    assert!(ok(t.replica.undo()));
    project_into(&t.file, &mut t.replica, "", 12);
    assert_eq!(
        projected_ids(&t.file).get(&format!("kition_records:{}", t.task)),
        before.get(&format!("kition_records:{}", t.task))
    );
    let values = record_values(&t.file, "tasks", &t.task);
    assert_eq!(values.get("title"), Some(&json!("Write")));
    assert_eq!(values.get("owner_name"), Some(&json!(["Alice"])));
    let fresh = new_file(t.dir.path(), "fresh.kitable", true);
    rebuild_into(&fresh, &t.replica, 13);
    assert_same(
        &snapshot(&t.file, &Labels::identity(), false),
        &snapshot(&fresh, &Labels::identity(), false),
        "undo",
    );
}

#[test]
fn rebuild_keeps_ids_and_equals_the_incremental_projection() {
    let mut t = linked();
    let people = t.people.table.clone();
    let rows: Vec<Map<String, Value>> = (0..20)
        .map(|index| object(json!({ nth(&t.people.fields, 0).as_str(): format!("p{index}") })))
        .collect();
    let added = write(&mut t.replica, |tx| {
        model::create_records(tx, &people, None, &rows, 20, "user:test")
    });
    let task = t.task.clone();
    let owner = t.owner.clone();
    write(&mut t.replica, |tx| {
        model::replace_links(tx, &task, &owner, &[nth(&added, 3), nth(&added, 1)])
    });
    project_into(&t.file, &mut t.replica, "", 11);
    let ids = projected_ids(&t.file);
    let before = snapshot(&t.file, &Labels::identity(), true);
    rebuild_into(&t.file, &t.replica, 12);
    assert_eq!(ids, projected_ids(&t.file));
    assert_same(
        &before,
        &snapshot(&t.file, &Labels::identity(), true),
        "rebuild in place",
    );
    let fresh = new_file(t.dir.path(), "fresh.kitable", true);
    rebuild_into(&fresh, &t.replica, 13);
    assert_same(
        &snapshot(&t.file, &Labels::identity(), false),
        &snapshot(&fresh, &Labels::identity(), false),
        "rebuild into an empty file",
    );
    // A rebuild also repairs a projection that went wrong.
    ok(t.file
        .conn()
        .execute("UPDATE kition_records SET values_json = '{}'", []));
    ok(t.file.conn().execute("DELETE FROM kition_record_links", []));
    rebuild_into(&t.file, &t.replica, 14);
    assert_same(
        &before,
        &snapshot(&t.file, &Labels::identity(), true),
        "rebuild repairs",
    );
}

#[test]
fn a_merge_projects_like_a_rebuild() {
    let mut t = linked();
    let mut other = ok(Replica::load(
        schema(),
        &ok(t.replica.snapshot()),
        ok(ActorId::from_u64(2)),
    ));
    let since = t.replica.version();
    let people = t.people.table.clone();
    let tasks = t.tasks.table.clone();
    let name = nth(&t.people.fields, 0);
    let title = nth(&t.tasks.fields, 0);
    let owner = t.owner.clone();
    let (task, bob, alice) = (t.task.clone(), t.bob.clone(), t.alice.clone());

    // Here: a cell, a new person, and Alice's rename.
    write(&mut t.replica, |tx| {
        model::set_cells(
            tx,
            &tasks,
            &task,
            &object(json!({ title.as_str(): "Here" })),
        )
    });
    write(&mut t.replica, |tx| {
        model::create_records(
            tx,
            &people,
            None,
            &[object(json!({ name.as_str(): "Cy" }))],
            30,
            "",
        )
    });
    write(&mut t.replica, |tx| {
        model::set_cells(
            tx,
            &people,
            &alice,
            &object(json!({ name.as_str(): "Ali" })),
        )
    });
    project_into(&t.file, &mut t.replica, "", 11);

    // There: a link to Bob, a new field, a deleted view, a moved record, a new task.
    write(&mut other, |tx| {
        model::replace_links(tx, &task, &owner, &[alice.clone(), bob.clone()])
    });
    write(&mut other, |tx| {
        model::create_field(tx, &people, &field("Age", "number"))
    });
    let view = nth(&t.people.views, 0);
    write(&mut other, |tx| model::delete_view(tx, &people, &view));
    write(&mut other, |tx| {
        model::move_records(tx, &people, std::slice::from_ref(&bob), Some(&alice))
    });
    let late = nth(
        &write(&mut other, |tx| {
            model::create_records(
                tx,
                &tasks,
                None,
                &[object(json!({ title.as_str(): "There" }))],
                31,
                "",
            )
        }),
        0,
    );
    write(&mut other, |tx| {
        model::replace_links(tx, &late, &owner, std::slice::from_ref(&bob))
    });

    ok(t.replica.import_changes(&ok(other.export_changes(&since))));
    let imported = t.replica.take_changed();
    ok(repair::run(&mut t.replica, &imported));
    let mut changed = imported;
    changed.extend(t.replica.take_changed());
    let tx = ok(t.file.conn().unchecked_transaction());
    ok(project::project_changes(
        &tx, &t.replica, &changed, "import", 12,
    ));
    ok(tx.commit());

    let fresh = new_file(t.dir.path(), "fresh.kitable", true);
    rebuild_into(&fresh, &t.replica, 13);
    assert_same(
        &snapshot(&t.file, &Labels::identity(), false),
        &snapshot(&fresh, &Labels::identity(), false),
        "merge",
    );
    let values = record_values(&t.file, "tasks", &task);
    assert_eq!(values.get("owner_name"), Some(&json!(["Ali", "Bob"])));
}

// ---------------------------------------------------------------------------
// Timings.

/// Projects what changed and answers how long the projection took, the commit excluded.
fn timed_projection(file: &KitableFile, replica: &mut Replica, now: i64) -> std::time::Duration {
    let changed = replica.take_changed();
    let tx = ok(file.conn().unchecked_transaction());
    let started = Instant::now();
    ok(project::project_changes(&tx, replica, &changed, "", now));
    let elapsed = started.elapsed();
    ok(tx.commit());
    elapsed
}

#[test]
#[ignore = "timing; run with --release -- --ignored --nocapture"]
fn projection_timings() {
    let dir = temp();
    let file = new_file(dir.path(), "big.kitable", true);
    let mut replica = new_replica(1);
    let base = base_in(&mut replica);
    let ids = write(&mut replica, |tx| {
        model::create_table(
            tx,
            &base,
            &table_spec(
                "Big",
                vec![
                    primary("Title"),
                    field("Count", "number"),
                    field("Notes", "text"),
                ],
            ),
            None,
        )
    });
    let title = nth(&ids.fields, 0);
    let count = nth(&ids.fields, 1);
    write(&mut replica, |tx| {
        model::create_field(
            tx,
            &ids.table,
            &FieldSpec {
                formula: "{count} * 2".into(),
                ..field("Double", "formula")
            },
        )
    });
    let rows: Vec<Map<String, Value>> = (0..10_000)
        .map(|index| object(json!({ title.as_str(): format!("r{index}"), count.as_str(): index })))
        .collect();
    let records = write(&mut replica, |tx| {
        model::create_records(tx, &ids.table, None, &rows, 1, "")
    });
    replica.take_changed();

    let tx = ok(file.conn().unchecked_transaction());
    let started = Instant::now();
    ok(project::rebuild(&tx, &replica, 2));
    let rebuild = started.elapsed();
    ok(tx.commit());

    let edits: Vec<(ObjectId, Map<String, Value>)> = records
        .iter()
        .take(1_000)
        .map(|record| (record.clone(), object(json!({ count.as_str(): -1 }))))
        .collect();
    write(&mut replica, |tx| {
        model::set_cells_many(tx, &ids.table, &edits)
    });
    let many = timed_projection(&file, &mut replica, 3);

    let record = nth(&records, 5_000);
    let table = ids.table.clone();
    write(&mut replica, |tx| {
        model::set_cells(tx, &table, &record, &object(json!({ count.as_str(): 7 })))
    });
    let one = timed_projection(&file, &mut replica, 4);

    write(&mut replica, |tx| {
        model::create_records(
            tx,
            &table,
            None,
            &[object(json!({ title.as_str(): "new" }))],
            5,
            "",
        )
    });
    let create = timed_projection(&file, &mut replica, 5);

    // A second table of 1,000 records linking to the first, with a lookup of the title.
    let refs = write(&mut replica, |tx| {
        model::create_table(tx, &base, &table_spec("Refs", vec![primary("Name")]), None)
    });
    let target = ids.table.clone();
    let link = write(&mut replica, |tx| {
        model::create_field(
            tx,
            &refs.table,
            &FieldSpec {
                options: json!({ "target_table": target.as_str() }),
                ..field("Big", "link_to_record")
            },
        )
    });
    write(&mut replica, |tx| {
        model::create_field(
            tx,
            &refs.table,
            &FieldSpec {
                options: json!({ "link_field": link.as_str(), "target_field": title.as_str() }),
                ..field("Big title", "lookup")
            },
        )
    });
    let name = nth(&refs.fields, 0);
    let rows: Vec<Map<String, Value>> = (0..1_000)
        .map(|index| object(json!({ name.as_str(): format!("ref{index}") })))
        .collect();
    let sources = write(&mut replica, |tx| {
        model::create_records(tx, &refs.table, None, &rows, 6, "")
    });
    timed_projection(&file, &mut replica, 6);
    let edits: Vec<(ObjectId, Vec<ObjectId>)> = sources
        .iter()
        .enumerate()
        .map(|(index, source)| (source.clone(), vec![nth(&records, index % 10)]))
        .collect();
    write(&mut replica, |tx| {
        model::replace_links_many(tx, &link, &edits)
    });
    let links = timed_projection(&file, &mut replica, 7);

    // One title edit refreshes the lookups of the 100 records linking to it.
    let linked = nth(&records, 3);
    write(&mut replica, |tx| {
        model::set_cells(
            tx,
            &table,
            &linked,
            &object(json!({ title.as_str(): "renamed" })),
        )
    });
    let fan_out = timed_projection(&file, &mut replica, 8);

    let fresh = new_file(dir.path(), "fresh.kitable", true);
    let tx = ok(fresh.conn().unchecked_transaction());
    let started = Instant::now();
    ok(project::rebuild(&tx, &replica, 9));
    let rebuild_links = started.elapsed();
    ok(tx.commit());

    println!(
        "rebuild of 10k records: {rebuild:?}; 1,000-cell set_cells_many: {many:?}; one cell: {one:?}; \
         one new record: {create:?}; 1,000 link replacements: {links:?}; one cell under 100 lookups: {fan_out:?}; \
         rebuild of 11k records and 1,000 links: {rebuild_links:?}"
    );
    let source = some(
        ok(file.list_records(table_id(&file, "refs")))
            .into_iter()
            .find(|record| record.row_key == nth(&sources, 3).as_str()),
        "source",
    );
    assert_eq!(source.values.get("big_title"), Some(&json!(["renamed"])));
    let values = record_values(&file, "big", &record);
    assert_eq!(values.get("double"), Some(&json!(14)));
}
