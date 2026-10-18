//! JSON shapes for tables, fields, views, records, and changes.

use kition_kdm::{Origin, OriginKind};
use kition_kitable::{Field, KitableFile, Record, Table, TableChange, View};
use serde_json::{Value, json};

use crate::DocRef;

pub fn field(doc: &DocRef, field: &Field) -> Value {
    json!({
        "id": field.id, "user_id": doc.user_id, "document_id": doc.document_id, "table_id": field.table_id,
        "name": field.name, "title": field.title, "type": field.field_type, "required": field.required,
        "unique": field.unique, "readonly": field.readonly, "is_primary": field.is_primary, "order": field.order,
        "options": field.options, "formula": field.formula, "ai_prompt": field.ai_prompt,
        "meta": field.meta, "created_at": field.created_at, "updated_at": field.updated_at,
    })
}

pub fn view(doc: &DocRef, view: &View) -> Value {
    json!({
        "id": view.id, "user_id": doc.user_id, "document_id": doc.document_id, "table_id": view.table_id,
        "title": view.title, "type": view.view_type, "order": view.order, "locked": view.locked,
        "config": view.config, "created_at": view.created_at, "updated_at": view.updated_at,
    })
}

pub fn record(doc: &DocRef, record: &Record) -> Value {
    json!({
        "id": record.id, "user_id": doc.user_id, "document_id": doc.document_id, "table_id": record.table_id,
        "row_key": record.row_key, "order": record.order, "values": record.values,
        "created_at": record.created_at, "updated_at": record.updated_at,
    })
}

pub fn table(doc: &DocRef, table: &Table, include_schema: bool) -> Value {
    let mut value = json!({
        "id": table.id, "user_id": doc.user_id, "document_id": doc.document_id, "name": table.name,
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

/// Every table of the file with its schema; empty when the file cannot be read.
pub fn tables_of(doc: &DocRef, file: &KitableFile) -> Vec<Value> {
    file.list_tables()
        .unwrap_or_default()
        .iter()
        .map(|t| table(doc, t, true))
        .collect()
}

/// A dashboard, summarized for the workspace tree: `id`, `title`, and `order`
/// (`KitableDashboardSummary` on the frontend), not its widgets or layout.
pub fn dashboards_of(file: &KitableFile) -> Vec<Value> {
    file.list_dashboards()
        .unwrap_or_default()
        .iter()
        .map(|d| {
            json!({
                "id": d.id, "title": d.name,
                "order": d.config.get("order").cloned().unwrap_or(json!(0)),
            })
        })
        .collect()
}

/// An origin as the change payloads name it: `kind:principal`, or a system origin's label.
pub fn render_origin(origin: &Origin) -> String {
    match origin.kind {
        OriginKind::System => origin
            .label
            .clone()
            .unwrap_or_else(|| origin.principal.clone()),
        kind => format!("{}:{}", kind.as_str(), origin.principal),
    }
}

/// A [`TableChange`] as the `change` field of the transact/undo/redo responses
/// (`contracts/runtime/data-documents-transact.schema.json`): `documentId` and `origin` plus
/// the change's own camelCase fields.
pub fn change_json(document_id: &str, origin: &Origin, change: &TableChange) -> Value {
    // TableChange derives Serialize with rename_all = "camelCase" already; this just adds the
    // two fields the caller knows and the replica does not.
    let mut value =
        serde_json::to_value(change).unwrap_or_else(|_| Value::Object(serde_json::Map::new()));
    if let Value::Object(map) = &mut value {
        map.insert("documentId".to_owned(), Value::from(document_id));
        map.insert("origin".to_owned(), Value::from(render_origin(origin)));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_renders_as_the_contract_describes() {
        assert_eq!(
            render_origin(&Origin::person("session:abc")),
            "person:session:abc"
        );
        assert_eq!(render_origin(&Origin::agent("turn-1")), "agent:turn-1");
        assert_eq!(render_origin(&Origin::system("template")), "template");
    }

    #[test]
    fn change_json_matches_the_contracts_table_change_shape() {
        let change = TableChange {
            tables: vec![1],
            schema: vec![1],
            views: vec![2],
            records_upserted: vec![(1, "r1".into())],
            records_deleted: vec![(1, "r2".into())],
            records_reordered: vec![1],
            dashboards: true,
        };
        let value = change_json("42", &Origin::person("session:abc"), &change);
        assert_eq!(
            value,
            json!({
                "documentId": "42",
                "origin": "person:session:abc",
                "tables": [1],
                "schema": [1],
                "views": [2],
                "recordsUpserted": [[1, "r1"]],
                "recordsDeleted": [[1, "r2"]],
                "recordsReordered": [1],
                "dashboards": true,
            })
        );
    }
}
