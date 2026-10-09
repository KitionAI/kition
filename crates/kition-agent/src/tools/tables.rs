//! Data table tools over `.kitable` documents.

use std::collections::{HashMap, HashSet};

use kition_datadoc::DataDocState;
use kition_datadoc::index::{DataDocument, NewDocument};
use kition_kitable::{Field, FieldSpec, KitableFile, Record, Table, TableSpec, ViewSpec};
use serde_json::{Map, Value, json};

use crate::run::{ToolOutput, ToolResult, int_field, string_list, text_field, truncate_chars};
use crate::workspace::{clean_path, parent_folder, sanitize_filename};

const MAX_RECORD_READ: i64 = 100;
const MAX_RECORD_WRITE: usize = 100;
const MAX_FIELD_WRITE: usize = 30;

const FIELD_TYPES: &[&str] = &[
    "text",
    "long_text",
    "number",
    "date",
    "datetime",
    "single_select",
    "multi_select",
    "checkbox",
    "url",
];

/// What a table tool needs to know about the turn.
#[derive(Debug, Clone, Default)]
pub struct TableContext {
    pub user_id: i64,
    pub active_document_path: String,
    pub document_id: i64,
    pub table_id: i64,
}

struct TableRef {
    doc: DataDocument,
    file: KitableFile,
    table: Table,
}

fn open(state: &DataDocState, ctx: &TableContext, input: &Value) -> Result<TableRef, String> {
    let mut document_id = int_field(input, "document_id");
    let mut table_id = int_field(input, "table_id");
    if document_id == 0 {
        document_id = ctx.document_id;
    }
    if table_id == 0 {
        table_id = ctx.table_id;
    }
    if document_id == 0 || table_id == 0 {
        return Err("missing current data-table context".into());
    }
    let opened = state
        .agent_table(ctx.user_id, document_id, table_id)
        .or_else(|error| {
            // Fall back to the active table when the model names a stale one.
            let active = ctx.document_id != 0
                && ctx.table_id != 0
                && (ctx.document_id, ctx.table_id) != (document_id, table_id);
            if active {
                state.agent_table(ctx.user_id, ctx.document_id, ctx.table_id)
            } else {
                Err(error)
            }
        });
    let (doc, file, table) = opened.map_err(|error| error.to_string())?;
    Ok(TableRef { doc, file, table })
}

fn display(field: &Field) -> &str {
    if field.title.trim().is_empty() {
        &field.name
    } else {
        &field.title
    }
}

/// Fields by lowercase display name and internal name.
fn lookup(fields: &[Field]) -> HashMap<String, Field> {
    let mut map = HashMap::new();
    for field in fields {
        map.entry(field.name.trim().to_lowercase())
            .or_insert_with(|| field.clone());
        map.insert(field.title.trim().to_lowercase(), field.clone());
    }
    map.remove("");
    map
}

fn field_summary(field: &Field) -> Value {
    json!({
        "id": field.id, "name": field.name, "title": display(field), "type": field.field_type,
        "required": field.required, "is_primary": field.is_primary, "options": field.options,
    })
}

fn record_row(record: &Record, fields: &[Field]) -> Value {
    let values: Map<String, Value> = fields
        .iter()
        .filter_map(|field| {
            record
                .values
                .get(&field.name)
                .map(|v| (display(field).to_owned(), v.clone()))
        })
        .collect();
    json!({ "id": record.id, "order": record.order, "values": values })
}

fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn plain(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A cell value shaped for the field's type; `Null` drops it.
pub fn coerce(field: &Field, value: &Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    let number = |value: &Value| match value {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    match field.field_type.as_str() {
        "number" => number(value).map_or(Value::Null, |n| json!(n)),
        "rating" => {
            let max = field
                .options
                .get("max")
                .and_then(Value::as_f64)
                .filter(|m| *m > 0.0)
                .unwrap_or(5.0);
            number(value).map_or(Value::Null, |n| json!(n.clamp(0.0, max)))
        }
        "checkbox" => match value {
            Value::Bool(flag) => json!(flag),
            Value::String(text) => json!(matches!(
                text.trim().to_lowercase().as_str(),
                "true" | "yes" | "1"
            )),
            _ => json!(false),
        },
        "multi_select" => {
            let items: Vec<String> = match value {
                Value::Array(items) => items
                    .iter()
                    .map(plain)
                    .map(|s| s.trim().to_owned())
                    .collect(),
                Value::String(text) => text.split(',').map(|s| s.trim().to_owned()).collect(),
                _ => Vec::new(),
            };
            json!(
                items
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            )
        }
        "link_to_record" | "lookup" | "rollup" | "formula" | "auto_number" | "created_time"
        | "last_modified_time" | "created_by" | "last_modified_by" | "button" => Value::Null,
        _ => json!(plain(value)),
    }
}

fn normalize_type(value: &str, title: &str) -> String {
    let value = value.trim().to_lowercase();
    if FIELD_TYPES.contains(&value.as_str()) {
        return value;
    }
    let title = title.trim().to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| title.contains(w));
    if has(&["url", "link"]) {
        "url"
    } else if has(&["content", "text"]) {
        "long_text"
    } else if has(&["date"]) {
        "date"
    } else if has(&["time"]) {
        "datetime"
    } else if has(&["count", "number", "likes", "retweets", "replies"]) {
        "number"
    } else if has(&["status"]) {
        "single_select"
    } else {
        "text"
    }
    .to_owned()
}

fn field_options(options: Option<&Value>, field_type: &str) -> Value {
    let mut options = options
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if matches!(field_type, "single_select" | "multi_select") && !options.contains_key("choices") {
        options.insert(
            "choices".into(),
            json!(["To Review", "In Progress", "Done"]),
        );
    }
    Value::Object(options)
}

fn internal_name(value: &str) -> String {
    let mut out = String::new();
    for c in value.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let out = out.trim_matches('_').to_owned();
    match out.chars().next() {
        None => "field".into(),
        Some(c) if c.is_ascii_alphabetic() => out,
        Some(_) => format!("f_{out}"),
    }
}

/// Field specs from model input; the first text field becomes primary.
fn field_specs(input: Option<&Value>, existing: &[Field]) -> Vec<FieldSpec> {
    let mut taken: HashSet<String> = existing.iter().map(|f| f.name.clone()).collect();
    let mut specs: Vec<FieldSpec> = Vec::new();
    for item in input.and_then(Value::as_array).into_iter().flatten() {
        let title = text_field(item, "title");
        if title.is_empty() {
            continue;
        }
        let field_type = normalize_type(&text_field(item, "type"), &title);
        let base = internal_name(&match text_field(item, "name") {
            name if name.is_empty() => title.clone(),
            name => name,
        });
        let mut name = base.clone();
        let mut counter = 2;
        while !taken.insert(name.clone()) {
            name = format!("{base}_{counter}");
            counter += 1;
        }
        let primary = item
            .get("primary")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        specs.push(FieldSpec {
            name,
            title,
            options: field_options(item.get("options"), &field_type),
            field_type,
            primary,
            required: primary
                || item
                    .get("required")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ..FieldSpec::default()
        });
    }
    specs
}

pub fn create(state: &DataDocState, ctx: &TableContext, input: &Value) -> ToolResult {
    let table_title = match text_field(input, "table_title") {
        title if title.is_empty() => "Table".to_owned(),
        title => title,
    };
    let document_title = match text_field(input, "document_title") {
        title if title.is_empty() => table_title.clone(),
        title => title,
    };
    let mut path = text_field(input, "path");
    if path.is_empty() {
        let mut folder = text_field(input, "folder");
        if folder.is_empty() {
            folder = parent_folder(&ctx.active_document_path);
        }
        if folder.is_empty() {
            folder = "Agent".into();
        }
        path = format!(
            "{}/{}",
            folder.trim_matches('/'),
            sanitize_filename(&document_title, "Untitled data table")
        );
    }
    if !path.to_lowercase().ends_with(".kitable") {
        path.push_str(".kitable");
    }
    let path = clean_path(&path, false)?;
    let mut fields = field_specs(input.get("fields"), &[]);
    if fields.is_empty() {
        fields = vec![
            FieldSpec {
                name: "title".into(),
                title: "Title".into(),
                field_type: "text".into(),
                primary: true,
                required: true,
                ..FieldSpec::default()
            },
            FieldSpec {
                name: "status".into(),
                title: "Status".into(),
                field_type: "single_select".into(),
                options: json!({ "choices": ["To do", "In progress", "Done"] }),
                ..FieldSpec::default()
            },
            FieldSpec {
                name: "notes".into(),
                title: "Notes".into(),
                field_type: "long_text".into(),
                ..FieldSpec::default()
            },
        ];
    } else if !fields.iter().any(|f| f.primary) {
        fields[0].primary = true;
        fields[0].required = true;
    }
    let mut views: Vec<ViewSpec> = input
        .get("views")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|view| {
            let title = text_field(view, "title");
            (!title.is_empty()).then(|| {
                let kind = text_field(view, "type").to_lowercase();
                ViewSpec {
                    title,
                    view_type: if ["grid", "form", "kanban", "calendar", "gallery"]
                        .contains(&kind.as_str())
                    {
                        kind
                    } else {
                        "grid".into()
                    },
                    config: view.get("config").cloned().unwrap_or(Value::Null),
                }
            })
        })
        .collect();
    if views.is_empty() {
        views.push(ViewSpec {
            title: "All".into(),
            view_type: "grid".into(),
            config: Value::Null,
        });
    }
    let spec = TableSpec {
        title: table_title,
        fields,
        views,
        ..TableSpec::default()
    };
    let (doc, tables) = state
        .create_kitable_document(
            NewDocument {
                user_id: ctx.user_id,
                workspace_root: String::new(),
                path,
                title: document_title,
                description: text_field(input, "description"),
                icon: String::new(),
                color: String::new(),
                meta: Map::new(),
            },
            &[spec],
        )
        .map_err(|error| error.to_string())?;
    let table = tables.into_iter().next().ok_or("failed to create table")?;
    Ok(ToolOutput::new(
        format!("Created data table `{}` in `{}`.", table.title, doc.path),
        json!({
            "document_id": doc.id, "document_title": doc.title, "document_path": doc.path,
            "table_id": table.id, "table_title": table.title, "table_name": table.name,
            "field_titles": table.fields.iter().map(display).collect::<Vec<_>>(),
            "view_titles": table.views.iter().map(|v| v.title.clone()).collect::<Vec<_>>(),
        }),
    ))
}

