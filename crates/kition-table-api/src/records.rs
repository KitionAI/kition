//! Records, their history and links, and CSV/Markdown transfer.

use kition_kitable::{HistoryEntry, KitableError, KitableFile, LinkRef, Record};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{ApiError, ApiResult, DocRef, csvutil, respond};

fn bad(err: KitableError) -> ApiError {
    ApiError::bad_request(err.to_string())
}

fn table_not_found(_: KitableError) -> ApiError {
    ApiError::not_found("Table does not exist")
}

/// `GET /records`: one page (see [`crate::list_window`]) and the table's record count.
pub fn list(
    file: &KitableFile,
    doc: &DocRef,
    table_id: i64,
    limit: i64,
    offset: i64,
) -> ApiResult<Value> {
    let failed = |_| ApiError::internal("Failed to query records");
    let total = file.count_records(table_id).map_err(failed)?;
    let records = file
        .list_records_page(table_id, limit, offset)
        .map_err(failed)?;
    let items: Vec<Value> = records.iter().map(|r| respond::record(doc, r)).collect();
    Ok(json!({ "items": items, "total": total, "offset": offset, "limit": limit }))
}

/// The body of `POST /records` and `PATCH /records/{recordId}`.
#[derive(Debug, Default, Deserialize)]
pub struct RecordRequest {
    #[serde(default)]
    pub values: Option<Map<String, Value>>,
    #[serde(default)]
    pub order: Option<i64>,
}

/// `POST /records`: the new record (answered with [`respond::record`]).
pub fn create(file: &mut KitableFile, table_id: i64, request: RecordRequest) -> ApiResult<Record> {
    file.create_record(table_id, &request.values.unwrap_or_default())
        .map_err(bad)
}

/// `PATCH /records/{recordId}`: the updated record and its values before the update, when it
/// could be read.
pub fn update(
    file: &mut KitableFile,
    table_id: i64,
    record_id: i64,
    request: RecordRequest,
) -> ApiResult<(Record, Option<Map<String, Value>>)> {
    let previous = file.get_record(table_id, record_id).ok().map(|r| r.values);
    let record = file
        .update_record(
            table_id,
            record_id,
            &request.values.unwrap_or_default(),
            request.order,
        )
        .map_err(bad)?;
    Ok((record, previous))
}

/// `DELETE /records/{recordId}`.
pub fn delete(file: &mut KitableFile, table_id: i64, record_id: i64) -> ApiResult<Value> {
    file.delete_record(table_id, record_id)
        .map_err(|_| ApiError::not_found("Record does not exist"))?;
    Ok(json!({ "message": "Record deleted" }))
}

fn history_entry(entry: &HistoryEntry) -> Value {
    json!({
        "id": entry.id, "document_id": entry.document_id, "table_id": entry.table_id,
        "record_id": entry.record_id, "field_id": entry.field_id, "action": entry.action,
        "before": entry.before, "after": entry.after, "actor": entry.actor, "created_at": entry.created_at,
    })
}

/// `GET /records/{recordId}/history`; a `limit` of 0 means 100.
pub fn history(
    file: &KitableFile,
    table_id: i64,
    record_id: i64,
    limit: i64,
    offset: i64,
) -> ApiResult<Value> {
    let limit = if limit <= 0 { 100 } else { limit };
    let (entries, total) = file
        .list_record_history(table_id, record_id, limit, offset)
        .map_err(|_| ApiError::internal("Failed to query record history"))?;
    let items: Vec<Value> = entries.iter().map(history_entry).collect();
    Ok(json!({ "items": items, "total": total, "limit": limit, "offset": offset }))
}

fn link_items(refs: &[LinkRef]) -> Value {
    json!({ "items": refs.iter().map(|r| json!({ "row_key": r.row_key, "display": r.display })).collect::<Vec<_>>() })
}

/// The `field_id` query value of `GET /records/{recordId}/links`: a positive integer.
pub fn link_field_id(value: Option<&str>) -> ApiResult<i64> {
    value
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|id| *id > 0)
        .ok_or_else(|| ApiError::bad_request("field_id is required"))
}

/// `GET /records/{recordId}/links`.
pub fn list_links(
    file: &KitableFile,
    table_id: i64,
    record_id: i64,
    field_id: i64,
) -> ApiResult<Value> {
    let refs = file
        .list_record_links(table_id, record_id, field_id)
        .map_err(|_| ApiError::internal("Failed to list record links"))?;
    Ok(link_items(&refs))
}

/// The body of `POST` and `DELETE /records/{recordId}/links`.
#[derive(Debug, Default, Deserialize)]
pub struct LinkRequest {
    #[serde(default)]
    pub field_id: Option<i64>,
    #[serde(default)]
    pub target_row_keys: Option<Vec<String>>,
}

impl LinkRequest {
    /// Refuses a request without a positive `field_id`.
    pub fn check(self) -> ApiResult<Self> {
        if self.field_id.unwrap_or_default() <= 0 {
            return Err(ApiError::bad_request("field_id is required"));
        }
        Ok(self)
    }
}

/// `POST /records/{recordId}/links`: replaces the record's links in the field.
pub fn replace_links(
    file: &mut KitableFile,
    table_id: i64,
    record_id: i64,
    request: LinkRequest,
) -> ApiResult<Value> {
    let refs = file
        .replace_record_links(
            table_id,
            record_id,
            request.field_id.unwrap_or_default(),
            &request.target_row_keys.unwrap_or_default(),
        )
        .map_err(bad)?;
    Ok(link_items(&refs))
}

