//! Table access for workflows: schema, record listing, and record writes
//! that publish the same events as the HTTP endpoints.

use kition_core::events::{DomainEvent, RecordCreated, RecordUpdated};
use kition_core::{AppError, AppResult, Millis, now_millis};
use kition_kdm::Origin;
use kition_kitable::Table;
use serde_json::{Map, Value};

use crate::DataDocState;
use crate::index::DataDocument;
use crate::source::parse_id;
use crate::table_documents::TableHandle;

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
        origin: Origin,
    ) -> AppResult<(TableHandle, Table, i64)> {
        let table_id = parse_id(table_id)?;
        let file = self.open_or_500_as(doc, origin)?;
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
        origin: Origin,
    ) -> AppResult<(String, Vec<FieldInfo>)> {
        let doc = self.workflow_document(user_id, document_id)?;
        let (_, table, _) = self.workflow_table(&doc, table_id, origin)?;
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
        origin: Origin,
    ) -> AppResult<Vec<RecordResult>> {
        let doc = self.workflow_document(user_id, document_id)?;
        let table_id = parse_id(table_id)?;
        let file = self.open_or_500_as(&doc, origin)?;
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
        origin: Origin,
    ) -> AppResult<String> {
        if document_id.trim().is_empty() {
            return Err(AppError::bad_request("documentId required"));
        }
        if table_id.trim().is_empty() {
            return Err(AppError::bad_request("tableId required"));
        }
        let doc = self.workflow_document(user_id, document_id)?;
        let (mut file, table, table_id) = self.workflow_table(&doc, table_id, origin)?;
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
        origin: Origin,
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
        let (mut file, table, table_id) = self.workflow_table(&doc, table_id, origin)?;
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use kition_kitable::{CreateOptions, FieldSpec, KitableFile, TableSpec};

    use super::*;
    use crate::index::{self, NewDocument};
    use crate::{ImportStore, TableDocuments};

    /// A workspace with one document and table, through the shared `DataDocState`.
    fn fixture() -> (DataDocState, i64, String, String) {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace_dir = dir.keep();
        let db = kition_store::Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        kition_store::seed::run(&conn).unwrap_or_else(|err| panic!("{err}"));
        let user_id = kition_store::users::find_local_user(&conn)
            .unwrap_or_else(|err| panic!("{err}"))
            .unwrap_or_else(|| panic!("seed::run did not leave a local user"))
            .id;
        let absolute = workspace_dir.join("Test.kitable");
        let mut file = KitableFile::create(&absolute, &CreateOptions::default())
            .unwrap_or_else(|err| panic!("{err}"));
        let table = file
            .create_table(&TableSpec {
                name: "items".into(),
                fields: vec![FieldSpec {
                    name: "title".into(),
                    title: "Title".into(),
                    field_type: "text".into(),
                    primary: true,
                    required: true,
                    ..Default::default()
                }],
                ..Default::default()
            })
            .unwrap_or_else(|err| panic!("{err}"));
        file.close();
        let doc = index::insert(
            &conn,
            NewDocument {
                user_id,
                workspace_root: workspace_dir.to_string_lossy().into_owned(),
                path: "Test.kitable".into(),
                title: "Test".into(),
                description: String::new(),
                icon: String::new(),
                color: String::new(),
                meta: serde_json::json!({ "storage": "kitable_file" })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            },
        )
        .unwrap_or_else(|err| panic!("{err}"));
        drop(conn);
        let assets = kition_workspace::AssetStore::new(&workspace_dir, None)
            .unwrap_or_else(|err| panic!("{err}"));
        let state = DataDocState {
            auth: kition_http::AuthConfig {
                db: db.clone(),
                jwt_secret: "test".into(),
                disabled: true,
            },
            db,
            workspace_dir,
            assets,
            events: kition_core::events::EventBus::default(),
            workflow_cleaner: None,
            ai_gate: Arc::new(|| false),
            imports: ImportStore::default(),
            ai: None,
            tables: TableDocuments::default(),
        };
        (state, user_id, doc.id.to_string(), table.id.to_string())
    }

    /// Workflow and form-sync writes are `system:*` origins: they land through the shared
    /// manager (so an open window's handle sees them with no SQLite-level staleness) but, like
    /// every other `system` write, are not undo steps.
    #[test]
    fn workflow_writes_are_not_undo_steps() {
        let (state, user_id, document_id, table_id) = fixture();
        let record_id = state
            .create_record_for_workflow(
                user_id,
                &document_id,
                &table_id,
                &Map::from_iter([("title".to_owned(), Value::from("from a workflow"))]),
                Origin::system("workflow"),
            )
            .unwrap_or_else(|err| panic!("{err}"));
        assert!(!record_id.is_empty());

        state
            .update_record_for_workflow(
                user_id,
                &document_id,
                &table_id,
                &record_id,
                &Map::from_iter([("title".to_owned(), Value::from("from a form"))]),
                Origin::system("formsync"),
            )
            .unwrap_or_else(|err| panic!("{err}"));

        let file = state
            .open_or_500(
                &state
                    .load_document(user_id, &document_id)
                    .unwrap_or_else(|err| panic!("{err}")),
            )
            .unwrap_or_else(|err| panic!("{err}"));
        assert!(
            !file.can_undo(),
            "system-origin writes (workflow, formsync) are not undo steps"
        );
    }
}
