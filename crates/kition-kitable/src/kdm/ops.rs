//! The ops of [`crate::KitableFile::transact`], as `contracts/runtime/data-documents-transact.schema.json`
//! names them: tagged by `op`, camelCase, fields by name, records by row key.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// One step of a transaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum TableOp {
    /// Sets cells of existing records; `null` clears. Unknown and computed fields are skipped.
    #[serde(rename = "cells.set", rename_all = "camelCase")]
    CellsSet {
        table_id: i64,
        records: Vec<CellEdit>,
    },
    /// Creates records (field name to initial value) at `at`; `null` appends.
    #[serde(rename = "records.create", rename_all = "camelCase")]
    RecordsCreate {
        table_id: i64,
        #[serde(default)]
        at: Option<CreateAt>,
        records: Vec<Map<String, Value>>,
    },
    /// Deletes records and their links; unknown row keys are skipped.
    #[serde(rename = "records.delete", rename_all = "camelCase")]
    RecordsDelete {
        table_id: i64,
        row_keys: Vec<String>,
    },
    /// Moves records, in the given order, to just before `before` (`null`: the end).
    #[serde(rename = "records.move", rename_all = "camelCase")]
    RecordsMove {
        table_id: i64,
        row_keys: Vec<String>,
        #[serde(default)]
        before: Option<String>,
    },
    /// Moves fields so the first becomes the `toIndex`-th of the table's other fields.
    #[serde(rename = "fields.move", rename_all = "camelCase")]
    FieldsMove {
        table_id: i64,
        field_ids: Vec<i64>,
        to_index: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    pub row_key: String,
    pub values: Map<String, Value>,
}

/// Where `records.create` inserts: `{"before": rowKey}` or `{"after": rowKey}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CreateAt {
    Before(String),
    After(String),
}