/// `DELETE /records/{recordId}/links`.
pub fn delete_links(
    file: &mut KitableFile,
    table_id: i64,
    record_id: i64,
    request: LinkRequest,
) -> ApiResult<Value> {
    file.delete_record_links(
        table_id,
        record_id,
        request.field_id.unwrap_or_default(),
        &request.target_row_keys.unwrap_or_default(),
    )
    .map_err(|_| ApiError::internal("Failed to delete record links"))?;
    Ok(json!({ "ok": true }))
}

/// The `limit` query value of `GET /fields/{fieldId}/link-candidates`: positive, else 25.
pub fn candidate_limit(value: Option<&str>) -> i64 {
    value
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|l| *l > 0)
        .unwrap_or(25)
}

/// `GET /fields/{fieldId}/link-candidates`.
pub fn link_candidates(
    file: &KitableFile,
    field_id: i64,
    query: &str,
    limit: i64,
) -> ApiResult<Value> {
    let refs = file
        .list_link_candidates(field_id, query, limit)
        .map_err(|_| ApiError::internal("Failed to list link candidates"))?;
    Ok(link_items(&refs))
}

/// The body of `POST /import/csv`.
#[derive(Debug, Default, Deserialize)]
pub struct CsvRequest {
    #[serde(default)]
    pub content: Option<String>,
}

/// The rows of a CSV import: rectangular and not empty.
pub fn parse_csv(content: &str) -> ApiResult<Vec<Vec<String>>> {
    csvutil::read_all(content)
        .filter(|rows| !rows.is_empty())
        .ok_or_else(|| ApiError::bad_request("Invalid CSV content"))
}

/// `POST /import/csv`: the first row names fields (by title or name); every other row becomes
/// a record, all in one transaction.
pub fn import_csv(file: &mut KitableFile, table_id: i64, rows: &[Vec<String>]) -> ApiResult<Value> {
    let table = file.get_table(table_id).map_err(table_not_found)?;
    let Some((headers, rows)) = rows.split_first() else {
        return Err(ApiError::bad_request("Invalid CSV content"));
    };
    let mut batch = Vec::with_capacity(rows.len());
    for row in rows {
        let mut values = Map::new();
        for (index, header) in headers.iter().enumerate() {
            let Some(cell) = row.get(index) else { continue };
            if let Some(field) = table
                .fields
                .iter()
                .find(|f| &f.title == header || &f.name == header)
            {
                values.insert(field.name.clone(), Value::String(cell.clone()));
            }
        }
        batch.push(values);
    }
    // One transaction for the whole file.
    let created = file
        .create_records(table_id, &batch)
        .map_err(|_| ApiError::internal("Failed to import CSV"))?
        .len();
    Ok(json!({ "created": created }))
}

/// Text form of a cell for CSV and Markdown exports.
pub fn stringify_cell(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(stringify_cell)
            .collect::<Vec<_>>()
            .join(", "),
        Value::Object(map) => ["display", "name", "title", "url", "href", "row_key"]
            .iter()
            .find_map(|key| {
                map.get(*key)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_default()
            .to_owned(),
        Value::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(int), _) => int.to_string(),
            (None, Some(float)) => float.to_string(),
            _ => number.to_string(),
        },
        Value::Bool(flag) => flag.to_string(),
    }
}

fn escape_markdown_cell(value: &str) -> String {
    value.replace('\n', "<br>").replace('|', "\\|")
}

/// `GET /export/csv`: the table's name and its records as CSV, one column per field.
pub fn export_csv(file: &KitableFile, table_id: i64) -> ApiResult<(String, String)> {
    let table = file.get_table(table_id).map_err(table_not_found)?;
    let records = file
        .list_records(table_id)
        .map_err(|_| ApiError::internal("Failed to export CSV"))?;
    let mut out = String::new();
    csvutil::write_record(
        &mut out,
        &table
            .fields
            .iter()
            .map(|f| f.title.clone())
            .collect::<Vec<_>>(),
    );
    for record in &records {
        let row: Vec<String> = table
            .fields
            .iter()
            .map(|f| stringify_cell(record.values.get(&f.name).unwrap_or(&Value::Null)))
            .collect();
        csvutil::write_record(&mut out, &row);
    }
    Ok((table.name, out))
}

/// `GET /export/markdown`: `{ "content" }`, the table as a Markdown table.
pub fn export_markdown(file: &KitableFile, table_id: i64) -> ApiResult<Value> {
    let table = file.get_table(table_id).map_err(table_not_found)?;
    let records = file
        .list_records(table_id)
        .map_err(|_| ApiError::internal("Failed to export Markdown"))?;
    let mut out = String::from("|");
    for field in &table.fields {
        out.push_str(&format!(" {} |", escape_markdown_cell(&field.title)));
    }
    out.push_str("\n|");
    for _ in &table.fields {
        out.push_str(" --- |");
    }
    out.push('\n');
    for record in &records {
        out.push('|');
        for field in &table.fields {
            let cell = stringify_cell(record.values.get(&field.name).unwrap_or(&Value::Null));
            out.push_str(&format!(" {} |", escape_markdown_cell(&cell)));
        }
        out.push('\n');
    }
    Ok(json!({ "content": out }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stringifies_cells() {
        assert_eq!(
            stringify_cell(&json!([1, "a", {"display": "D"}])),
            "1, a, D"
        );
        assert_eq!(stringify_cell(&json!(2.5)), "2.5");
        assert_eq!(stringify_cell(&json!({"x": 1})), "");
        assert_eq!(stringify_cell(&json!(true)), "true");
        assert_eq!(escape_markdown_cell("a|b\nc"), "a\\|b<br>c");
    }
}
