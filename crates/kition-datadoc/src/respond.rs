//! JSON shapes for documents, tables, fields, views, and records.

use kition_kitable::{Field, KitableFile, Record};
use kition_table_api::{DocRef, respond as api};
use serde_json::{Value, json};

use crate::DataDocState;
use crate::index::DataDocument;

impl DataDocument {
    /// The document as the table API's responses name it.
    pub(crate) fn doc_ref(&self) -> DocRef {
        DocRef {
            document_id: self.id,
            user_id: self.user_id,
        }
    }
}

pub fn field(doc: &DataDocument, field: &Field) -> Value {
    api::field(&doc.doc_ref(), field)
}

pub fn record(doc: &DataDocument, record: &Record) -> Value {
    api::record(&doc.doc_ref(), record)
}

pub fn tables_of(doc: &DataDocument, file: &KitableFile) -> Vec<Value> {
    api::tables_of(&doc.doc_ref(), file)
}

/// A dashboard, summarized for the workspace tree: `id`, `title`, and `order`
/// (`KitableDashboardSummary` on the frontend), not its widgets or layout.
pub fn dashboards_of(file: &KitableFile) -> Vec<Value> {
    api::dashboards_of(file)
}

impl DataDocState {
    /// A document with its tables (and their schema) and dashboard summaries when requested.
    pub(crate) fn document_response(&self, doc: &DataDocument, include_tables: bool) -> Value {
        let mut value = json!({
            "id": doc.id, "user_id": doc.user_id, "workspace_root": doc.workspace_root, "path": doc.path,
            "title": doc.title, "description": doc.description, "icon": doc.icon, "color": doc.color,
            "meta": doc.meta, "created_at": doc.created_at, "updated_at": doc.updated_at,
        });
        if include_tables {
            let (tables, dashboards) = if doc.is_file_backed() {
                match self.open_document(doc) {
                    Ok(file) => {
                        let tables = tables_of(doc, &file);
                        let dashboards = dashboards_of(&file);
                        file.close();
                        (tables, dashboards)
                    }
                    Err(_) => (Vec::new(), Vec::new()),
                }
            } else {
                (Vec::new(), Vec::new())
            };
            value["tables"] = Value::Array(tables);
            value["dashboards"] = Value::Array(dashboards);
        }
        value
    }
}
