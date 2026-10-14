//! Derived values in dependency order.
//!
//! A projection seeds the records whose values may have changed, each with the field names that
//! may have changed. Discovery follows the links back to the records that read those names (a
//! lookup or rollup of a changed field, a whole-record rollup, or a chip showing a changed
//! primary field), with the names their readers derive. The reached records form a graph
//! (dependency to dependent); its strongly connected components are processed dependencies first
//! (Tarjan), each record once, and only when a record it reads actually changed a name it reads.
//!
//! A component with more than one record (or a record linking to itself) is iterated to a
//! fixpoint. The `(record, field)` pairs that depend on themselves form cycles, found over the
//! whole document (so incremental projections and rebuilds agree) among the fields on a cycle of
//! the field dependency graph: each field of a cycle reads the other fields of its cycle as
//! missing, so its value depends only on values outside the cycle, the iteration converges, and
//! nothing nests without bound. A running total is circular per field but not per record, and
//! computes exactly.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use kition_kdm::ObjectId;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use super::{Projector, TableSchema};
use crate::computed::{Deriver, formula_references};
use crate::source::Field;
use crate::{Result, file, json};

/// The `(record, field)` cycles last projected, so a change of membership is noticed.
const CYCLES_KEY: &str = "kdm_projected_cycles";

/// What may have changed in a record, seeding its recomputation.
#[derive(Debug, Clone)]
pub(super) enum Seed {
    /// Anything: a new record, a schema change, a rebuild.
    All,
    /// These names (stored cells that changed).
    Names(HashSet<String>),
    /// The derived fields reading through this link field (its links changed).
    Link(i64),
}

#[derive(Debug, Clone, Default)]
struct NameSet {
    all: bool,
    names: HashSet<String>,
}

impl NameSet {
    fn contains(&self, name: &str) -> bool {
        self.all || self.names.contains(name)
    }

    fn is_empty(&self) -> bool {
        !self.all && self.names.is_empty()
    }

    /// Adds `other`; answers whether anything was new.
    fn merge(&mut self, other: NameSet) -> bool {
        if self.all {
            return false;
        }
        if other.all {
            self.all = true;
            return true;
        }
        let before = self.names.len();
        self.names.extend(other.names);
        self.names.len() != before
    }
}

/// What a derived field reads of the records its link field links to.
#[derive(Debug, Clone)]
enum Reads {
    Name(String),
    /// Every field: a rollup without a target field.
    Whole,
}

impl Reads {
    fn matches(&self, names: &NameSet) -> bool {
        match self {
            Reads::Name(name) => names.contains(name),
            Reads::Whole => !names.is_empty(),
        }
    }

    fn matches_set(&self, names: &HashSet<String>) -> bool {
        match self {
            Reads::Name(name) => names.contains(name),
            Reads::Whole => !names.is_empty(),
        }
    }
}

/// A derived field reading through a link field of its own table.
#[derive(Debug, Clone)]
struct Reader {
    name: String,
    reads: Reads,
}

#[derive(Debug, Default)]
struct TableInfo {
    derived: HashSet<String>,
    /// Formulas of the table naming each field name.
    formula_readers: HashMap<String, Vec<String>>,
    primary: Option<String>,
}

/// The document's derived-field dependencies, from the projected field rows.
#[derive(Default)]
struct Graph {
    tables: HashMap<i64, TableInfo>,
    /// Readers by link field id.
    readers: HashMap<i64, Vec<Reader>>,
    field_names: HashMap<i64, String>,
    /// Every live field by id.
    fields: HashMap<i64, Field>,
    /// The derived fields on a cycle of the field dependency graph, one list per strongly
    /// connected component. Only such fields can be on a `(record, field)` cycle.
    field_cycles: Vec<Vec<i64>>,
    /// Tables holding a field of `field_cycles`.
    cyclic_tables: HashSet<i64>,
}

impl Graph {
    fn info(&self, table: i64) -> Option<&TableInfo> {
        self.tables.get(&table)
    }

    /// `names` with every formula of `table` that reads them, transitively.
    fn closure(&self, table: i64, names: NameSet) -> NameSet {
        if names.all {
            return names;
        }
        let Some(info) = self.info(table) else {
            return names;
        };
        let mut out = names.names.clone();
        let mut queue: Vec<String> = names.names.into_iter().collect();
        while let Some(name) = queue.pop() {
            for reader in info.formula_readers.get(&name).into_iter().flatten() {
                if out.insert(reader.clone()) {
                    queue.push(reader.clone());
                }
            }
        }
        NameSet {
            all: false,
            names: out,
        }
    }

