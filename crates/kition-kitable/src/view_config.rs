//! View configuration: nested filter trees, sorts, groups, and per-view
//! field layout.

use kition_core::now_millis;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::source::exists;
use crate::{KitableError, KitableFile, Result};

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

fn insert_group(
    conn: &Connection,
    view_id: i64,
    parent: Option<i64>,
    position: i64,
    tree: &FilterTree,
) -> Result<i64> {
    let now = now_millis();
    conn.execute(
        "INSERT INTO kition_filter_groups (view_id, parent_group_id, conjunction, position, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![view_id, parent, normalize_conjunction(&tree.conjunction), position, now],
    )?;
    let group_id = conn.last_insert_rowid();
    for (index, child) in tree.children.iter().enumerate() {
        let index = i64::try_from(index).unwrap_or(i64::MAX);
        if let Some(group) = &child.group {
            insert_group(conn, view_id, Some(group_id), index, group)?;
        } else if let Some(condition) = &child.condition {
            conn.execute(
                "INSERT INTO kition_filter_conditions (view_id, group_id, field_id, operator, value_json, position, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![view_id, group_id, condition.field_id, condition.operator, condition.value.to_string(), index, now],
            )?;
        }
    }
    Ok(group_id)
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

    /// The view's filter tree, or `None` when it has no filters.
    pub fn load_filter_tree(&self, view_id: i64) -> Result<Option<FilterTree>> {
        self.assert_view_exists(view_id)?;
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

    /// Replaces the view's filters; `None` clears them.
    pub fn save_filter_tree(&mut self, view_id: i64, tree: Option<&FilterTree>) -> Result<()> {
        self.assert_view_exists(view_id)?;
        if let Some(tree) = tree {
            validate_tree(tree)?;
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM kition_filter_conditions WHERE view_id = ?1",
            [view_id],
        )?;
        tx.execute(
            "DELETE FROM kition_filter_groups WHERE view_id = ?1",
            [view_id],
        )?;
        if let Some(tree) = tree {
            insert_group(&tx, view_id, None, 0, tree)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_view_sorts(&self, view_id: i64) -> Result<Vec<ViewSort>> {
        self.list_ordering("kition_view_sorts", view_id)
    }

    pub fn list_view_groups(&self, view_id: i64) -> Result<Vec<ViewGroup>> {
        self.list_ordering("kition_view_groups", view_id)
    }

    fn list_ordering(&self, table: &str, view_id: i64) -> Result<Vec<ViewSort>> {
        self.assert_view_exists(view_id)?;
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
        let tx = self.conn.transaction()?;
        tx.execute(
            &format!("DELETE FROM {table} WHERE view_id = ?1"),
            [view_id],
        )?;
        let now = now_millis();
        for (index, item) in items.iter().enumerate() {
            tx.execute(
                &format!(
                    "INSERT INTO {table} (view_id, field_id, direction, position, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)"
                ),
                params![view_id, item.field_id, normalize_direction(&item.direction), i64::try_from(index).unwrap_or(0), now],
            )?;
        }
        tx.commit()?;
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
        let tx = self.conn.transaction()?;
        let mut current = ViewField {
            view_id,
            field_id,
            visible: true,
            width: 180,
            position: 0,
            frozen: false,
        };
        let existing: Option<(i64, i64, i64, i64)> = tx
            .query_row(
                "SELECT visible, width, position, frozen FROM kition_view_fields WHERE view_id = ?1 AND field_id = ?2",
                params![view_id, field_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((visible, width, position, frozen)) = existing {
            current.visible = visible != 0;
            current.width = width;
            current.position = position;
            current.frozen = frozen != 0;
        }
        if let Some(visible) = patch.visible {
            current.visible = visible;
        }
        if let Some(width) = patch.width {
            current.width = width.clamp(40, 1200);
        }
        if let Some(position) = patch.position {
            current.position = position;
        }
        if let Some(frozen) = patch.frozen {
            current.frozen = frozen;
        }
        let now = now_millis();
        tx.execute(
            "INSERT INTO kition_view_fields (view_id, field_id, visible, width, position, frozen, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) \
             ON CONFLICT(view_id, field_id) DO UPDATE SET visible = excluded.visible, width = excluded.width, \
             position = excluded.position, frozen = excluded.frozen, updated_at = excluded.updated_at",
            params![view_id, field_id, current.visible, current.width, current.position, current.frozen, now],
        )?;
        tx.commit()?;
        Ok(current)
    }
}
