//! Bridges between route groups: workflows and form sync read and write tables through the host
//! table client (`kition-tableclient`), which reaches every `.ktable` file through the Table kit.

use kition_formsync::{TableField, TableRecord, TableWriter};
use kition_tableclient::TableClient;
use kition_workflow::types::{FieldSchema, TableSchema};
use kition_workflow::{RecordView, Tables};
use serde_json::{Map, Value};

/// Runs the table client's future from the blocking thread a workflow or a sync calls on.
fn blocking<T>(work: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Handle::current().block_on(work)
}

/// Workflows read and write tables through the Table kit, as `system:workflow`.
pub struct ClientTables(pub TableClient);

impl Tables for ClientTables {
    fn schema(
        &self,
        _user_id: i64,
        document_path: &str,
        table_id: &str,
    ) -> Result<TableSchema, String> {
        let table = blocking(self.0.table(document_path, table_id)).map_err(|e| e.message)?;
        Ok(TableSchema {
            id: table.id,
            name: table.title,
            fields: table
                .fields
                .into_iter()
                .map(|field| FieldSchema {
                    id: field.id,
                    name: field.title,
                    field_type: field.field_type,
                })
                .collect(),
        })
    }

    fn records(
        &self,
        _user_id: i64,
        document_path: &str,
        table_id: &str,
    ) -> Result<Vec<RecordView>, String> {
        let records = blocking(self.0.records(document_path, table_id)).map_err(|e| e.message)?;
        Ok(records
            .into_iter()
            .map(|record| RecordView {
                id: record.id,
                fields: record.values,
                created_at: record.created_at,
            })
            .collect())
    }

    fn create_record(
        &self,
        _user_id: i64,
        document_path: &str,
        table_id: &str,
        values: &Map<String, Value>,
    ) -> Result<String, String> {
        blocking(
            self.0
                .create_record(document_path, table_id, values, "system:workflow"),
        )
        .map(|record| record.id)
        .map_err(|e| e.message)
    }

    fn update_record(
        &self,
        _user_id: i64,
        document_path: &str,
        table_id: &str,
        record_id: &str,
        values: &Map<String, Value>,
    ) -> Result<Map<String, Value>, String> {
        blocking(self.0.update_record(
            document_path,
            table_id,
            record_id,
            values,
            "system:workflow",
        ))
        .map_err(|e| e.message)
    }
}

/// Form sync writes submissions through the Table kit, as `system:formsync`.
pub struct ClientTableWriter(pub TableClient);

impl TableWriter for ClientTableWriter {
    fn fields(
        &self,
        _user_id: i64,
        document_path: &str,
        table_id: &str,
    ) -> Result<Vec<TableField>, String> {
        let table = blocking(self.0.table(document_path, table_id)).map_err(|e| e.message)?;
        Ok(table
            .fields
            .into_iter()
            .map(|field| TableField {
                id: field.id,
                name: field.title,
            })
            .collect())
    }

    fn records(
        &self,
        _user_id: i64,
        document_path: &str,
        table_id: &str,
    ) -> Result<Vec<TableRecord>, String> {
        let records = blocking(self.0.records(document_path, table_id)).map_err(|e| e.message)?;
        Ok(records
            .into_iter()
            .map(|record| TableRecord {
                id: record.id,
                fields: record.values,
            })
            .collect())
    }

    fn create(
        &self,
        _user_id: i64,
        document_path: &str,
        table_id: &str,
        values: &Map<String, Value>,
    ) -> Result<String, String> {
        blocking(
            self.0
                .create_record(document_path, table_id, values, "system:formsync"),
        )
        .map(|record| record.id)
        .map_err(|e| e.message)
    }
}
