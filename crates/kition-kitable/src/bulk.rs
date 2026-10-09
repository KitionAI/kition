//! Bulk record operations addressed by row key.

use kition_core::now_millis;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter};
use serde::Serialize;

use crate::links::{dedupe, placeholders};
use crate::{KitableError, KitableFile, Result};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BulkDeleteResult {
    pub deleted_count: i64,
    pub missing_keys: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BulkCopyResult {
    pub copied_count: i64,
    pub new_row_keys: Vec<String>,
}

impl KitableFile {
    pub fn bulk_delete_records(
        &mut self,
        table_id: i64,
        row_keys: &[String],
    ) -> Result<BulkDeleteResult> {
        if table_id <= 0 {
            return Err(KitableError::invalid("table_id is required"));
        }
        let cleaned = dedupe(row_keys);
        if cleaned.is_empty() {
            return Ok(BulkDeleteResult::default());
        }
        let tx = self.conn.transaction()?;
        let mut args = vec![SqlValue::Integer(table_id)];
        args.extend(cleaned.iter().map(|key| SqlValue::Text(key.clone())));
        let existing: Vec<String> = {
            let mut statement = tx.prepare(&format!(
                "SELECT row_key FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL AND row_key IN ({})",
                placeholders(2, cleaned.len())
            ))?;
            statement
                .query_map(params_from_iter(args.iter()), |row| row.get(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let now = now_millis();
        let mut update_args = vec![SqlValue::Integer(now), SqlValue::Integer(table_id)];
        update_args.extend(cleaned.iter().map(|key| SqlValue::Text(key.clone())));
        let affected = tx.execute(
            &format!(
                "UPDATE kition_records SET deleted_at = ?1, updated_at = ?1 \
                 WHERE table_id = ?2 AND deleted_at IS NULL AND row_key IN ({})",
                placeholders(3, cleaned.len())
            ),
            params_from_iter(update_args.iter()),
        )?;
        tx.commit()?;
        let missing_keys = cleaned
            .into_iter()
            .filter(|key| !existing.contains(key))
            .collect();
        Ok(BulkDeleteResult {
            deleted_count: i64::try_from(affected).unwrap_or(i64::MAX),
            missing_keys,
        })
    }

    /// Copies records (in the order given) to `target_position`, shifting
    /// later records; `target_position <= 0` appends.
    pub fn bulk_copy_records(
        &mut self,
        table_id: i64,
        row_keys: &[String],
        target_position: i64,
    ) -> Result<BulkCopyResult> {
        if table_id <= 0 {
            return Err(KitableError::invalid("table_id is required"));
        }
        let cleaned = dedupe(row_keys);
        if cleaned.is_empty() {
            return Ok(BulkCopyResult::default());
        }
        let tx = self.conn.transaction()?;
        let mut args = vec![SqlValue::Integer(table_id)];
        args.extend(cleaned.iter().map(|key| SqlValue::Text(key.clone())));
        let sources: Vec<(String, String, String)> = {
            let mut statement = tx.prepare(&format!(
                "SELECT row_key, document_id, values_json FROM kition_records \
                 WHERE table_id = ?1 AND deleted_at IS NULL AND row_key IN ({})",
                placeholders(2, cleaned.len())
            ))?;
            statement
                .query_map(params_from_iter(args.iter()), |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let ordered: Vec<&(String, String, String)> = cleaned
            .iter()
            .filter_map(|key| sources.iter().find(|(row_key, _, _)| row_key == key))
            .collect();
        if ordered.is_empty() {
            return Ok(BulkCopyResult::default());
        }
        let count = i64::try_from(ordered.len()).unwrap_or(i64::MAX);
        let target = if target_position <= 0 {
            let max: Option<i64> = tx.query_row(
                "SELECT MAX(position) FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL",
                [table_id],
                |row| row.get(0),
            )?;
            max.unwrap_or(0) + 1
        } else {
            tx.execute(
                "UPDATE kition_records SET position = position + ?1 WHERE table_id = ?2 AND deleted_at IS NULL AND position >= ?3",
                params![count, table_id, target_position],
            )?;
            target_position
        };
        let now = now_millis();
        let mut new_row_keys = Vec::with_capacity(ordered.len());
        for (offset, (_, document_id, values)) in ordered.into_iter().enumerate() {
            let new_key = uuid::Uuid::new_v4().to_string();
            let cloned = if values.trim().is_empty() {
                "{}".to_owned()
            } else {
                let parsed: serde_json::Map<String, serde_json::Value> =
                    serde_json::from_str(values)
                        .map_err(|err| KitableError::invalid(format!("decode values: {err}")))?;
                serde_json::to_string(&parsed)?
            };
            tx.execute(
                "INSERT INTO kition_records (document_id, table_id, row_key, position, values_json, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![document_id, table_id, new_key, target + i64::try_from(offset).unwrap_or(0), cloned, now],
            )?;
            new_row_keys.push(new_key);
        }
        tx.commit()?;
        Ok(BulkCopyResult {
            copied_count: count,
            new_row_keys,
        })
    }
}
