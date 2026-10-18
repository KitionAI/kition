//! `transact`, `undo`, `redo`, and `history-state`: the table document's write path.
//!
//! The caller's origin is the file's current one ([`KitableFile::origin`]): the runtime sets it
//! from the request's `Kition-Session` / `Kition-Origin` headers before calling in. A
//! successful mutation answers its [`TableChange`] too, for the caller to tell every other view
//! of the document.

use kition_kitable::{KitableError, KitableFile, TableChange, TableOp};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::respond::change_json;
use crate::{ApiError, ApiResult, DocRef};

/// A write that the file's `.kitable` layer refused. A read-only file (opened that way because
/// it could not be written, or could not be brought up to date) answers 409, not 400: the
/// request itself was fine, the document just cannot take writes right now.
fn bad(err: KitableError) -> ApiError {
    match err {
        KitableError::ReadOnly(reason) => ApiError::Conflict(reason),
        other => ApiError::bad_request(other.to_string()),
    }
}

/// The body of `POST /transact`.
#[derive(Debug, Deserialize)]
pub struct TransactRequest {
    pub ops: Vec<TableOp>,
}

impl TransactRequest {
    /// Refuses a request without ops.
    pub fn check(self) -> ApiResult<Self> {
        if self.ops.is_empty() {
            return Err(ApiError::bad_request("ops must not be empty"));
        }
        Ok(self)
    }
}

/// `POST /transact`: `{ "change", "created" }` and the change.
pub fn transact(
    file: &mut KitableFile,
    doc: &DocRef,
    request: &TransactRequest,
) -> ApiResult<(Value, TableChange)> {
    let (created, change) = file.transact(&request.ops).map_err(bad)?;
    let body = json!({
        "change": change_json(&doc.document_id.to_string(), file.origin(), &change),
        "created": created,
    });
    Ok((body, change))
}

/// `POST /undo` (`redo` false) or `POST /redo`: `{ "done", "change" }`, and the change when a
/// step was undone or redone.
pub fn undo_or_redo(
    file: &mut KitableFile,
    doc: &DocRef,
    redo: bool,
) -> ApiResult<(Value, Option<TableChange>)> {
    let (done, change) = if redo { file.redo() } else { file.undo() }.map_err(bad)?;
    let body = json!({
        "done": done,
        "change": change_json(&doc.document_id.to_string(), file.origin(), &change),
    });
    Ok((body, done.then_some(change)))
}

/// `GET /history-state`.
pub fn history_state(file: &KitableFile) -> Value {
    json!({ "canUndo": file.can_undo(), "canRedo": file.can_redo() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transact_request_parses_the_contracts_op_shapes() {
        let request: TransactRequest = serde_json::from_value(json!({
            "ops": [
                { "op": "cells.set", "tableId": 1, "records": [{ "rowKey": "r1", "values": { "Name": "Ada" } }] },
                { "op": "records.create", "tableId": 1, "at": null, "records": [{}] },
                { "op": "records.delete", "tableId": 1, "rowKeys": ["r1"] },
                { "op": "records.move", "tableId": 1, "rowKeys": ["r1"], "before": null },
                { "op": "fields.move", "tableId": 1, "fieldIds": [2, 3], "toIndex": 0 },
            ]
        }))
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(request.ops.len(), 5);
    }
}
