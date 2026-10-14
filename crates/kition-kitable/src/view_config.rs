//! View configuration: nested filter trees, sorts, groups, and per-view
//! field layout.

use std::collections::HashMap;

use kition_core::now_millis;
use kition_kdm::{ObjectId, Origin};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::kdm::commit::view_object;
use crate::kdm::model;
use crate::source::{ViewPatch, exists};
use crate::{KitableError, KitableFile, Result, json};

/// The view config keys the filter tree, sorts, and groups are kept under.
const FILTER_TREE_KEY: &str = "filter_tree";
const SORTS_KEY: &str = "sorts";
const GROUPS_KEY: &str = "groups";

fn ordering_key(table: &str) -> &'static str {
    if table == "kition_view_groups" {
        GROUPS_KEY
    } else {
        SORTS_KEY
    }
}

/// A new view config that keeps the sorts and groups of `current` unless it names its own:
/// the table editor writes whole configs and knows nothing of them.
pub(crate) fn keep_orderings(current: &Map<String, Value>, config: &Value) -> Result<Value> {
    let mut parsed = match config {
        Value::String(raw) if !raw.trim().is_empty() => match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(_) => return Ok(config.clone()),
        },
        other => other.clone(),
    };
    if let Value::Object(map) = &mut parsed {
        for key in [SORTS_KEY, GROUPS_KEY] {
            if !map.contains_key(key)
                && let Some(kept) = current.get(key)
            {
                map.insert(key.to_owned(), kept.clone());
            }
        }
    }
    Ok(parsed)
}

fn field_names_by_id(conn: &Connection, table_id: i64) -> Result<HashMap<i64, String>> {
    let mut statement = conn
        .prepare("SELECT id, name FROM kition_fields WHERE table_id = ?1 AND deleted_at IS NULL")?;
    let rows = statement
        .query_map([table_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

fn field_ids_by_name(conn: &Connection, table_id: i64) -> Result<HashMap<String, i64>> {
    Ok(field_names_by_id(conn, table_id)?
        .into_iter()
        .map(|(id, name)| (name, id))
        .collect())
}

/// A config entry's field: by `field_name` when it names a live field, else its `field_id`.
fn config_field_id(item: &Value, ids: &HashMap<String, i64>) -> i64 {
    item.get("field_name")
        .and_then(Value::as_str)
        .and_then(|name| ids.get(name).copied())
        .or_else(|| item.get("field_id").and_then(Value::as_i64))
        .unwrap_or(0)
}

/// A filter tree in the table editor's form: `{id, kind: "group", conjunction, children}` and
/// `{id, kind: "condition", field_name, operator, value}`, plus the field's integer id.
fn tree_to_config(tree: &FilterTree, names: &HashMap<i64, String>) -> Value {
    let children: Vec<Value> = tree
        .children
        .iter()
        .filter_map(|child| match (&child.group, &child.condition) {
            (Some(group), _) => Some(tree_to_config(group, names)),
            (None, Some(rule)) => Some(json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "kind": "condition",
                "field_name": names.get(&rule.field_id).cloned().unwrap_or_default(),
                "field_id": rule.field_id,
                "operator": rule.operator,
                "value": rule.value,
            })),
            (None, None) => None,
        })
        .collect();
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "kind": "group",
        "conjunction": normalize_conjunction(&tree.conjunction),
        "children": children,
    })
}

