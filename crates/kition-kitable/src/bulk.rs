//! Bulk record operations addressed by row key.

use kition_kdm::ObjectId;
use kition_time::now_millis;
use rusqlite::types::Value as SqlValue;
use rusqlite::{OptionalExtension, params, params_from_iter};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::json;
use crate::kdm::commit::{by_field_id, field_objects_by_name, table_object};
use crate::kdm::model::{self, Anchor};
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
    /// The given row keys that name live records of the table, in the given order.
    fn live_row_keys(&self, table_id: i64, keys: &[String]) -> Result<Vec<String>> {
        let mut args = vec![SqlValue::Integer(table_id)];
        args.extend(keys.iter().map(|key| SqlValue::Text(key.clone())));
        let mut statement = self.conn.prepare(&format!(
            "SELECT row_key FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL AND row_key IN ({})",
            placeholders(2, keys.len())
        ))?;
        let existing: Vec<String> = statement
            .query_map(params_from_iter(args.iter()), |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(keys
            .iter()
            .filter(|key| existing.contains(key))
            .cloned()
            .collect())
    }

    pub fn bulk_delete_records(
        &mut self,
        table_id: i64,
        row_keys: &[String],
    ) -> Result<BulkDeleteResult> {
        self.writable()?;
        if table_id <= 0 {
            return Err(KitableError::invalid("table_id is required"));
        }
        let cleaned = dedupe(row_keys);
        if cleaned.is_empty() {
            return Ok(BulkDeleteResult::default());
        }
        let existing = self.live_row_keys(table_id, &cleaned)?;
        let missing_keys: Vec<String> = cleaned
            .iter()
            .filter(|key| !existing.contains(key))
            .cloned()
            .collect();
        if existing.is_empty() {
            return Ok(BulkDeleteResult {
                deleted_count: 0,
                missing_keys,
            });
        }
        let table = table_object(&self.conn, table_id)?;
        let records: Vec<ObjectId> = existing.iter().map(ObjectId::from_string).collect();
        let (deleted, _) = self.commit(|tx| model::delete_records(tx, &table, &records))?;
        Ok(BulkDeleteResult {
            deleted_count: i64::try_from(deleted).unwrap_or(i64::MAX),
            missing_keys,
        })
    }

    /// Copies records (in the order given) to `target_position`: just before the first record at
    /// that position or later. `target_position <= 0` appends.
    pub fn bulk_copy_records(
        &mut self,
        table_id: i64,
        row_keys: &[String],
        target_position: i64,
    ) -> Result<BulkCopyResult> {
        self.writable()?;
        if table_id <= 0 {
            return Err(KitableError::invalid("table_id is required"));
        }
        let cleaned = dedupe(row_keys);
        if cleaned.is_empty() {
            return Ok(BulkCopyResult::default());
        }
        let ordered = self.live_row_keys(table_id, &cleaned)?;
        if ordered.is_empty() {
            return Ok(BulkCopyResult::default());
        }
        let table = table_object(&self.conn, table_id)?;
        let at = if target_position <= 0 {
            None
        } else {
            self.conn
                .query_row(
                    "SELECT row_key FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL \
                     AND position >= ?2 ORDER BY position ASC, id ASC LIMIT 1",
                    params![table_id, target_position],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .map(|key| Anchor::Before(ObjectId::from_string(key)))
        };
        let names = field_objects_by_name(&self.conn, table_id)?;
        let rows: Vec<Map<String, Value>> = ordered
            .iter()
            .map(|key| {
                let values: String = self.conn.query_row(
                    "SELECT values_json FROM kition_records WHERE table_id = ?1 AND row_key = ?2 AND deleted_at IS NULL",
                    params![table_id, key],
                    |row| row.get(0),
                )?;
                Ok(by_field_id(&names, &json::object(&values)))
            })
            .collect::<Result<_>>()?;
        let created_by = self.actor();
        let (ids, _) = self.commit(|tx| {
            model::create_records(tx, &table, at.as_ref(), &rows, now_millis(), &created_by)
        })?;
        Ok(BulkCopyResult {
            copied_count: i64::try_from(ids.len()).unwrap_or(i64::MAX),
            new_row_keys: ids.into_iter().map(|id| id.to_string()).collect(),
        })
    }
}