    fn seed_names(&self, table: i64, seed: &Seed) -> NameSet {
        match seed {
            Seed::All => NameSet {
                all: true,
                names: HashSet::new(),
            },
            Seed::Names(names) => self.closure(
                table,
                NameSet {
                    all: false,
                    names: names.clone(),
                },
            ),
            Seed::Link(link) => self.closure(
                table,
                NameSet {
                    all: false,
                    names: self
                        .readers
                        .get(link)
                        .into_iter()
                        .flatten()
                        .map(|reader| reader.name.clone())
                        .collect(),
                },
            ),
        }
    }
}

/// One record reached by discovery.
struct Node {
    table: i64,
    key: String,
    names: NameSet,
    /// `(dependent record, link field)`: the dependent links to this record through the field.
    out: Vec<(i64, i64)>,
}

impl Projector<'_> {
    /// Recomputes the derived values of every seeded record and of the records that read them.
    pub(super) fn derive(&mut self) -> Result<()> {
        self.recomputed = 0;
        let mut seeds = std::mem::take(&mut self.seeds);
        for table in self.recompute_tables.clone() {
            let mut statement = self.conn.prepare_cached(
                "SELECT id FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL",
            )?;
            for id in statement.query_map([table], |row| row.get::<_, i64>(0))? {
                seeds.entry(id?).or_default().push(Seed::All);
            }
        }
        for table in self.primary_changed.clone() {
            let mut statement = self.conn.prepare_cached(
                "SELECT DISTINCT from_record_id, from_field_id FROM kition_record_links WHERE to_table_id = ?1",
            )?;
            let rows = statement.query_map([table], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows {
                let (record, link) = row?;
                seeds.entry(record).or_default().push(Seed::Link(link));
            }
        }
        let stored = file::get_meta(self.conn, CYCLES_KEY)?;
        if seeds.is_empty() && stored.is_none() {
            return Ok(());
        }
        let graph = self.graph()?;
        // Cycles over the whole document; a record whose cycle membership changed reads other
        // inputs now, so it is recomputed even when no value it reads changed.
        let cycles = if graph.cyclic_tables.is_empty() {
            HashMap::new()
        } else {
            self.cycles(&graph)?
        };
        let labels = cycle_labels(&cycles);
        let before: BTreeMap<String, BTreeMap<String, String>> = stored
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default();
        if before != labels {
            let records: BTreeSet<&String> = before.keys().chain(labels.keys()).collect();
            for record in records {
                if before.get(record) != labels.get(record)
                    && let Ok(id) = record.parse::<i64>()
                {
                    seeds.entry(id).or_default().push(Seed::All);
                }
            }
            if labels.is_empty() {
                self.conn
                    .execute("DELETE FROM kition_meta WHERE key = ?1", [CYCLES_KEY])?;
            } else {
                file::set_meta(self.conn, CYCLES_KEY, &serde_json::to_string(&labels)?)?;
            }
        }
        if seeds.is_empty() {
            return Ok(());
        }

        // Discovery.
        let mut nodes: HashMap<i64, Node> = HashMap::new();
        let mut queue: VecDeque<i64> = VecDeque::new();
        let mut dirty: HashSet<i64> = HashSet::new();
        let mut seeded: Vec<i64> = seeds.keys().copied().collect();
        seeded.sort_unstable();
        for id in seeded {
            let Some((table, key)) = self.record_row(id)? else {
                continue;
            };
            let mut names = NameSet::default();
            for seed in seeds.get(&id).into_iter().flatten() {
                names.merge(graph.seed_names(table, seed));
            }
            dirty.insert(id);
            nodes.insert(
                id,
                Node {
                    table,
                    key,
                    names,
                    out: Vec::new(),
                },
            );
            queue.push_back(id);
        }
        while let Some(id) = queue.pop_front() {
            let Some(names) = nodes.get(&id).map(|node| node.names.clone()) else {
                continue;
            };
            if names.is_empty() {
                continue;
            }
            let table = nodes.get(&id).map_or(0, |node| node.table);
            let linkers: Vec<(i64, i64)> = {
                let mut statement = self.conn.prepare_cached(
                    "SELECT from_record_id, from_field_id FROM kition_record_links WHERE to_table_id = ?1 AND to_record_id = ?2",
                )?;
                statement
                    .query_map(params![table, id], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            };
            let mut edges = Vec::new();
            for (record, link) in linkers {
                let read: HashSet<String> = graph
                    .readers
                    .get(&link)
                    .into_iter()
                    .flatten()
                    .filter(|reader| reader.reads.matches(&names))
                    .map(|reader| reader.name.clone())
                    .collect();
                if read.is_empty() {
                    continue;
                }
                edges.push((record, link));
                let (record_table, key) = match nodes.get(&record) {
                    Some(node) => (node.table, None),
                    None => match self.record_row(record)? {
                        Some((table, key)) => (table, Some(key)),
                        None => continue,
                    },
                };
                let wanted = graph.closure(
                    record_table,
                    NameSet {
                        all: false,
                        names: read,
                    },
                );
                let grew = match (nodes.get_mut(&record), key) {
                    (Some(node), _) => node.names.merge(wanted),
                    (None, Some(key)) => {
                        nodes.insert(
                            record,
                            Node {
                                table: record_table,
                                key,
                                names: wanted,
                                out: Vec::new(),
                            },
                        );
                        true
                    }
                    (None, None) => false,
                };
                if grew {
                    queue.push_back(record);
                }
            }
            if let Some(node) = nodes.get_mut(&id) {
                for edge in edges {
                    if !node.out.contains(&edge) {
                        node.out.push(edge);
                    }
                }
            }
        }

        // Components, dependencies first.
        let mut ids: Vec<i64> = nodes.keys().copied().collect();
        ids.sort_unstable();
        let index: HashMap<i64, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
        let adjacency: Vec<Vec<usize>> = ids
            .iter()
            .map(|id| {
                nodes
                    .get(id)
                    .map(|node| {
                        node.out
                            .iter()
                            .filter_map(|(record, _)| index.get(record).copied())
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .collect();
        let mut components = strongly_connected(&adjacency);
        components.reverse();

        let deriver = Deriver::new(self.conn, true);
        for component in components {
            let members: Vec<i64> = component
                .iter()
                .filter_map(|i| ids.get(*i).copied())
                .collect();
            let looped = match members.as_slice() {
                [single] => nodes
                    .get(single)
                    .is_some_and(|node| node.out.iter().any(|(record, _)| record == single)),
                _ => true,
            };
            if !looped {
                let Some(id) = members.first().copied() else {
                    continue;
                };
                if !dirty.contains(&id) {
                    continue;
                }
                let changed = self.compute(&deriver, &graph, &nodes, id, &cycles)?;
                mark(&nodes, &graph, id, &changed, &mut dirty);
                continue;
            }
            if !members.iter().any(|id| dirty.contains(id)) {
                continue;
            }
            let derived: usize = members
                .iter()
                .filter_map(|id| nodes.get(id))
                .filter_map(|node| graph.info(node.table))
                .map(|info| info.derived.len())
                .sum();
            let mut changed: HashMap<i64, HashSet<String>> = HashMap::new();
            for _ in 0..=derived + 1 {
                let mut any = false;
                for id in &members {
                    let names = self.compute(&deriver, &graph, &nodes, *id, &cycles)?;
                    if !names.is_empty() {
                        any = true;
                        changed.entry(*id).or_default().extend(names);
                    }
                }
                if !any {
                    break;
                }
            }
            for id in &members {
                if let Some(names) = changed.get(id) {
                    mark(&nodes, &graph, *id, names, &mut dirty);
                }
            }
        }
        Ok(())
    }

    fn record_row(&self, id: i64) -> Result<Option<(i64, String)>> {
        Ok(self
            .conn
            .prepare_cached(
                "SELECT table_id, row_key FROM kition_records WHERE id = ?1 AND deleted_at IS NULL",
            )?
            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?)
    }

    /// The derived-field dependencies of every live table.
    fn graph(&mut self) -> Result<Graph> {
        let mut graph = Graph::default();
        let mut primaries: HashMap<i64, Option<i64>> = HashMap::new();
        {
            let mut statement = self.conn.prepare_cached(
                "SELECT id, primary_field_id FROM kition_tables WHERE deleted_at IS NULL",
            )?;
            for row in statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))? {
                let (id, primary) = row?;
                primaries.insert(id, primary);
            }
        }
        let mut tables: Vec<i64> = primaries.keys().copied().collect();
        tables.sort_unstable();
        let mut schemas: Vec<(i64, std::rc::Rc<TableSchema>)> = Vec::new();
        let mut field_table: HashMap<i64, i64> = HashMap::new();
        for table in &tables {
            let schema = self.schema(*table)?;
            for field in &schema.fields {
                graph.field_names.insert(field.id, field.name.clone());
                field_table.insert(field.id, *table);
            }
            schemas.push((*table, schema));
        }
        for (table, schema) in &schemas {
            let mut info = TableInfo {
                primary: primaries
                    .get(table)
                    .copied()
                    .flatten()
                    .filter(|id| field_table.get(id) == Some(table))
                    .and_then(|id| graph.field_names.get(&id).cloned()),
                ..TableInfo::default()
            };
            for field in &schema.fields {
                if !is_derived(field) {
                    continue;
                }
                info.derived.insert(field.name.clone());
                let option = |key: &str| json::int_option(&field.options, key);
                let (link, reads) = match field.field_type.as_str() {
                    "formula" => {
                        for name in formula_references(&field.formula) {
                            info.formula_readers
                                .entry(name)
                                .or_default()
                                .push(field.name.clone());
                        }
                        continue;
                    }
                    "lookup" => {
                        let Some(name) = graph.field_names.get(&option("target_field_id")) else {
                            continue;
                        };
                        (option("link_field_id"), Reads::Name(name.clone()))
                    }
                    "rollup" => {
                        let aggregation = field
                            .options
                            .get("aggregation")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if aggregation.is_empty() {
                            continue;
                        }
                        let reads = match graph.field_names.get(&option("target_field_id")) {
                            Some(name) => Reads::Name(name.clone()),
                            None => Reads::Whole,
                        };
                        (option("link_field_id"), reads)
                    }
                    _ => {
                        // A chip shows the target table's primary field.
                        let target = option("target_table_id");
                        let Some(primary) = primaries
                            .get(&target)
                            .copied()
                            .flatten()
                            .and_then(|id| graph.field_names.get(&id).cloned())
                        else {
                            continue;
                        };
                        (field.id, Reads::Name(primary))
                    }
                };
                if link != 0 && field_table.get(&link) == Some(table) {
                    graph.readers.entry(link).or_default().push(Reader {
                        name: field.name.clone(),
                        reads,
                    });
                }
            }
            graph.tables.insert(*table, info);
        }
        for (_, schema) in &schemas {
            for field in &schema.fields {
                graph.fields.insert(field.id, field.clone());
            }
        }
        // The field dependency graph, for its cycles.
        let mut ids: Vec<i64> = graph.fields.keys().copied().collect();
        ids.sort_unstable();
        let position: HashMap<i64, usize> =
            ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
        let table_fields = |table: i64| -> Vec<usize> {
            ids.iter()
                .enumerate()
                .filter(|(_, id)| field_table.get(id) == Some(&table))
                .map(|(i, _)| i)
                .collect()
        };
        let adjacency: Vec<Vec<usize>> = ids
            .iter()
            .map(|id| {
                let Some(field) = graph.fields.get(id) else {
                    return Vec::new();
                };
                let table = field_table.get(id).copied().unwrap_or_default();
                let option = |key: &str| json::int_option(&field.options, key);
                let at = |id: i64| position.get(&id).copied();
                match field.field_type.as_str() {
                    "formula" => {
                        let names = formula_references(&field.formula);
                        table_fields(table)
                            .into_iter()
                            .filter(|i| {
                                ids.get(*i)
                                    .and_then(|id| graph.field_names.get(id))
                                    .is_some_and(|name| names.contains(name))
                            })
                            .collect()
                    }
                    "lookup" => at(option("target_field_id")).into_iter().collect(),
                    "rollup" => match at(option("target_field_id")) {
                        Some(target) => vec![target],
                        None => graph
                            .fields
                            .get(&option("link_field_id"))
                            .map(|link| {
                                table_fields(json::int_option(&link.options, "target_table_id"))
                            })
                            .unwrap_or_default(),
                    },
                    "link_to_record" => primaries
                        .get(&option("target_table_id"))
                        .copied()
                        .flatten()
                        .and_then(at)
                        .into_iter()
                        .collect(),
                    _ => Vec::new(),
                }
            })
            .collect();
        for component in strongly_connected(&adjacency) {
            if !circular(&component, &adjacency) {
                continue;
            }
            let members: Vec<i64> = component
                .iter()
                .filter_map(|i| ids.get(*i).copied())
                .collect();
            for id in &members {
                if let Some(table) = field_table.get(id) {
                    graph.cyclic_tables.insert(*table);
                }
            }
            graph.field_cycles.push(members);
        }
        Ok(graph)
    }

    /// The `(record, field)` pairs on a cycle, by record and field name, with a cycle id. Only
    /// fields on a field-level cycle can be on one, so the graph covers those fields of every
    /// record of their tables: a running total (circular per field) has no cycle, a lookup of
    /// itself through records linking to each other has one.
    fn cycles(&mut self, graph: &Graph) -> Result<HashMap<i64, HashMap<String, usize>>> {
        let mut cycles: HashMap<i64, HashMap<String, usize>> = HashMap::new();
        let mut next_cycle = 0;
        for members in &graph.field_cycles {
            // The member fields' names by table.
            let mut names: HashMap<i64, Vec<&Field>> = HashMap::new();
            for id in members {
                if let Some(field) = graph.fields.get(id) {
                    names.entry(field.table_id).or_default().push(field);
                }
            }
            let mut keys: Vec<(i64, &Field)> = Vec::new();
            let mut record_table: HashMap<i64, i64> = HashMap::new();
            for (table, fields) in &names {
                let mut statement = self.conn.prepare_cached(
                    "SELECT id FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL",
                )?;
                for record in statement.query_map([table], |row| row.get::<_, i64>(0))? {
                    let record = record?;
                    record_table.insert(record, *table);
                    for field in fields {
                        keys.push((record, field));
                    }
                }
            }
            let index: HashMap<(i64, &str), usize> = keys
                .iter()
                .enumerate()
                .map(|(i, (record, field))| ((*record, field.name.as_str()), i))
                .collect();
            // Links of the member fields' link fields, by source record.
            let mut links: HashMap<i64, HashMap<i64, Vec<i64>>> = HashMap::new();
            for fields in names.values() {
                for field in fields {
                    let link = if field.field_type == "link_to_record" {
                        field.id
                    } else {
                        json::int_option(&field.options, "link_field_id")
                    };
                    if link == 0 || links.contains_key(&link) {
                        continue;
                    }
                    let mut by_source: HashMap<i64, Vec<i64>> = HashMap::new();
                    let mut statement = self.conn.prepare_cached(
                        "SELECT from_record_id, to_record_id FROM kition_record_links WHERE from_field_id = ?1",
                    )?;
                    let rows = statement.query_map([link], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                    })?;
                    for row in rows {
                        let (from, to) = row?;
                        by_source.entry(from).or_default().push(to);
                    }
                    links.insert(link, by_source);
                }
            }
            let empty = Vec::new();
            let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); keys.len()];
            for (i, (record, field)) in keys.iter().enumerate() {
                let option = |key: &str| json::int_option(&field.options, key);
                let linked = |link: i64| -> &Vec<i64> {
                    links
                        .get(&link)
                        .and_then(|by_source| by_source.get(record))
                        .unwrap_or(&empty)
                };
                let member = |to: i64, name: &str| index.get(&(to, name)).copied();
                let mut targets: Vec<usize> = Vec::new();
                match field.field_type.as_str() {
                    "formula" => {
                        for name in formula_references(&field.formula) {
                            targets.extend(member(*record, &name));
                        }
                    }
                    "lookup" | "rollup" => {
                        let target = graph.field_names.get(&option("target_field_id"));
                        for to in linked(option("link_field_id")) {
                            match target {
                                Some(name) => targets.extend(member(*to, name)),
                                None if field.field_type == "rollup" => {
                                    let table = record_table.get(to).copied().unwrap_or_default();
                                    for other in names.get(&table).into_iter().flatten() {
                                        targets.extend(member(*to, &other.name));
                                    }
                                }
                                None => {}
                            }
                        }
                    }
                    _ => {
                        for to in linked(field.id) {
                            let primary = record_table
                                .get(to)
                                .and_then(|table| graph.info(*table))
                                .and_then(|info| info.primary.as_deref());
                            if let Some(primary) = primary {
                                targets.extend(member(*to, primary));
                            }
                        }
                    }
                }
                if let Some(slot) = adjacency.get_mut(i) {
                    *slot = targets;
                }
            }
            for component in strongly_connected(&adjacency) {
                if !circular(&component, &adjacency) {
                    continue;
                }
                for i in component {
                    if let Some((record, field)) = keys.get(i) {
                        cycles
                            .entry(*record)
                            .or_default()
                            .insert(field.name.clone(), next_cycle);
                    }
                }
                next_cycle += 1;
            }
        }
        Ok(cycles)
    }

    /// Recomputes one record and writes its values if they changed; answers the names whose
    /// values changed.
    fn compute(
        &mut self,
        deriver: &Deriver<'_>,
        graph: &Graph,
        nodes: &HashMap<i64, Node>,
        id: i64,
        cycles: &HashMap<i64, HashMap<String, usize>>,
    ) -> Result<HashSet<String>> {
        self.recomputed += 1;
        let Some(node) = nodes.get(&id) else {
            return Ok(HashSet::new());
        };
        let current: Option<String> = self
            .conn
            .prepare_cached(
                "SELECT values_json FROM kition_records WHERE id = ?1 AND deleted_at IS NULL",
            )?
            .query_row([id], |row| row.get(0))
            .optional()?;
        let Some(current) = current else {
            return Ok(HashSet::new());
        };
        let schema = self.schema(node.table)?;
        let stored = self.stored_values(&schema, &ObjectId::from_string(node.key.clone()))?;
        let hidden = |record: i64, name: &str| -> Option<usize> {
            cycles
                .get(&record)
                .and_then(|names| names.get(name))
                .copied()
        };
        let (mut values, _) = deriver.recompute_hiding(&schema.fields, id, &stored, &hidden)?;
        if schema.forward_formulas {
            let passes = graph.info(node.table).map_or(1, |info| info.derived.len());
            for _ in 1..passes.max(1) {
                let (again, changed) =
                    deriver.recompute_hiding(&schema.fields, id, &values, &hidden)?;
                values = again;
                if !changed {
                    break;
                }
            }
        }
        let before = json::object(&current);
        let mut changed: HashSet<String> = HashSet::new();
        for (name, value) in &values {
            if !json::equal(before.get(name).unwrap_or(&Value::Null), value) {
                changed.insert(name.clone());
            }
        }
        for (name, value) in &before {
            if !values.contains_key(name) && !value.is_null() {
                changed.insert(name.clone());
            }
        }
        if changed.is_empty() {
            if self.created.contains(&id) {
                self.out.upserted.insert((node.table, node.key.clone()));
            }
            return Ok(changed);
        }
        let encoded = Value::Object(values).to_string();
        if self.touched.contains(&id) {
            self.conn
                .prepare_cached(
                    "UPDATE kition_records SET values_json = ?1, updated_by = ?2, updated_at = ?3 WHERE id = ?4",
                )?
                .execute(params![encoded, self.actor, self.now, id])?;
        } else {
            self.conn
                .prepare_cached(
                    "UPDATE kition_records SET values_json = ?1, updated_at = ?2 WHERE id = ?3",
                )?
                .execute(params![encoded, self.now, id])?;
        }
        self.out.upserted.insert((node.table, node.key.clone()));
        Ok(changed)
    }
}