/// The API form of a config's filter tree; `None` when it holds no group.
fn tree_from_config(value: &Value, ids: &HashMap<String, i64>) -> Option<FilterTree> {
    if value.get("kind").and_then(Value::as_str) != Some("group") {
        return None;
    }
    let children = value
        .get("children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|child| match child.get("kind").and_then(Value::as_str) {
            Some("group") => tree_from_config(child, ids).map(|group| FilterTreeChild {
                group: Some(Box::new(group)),
                condition: None,
            }),
            Some("condition") => Some(FilterTreeChild {
                group: None,
                condition: Some(FilterRule {
                    field_id: config_field_id(child, ids),
                    operator: child
                        .get("operator")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    value: child.get("value").cloned().unwrap_or(Value::Null),
                }),
            }),
            _ => None,
        })
        .collect();
    Some(FilterTree {
        conjunction: normalize_conjunction(
            value
                .get("conjunction")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .to_owned(),
        children,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct FilterTree {
    #[serde(default)]
    pub conjunction: String,
    #[serde(default)]
    pub children: Vec<FilterTreeChild>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct FilterTreeChild {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<Box<FilterTree>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<FilterRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct FilterRule {
    #[serde(default)]
    pub field_id: i64,
    #[serde(default)]
    pub operator: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ViewSort {
    #[serde(default)]
    pub field_id: i64,
    #[serde(default)]
    pub direction: String,
}

pub type ViewGroup = ViewSort;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ViewField {
    pub view_id: i64,
    pub field_id: i64,
    pub visible: bool,
    pub width: i64,
    pub position: i64,
    pub frozen: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ViewFieldPatch {
    pub visible: Option<bool>,
    pub width: Option<i64>,
    pub position: Option<i64>,
    pub frozen: Option<bool>,
}

fn normalize_conjunction(value: &str) -> &'static str {
    if value.trim().eq_ignore_ascii_case("or") {
        "or"
    } else {
        "and"
    }
}

fn validate_direction(value: &str) -> std::result::Result<(), String> {
    match value.trim().to_lowercase().as_str() {
        "asc" | "desc" | "" => Ok(()),
        _ => Err(format!("invalid direction {value:?}")),
    }
}

fn normalize_direction(value: &str) -> &'static str {
    if value.trim().eq_ignore_ascii_case("desc") {
        "desc"
    } else {
        "asc"
    }
}

fn validate_tree(tree: &FilterTree) -> Result<()> {
    for (index, child) in tree.children.iter().enumerate() {
        match (&child.group, &child.condition) {
            (None, None) => {
                return Err(KitableError::InvalidFilterTree(format!(
                    "child[{index}] has neither group nor condition"
                )));
            }
            (Some(_), Some(_)) => {
                return Err(KitableError::InvalidFilterTree(format!(
                    "child[{index}] has both group and condition"
                )));
            }
            (Some(group), None) => validate_tree(group)?,
            (None, Some(condition)) => {
                if condition.field_id <= 0 {
                    return Err(KitableError::InvalidFilterTree(format!(
                        "condition[{index}] missing field_id"
                    )));
                }
                if condition.operator.trim().is_empty() {
                    return Err(KitableError::InvalidFilterTree(format!(
                        "condition[{index}] missing operator"
                    )));
                }
            }
        }
    }
    Ok(())
}

impl KitableFile {
    fn assert_view_exists(&self, view_id: i64) -> Result<()> {
        exists(
            &self.conn,
            "SELECT id FROM kition_views WHERE id = ?1 AND deleted_at IS NULL",
            view_id,
        )
    }

    fn assert_field_exists(&self, field_id: i64) -> Result<()> {
        exists(
            &self.conn,
            "SELECT id FROM kition_fields WHERE id = ?1 AND deleted_at IS NULL",
            field_id,
        )
    }

    /// The view's filter tree, or `None` when it has no filters: the one in the view's config
    /// (`filter_tree`, as the table editor writes it), else, for a view whose config never held
    /// one, the legacy filter tables.
    pub fn load_filter_tree(&self, view_id: i64) -> Result<Option<FilterTree>> {
        self.assert_view_exists(view_id)?;
        let (table_id, config) = self.view_config(view_id)?;
        if let Some(tree) = config.get(FILTER_TREE_KEY) {
            let ids = field_ids_by_name(&self.conn, table_id)?;
            return Ok(tree_from_config(tree, &ids));
        }
        let root: Option<(i64, String)> = self
            .conn
            .query_row(
                "SELECT id, conjunction FROM kition_filter_groups WHERE view_id = ?1 AND parent_group_id IS NULL \
                 ORDER BY position ASC, id ASC LIMIT 1",
                [view_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match root {
            None => Ok(None),
            Some((id, conjunction)) => Ok(Some(self.load_group(view_id, id, &conjunction)?)),
        }
    }

    fn load_group(&self, view_id: i64, group_id: i64, conjunction: &str) -> Result<FilterTree> {
        enum Entry {
            Group(i64, String),
            Condition(FilterRule),
        }
        let mut entries: Vec<(i64, i64, Entry)> = Vec::new();
        {
            let mut statement = self.conn.prepare(
                "SELECT id, conjunction, position FROM kition_filter_groups WHERE view_id = ?1 AND parent_group_id = ?2 \
                 ORDER BY position ASC, id ASC",
            )?;
            let groups = statement
                .query_map(params![view_id, group_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for (id, conj, position) in groups {
                entries.push((position, id, Entry::Group(id, conj)));
            }
        }
        {
            let mut statement = self.conn.prepare(
                "SELECT id, field_id, operator, value_json, position FROM kition_filter_conditions \
                 WHERE view_id = ?1 AND group_id = ?2 ORDER BY position ASC, id ASC",
            )?;
            let conditions = statement
                .query_map(params![view_id, group_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for (id, field_id, operator, value_json, position) in conditions {
                let value = if value_json.trim().is_empty() {
                    Value::Null
                } else {
                    serde_json::from_str(&value_json).unwrap_or(Value::Null)
                };
                entries.push((
                    position,
                    id,
                    Entry::Condition(FilterRule {
                        field_id,
                        operator,
                        value,
                    }),
                ));
            }
        }
        entries.sort_by_key(|(position, id, _)| (*position, *id));
        let mut children = Vec::with_capacity(entries.len());
        for (_, _, entry) in entries {
            children.push(match entry {
                Entry::Group(id, conj) => FilterTreeChild {
                    group: Some(Box::new(self.load_group(view_id, id, &conj)?)),
                    condition: None,
                },
                Entry::Condition(rule) => FilterTreeChild {
                    group: None,
                    condition: Some(rule),
                },
            });
        }
        Ok(FilterTree {
            conjunction: normalize_conjunction(conjunction).to_owned(),
            children,
        })
    }

    /// Replaces the view's filters; `None` clears them. Written to the view's config
    /// (`filter_tree`), in the table editor's form (fields by name).
    pub fn save_filter_tree(&mut self, view_id: i64, tree: Option<&FilterTree>) -> Result<()> {
        self.assert_view_exists(view_id)?;
        if let Some(tree) = tree {
            validate_tree(tree)?;
        }
        let (table_id, _) = self.view_config(view_id)?;
        let names = field_names_by_id(&self.conn, table_id)?;
        let value = tree.map_or(Value::Null, |tree| tree_to_config(tree, &names));
        self.set_view_config_key(view_id, FILTER_TREE_KEY, value)
    }

    pub fn list_view_sorts(&self, view_id: i64) -> Result<Vec<ViewSort>> {
        self.list_ordering("kition_view_sorts", view_id)
    }

    pub fn list_view_groups(&self, view_id: i64) -> Result<Vec<ViewGroup>> {
        self.list_ordering("kition_view_groups", view_id)
    }

    fn list_ordering(&self, table: &str, view_id: i64) -> Result<Vec<ViewSort>> {
        self.assert_view_exists(view_id)?;
        let (table_id, config) = self.view_config(view_id)?;
        if let Some(items) = config.get(ordering_key(table)) {
            let ids = field_ids_by_name(&self.conn, table_id)?;
            return Ok(items
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| ViewSort {
                    field_id: config_field_id(item, &ids),
                    direction: item
                        .get("direction")
                        .and_then(Value::as_str)
                        .unwrap_or("asc")
                        .to_owned(),
                })
                .collect());
        }
        let mut statement = self.conn.prepare(&format!(
            "SELECT field_id, direction FROM {table} WHERE view_id = ?1 ORDER BY position ASC, id ASC"
        ))?;
        Ok(statement
            .query_map([view_id], |row| {
                Ok(ViewSort {
                    field_id: row.get(0)?,
                    direction: row.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn replace_view_sorts(&mut self, view_id: i64, sorts: &[ViewSort]) -> Result<()> {
        self.replace_ordering("kition_view_sorts", "sort", view_id, sorts)
    }

    pub fn replace_view_groups(&mut self, view_id: i64, groups: &[ViewGroup]) -> Result<()> {
        self.replace_ordering("kition_view_groups", "group", view_id, groups)
    }

    fn replace_ordering(
        &mut self,
        table: &str,
        label: &str,
        view_id: i64,
        items: &[ViewSort],
    ) -> Result<()> {
        self.assert_view_exists(view_id)?;
        for (index, item) in items.iter().enumerate() {
            validate_direction(&item.direction)
                .map_err(|err| KitableError::invalid(format!("{label}[{index}]: {err}")))?;
            if item.field_id <= 0 {
                return Err(KitableError::invalid(format!(
                    "{label}[{index}]: field_id is required"
                )));
            }
        }
        let (table_id, _) = self.view_config(view_id)?;
        let names = field_names_by_id(&self.conn, table_id)?;
        let value = Value::Array(
            items
                .iter()
                .map(|item| {
                    let mut entry = Map::new();
                    if let Some(name) = names.get(&item.field_id) {
                        entry.insert("field_name".into(), Value::String(name.clone()));
                    }
                    entry.insert("field_id".into(), Value::from(item.field_id));
                    entry.insert(
                        "direction".into(),
                        Value::String(normalize_direction(&item.direction).to_owned()),
                    );
                    Value::Object(entry)
                })
                .collect(),
        );
        self.set_view_config_key(view_id, ordering_key(table), value)
    }

    /// The view's table and its config as projected.
    fn view_config(&self, view_id: i64) -> Result<(i64, Map<String, Value>)> {
        let (table_id, config): (i64, String) = self.conn.query_row(
            "SELECT table_id, config_json FROM kition_views WHERE id = ?1 AND deleted_at IS NULL",
            [view_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((table_id, json::object(&config)))
    }

    /// Sets one key of the view's config, in one transaction.
    fn set_view_config_key(&mut self, view_id: i64, key: &str, value: Value) -> Result<()> {
        let (table_id, mut config) = self.view_config(view_id)?;
        config.insert(key.to_owned(), value);
        let view = view_object(&self.conn, table_id, view_id)?;
        let patch = ViewPatch {
            config: Some(Value::Object(config)),
            ..ViewPatch::default()
        };
        self.commit(|tx| model::update_view(tx, &view, &patch))?;
        Ok(())
    }

    pub fn list_view_fields(&self, view_id: i64) -> Result<Vec<ViewField>> {
        self.assert_view_exists(view_id)?;
        let mut statement = self.conn.prepare(
            "SELECT view_id, field_id, visible, width, position, frozen FROM kition_view_fields \
             WHERE view_id = ?1 ORDER BY position ASC, field_id ASC",
        )?;
        Ok(statement
            .query_map([view_id], |row| {
                Ok(ViewField {
                    view_id: row.get(0)?,
                    field_id: row.get(1)?,
                    visible: row.get::<_, i64>(2)? != 0,
                    width: row.get(3)?,
                    position: row.get(4)?,
                    frozen: row.get::<_, i64>(5)? != 0,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Creates or patches one field's layout in a view. Width is clamped to
    /// 40..=1200.
    pub fn upsert_view_field(
        &mut self,
        view_id: i64,
        field_id: i64,
        patch: &ViewFieldPatch,
    ) -> Result<ViewField> {
        self.assert_view_exists(view_id)?;
        self.assert_field_exists(field_id)?;
        let (table_id, _) = self.view_config(view_id)?;
        let view = view_object(&self.conn, table_id, view_id)?;
        let field: Option<String> = self
            .conn
            .query_row(
                "SELECT kdm_id FROM kition_fields WHERE id = ?1 AND deleted_at IS NULL",
                [field_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let field = field
            .map(ObjectId::from_string)
            .ok_or(KitableError::NotFound)?;
        if let Some(width) = patch.width {
            // Resizing a column is no undo step.
            self.commit_as(&Origin::system("view-width"), |tx| {
                model::set_view_width(tx, &view, &field, width)
            })?;
        }
        if let Some(visible) = patch.visible {
            self.commit(|tx| model::set_view_hidden(tx, &view, &field, !visible))?;
        }
        // Column position and freezing are not part of the table document: plain SQL.
        let now = now_millis();
        self.conn.execute(
            "INSERT INTO kition_view_fields (view_id, field_id, visible, width, position, frozen, created_at, updated_at) \
             VALUES (?1, ?2, 1, 180, 0, 0, ?3, ?3) ON CONFLICT(view_id, field_id) DO NOTHING",
            params![view_id, field_id, now],
        )?;
        if let Some(position) = patch.position {
            self.conn.execute(
                "UPDATE kition_view_fields SET position = ?1, updated_at = ?2 WHERE view_id = ?3 AND field_id = ?4",
                params![position, now, view_id, field_id],
            )?;
        }
        if let Some(frozen) = patch.frozen {
            self.conn.execute(
                "UPDATE kition_view_fields SET frozen = ?1, updated_at = ?2 WHERE view_id = ?3 AND field_id = ?4",
                params![frozen, now, view_id, field_id],
            )?;
        }
        let (visible, width, position, frozen): (i64, i64, i64, i64) = self.conn.query_row(
            "SELECT visible, width, position, frozen FROM kition_view_fields WHERE view_id = ?1 AND field_id = ?2",
            params![view_id, field_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        Ok(ViewField {
            view_id,
            field_id,
            visible: visible != 0,
            width,
            position,
            frozen: frozen != 0,
        })
    }
}