pub fn schema(state: &DataDocState, ctx: &TableContext, input: &Value) -> ToolResult {
    let target = open(state, ctx, input)?;
    let (doc, table) = (&target.doc, &target.table);
    let mut rows = vec![
        format!("Current data table `{}` / `{}`.", doc.title, table.title),
        "Fields:".to_owned(),
    ];
    rows.extend(
        table
            .fields
            .iter()
            .map(|f| format!("- {} (`{}`, {})", display(f), f.name, f.field_type)),
    );
    if !table.views.is_empty() {
        rows.push("Views:".into());
        rows.extend(
            table
                .views
                .iter()
                .map(|v| format!("- {} ({})", v.title, v.view_type)),
        );
    }
    Ok(ToolOutput::new(
        rows.join("\n"),
        json!({
            "document": { "id": doc.id, "title": doc.title, "path": doc.path },
            "table": { "id": table.id, "title": table.title, "name": table.name },
            "fields": table.fields.iter().map(field_summary).collect::<Vec<_>>(),
            "views": table.views.iter().map(|v| json!({ "id": v.id, "title": v.title, "type": v.view_type })).collect::<Vec<_>>(),
        }),
    ))
}

pub fn records(state: &DataDocState, ctx: &TableContext, input: &Value) -> ToolResult {
    let target = open(state, ctx, input)?;
    let limit = match int_field(input, "limit") {
        n if n <= 0 => 20,
        n => n.min(MAX_RECORD_READ),
    };
    let records = target
        .file
        .list_records_page(target.table.id, limit, 0)
        .map_err(|_| "failed to read table records".to_owned())?;
    let rows: Vec<Value> = records
        .iter()
        .map(|r| record_row(r, &target.table.fields))
        .collect();
    Ok(ToolOutput::new(
        format!(
            "Read {} rows from table `{}`.",
            rows.len(),
            target.table.title
        ),
        json!({
            "document_id": target.doc.id, "table_id": target.table.id,
            "fields": target.table.fields.iter().map(field_summary).collect::<Vec<_>>(),
            "records": rows,
        }),
    ))
}

