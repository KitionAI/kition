//! JSON shapes for documents, tables, fields, views, and records.

use kition_kitable::{Field, KitableFile, Record, Table, View};
use serde_json::{Value, json};

use crate::DataDocState;
use crate::index::DataDocument;

pub fn field(doc: &DataDocument, field: &Field) -> Value {
    json!({
        "id": field.id, "user_id": doc.user_id, "document_id": doc.id, "table_id": field.table_id,
        "name": field.name, "title": field.title, "type": field.field_type, "required": field.required,
        "unique": field.unique, "readonly": field.readonly, "is_primary": field.is_primary, "order": field.order,
        "options": field.options, "formula": field.formula, "ai_prompt": field.ai_prompt,
        "meta": field.meta, "created_at": field.created_at, "updated_at": field.updated_at,
    })
}

pub fn view(doc: &DataDocument, view: &View) -> Value {
    json!({
        "id": view.id, "user_id": doc.user_id, "document_id": doc.id, "table_id": view.table_id,
        "title": view.title, "type": view.view_type, "order": view.order, "locked": view.locked,
        "config": view.config, "created_at": view.created_at, "updated_at": view.updated_at,
    })
}

pub fn record(doc: &DataDocument, record: &Record) -> Value {
    json!({
        "id": record.id, "user_id": doc.user_id, "document_id": doc.id, "table_id": record.table_id,
        "row_key": record.row_key, "order": record.order, "values": record.values,
        "created_at": record.created_at, "updated_at": record.updated_at,
    })
}

pub fn table(doc: &DataDocument, table: &Table, include_schema: bool) -> Value {
    let mut value = json!({
        "id": table.id, "user_id": doc.user_id, "document_id": doc.id, "name": table.name,
        "title": table.title, "description": table.description, "order": table.order,
        "primary_field_id": table.primary_field_id, "meta": table.meta,
        "created_at": table.created_at, "updated_at": table.updated_at,
    });
    if include_schema {
        value["fields"] = Value::Array(table.fields.iter().map(|f| field(doc, f)).collect());
        value["views"] = Value::Array(table.views.iter().map(|v| view(doc, v)).collect());
    }
    value
}

pub fn tables_of(doc: &DataDocument, file: &KitableFile) -> Vec<Value> {
    file.list_tables()
        .unwrap_or_default()
        .iter()
        .map(|t| table(doc, t, true))
        .collect()
}

impl DataDocState {
    /// A document with its tables (and their schema) when requested.
    pub(crate) fn document_response(&self, doc: &DataDocument, include_tables: bool) -> Value {
        let mut value = json!({
            "id": doc.id, "user_id": doc.user_id, "workspace_root": doc.workspace_root, "path": doc.path,
            "title": doc.title, "description": doc.description, "icon": doc.icon, "color": doc.color,
            "meta": doc.meta, "created_at": doc.created_at, "updated_at": doc.updated_at,
        });
        if include_tables {
            let tables = if doc.is_file_backed() {
                match self.open_document(doc) {
                    Ok(file) => {
                        let tables = tables_of(doc, &file);
                        file.close();
                        tables
                    }
                    Err(_) => Vec::new(),
                }
            } else {
                Vec::new()
            };
            value["tables"] = Value::Array(tables);
        }
        value
    }
}
