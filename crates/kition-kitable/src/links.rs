//! `link_to_record` fields: links between records and link candidates.

use kition_core::now_millis;
use rusqlite::types::Value as SqlValue;
use rusqlite::{OptionalExtension, params, params_from_iter};
use serde::Serialize;
use serde_json::Value;

use crate::json;
use crate::source::Field;
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

fn display(values_json: &str, primary: Option<&Field>) -> String {
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
        let mut statement = self.conn.prepare(
            "SELECT r.row_key, r.values_json FROM kition_record_links l \
             JOIN kition_records r ON r.id = l.to_record_id \
             WHERE l.from_table_id = ?1 AND l.from_record_id = ?2 AND l.from_field_id = ?3 AND l.to_table_id = ?4 \
             AND r.deleted_at IS NULL ORDER BY l.id ASC",
        )?;
        let refs = statement
            .query_map(
                params![from_table_id, from_record_id, field_id, target],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|(row_key, values)| LinkRef {
                row_key,
                display: display(&values, primary.as_ref()),
            })
            .collect();
        Ok(refs)
    }

    /// Replaces the field's links from one record with `target_row_keys`, in
    /// the given order.
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

        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM kition_record_links WHERE from_table_id = ?1 AND from_record_id = ?2 AND from_field_id = ?3",
            params![from_table_id, from_record_id, field_id],
        )?;
        if cleaned.is_empty() {
            tx.commit()?;
            return Ok(Vec::new());
        }
        let mut args = vec![SqlValue::Integer(target_table_id)];
        args.extend(cleaned.iter().map(|key| SqlValue::Text(key.clone())));
        let rows = {
            let mut statement = tx.prepare(&format!(
                "SELECT id, document_id, row_key, values_json FROM kition_records \
                 WHERE table_id = ?1 AND deleted_at IS NULL AND row_key IN ({})",
                placeholders(2, cleaned.len())
            ))?;
            statement
                .query_map(params_from_iter(args.iter()), |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let now = now_millis();
        let mut ordered = Vec::with_capacity(cleaned.len());
        for key in &cleaned {
            let (id, document_id, row_key, values) = rows
                .iter()
                .find(|(_, _, row_key, _)| row_key == key)
                .ok_or_else(|| KitableError::invalid(format!("link target not found: {key}")))?;
            tx.execute(
                "INSERT INTO kition_record_links (document_id, from_table_id, from_record_id, from_field_id, to_table_id, to_record_id, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![document_id, from_table_id, from_record_id, field_id, target_table_id, id, now],
            )?;
            ordered.push(LinkRef {
                row_key: row_key.clone(),
                display: display(values, primary.as_ref()),
            });
        }
        tx.commit()?;
        self.recompute_after_link_change(from_table_id, from_record_id);
        Ok(ordered)
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
        let mut args = vec![
            SqlValue::Integer(from_table_id),
            SqlValue::Integer(from_record_id),
            SqlValue::Integer(field_id),
        ];
        args.extend(cleaned.iter().map(|key| SqlValue::Text(key.clone())));
        self.conn.execute(
            &format!(
                "DELETE FROM kition_record_links WHERE from_table_id = ?1 AND from_record_id = ?2 AND from_field_id = ?3 \
                 AND to_record_id IN (SELECT id FROM kition_records WHERE row_key IN ({}))",
                placeholders(4, cleaned.len())
            ),
            params_from_iter(args.iter()),
        )?;
        self.recompute_after_link_change(from_table_id, from_record_id);
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
        let (_, options_json): (i64, String) = self
            .conn
            .query_row(
                "SELECT table_id, options_json FROM kition_fields WHERE id = ?1 AND deleted_at IS NULL",
                [field_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|err| KitableError::invalid(format!("link field not found: {}", KitableError::from(err))))?;
        let target_table_id = json::int_option(&json::object(&options_json), "target_table_id");
        if target_table_id == 0 {
            return Err(KitableError::invalid(
                "link field is missing target_table_id",
            ));
        }
        let primary_id: Option<i64> = self
            .conn
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
        let primary = primary_id.and_then(|id| self.get_field(target_table_id, id).ok());
        Ok((target_table_id, primary))
    }
}
