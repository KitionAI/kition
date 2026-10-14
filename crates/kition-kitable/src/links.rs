//! `link_to_record` fields: links between records and link candidates.

use kition_kdm::ObjectId;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;
use serde_json::Value;

use crate::json;
use crate::kdm::commit::{field_object, record_object};
use crate::kdm::model;
use crate::source::{self, Field};
use crate::{KitableError, KitableFile, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkRef {
    pub row_key: String,
    pub display: String,
}

/// Trimmed, non-empty, first occurrence only.
pub(crate) fn dedupe(values: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_owned());
        }
    }
    out
}

pub(crate) fn placeholders(start: usize, count: usize) -> String {
    (start..start + count)
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// A record's display text: its value of the primary field.
pub(crate) fn display(values_json: &str, primary: Option<&Field>) -> String {
    let Some(primary) = primary else {
        return String::new();
    };
    match json::object(values_json).get(&primary.name) {
        None | Some(Value::Null) => String::new(),
        Some(value) => json::to_text(value),
    }
}

impl KitableFile {
    pub fn list_record_links(
        &self,
        from_table_id: i64,
        from_record_id: i64,
        field_id: i64,
    ) -> Result<Vec<LinkRef>> {
        let (target, primary) = self.resolve_link_target(field_id)?;
        link_refs(
            &self.conn,
            from_table_id,
            from_record_id,
            field_id,
            target,
            primary.as_ref(),
        )
    }

    /// Replaces the field's links from one record with `target_row_keys`. Links already there
    /// keep their place; new ones follow, in the given order. Answers the links in link order.
    pub fn replace_record_links(
        &mut self,
        from_table_id: i64,
        from_record_id: i64,
        field_id: i64,
        target_row_keys: &[String],
    ) -> Result<Vec<LinkRef>> {
        let field = self
            .get_field(from_table_id, field_id)
            .map_err(|err| KitableError::invalid(format!("field not found: {err}")))?;
        if field.field_type != "link_to_record" {
            return Err(KitableError::invalid(format!(
                "field {} is not link_to_record",
                field.name
            )));
        }
        let (target_table_id, primary) = self.resolve_link_target(field_id)?;
        let cleaned = dedupe(target_row_keys);
        let allow_multiple = field
            .options
            .get("allow_multiple")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if !allow_multiple && cleaned.len() > 1 {
            return Err(KitableError::invalid(
                "field does not allow multiple link targets",
            ));
        }

        let mut targets = Vec::with_capacity(cleaned.len());
        if !cleaned.is_empty() {
            let mut args = vec![SqlValue::Integer(target_table_id)];
            args.extend(cleaned.iter().map(|key| SqlValue::Text(key.clone())));
            let live: Vec<String> = {
                let mut statement = self.conn.prepare(&format!(
                    "SELECT row_key FROM kition_records \
                     WHERE table_id = ?1 AND deleted_at IS NULL AND row_key IN ({})",
                    placeholders(2, cleaned.len())
                ))?;
                statement
                    .query_map(params_from_iter(args.iter()), |row| row.get(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            };
            for key in &cleaned {
                if !live.contains(key) {
                    return Err(KitableError::invalid(format!(
                        "link target not found: {key}"
                    )));
                }
                targets.push(ObjectId::from_string(key.clone()));
            }
        }
        let from = record_object(&self.conn, from_table_id, from_record_id)?;
        let field_object = field_object(&self.conn, from_table_id, field_id)?;
        self.commit(|tx| model::replace_links(tx, &from, &field_object, &targets))?;
        if cleaned.is_empty() {
            return Ok(Vec::new());
        }
        link_refs(
            &self.conn,
            from_table_id,
            from_record_id,
            field_id,
            target_table_id,
            primary.as_ref(),
        )
    }

    pub fn delete_record_links(
        &mut self,
        from_table_id: i64,
        from_record_id: i64,
        field_id: i64,
        target_row_keys: &[String],
    ) -> Result<()> {
        let cleaned = dedupe(target_row_keys);
        if cleaned.is_empty() {
            return Ok(());
        }
        let current: Vec<String> = {
            let mut statement = self.conn.prepare(
                "SELECT r.row_key FROM kition_record_links l JOIN kition_records r ON r.id = l.to_record_id \
                 WHERE l.from_table_id = ?1 AND l.from_record_id = ?2 AND l.from_field_id = ?3 ORDER BY l.id ASC",
            )?;
            statement
                .query_map(params![from_table_id, from_record_id, field_id], |row| {
                    row.get(0)
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let kept: Vec<ObjectId> = current
            .iter()
            .filter(|key| !cleaned.contains(key))
            .map(|key| ObjectId::from_string(key.clone()))
            .collect();
        if kept.len() == current.len() {
            return Ok(());
        }
        let from = record_object(&self.conn, from_table_id, from_record_id)?;
        let field_object = field_object(&self.conn, from_table_id, field_id)?;
        self.commit(|tx| model::replace_links(tx, &from, &field_object, &kept))?;
        Ok(())
    }

    /// Records of the link target table whose display text contains `query`
    /// (case-insensitive). `limit` outside 1..=100 means 25.
    pub fn list_link_candidates(
        &self,
        field_id: i64,
        query: &str,
        limit: i64,
    ) -> Result<Vec<LinkRef>> {
        let (target_table_id, primary) = self.resolve_link_target(field_id)?;
        let limit = if limit <= 0 || limit > 100 { 25 } else { limit };
        let limit = usize::try_from(limit).unwrap_or(25);
        let needle = query.trim().to_lowercase();
        let mut statement = self.conn.prepare(
            "SELECT row_key, values_json FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position ASC, id ASC",
        )?;
        let mut rows = statement.query([target_table_id])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            if out.len() >= limit {
                break;
            }
            let row_key: String = row.get(0)?;
            let values: String = row.get(1)?;
            let text = display(&values, primary.as_ref());
            if !needle.is_empty() && !text.to_lowercase().contains(&needle) {
                continue;
            }
            out.push(LinkRef {
                row_key,
                display: text,
            });
        }
        Ok(out)
    }

    /// The link field's target table and that table's primary field.
    pub(crate) fn resolve_link_target(&self, field_id: i64) -> Result<(i64, Option<Field>)> {
        resolve_link_target(&self.conn, field_id)
    }
}

/// The live records one record links to through `field_id` in the `target` table, in link order,
/// with their display text (their value of `primary`).
pub(crate) fn link_refs(
    conn: &Connection,
    from_table_id: i64,
    from_record_id: i64,
    field_id: i64,
    target: i64,
    primary: Option<&Field>,
) -> Result<Vec<LinkRef>> {
    Ok(
        link_rows(conn, from_table_id, from_record_id, field_id, target)?
            .into_iter()
            .map(|(_, row_key, values)| LinkRef {
                row_key,
                display: display(&values, primary),
            })
            .collect(),
    )
}

/// `(id, row_key, values_json)` of the live records one record links to through `field_id` in
/// the `target` table, in link order.
pub(crate) fn link_rows(
    conn: &Connection,
    from_table_id: i64,
    from_record_id: i64,
    field_id: i64,
    target: i64,
) -> Result<Vec<(i64, String, String)>> {
    let mut statement = conn.prepare_cached(
        "SELECT r.id, r.row_key, r.values_json FROM kition_record_links l \
         JOIN kition_records r ON r.id = l.to_record_id \
         WHERE l.from_table_id = ?1 AND l.from_record_id = ?2 AND l.from_field_id = ?3 AND l.to_table_id = ?4 \
         AND r.deleted_at IS NULL ORDER BY l.id ASC",
    )?;
    let rows = statement
        .query_map(
            params![from_table_id, from_record_id, field_id, target],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The link field's target table and that table's primary field.
pub(crate) fn resolve_link_target(
    conn: &Connection,
    field_id: i64,
) -> Result<(i64, Option<Field>)> {
    let (_, options_json): (i64, String) = conn
        .query_row(
            "SELECT table_id, options_json FROM kition_fields WHERE id = ?1 AND deleted_at IS NULL",
            [field_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => {
                KitableError::invalid(format!("link field not found: {}", KitableError::NotFound))
            }
            other => KitableError::from(other),
        })?;
    let target_table_id = json::int_option(&json::object(&options_json), "target_table_id");
    if target_table_id == 0 {
        return Err(KitableError::invalid(
            "link field is missing target_table_id",
        ));
    }
    let primary_id: Option<i64> = conn
        .query_row(
            "SELECT primary_field_id FROM kition_tables WHERE id = ?1 AND deleted_at IS NULL",
            [target_table_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            KitableError::invalid(format!(
                "link target table not found: {}",
                KitableError::NotFound
            ))
        })?;
    let primary = match primary_id {
        None => None,
        Some(id) => match source::field_in(conn, target_table_id, id) {
            Ok(field) => Some(field),
            Err(KitableError::NotFound) => None,
            Err(error) => return Err(error),
        },
    };
    Ok((target_table_id, primary))
}