/// Lowercase letters and digits only, for matching source keys to fields.
fn squash(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn infer_type(value: &Value, title: &str) -> String {
    match value {
        Value::Bool(_) => "checkbox".into(),
        Value::Number(_) => "number".into(),
        Value::Array(_) => "multi_select".into(),
        Value::String(text) => {
            let text = text.trim();
            if text.starts_with("http://") || text.starts_with("https://") {
                "url".into()
            } else if text.chars().count() > 160 {
                "long_text".into()
            } else {
                normalize_type("", title)
            }
        }
        _ => normalize_type("", title),
    }
}

fn humanize(key: &str) -> String {
    key.split(['_', '-', ' '])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map_or(String::new(), |c| c.to_uppercase().chain(chars).collect())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn looks_unique(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["url", "link", "slug", "uid", "uuid", "id", "source"]
        .iter()
        .any(|word| lower.contains(word))
}

pub fn record_draft(state: &DataDocState, ctx: &TableContext, input: &Value) -> ToolResult {
    let target = open(state, ctx, input)?;
    let limit = match int_field(input, "limit") {
        n if n <= 0 => 20,
        n => n.min(MAX_RECORD_READ),
    } as usize;
    let mut sources: Vec<Map<String, Value>> = ["source_records", "records"]
        .iter()
        .find_map(|key| {
            input
                .get(*key)
                .and_then(Value::as_array)
                .filter(|a| !a.is_empty())
        })
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .collect()
        })
        .unwrap_or_default();
    sources.truncate(limit);
    let base = json!({ "document_id": target.doc.id, "table_id": target.table.id, "source_kind": "provided_records" });
    if sources.is_empty() {
        let mut output = base;
        output["record_draft_count"] = json!(0);
        output["records"] = json!([]);
        output["ready_to_write"] = json!(false);
        return Ok(ToolOutput::new("No source records were provided.", output));
    }
    let fields = &target.table.fields;
    let by_key: HashMap<String, &Field> = fields
        .iter()
        .flat_map(|f| [(squash(display(f)), f), (squash(&f.name), f)])
        .filter(|(key, _)| !key.is_empty())
        .collect();
    let mut keys: Vec<String> = Vec::new();
    for record in &sources {
        for key in record.keys() {
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
    }
    let mut matched = Vec::new();
    let mut missing = Vec::new();
    let mut targets: Vec<(String, Field)> = Vec::new();
    for key in &keys {
        if let Some(field) = by_key.get(&squash(key)) {
            matched.push(json!({ "source_key": key, "field_title": display(field), "field_name": field.name, "field_type": field.field_type }));
            targets.push((key.clone(), (*field).clone()));
            continue;
        }
        let title = humanize(key);
        let sample = sources
            .iter()
            .find_map(|r| r.get(key).filter(|v| !is_blank(v)))
            .cloned()
            .unwrap_or(Value::Null);
        let field_type = infer_type(&sample, &title);
        missing.push(json!({ "source_key": key, "title": title, "name": internal_name(key), "type": field_type }));
        targets.push((
            key.clone(),
            Field {
                name: internal_name(key),
                title,
                field_type,
                ..Field::default()
            },
        ));
    }
    let drafts: Vec<Value> = sources
        .iter()
        .map(|record| {
            let row: Map<String, Value> = targets
                .iter()
                .filter_map(|(key, field)| {
                    let value = record.get(key).filter(|v| !is_blank(v))?;
                    let value = coerce(field, value);
                    (!value.is_null()).then(|| (display(field).to_owned(), value))
                })
                .collect();
            Value::Object(row)
        })
        .filter(|row| row.as_object().is_some_and(|r| !r.is_empty()))
        .collect();
    let unique_by: Vec<String> = targets
        .iter()
        .map(|(_, field)| display(field).to_owned())
        .filter(|title| looks_unique(title))
        .filter(|title| {
            let values: Vec<String> = drafts
                .iter()
                .filter_map(|d| d.get(title).map(plain))
                .collect();
            values.len() == drafts.len()
                && values.iter().collect::<HashSet<_>>().len() == values.len()
        })
        .take(1)
        .collect();
    let mut summary = vec![format!(
        "Drafted {} table-ready records for table `{}` from {} source records.",
        drafts.len(),
        target.table.title,
        sources.len()
    )];
    if !missing.is_empty() {
        let names: Vec<String> = missing
            .iter()
            .map(|m| format!("{} ({})", plain(&m["title"]), plain(&m["type"])))
            .collect();
        summary.push(format!(
            "Missing fields to add first: {}.",
            names.join(", ")
        ));
    }
    if !unique_by.is_empty() {
        summary.push(format!("Recommended unique_by: {}.", unique_by.join(", ")));
    }
    let mut output = base;
    let extra = json!({
        "candidate_count": sources.len(), "record_draft_count": drafts.len(), "records": drafts,
        "matched_fields": matched, "missing_fields": missing, "recommended_unique_by": unique_by,
        "ready_to_write": !drafts.is_empty(), "requires_new_fields": !missing.is_empty(),
        "draft_strategy": "deterministic_field_mapping",
    });
    if let (Some(output), Some(extra)) = (output.as_object_mut(), extra.as_object()) {
        output.extend(extra.clone());
    }
    Ok(ToolOutput::new(summary.join(" "), output))
}

pub fn add_fields(state: &DataDocState, ctx: &TableContext, input: &Value) -> ToolResult {
    let mut target = open(state, ctx, input)?;
    let existing = lookup(&target.table.fields);
    let mut specs = field_specs(input.get("fields"), &target.table.fields);
    if specs.is_empty() {
        return Err("missing fields".into());
    }
    specs.truncate(MAX_FIELD_WRITE);
    let mut created = Vec::new();
    let mut skipped = Vec::new();
    for spec in specs {
        if existing.contains_key(&spec.title.to_lowercase()) {
            skipped.push(spec.title);
            continue;
        }
        let field = target
            .file
            .create_field(target.table.id, &spec)
            .map_err(|error| format!("failed to add fields: {error}"))?;
        created.push(field_summary(&field));
    }
    Ok(ToolOutput::new(
        format!(
            "Added {} fields to table `{}` and skipped {} existing fields.",
            created.len(),
            target.table.title,
            skipped.len()
        ),
        json!({ "document_id": target.doc.id, "table_id": target.table.id, "created": created, "skipped": skipped }),
    ))
}

fn values_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(l), Some(r)) if !is_blank(l) && !is_blank(r) => {
            plain(l).trim().eq_ignore_ascii_case(plain(r).trim())
        }
        _ => false,
    }
}