/// Marks dirty the records reading a name of `changed` from `id`.
fn mark(
    nodes: &HashMap<i64, Node>,
    graph: &Graph,
    id: i64,
    changed: &HashSet<String>,
    dirty: &mut HashSet<i64>,
) {
    if changed.is_empty() {
        return;
    }
    let Some(node) = nodes.get(&id) else {
        return;
    };
    for (record, link) in &node.out {
        let reads = graph
            .readers
            .get(link)
            .into_iter()
            .flatten()
            .any(|reader| reader.reads.matches_set(changed));
        if reads {
            dirty.insert(*record);
        }
    }
}

/// Each cycle's canonical label (its smallest `record:field` member), by record and field name,
/// as kept in `kition_meta` between projections.
fn cycle_labels(
    cycles: &HashMap<i64, HashMap<String, usize>>,
) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut smallest: HashMap<usize, (i64, &str)> = HashMap::new();
    for (record, names) in cycles {
        for (name, cycle) in names {
            let candidate = (*record, name.as_str());
            smallest
                .entry(*cycle)
                .and_modify(|current| {
                    if candidate < *current {
                        *current = candidate;
                    }
                })
                .or_insert(candidate);
        }
    }
    let mut labels: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for (record, names) in cycles {
        for (name, cycle) in names {
            if let Some((first, field)) = smallest.get(cycle) {
                labels
                    .entry(record.to_string())
                    .or_default()
                    .insert(name.clone(), format!("{first}:{field}"));
            }
        }
    }
    labels
}

