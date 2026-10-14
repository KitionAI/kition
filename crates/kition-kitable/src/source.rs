//! Tables, fields, views, records, and attachments.

use kition_core::{Millis, now_millis};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::history::{HistoryAction, HistoryWrite};
use crate::json::{self, encode_default, fallback};
use crate::{KitableError, KitableFile, Result};

pub const FIELD_TYPES: [&str; 24] = [
    "text",
    "long_text",
    "number",
    "date",
    "datetime",
    "single_select",
    "multi_select",
    "checkbox",
    "url",
    "attachment",
    "document_link",
    "formula",
    "ai",
    "rating",
    "user",
    "link_to_record",
    "lookup",
    "rollup",
    "button",
    "created_time",
    "last_modified_time",
    "created_by",
    "last_modified_by",
    "auto_number",
];

pub const VIEW_TYPES: [&str; 5] = ["grid", "form", "kanban", "calendar", "gallery"];

#[derive(Debug, Clone, Default)]
pub struct TableSpec {
    pub name: String,
    pub title: String,
    pub description: String,
    pub fields: Vec<FieldSpec>,
    pub views: Vec<ViewSpec>,
    pub meta: Value,
}

#[derive(Debug, Clone, Default)]
pub struct FieldSpec {
    pub name: String,
    pub title: String,
    pub field_type: String,
    pub primary: bool,
    pub required: bool,
    pub readonly: bool,
    pub options: Value,
    pub formula: String,
    pub ai_prompt: String,
    pub meta: Value,
    /// Inserts at this position, shifting later fields; `None` appends.
    pub order: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct ViewSpec {
    pub title: String,
    pub view_type: String,
    pub config: Value,
}

#[derive(Debug, Clone, Default)]
pub struct TablePatch {
    pub title: Option<String>,
    pub description: Option<String>,
    /// `Some` replaces the metadata (with `Null` meaning `{}`).
    pub meta: Option<Value>,
    pub primary_field_id: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct FieldPatch {
    pub title: Option<String>,
    pub field_type: Option<String>,
    pub required: Option<bool>,
    pub readonly: Option<bool>,
    pub is_primary: Option<bool>,
    pub options: Option<Value>,
    pub formula: Option<String>,
    pub ai_prompt: Option<String>,
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Default)]
pub struct ViewPatch {
    pub title: Option<String>,
    pub view_type: Option<String>,
    pub config: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Table {
    pub id: i64,
    pub document_id: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub order: i64,
    pub primary_field_id: Option<i64>,
    pub meta: Map<String, Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<Field>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<View>,
    pub created_at: Millis,
    pub updated_at: Millis,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Field {
    pub id: i64,
    pub document_id: String,
    pub table_id: i64,
    pub name: String,
    pub title: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub required: bool,
    pub unique: bool,
    pub readonly: bool,
    pub is_primary: bool,
    pub order: i64,
    pub options: Map<String, Value>,
    pub formula: String,
    pub ai_prompt: String,
    pub meta: Map<String, Value>,
    pub created_at: Millis,
    pub updated_at: Millis,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct View {
    pub id: i64,
    pub document_id: String,
    pub table_id: i64,
    pub title: String,
    #[serde(rename = "type")]
    pub view_type: String,
    pub order: i64,
    pub locked: bool,
    pub config: Map<String, Value>,
    pub created_at: Millis,
    pub updated_at: Millis,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Record {
    pub id: i64,
    pub document_id: String,
    pub table_id: i64,
    pub row_key: String,
    pub order: i64,
    pub values: Map<String, Value>,
    pub created_at: Millis,
    pub updated_at: Millis,
}

#[derive(Debug, Clone, Default)]
pub struct AttachmentSpec {
    pub document_id: String,
    pub record_id: Option<i64>,
    pub field_id: Option<i64>,
    pub name: String,
    pub path: String,
    pub mime_type: String,
    pub size: i64,
    pub meta: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attachment {
    pub id: i64,
    pub document_id: String,
    pub record_id: Option<i64>,
    pub field_id: Option<i64>,
    pub name: String,
    pub path: String,
    pub mime_type: String,
    pub size: i64,
    pub meta: Map<String, Value>,
    pub created_at: Millis,
}

const TABLE_COLUMNS: &str = "id, document_id, name, title, description, position, primary_field_id, meta_json, created_at, updated_at";
pub(crate) const FIELD_COLUMNS: &str = "id, document_id, table_id, name, title, type, required, unique_value, readonly, \
    is_primary, position, options_json, formula, ai_prompt, meta_json, created_at, updated_at";
const VIEW_COLUMNS: &str =
    "id, document_id, table_id, title, type, position, locked, config_json, created_at, updated_at";
const RECORD_COLUMNS: &str =
    "id, document_id, table_id, row_key, position, values_json, created_at, updated_at";

fn table_from_row(row: &Row<'_>) -> rusqlite::Result<Table> {
    Ok(Table {
        id: row.get(0)?,
        document_id: row.get(1)?,
        name: row.get(2)?,
        title: row.get(3)?,
        description: row.get(4)?,
        order: row.get(5)?,
        primary_field_id: row.get(6)?,
        meta: json::object(&row.get::<_, String>(7)?),
        fields: Vec::new(),
        views: Vec::new(),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

pub(crate) fn field_from_row(row: &Row<'_>) -> rusqlite::Result<Field> {
    Ok(Field {
        id: row.get(0)?,
        document_id: row.get(1)?,
        table_id: row.get(2)?,
        name: row.get(3)?,
        title: row.get(4)?,
        field_type: row.get(5)?,
        required: row.get::<_, i64>(6)? != 0,
        unique: row.get::<_, i64>(7)? != 0,
        readonly: row.get::<_, i64>(8)? != 0,
        is_primary: row.get::<_, i64>(9)? != 0,
        order: row.get(10)?,
        options: json::object(&row.get::<_, String>(11)?),
        formula: row.get(12)?,
        ai_prompt: row.get(13)?,
        meta: json::object(&row.get::<_, String>(14)?),
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

fn view_from_row(row: &Row<'_>) -> rusqlite::Result<View> {
    Ok(View {
        id: row.get(0)?,
        document_id: row.get(1)?,
        table_id: row.get(2)?,
        title: row.get(3)?,
        view_type: row.get(4)?,
        order: row.get(5)?,
        locked: row.get::<_, i64>(6)? != 0,
        config: json::object(&row.get::<_, String>(7)?),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

pub(crate) fn record_from_row(row: &Row<'_>) -> rusqlite::Result<Record> {
    Ok(Record {
        id: row.get(0)?,
        document_id: row.get(1)?,
        table_id: row.get(2)?,
        row_key: row.get(3)?,
        order: row.get(4)?,
        values: json::object(&row.get::<_, String>(5)?),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn affected_or_not_found(count: usize) -> Result<()> {
    if count == 0 {
        Err(KitableError::NotFound)
    } else {
        Ok(())
    }
}

impl KitableFile {
    pub fn kind(&self) -> &'static str {
        "kitable"
    }

    pub fn document_id(&self) -> Result<String> {
        self.get_meta("document_id")
    }

    pub fn list_tables(&self) -> Result<Vec<Table>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {TABLE_COLUMNS} FROM kition_tables WHERE deleted_at IS NULL ORDER BY position ASC, id ASC"
        ))?;
        let mut tables = statement
            .query_map([], table_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for table in &mut tables {
            self.fill_table_schema(table)?;
        }
        Ok(tables)
    }

    pub fn get_table(&self, table_id: i64) -> Result<Table> {
        let mut table = self.conn.query_row(
            &format!(
                "SELECT {TABLE_COLUMNS} FROM kition_tables WHERE id = ?1 AND deleted_at IS NULL"
            ),
            [table_id],
            table_from_row,
        )?;
        self.fill_table_schema(&mut table)?;
        Ok(table)
    }

    fn fill_table_schema(&self, table: &mut Table) -> Result<()> {
        table.fields = self.list_fields(table.id)?;
        table.views = self.list_views(table.id)?;
        Ok(())
    }

    pub fn list_fields(&self, table_id: i64) -> Result<Vec<Field>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {FIELD_COLUMNS} FROM kition_fields WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position ASC, id ASC"
        ))?;
        Ok(statement
            .query_map([table_id], field_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }

    fn list_views(&self, table_id: i64) -> Result<Vec<View>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {VIEW_COLUMNS} FROM kition_views WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position ASC, id ASC"
        ))?;
        Ok(statement
            .query_map([table_id], view_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn create_table(&mut self, spec: &TableSpec) -> Result<Table> {
        let document_id = self.document_id()?;
        let title = fallback(&spec.title, "Table");
        let name = unique_name(
            &self.conn,
            "kition_tables",
            "document_id",
            &SqlValue::Text(document_id.clone()),
            &spec.name,
            &title,
        )?;
        let now = now_millis();
        let position = next_position(
            &self.conn,
            "kition_tables",
            "document_id",
            &SqlValue::Text(document_id.clone()),
        )?;
        let meta_json = encode_default(&spec.meta, "{}")?;

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO kition_tables (document_id, name, title, description, position, meta_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![document_id, name, title, spec.description.trim(), position, meta_json, now],
        )?;
        let table_id = tx.last_insert_rowid();
        let default_fields = [FieldSpec {
            title: "Title".to_owned(),
            field_type: "text".to_owned(),
            primary: true,
            required: true,
            ..FieldSpec::default()
        }];
        let fields: &[FieldSpec] = if spec.fields.is_empty() {
            &default_fields
        } else {
            &spec.fields
        };
        let mut primary_field_id = None;
        for field_spec in fields {
            let field = create_field_tx(&tx, &document_id, table_id, field_spec)?;
            if field.is_primary {
                primary_field_id = Some(field.id);
            }
        }
        let primary_field_id = match primary_field_id {
            Some(id) => id,
            None => {
                let id: i64 = tx.query_row(
                    "SELECT id FROM kition_fields WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position ASC, id ASC LIMIT 1",
                    [table_id],
                    |row| row.get(0),
                )?;
                tx.execute(
                    "UPDATE kition_fields SET is_primary = 1 WHERE id = ?1",
                    [id],
                )?;
                id
            }
        };
        tx.execute(
            "UPDATE kition_tables SET primary_field_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![primary_field_id, now, table_id],
        )?;
        let default_views = [ViewSpec {
            title: "All".to_owned(),
            view_type: "grid".to_owned(),
            config: Value::Null,
        }];
        let views: &[ViewSpec] = if spec.views.is_empty() {
            &default_views
        } else {
            &spec.views
        };
        for view_spec in views {
            create_view_tx(&tx, &document_id, table_id, view_spec)?;
        }
        tx.commit()?;
        self.get_table(table_id)
    }

    pub fn update_table(&mut self, table_id: i64, patch: &TablePatch) -> Result<Table> {
        let table = self.get_table(table_id)?;
        let title = match patch.title.as_deref().map(str::trim) {
            Some(title) if !title.is_empty() => title.to_owned(),
            _ => table.title.clone(),
        };
        let description = patch
            .description
            .clone()
            .unwrap_or_else(|| table.description.clone());
        let meta_json = match &patch.meta {
            Some(meta) => encode_default(meta, "{}")?,
            None => serde_json::to_string(&table.meta)?,
        };
        let mut primary_field_id = table.primary_field_id;
        if let Some(requested) = patch.primary_field_id {
            if !table.fields.iter().any(|field| field.id == requested) {
                return Err(KitableError::NotFound);
            }
            primary_field_id = Some(requested);
        }
        let now = now_millis();
        let tx = self.conn.transaction()?;
        if let Some(primary) = primary_field_id {
            tx.execute(
                "UPDATE kition_fields SET is_primary = CASE WHEN id = ?1 THEN 1 ELSE 0 END WHERE table_id = ?2",
                params![primary, table_id],
            )?;
        }
        let count = tx.execute(
            "UPDATE kition_tables SET title = ?1, description = ?2, primary_field_id = ?3, meta_json = ?4, updated_at = ?5 \
             WHERE id = ?6 AND deleted_at IS NULL",
            params![title, description, primary_field_id, meta_json, now, table_id],
        )?;
        affected_or_not_found(count)?;
        tx.commit()?;
        self.get_table(table_id)
    }

    pub fn delete_table(&mut self, table_id: i64) -> Result<()> {
        let now = now_millis();
        let tx = self.conn.transaction()?;
        let count = tx.execute(
            "UPDATE kition_tables SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, table_id],
        )?;
        affected_or_not_found(count)?;
        for table in ["kition_fields", "kition_views", "kition_records"] {
            tx.execute(
                &format!("UPDATE {table} SET deleted_at = ?1, updated_at = ?1 WHERE table_id = ?2 AND deleted_at IS NULL"),
                params![now, table_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn create_field(&mut self, table_id: i64, spec: &FieldSpec) -> Result<Field> {
        let table = self.get_table(table_id)?;
        let tx = self.conn.transaction()?;
        let field = create_field_tx(&tx, &table.document_id, table_id, spec)?;
        if field.is_primary {
            tx.execute(
                "UPDATE kition_tables SET primary_field_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![field.id, field.updated_at, table_id],
            )?;
        }
        tx.commit()?;
        Ok(field)
    }

    /// Copies a field's settings into a new non-primary field placed right
    /// after it, titled "<title> copy".
    pub fn duplicate_field(&mut self, table_id: i64, field_id: i64) -> Result<Field> {
        let source = self.get_field(table_id, field_id)?;
        let spec = FieldSpec {
            name: String::new(),
            title: format!("{} copy", source.title),
            field_type: source.field_type.clone(),
            primary: false,
            required: source.required,
            readonly: source.readonly,
            options: Value::Object(source.options.clone()),
            formula: source.formula.clone(),
            ai_prompt: source.ai_prompt.clone(),
            meta: Value::Object(source.meta.clone()),
            order: Some(source.order + 1),
        };
        self.create_field(table_id, &spec)
    }

    pub fn update_field(
        &mut self,
        table_id: i64,
        field_id: i64,
        patch: &FieldPatch,
    ) -> Result<Field> {
        let field = self.get_field(table_id, field_id)?;
        let title = match patch.title.as_deref().map(str::trim) {
            Some(title) if !title.is_empty() => title.to_owned(),
            _ => field.title.clone(),
        };
        let mut field_type = field.field_type.clone();
        if let Some(requested) = patch
            .field_type
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            if !FIELD_TYPES.contains(&requested) {
                return Err(KitableError::invalid(format!(
                    "unsupported field type {requested:?}"
                )));
            }
            field_type = requested.to_owned();
        }
        let required = patch.required.unwrap_or(field.required);
        let mut readonly = patch.readonly.unwrap_or(field.readonly);
        if field_type == "formula" || field_type == "ai" {
            readonly = true;
        }
        let is_primary = patch.is_primary.unwrap_or(field.is_primary);
        let options_json = match &patch.options {
            Some(options) => encode_default(options, "{}")?,
            None => serde_json::to_string(&field.options)?,
        };
        let formula = patch
            .formula
            .clone()
            .unwrap_or_else(|| field.formula.clone());
        let ai_prompt = patch
            .ai_prompt
            .clone()
            .unwrap_or_else(|| field.ai_prompt.clone());
        let meta_json = match &patch.meta {
            Some(meta) => encode_default(meta, "{}")?,
            None => serde_json::to_string(&field.meta)?,
        };
        if field.is_primary && !is_primary {
            return Err(KitableError::invalid(
                "primary field cannot be unset directly",
            ));
        }
        let now = now_millis();
        let tx = self.conn.transaction()?;
        if is_primary {
            tx.execute(
                "UPDATE kition_fields SET is_primary = 0 WHERE table_id = ?1",
                [table_id],
            )?;
            tx.execute(
                "UPDATE kition_tables SET primary_field_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![field_id, now, table_id],
            )?;
        }
        let count = tx.execute(
            "UPDATE kition_fields SET title = ?1, type = ?2, required = ?3, readonly = ?4, is_primary = ?5, \
             options_json = ?6, formula = ?7, ai_prompt = ?8, meta_json = ?9, updated_at = ?10 \
             WHERE id = ?11 AND table_id = ?12 AND deleted_at IS NULL",
            params![
                title,
                field_type,
                required,
                readonly,
                is_primary,
                options_json,
                formula,
                ai_prompt,
                meta_json,
                now,
                field_id,
                table_id
            ],
        )?;
        affected_or_not_found(count)?;
        tx.commit()?;
        self.get_field(table_id, field_id)
    }

    pub fn delete_field(&mut self, table_id: i64, field_id: i64) -> Result<()> {
        let field = self.get_field(table_id, field_id)?;
        if field.is_primary {
            return Err(KitableError::invalid("primary field cannot be deleted"));
        }
        let now = now_millis();
        let count = self.conn.execute(
            "UPDATE kition_fields SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND table_id = ?3 AND deleted_at IS NULL",
            params![now, field_id, table_id],
        )?;
        affected_or_not_found(count)
    }

    pub fn create_view(&mut self, table_id: i64, spec: &ViewSpec) -> Result<View> {
        let table = self.get_table(table_id)?;
        let tx = self.conn.transaction()?;
        let view = create_view_tx(&tx, &table.document_id, table_id, spec)?;
        tx.commit()?;
        Ok(view)
    }

    pub fn update_view(&mut self, table_id: i64, view_id: i64, patch: &ViewPatch) -> Result<View> {
        let view = self.get_view(table_id, view_id)?;
        let title = match patch.title.as_deref().map(str::trim) {
            Some(title) if !title.is_empty() => title.to_owned(),
            _ => view.title.clone(),
        };
        let mut view_type = view.view_type.clone();
        if let Some(requested) = patch
            .view_type
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            if !VIEW_TYPES.contains(&requested) {
                return Err(KitableError::invalid(format!(
                    "unsupported view type {requested:?}"
                )));
            }
            view_type = requested.to_owned();
        }
        let config_json = match &patch.config {
            Some(config) => encode_default(config, "{}")?,
            None => serde_json::to_string(&view.config)?,
        };
        let count = self.conn.execute(
            "UPDATE kition_views SET title = ?1, type = ?2, config_json = ?3, updated_at = ?4 \
             WHERE id = ?5 AND table_id = ?6 AND deleted_at IS NULL",
            params![
                title,
                view_type,
                config_json,
                now_millis(),
                view_id,
                table_id
            ],
        )?;
        affected_or_not_found(count)?;
        self.get_view(table_id, view_id)
    }

    pub fn delete_view(&mut self, table_id: i64, view_id: i64) -> Result<()> {
        let now = now_millis();
        let count = self.conn.execute(
            "UPDATE kition_views SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND table_id = ?3 AND deleted_at IS NULL",
            params![now, view_id, table_id],
        )?;
        affected_or_not_found(count)
    }

    pub fn list_records(&self, table_id: i64) -> Result<Vec<Record>> {
        self.list_records_page(table_id, 0, 0)
    }

    pub fn count_records(&self, table_id: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL",
            [table_id],
            |row| row.get(0),
        )?)
    }

    /// With `limit > 0`, returns up to `limit` records whose position is
    /// greater than `offset` (keyset pagination on position).
    pub fn list_records_page(&self, table_id: i64, limit: i64, offset: i64) -> Result<Vec<Record>> {
        let base = format!(
            "SELECT {RECORD_COLUMNS} FROM kition_records WHERE table_id = ?1 AND deleted_at IS NULL"
        );
        let records = if limit > 0 {
            let mut statement = self.conn.prepare(&format!(
                "{base} AND position > ?2 ORDER BY position ASC, id ASC LIMIT ?3"
            ))?;
            statement
                .query_map(params![table_id, offset.max(0), limit], record_from_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            let mut statement = self
                .conn
                .prepare(&format!("{base} ORDER BY position ASC, id ASC"))?;
            statement
                .query_map([table_id], record_from_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        Ok(records)
    }

    pub fn get_record(&self, table_id: i64, record_id: i64) -> Result<Record> {
        Ok(self.conn.query_row(
            &format!("SELECT {RECORD_COLUMNS} FROM kition_records WHERE id = ?1 AND table_id = ?2 AND deleted_at IS NULL"),
            params![record_id, table_id],
            record_from_row,
        )?)
    }

    pub fn create_record(&mut self, table_id: i64, values: &Map<String, Value>) -> Result<Record> {
        let table = self.get_table(table_id)?;
        let clean = validate_record_values(&table.fields, values)?;
        let values_json = serde_json::to_string(&clean)?;
        let position = next_position(
            &self.conn,
            "kition_records",
            "table_id",
            &SqlValue::Integer(table_id),
        )?;
        let now = now_millis();
        self.conn.execute(
            "INSERT INTO kition_records (document_id, table_id, row_key, position, values_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![table.document_id, table_id, uuid::Uuid::new_v4().to_string(), position, values_json, now],
        )?;
        let record_id = self.conn.last_insert_rowid();
        let _ = self.write_record_history(&HistoryWrite {
            document_id: &table.document_id,
            table_id,
            record_id,
            field_id: None,
            action: HistoryAction::Create,
            before: Value::Null,
            after: Value::Object(clean.clone()),
            actor: "",
        });
        let _ = self.apply_recomputed_values(&table, record_id, &clean);
        self.get_record(table_id, record_id)
    }

    /// Merges `values` over the record's current values; `order > 0` moves it.
    pub fn update_record(
        &mut self,
        table_id: i64,
        record_id: i64,
        values: &Map<String, Value>,
        order: Option<i64>,
    ) -> Result<Record> {
        let table = self.get_table(table_id)?;
        let record = self.get_record(table_id, record_id)?;
        let mut next = record.values.clone();
        for (key, value) in values {
            next.insert(key.clone(), value.clone());
        }
        let clean = validate_record_values(&table.fields, &next)?;
        let values_json = serde_json::to_string(&clean)?;
        let next_order = order.filter(|o| *o > 0).unwrap_or(record.order);
        self.conn.execute(
            "UPDATE kition_records SET values_json = ?1, position = ?2, updated_at = ?3 \
             WHERE id = ?4 AND table_id = ?5 AND deleted_at IS NULL",
            params![values_json, next_order, now_millis(), record_id, table_id],
        )?;
        for change in diff_record_values(&table.fields, &record.values, &clean) {
            let _ = self.write_record_history(&HistoryWrite {
                document_id: &table.document_id,
                table_id,
                record_id,
                field_id: Some(change.field_id),
                action: HistoryAction::Update,
                before: change.before,
                after: change.after,
                actor: "",
            });
        }
        let _ = self.apply_recomputed_values(&table, record_id, &clean);
        self.get_record(table_id, record_id)
    }

    pub fn delete_record(&mut self, table_id: i64, record_id: i64) -> Result<()> {
        let record = self.get_record(table_id, record_id);
        let back_links = self
            .collect_back_link_sources(record_id)
            .unwrap_or_default();
        let now = now_millis();
        let count = self.conn.execute(
            "UPDATE kition_records SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND table_id = ?3 AND deleted_at IS NULL",
            params![now, record_id, table_id],
        )?;
        affected_or_not_found(count)?;
        self.conn.execute(
            "DELETE FROM kition_record_links WHERE from_record_id = ?1 OR to_record_id = ?1",
            [record_id],
        )?;
        for (source_table, source_record) in back_links {
            self.recompute_after_link_change(source_table, source_record);
        }
        if let Ok(record) = record {
            let _ = self.write_record_history(&HistoryWrite {
                document_id: &record.document_id,
                table_id,
                record_id,
                field_id: None,
                action: HistoryAction::Delete,
                before: Value::Object(record.values),
                after: Value::Null,
                actor: "",
            });
        }
        Ok(())
    }

    fn collect_back_link_sources(&self, to_record_id: i64) -> Result<Vec<(i64, i64)>> {
        let mut statement = self.conn.prepare(
            "SELECT DISTINCT from_table_id, from_record_id FROM kition_record_links WHERE to_record_id = ?1",
        )?;
        Ok(statement
            .query_map([to_record_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn add_attachment(&self, spec: &AttachmentSpec) -> Result<Attachment> {
        let document_id = match spec.document_id.trim() {
            "" => self.document_id()?,
            id => id.to_owned(),
        };
        let name = fallback(&spec.name, "attachment");
        let path = spec.path.trim().to_owned();
        if path.is_empty() {
            return Err(KitableError::invalid("attachment path is required"));
        }
        let meta_json = encode_default(&spec.meta, "{}")?;
        let mime_type = spec.mime_type.trim().to_owned();
        let now = now_millis();
        self.conn.execute(
            "INSERT INTO kition_attachments (document_id, record_id, field_id, name, path, mime_type, size, meta_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![document_id, spec.record_id, spec.field_id, name, path, mime_type, spec.size, meta_json, now],
        )?;
        Ok(Attachment {
            id: self.conn.last_insert_rowid(),
            document_id,
            record_id: spec.record_id,
            field_id: spec.field_id,
            name,
            path,
            mime_type,
            size: spec.size,
            meta: json::object(&meta_json),
            created_at: now,
        })
    }

    pub fn get_field(&self, table_id: i64, field_id: i64) -> Result<Field> {
        field_in(&self.conn, table_id, field_id)
    }

    pub fn get_view(&self, table_id: i64, view_id: i64) -> Result<View> {
        Ok(self.conn.query_row(
            &format!("SELECT {VIEW_COLUMNS} FROM kition_views WHERE id = ?1 AND table_id = ?2 AND deleted_at IS NULL"),
            params![view_id, table_id],
            view_from_row,
        )?)
    }
}

/// A live field of a table.
pub(crate) fn field_in(conn: &Connection, table_id: i64, field_id: i64) -> Result<Field> {
    Ok(conn.query_row(
        &format!("SELECT {FIELD_COLUMNS} FROM kition_fields WHERE id = ?1 AND table_id = ?2 AND deleted_at IS NULL"),
        params![field_id, table_id],
        field_from_row,
    )?)
}

/// A live field of any table.
pub(crate) fn field_by_id(conn: &Connection, field_id: i64) -> Result<Field> {
    let table_id: i64 = conn.query_row(
        "SELECT table_id FROM kition_fields WHERE id = ?1 AND deleted_at IS NULL",
        [field_id],
        |row| row.get(0),
    )?;
    field_in(conn, table_id, field_id)
}

fn create_field_tx(
    conn: &Connection,
    document_id: &str,
    table_id: i64,
    spec: &FieldSpec,
) -> Result<Field> {
    let field_type = fallback(&spec.field_type, "text");
    if !FIELD_TYPES.contains(&field_type.as_str()) {
        return Err(KitableError::invalid(format!(
            "unsupported field type {field_type:?}"
        )));
    }
    let title = fallback(&spec.title, "Field");
    let name = unique_name(
        conn,
        "kition_fields",
        "table_id",
        &SqlValue::Integer(table_id),
        &spec.name,
        &title,
    )?;
    let position = match spec.order {
        Some(order) => {
            let position = order.max(1);
            conn.execute(
                "UPDATE kition_fields SET position = position + 1 WHERE table_id = ?1 AND position >= ?2 AND deleted_at IS NULL",
                params![table_id, position],
            )?;
            position
        }
        None => next_position(
            conn,
            "kition_fields",
            "table_id",
            &SqlValue::Integer(table_id),
        )?,
    };
    let options_json = encode_default(&spec.options, "{}")?;
    let meta_json = encode_default(&spec.meta, "{}")?;
    let now = now_millis();
    let readonly = spec.readonly || field_type == "formula" || field_type == "ai";
    if spec.primary {
        conn.execute(
            "UPDATE kition_fields SET is_primary = 0 WHERE table_id = ?1",
            [table_id],
        )?;
    }
    let formula = spec.formula.trim().to_owned();
    let ai_prompt = spec.ai_prompt.trim().to_owned();
    conn.execute(
        "INSERT INTO kition_fields (document_id, table_id, name, title, type, required, readonly, is_primary, position, \
         options_json, formula, ai_prompt, meta_json, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
        params![
            document_id,
            table_id,
            name,
            title,
            field_type,
            spec.required,
            readonly,
            spec.primary,
            position,
            options_json,
            formula,
            ai_prompt,
            meta_json,
            now
        ],
    )?;
    Ok(Field {
        id: conn.last_insert_rowid(),
        document_id: document_id.to_owned(),
        table_id,
        name,
        title,
        field_type,
        required: spec.required,
        unique: false,
        readonly,
        is_primary: spec.primary,
        order: position,
        options: json::object(&options_json),
        formula,
        ai_prompt,
        meta: json::object(&meta_json),
        created_at: now,
        updated_at: now,
    })
}

fn create_view_tx(
    conn: &Connection,
    document_id: &str,
    table_id: i64,
    spec: &ViewSpec,
) -> Result<View> {
    let mut view_type = fallback(&spec.view_type, "grid");
    if !VIEW_TYPES.contains(&view_type.as_str()) {
        view_type = "grid".to_owned();
    }
    let title = fallback(&spec.title, "All");
    let position = next_position(
        conn,
        "kition_views",
        "table_id",
        &SqlValue::Integer(table_id),
    )?;
    let config_json = encode_default(&spec.config, "{}")?;
    let now = now_millis();
    conn.execute(
        "INSERT INTO kition_views (document_id, table_id, title, type, position, config_json, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![document_id, table_id, title, view_type, position, config_json, now],
    )?;
    Ok(View {
        id: conn.last_insert_rowid(),
        document_id: document_id.to_owned(),
        table_id,
        title,
        view_type,
        order: position,
        locked: false,
        config: json::object(&config_json),
        created_at: now,
        updated_at: now,
    })
}

fn next_position(
    conn: &Connection,
    table: &str,
    scope_column: &str,
    scope: &SqlValue,
) -> Result<i64> {
    let max: i64 = conn.query_row(
        &format!("SELECT COALESCE(MAX(position), 0) FROM {table} WHERE {scope_column} = ?1"),
        [scope],
        |row| row.get(0),
    )?;
    Ok(max + 1)
}

/// `explicit` (or `fallback_title`) as an internal name, suffixed `_2`, `_3`,
/// ... until no live row in the scope uses it.
fn unique_name(
    conn: &Connection,
    table: &str,
    scope_column: &str,
    scope: &SqlValue,
    explicit: &str,
    fallback_title: &str,
) -> Result<String> {
    let base = json::internal_name(&fallback(explicit, fallback_title));
    let mut name = base.clone();
    let mut suffix = 2;
    loop {
        let count: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE {scope_column} = ?1 AND name = ?2 AND deleted_at IS NULL"),
            params_from_iter([scope.clone(), SqlValue::Text(name.clone())]),
            |row| row.get(0),
        )?;
        if count == 0 {
            return Ok(name);
        }
        name = format!("{base}_{suffix}");
        suffix += 1;
    }
}

/// Drops values for unknown fields and rejects blank required fields.
pub(crate) fn validate_record_values(
    fields: &[Field],
    values: &Map<String, Value>,
) -> Result<Map<String, Value>> {
    let clean: Map<String, Value> = values
        .iter()
        .filter(|(key, _)| fields.iter().any(|field| &field.name == *key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    for field in fields {
        if field.required && json::is_blank(clean.get(&field.name)) {
            return Err(KitableError::invalid(format!(
                "required field is blank: {}",
                field.title
            )));
        }
    }
    Ok(clean)
}

pub(crate) struct FieldChange {
    pub field_id: i64,
    pub before: Value,
    pub after: Value,
}

/// Per-field changes between two value maps, in field-name order.
pub(crate) fn diff_record_values(
    fields: &[Field],
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> Vec<FieldChange> {
    let mut keys: Vec<&String> = before.keys().chain(after.keys()).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .filter_map(|key| {
            let old = before.get(key).cloned().unwrap_or(Value::Null);
            let new = after.get(key).cloned().unwrap_or(Value::Null);
            if json::equal(&old, &new) {
                return None;
            }
            let field = fields.iter().find(|field| &field.name == key)?;
            Some(FieldChange {
                field_id: field.id,
                before: old,
                after: new,
            })
        })
        .collect()
}

/// Looks up a live row ID or reports `NotFound`.
pub(crate) fn exists(conn: &Connection, sql: &str, id: i64) -> Result<()> {
    conn.query_row(sql, [id], |row| row.get::<_, i64>(0))
        .optional()?
        .ok_or(KitableError::NotFound)?;
    Ok(())
}