pub fn add_records(state: &DataDocState, ctx: &TableContext, input: &Value) -> ToolResult {
    let mut target = open(state, ctx, input)?;
    let rows: Vec<Map<String, Value>> = input
        .get("records")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_object().cloned())
                .take(MAX_RECORD_WRITE)
                .collect()
        })
        .unwrap_or_default();
    if rows.is_empty() {
        return Err("missing records".into());
    }
    let fields = lookup(&target.table.fields);
    let mut unique_names: Vec<String> = match input.get("unique_by") {
        Some(Value::String(name)) => vec![name.clone()],
        _ => string_list(input, "unique_by"),
    };
    unique_names.dedup();
    let unique: Vec<Field> = unique_names
        .iter()
        .filter_map(|name| fields.get(&name.trim().to_lowercase()).cloned())
        .collect();
    let update_existing = input
        .get("update_existing")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut existing = if unique.is_empty() {
        Vec::new()
    } else {
        target
            .file
            .list_records(target.table.id)
            .map_err(|_| "failed to read table records".to_owned())?
    };
    let (mut created, mut updated, mut skipped) = (Vec::new(), Vec::new(), Vec::new());
    for row in rows {
        let values: Map<String, Value> = row
            .iter()
            .filter_map(|(key, value)| {
                let field = fields.get(&key.trim().to_lowercase())?;
                let value = coerce(field, value);
                (!value.is_null()).then(|| (field.name.clone(), value))
            })
            .collect();
        let matched = if unique.is_empty()
            || unique
                .iter()
                .any(|f| values.get(&f.name).is_none_or(is_blank))
        {
            None
        } else {
            existing.iter().position(|record| {
                unique
                    .iter()
                    .all(|f| values_equal(record.values.get(&f.name), values.get(&f.name)))
            })
        };
        if let Some(index) = matched {
            if !update_existing {
                skipped.push(existing[index].id);
                continue;
            }
            let previous = existing[index].values.clone();
            let record = target
                .file
                .update_record(target.table.id, existing[index].id, &values, None)
                .map_err(|error| format!("failed to add records: {error}"))?;
            state.publish_record_updated(&target.doc, &record, Some(previous));
            updated.push(record.id);
            existing[index] = record;
            continue;
        }
        if let Some(field) = target
            .table
            .fields
            .iter()
            .find(|f| f.required && values.get(&f.name).is_none_or(is_blank))
        {
            return Err(format!(
                "failed to add records: required field {} is empty",
                display(field)
            )
            .into());
        }
        let record = target
            .file
            .create_record(target.table.id, &values)
            .map_err(|error| format!("failed to add records: {error}"))?;
        state.publish_record_created(&target.doc, &record);
        created.push(record.id);
        if !unique.is_empty() {
            existing.push(record);
        }
    }
    Ok(ToolOutput::new(
        format!(
            "Wrote records to table `{}`: created {}, updated {}, skipped {}.",
            target.table.title,
            created.len(),
            updated.len(),
            skipped.len()
        ),
        json!({
            "document_id": target.doc.id, "table_id": target.table.id,
            "record_ids": created, "created_ids": created, "updated_ids": updated, "skipped_ids": skipped,
            "created": created.len(), "updated": updated.len(), "skipped": skipped.len(),
            "unique_by": unique.iter().map(|f| f.name.clone()).collect::<Vec<_>>(),
            "update_existing": update_existing,
        }),
    ))
}