/// Whether a component is a cycle: more than one member, or one with an edge to itself.
fn circular(component: &[usize], adjacency: &[Vec<usize>]) -> bool {
    component.len() > 1
        || component
            .first()
            .is_some_and(|i| adjacency.get(*i).is_some_and(|next| next.contains(i)))
}

fn is_derived(field: &Field) -> bool {
    matches!(
        field.field_type.as_str(),
        "formula" | "lookup" | "rollup" | "link_to_record"
    )
}

/// Strongly connected components (Tarjan, iterative), each finished after every component it
/// reaches: reversed, the list puts every component before the ones its edges point to.
pub(super) fn strongly_connected(adjacency: &[Vec<usize>]) -> Vec<Vec<usize>> {
    const UNSEEN: usize = usize::MAX;
    let count = adjacency.len();
    let mut order = vec![UNSEEN; count];
    let mut low = vec![0; count];
    let mut on_stack = vec![false; count];
    let mut stack: Vec<usize> = Vec::new();
    let mut components = Vec::new();
    let mut next = 0;
    for root in 0..count {
        if order.get(root) != Some(&UNSEEN) {
            continue;
        }
        // (node, index of the next edge to follow)
        let mut frames: Vec<(usize, usize)> = vec![(root, 0)];
        while let Some(&(node, edge)) = frames.last() {
            if edge == 0 && order.get(node) == Some(&UNSEEN) {
                set(&mut order, node, next);
                set(&mut low, node, next);
                next += 1;
                stack.push(node);
                set(&mut on_stack, node, true);
            }
            let edges = adjacency.get(node).map_or(&[][..], Vec::as_slice);
            if let Some(&target) = edges.get(edge) {
                if let Some(frame) = frames.last_mut() {
                    frame.1 += 1;
                }
                if order.get(target) == Some(&UNSEEN) {
                    frames.push((target, 0));
                } else if on_stack.get(target) == Some(&true) {
                    let value = get(&low, node).min(get(&order, target));
                    set(&mut low, node, value);
                }
                continue;
            }
            frames.pop();
            if let Some(&(parent, _)) = frames.last() {
                let value = get(&low, parent).min(get(&low, node));
                set(&mut low, parent, value);
            }
            if get(&low, node) == get(&order, node) {
                let mut component = Vec::new();
                while let Some(member) = stack.pop() {
                    set(&mut on_stack, member, false);
                    component.push(member);
                    if member == node {
                        break;
                    }
                }
                components.push(component);
            }
        }
    }
    components
}

