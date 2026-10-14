//! Table access for the workspace agent: opening a table, creating a
//! document, and publishing record events like the HTTP endpoints.

use kition_core::events::{DomainEvent, RecordCreated, RecordUpdated};
use kition_core::{AppError, AppResult, now_millis};
use kition_kitable::{CreateOptions, FORMAT, KitableFile, Record, Table, TableSpec};
use serde_json::{Map, Value, json};

use crate::DataDocState;
use crate::index::{self, DataDocument, NewDocument, STORAGE_KITABLE_FILE};
use crate::source::resolve_from_root;
use crate::table_documents::TableHandle;

impl DataDocState {
    /// The caller's document, its open file, and one of its tables.
    pub fn agent_table(
        &self,
        user_id: i64,
        document_id: i64,
        table_id: i64,
    ) -> AppResult<(DataDocument, TableHandle, Table)> {
        let doc = self
            .load_document(user_id, &document_id.to_string())
            .map_err(|_| AppError::not_found("data document does not exist"))?;
        let file = self.open_or_500(&doc)?;
        let table = file
            .get_table(table_id)
            .map_err(|_| AppError::not_found("table does not exist"))?;
        Ok((doc, file, table))
    }

    /// Creates a `.kitable` document at a workspace path with the given
    /// tables, indexing it for the user.
    pub fn create_kitable_document(
        &self,
        mut new: NewDocument,
        specs: &[TableSpec],
    ) -> AppResult<(DataDocument, Vec<Table>)> {
        let absolute = resolve_from_root(&self.workspace_root_string(), &new.path)?;
        self.prepare_kitable_target(&absolute)?;
        new.meta
            .insert("storage".into(), json!(STORAGE_KITABLE_FILE));
        new.meta.insert("file_format".into(), json!(FORMAT));
        if new.workspace_root.trim().is_empty() {
            new.workspace_root = self.workspace_root_string();
        }
        let meta = new.meta.clone();
        let conn = self.db.conn()?;
        let doc = index::insert(&conn, new)
            .map_err(|_| AppError::internal("Failed to create data-document index"))?;
        let mut file = match KitableFile::create(
            &absolute,
            &CreateOptions {
                title: doc.title.clone(),
                document_id: format!("data-doc-{}", doc.id),
                description: doc.description.clone(),
                icon: doc.icon.clone(),
                color: doc.color.clone(),
                meta_json: Value::Object(meta).to_string(),
                ..CreateOptions::default()
            },
        ) {
            Ok(file) => file,
            Err(_) => {
                let _ = index::soft_delete(&conn, doc.id);
                return Err(AppError::internal("Failed to create data-document file"));
            }
        };
        let mut tables = Vec::new();
        for spec in specs {
            match file.create_table(spec) {
                Ok(table) => tables.push(table),
                Err(_) => {
                    let _ = index::soft_delete(&conn, doc.id);
                    drop(file);
                    let _ = std::fs::remove_file(&absolute);
                    return Err(AppError::internal("Failed to initialize data document"));
                }
            }
        }
        file.close();
        Ok((doc, tables))
    }

    pub fn publish_record_created(&self, doc: &DataDocument, record: &Record) {
        self.events
            .publish(DomainEvent::RecordCreated(RecordCreated {
                user_id: doc.user_id,
                document_id: doc.id.to_string(),
                table_id: record.table_id.to_string(),
                record_id: record.id.to_string(),
                fields: record.values.clone(),
                created_at: now_millis(),
            }));
    }

    pub fn publish_record_updated(
        &self,
        doc: &DataDocument,
        record: &Record,
        previous: Option<Map<String, Value>>,
    ) {
        self.events
            .publish(DomainEvent::RecordUpdated(RecordUpdated {
                user_id: doc.user_id,
                document_id: doc.id.to_string(),
                table_id: record.table_id.to_string(),
                record_id: record.id.to_string(),
                fields: record.values.clone(),
                previous,
                updated_at: now_millis(),
            }));
    }
}