/// The system prompt block for the table the user has open.
pub fn active_table_context(state: &DataDocState, ctx: &TableContext) -> String {
    if ctx.document_id == 0 || ctx.table_id == 0 {
        return String::new();
    }
    let Ok(target) = open(state, ctx, &json!({})) else {
        return String::new();
    };
    let fields = &target.table.fields;
    let mut lines = vec![
        "Current linked data table:".to_owned(),
        format!("- document_id: {}, title: {}", target.doc.id, target.doc.title),
        format!("- table_id: {}, table: {}", target.table.id, target.table.title),
        "- Available data-table tools: data_table_schema, data_table_records, data_table_record_draft, data_table_add_fields, data_table_add_records.".to_owned(),
        "- When the user asks to organize, scrape, collect, or save structured information into the table, read the schema first, draft table-ready records next, add fields if needed, and then append records.".to_owned(),
        "- Field keys may use either display names or internal names. When writing URLs, posts, articles, products, or other external data, prefer passing unique_by to data_table_add_records to avoid duplicates.".to_owned(),
        "- For articles, posts, products, news items, or other records with dedicated pages, write each record's own original URL. If the current table has no URL/link field, add a `url` field first instead of burying the source in notes.".to_owned(),
        "- If the user explicitly asks to write into the current table, the task is only complete after data_table_add_records succeeds. Do not stop at search, browsing, or field suggestions.".to_owned(),
        "- If writing is temporarily blocked, explain the exact blocker, such as missing stable sources, insufficient fields that cannot be auto-filled, or results that are not structured enough.".to_owned(),
        "- Current field details:".to_owned(),
    ];
    for field in fields {
        let mut flags = Vec::new();
        if field.is_primary {
            flags.push("primary");
        }
        if field.required {
            flags.push("required");
        }
        if field.unique {
            flags.push("unique");
        }
        let flags = if flags.is_empty() {
            String::new()
        } else {
            format!(" [{}]", flags.join(", "))
        };
        lines.push(format!(
            "  - {} (`{}`, {}){flags}",
            display(field),
            field.name,
            field.field_type
        ));
    }
    let unique: Vec<&str> = fields
        .iter()
        .filter(|f| f.unique || f.is_primary || looks_unique(&format!("{} {}", f.title, f.name)))
        .map(display)
        .collect();
    if !unique.is_empty() {
        lines.push(format!(
            "- Recommended priority fields for unique_by: {}",
            unique.join(", ")
        ));
    }
    if let Some(url) = fields.iter().find(|f| f.field_type == "url").or_else(|| {
        fields.iter().find(|f| {
            let text = format!("{} {}", f.title, f.name).to_lowercase();
            text.contains("url") || text.contains("link")
        })
    }) {
        lines.push(format!(
            "- Recommended field for original source URLs: {}",
            display(url)
        ));
    }
    if let Ok(records) = target.file.list_records_page(target.table.id, 3, 0)
        && !records.is_empty()
    {
        lines.push("- Sample rows from the current table:".into());
        for record in records {
            let row = record_row(&record, fields);
            lines.push(format!(
                "  - {}",
                truncate_chars(&row["values"].to_string(), 320)
            ));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(name: &str, field_type: &str) -> Field {
        Field {
            name: name.into(),
            title: name.into(),
            field_type: field_type.into(),
            ..Field::default()
        }
    }

    #[test]
    fn coerces_cells_by_type() {
        assert_eq!(coerce(&field("n", "number"), &json!("4.5")), json!(4.5));
        assert_eq!(coerce(&field("n", "number"), &json!("x")), Value::Null);
        assert_eq!(coerce(&field("c", "checkbox"), &json!("yes")), json!(true));
        assert_eq!(
            coerce(&field("m", "multi_select"), &json!("a, b,")),
            json!(["a", "b"])
        );
        assert_eq!(coerce(&field("r", "rating"), &json!(9)), json!(5.0));
        assert_eq!(coerce(&field("t", "text"), &json!(3)), json!("3"));
        assert_eq!(coerce(&field("f", "formula"), &json!(3)), Value::Null);
    }

    #[test]
    fn names_and_types_fields() {
        assert_eq!(internal_name("Tweet URL"), "tweet_url");
        assert_eq!(internal_name("2024 sales"), "f_2024_sales");
        assert_eq!(normalize_type("", "Source Link"), "url");
        assert_eq!(normalize_type("checkbox", "x"), "checkbox");
        assert_eq!(humanize("published_at"), "Published At");
        let specs = field_specs(
            Some(&json!([{ "title": "Name" }, { "title": "Name" }])),
            &[],
        );
        assert_eq!(
            specs.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["name", "name_2"]
        );
    }
}