fn get<T: Copy + Default>(items: &[T], index: usize) -> T {
    items.get(index).copied().unwrap_or_default()
}

fn set<T>(items: &mut [T], index: usize, value: T) {
    if let Some(slot) = items.get_mut(index) {
        *slot = value;
    }
}

#[cfg(test)]
mod tests {
    use super::strongly_connected;

    #[test]
    fn components_come_after_what_they_reach() {
        // 0 -> 1 -> 2 -> 1, 2 -> 3, 4 alone.
        let adjacency = vec![vec![1], vec![2], vec![1, 3], vec![], vec![]];
        let mut components = strongly_connected(&adjacency);
        for component in &mut components {
            component.sort_unstable();
        }
        let position = |member: usize| {
            components
                .iter()
                .position(|component| component.contains(&member))
                .unwrap_or(usize::MAX)
        };
        assert!(components.contains(&vec![1, 2]));
        assert!(position(3) < position(1));
        assert!(position(1) < position(0));
        assert_eq!(components.len(), 4);
    }

    #[test]
    fn long_chains_do_not_recurse() {
        let adjacency: Vec<Vec<usize>> =
            (0..100_000).map(|i| vec![i + 1]).chain([vec![]]).collect();
        assert_eq!(strongly_connected(&adjacency).len(), 100_001);
    }
}
