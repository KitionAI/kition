//! Table access for workflows: schema, record listing, and record writes
//! that publish the same events as the HTTP endpoints.

use kition_core::events::{DomainEvent, RecordCreated, RecordUpdated};
use kition_core::{AppError, AppResult, Millis, now_millis};
use kition_kitable::{KitableFile, Table};
use serde_json::{Map, Value};

use crate::DataDocState;
use crate::index::DataDocument;
use crate::source::parse_id;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldInfo {
    pub id: String,
    pub name: String,
    pub field_type: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecordResult {
    pub id: String,
    pub fields: Map<String, Value>,
    pub created_at: Millis,
}

fn display_name(title: &str, name: &str) -> String {
    match title.trim() {
        "" => name.to_owned(),
        title => title.to_owned(),
    }
}

/// Maps keys that are field IDs to field names; other keys pass through.
fn values_by_name(table: &Table, values: &Map<String, Value>) -> Map<String, Value> {
    values
        .iter()
        .map(|(key, value)| {
            let resolved = table
                .fields
                .iter()
                .find(|f| f.id.to_string() == *key)
                .map_or_else(|| key.clone(), |f| f.name.clone());
            (resolved, value.clone())
        })
        .collect()
}

impl DataDocState {
    fn workflow_document(&self, user_id: i64, document_id: &str) -> AppResult<DataDocument> {
        self.load_document(user_id, document_id)
    }

    fn workflow_table(
        &self,
        doc: &DataDocument,
        table_id: &str,
    ) -> AppResult<(KitableFile, Table, i64)> {
        let table_id = parse_id(table_id)?;
        let file = self.open_or_500(doc)?;
        let table = file
            .get_table(table_id)
            .map_err(|_| AppError::not_found("Table does not exist"))?;
        Ok((file, table, table_id))
    }

    /// The table's display name and fields.
    pub fn fetch_table_schema(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
    ) -> AppResult<(String, Vec<FieldInfo>)> {
        let doc = self.workflow_document(user_id, document_id)?;
        let (_, table, _) = self.workflow_table(&doc, table_id)?;
        let fields = table
            .fields
            .iter()
            .map(|f| FieldInfo {
                id: f.id.to_string(),
                name: display_name(&f.title, &f.name),
                field_type: f.field_type.clone(),
            })
            .collect();
        Ok((display_name(&table.title, &table.name), fields))
    }

    /// Every live record, values keyed by field name.
    pub fn fetch_table_records(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
    ) -> AppResult<Vec<RecordResult>> {
        let doc = self.workflow_document(user_id, document_id)?;
        let table_id = parse_id(table_id)?;
        let file = self.open_or_500(&doc)?;
        let records = file
            .list_records(table_id)
            .map_err(|err| AppError::bad_request(err.to_string()))?;
        Ok(records
            .into_iter()
            .map(|r| RecordResult {
                id: r.id.to_string(),
                fields: r.values,
                created_at: r.created_at,
            })
            .collect())
    }

    /// Creates a record from values keyed by field ID or name; returns its ID.
    pub fn create_record_for_workflow(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
        values: &Map<String, Value>,
    ) -> AppResult<String> {
        if document_id.trim().is_empty() {
            return Err(AppError::bad_request("documentId required"));
        }
        if table_id.trim().is_empty() {
            return Err(AppError::bad_request("tableId required"));
        }
        let doc = self.workflow_document(user_id, document_id)?;
        let (mut file, table, table_id) = self.workflow_table(&doc, table_id)?;
        let record = file
            .create_record(table_id, &values_by_name(&table, values))
            .map_err(|err| AppError::bad_request(err.to_string()))?;
        self.events
            .publish(DomainEvent::RecordCreated(RecordCreated {
                user_id: doc.user_id,
                document_id: doc.id.to_string(),
                table_id: table_id.to_string(),
                record_id: record.id.to_string(),
                fields: record.values.clone(),
                created_at: now_millis(),
            }));
        Ok(record.id.to_string())
    }

    /// Applies a partial update from values keyed by field ID or name.
    pub fn update_record_for_workflow(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
        record_id: &str,
        values: &Map<String, Value>,
    ) -> AppResult<Map<String, Value>> {
        if document_id.trim().is_empty()
            || table_id.trim().is_empty()
            || record_id.trim().is_empty()
        {
            return Err(AppError::bad_request(
                "documentId, tableId and recordId are required",
            ));
        }
        let doc = self.workflow_document(user_id, document_id)?;
        let table_id_text = table_id.to_owned();
        let (mut file, table, table_id) = self.workflow_table(&doc, table_id)?;
        let record_id_number = parse_id(record_id)?;
        let previous = file
            .get_record(table_id, record_id_number)
            .ok()
            .map(|r| r.values);
        let updated = file
            .update_record(
                table_id,
                record_id_number,
                &values_by_name(&table, values),
                None,
            )
            .map_err(|err| AppError::bad_request(err.to_string()))?;
        self.events
            .publish(DomainEvent::RecordUpdated(RecordUpdated {
                user_id: doc.user_id,
                document_id: document_id.to_owned(),
                table_id: table_id_text,
                record_id: record_id.to_owned(),
                fields: updated.values.clone(),
                previous,
                updated_at: now_millis(),
            }));
        Ok(updated.values)
    }
}
