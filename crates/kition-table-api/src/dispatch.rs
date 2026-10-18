//! [`handle`]: one entry point for every request, by method name.

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::coerce::{list_window, parse_id};
use crate::{
    ApiError, ApiResult, DocRef, KitableFile, dashboards, records, respond, tables, transact,
    view_config,
};

/// Every method [`handle`] answers, with the runtime route it mirrors (relative to
/// `/v1/data-documents/{documentId}`).
pub const METHODS: &[(&str, &str)] = &[
    ("tables.list", "GET /tables"),
    ("tables.create", "POST /tables"),
    ("tables.update", "PATCH /tables/{tableId}"),
    ("tables.delete", "DELETE /tables/{tableId}"),
    ("fields.list", "GET /tables/{tableId}/fields"),
    ("fields.create", "POST /tables/{tableId}/fields"),
    ("fields.update", "PATCH /tables/{tableId}/fields/{fieldId}"),
    ("fields.delete", "DELETE /tables/{tableId}/fields/{fieldId}"),
    (
        "fields.duplicate",
        "POST /tables/{tableId}/fields/{fieldId}/duplicate",
    ),
    (
        "fields.linkCandidates",
        "GET /tables/{tableId}/fields/{fieldId}/link-candidates",
    ),
    ("views.list", "GET /tables/{tableId}/views"),
    ("views.create", "POST /tables/{tableId}/views"),
    ("views.update", "PATCH /tables/{tableId}/views/{viewId}"),
    ("views.delete", "DELETE /tables/{tableId}/views/{viewId}"),
    (
        "views.getFilterTree",
        "GET /tables/{tableId}/views/{viewId}/filter-tree",
    ),
    (
        "views.putFilterTree",
        "PUT /tables/{tableId}/views/{viewId}/filter-tree",
    ),
    (
        "views.getSorts",
        "GET /tables/{tableId}/views/{viewId}/sorts",
    ),
    (
        "views.putSorts",
        "PUT /tables/{tableId}/views/{viewId}/sorts",
    ),
    (
        "views.getGroups",
        "GET /tables/{tableId}/views/{viewId}/groups",
    ),
    (
        "views.putGroups",
        "PUT /tables/{tableId}/views/{viewId}/groups",
    ),
    (
        "views.patchConfig",
        "PATCH /tables/{tableId}/views/{viewId}/config",
    ),
    (
        "views.listFields",
        "GET /tables/{tableId}/views/{viewId}/view-fields",
    ),
    (
        "views.patchField",
        "PATCH /tables/{tableId}/views/{viewId}/view-fields/{fieldId}",
    ),
    ("records.list", "GET /tables/{tableId}/records"),
    ("records.create", "POST /tables/{tableId}/records"),
    (
        "records.update",
        "PATCH /tables/{tableId}/records/{recordId}",
    ),
    (
        "records.delete",
        "DELETE /tables/{tableId}/records/{recordId}",
    ),
    (
        "records.history",
        "GET /tables/{tableId}/records/{recordId}/history",
    ),
    (
        "records.bulkDelete",
        "POST /tables/{tableId}/records/bulk-delete",
    ),
    (
        "records.bulkCopy",
        "POST /tables/{tableId}/records/bulk-copy",
    ),
    (
        "links.list",
        "GET /tables/{tableId}/records/{recordId}/links",
    ),
    (
        "links.replace",
        "POST /tables/{tableId}/records/{recordId}/links",
    ),
    (
        "links.delete",
        "DELETE /tables/{tableId}/records/{recordId}/links",
    ),
    ("csv.import", "POST /tables/{tableId}/import/csv"),
    ("csv.export", "GET /tables/{tableId}/export/csv"),
    ("markdown.export", "GET /tables/{tableId}/export/markdown"),
    ("transact", "POST /transact"),
    ("undo", "POST /undo"),
    ("redo", "POST /redo"),
    ("historyState", "GET /history-state"),
    ("dashboards.list", "GET /dashboards"),
    ("dashboards.upsert", "PUT /dashboards/{dashboardId}"),
    ("dashboards.delete", "DELETE /dashboards/{dashboardId}"),
];

/// Answers one request against `file`, as the runtime route named in [`METHODS`] answers it
/// (the `data` of its response envelope). `params` is an object (or `null`): the route's path
/// ids (`tableId`, `fieldId`, `viewId`, `recordId`, `dashboardId`; numbers or decimal strings),
/// its query values (`limit`, `offset`, `field_id`, `q`), and its body's fields.
///
/// `csv.export` answers `{ "name", "content" }`, what the route sends as a file download.
/// Writes act as the file's current origin ([`KitableFile::set_origin`]).
pub fn handle(
    file: &mut KitableFile,
    doc: &DocRef,
    method: &str,
    params: &Value,
) -> ApiResult<Value> {
    let empty = Map::new();
    let params = match params {
        Value::Object(map) => map,
        Value::Null => &empty,
        _ => return Err(ApiError::InvalidBody),
    };
    let p = Params(params);
    match method {
        "tables.list" => tables::list_tables(file, doc),
        "tables.create" => tables::create_table(file, doc, &p.body()?),
        "tables.update" => {
            let table_id = p.id("tableId")?;
            tables::update_table(file, doc, table_id, params)
        }
        "tables.delete" => tables::delete_table(file, p.id("tableId")?),
        "fields.list" => tables::list_fields(file, doc, p.id("tableId")?),
        "fields.create" => {
            let table_id = p.id("tableId")?;
            tables::create_field(file, doc, table_id, p.body()?)
        }
        "fields.update" => {
            let (table_id, field_id) = (p.id("tableId")?, p.id("fieldId")?);
            tables::update_field(file, doc, table_id, field_id, params)
        }
        "fields.delete" => tables::delete_field(file, p.id("tableId")?, p.id("fieldId")?),
        "fields.duplicate" => {
            let (table_id, field_id) = (p.id("tableId")?, p.id("fieldId")?);
            tables::duplicate_field(file, doc, table_id, field_id)
        }
        "fields.linkCandidates" => {
            let field_id = p.id("fieldId")?;
            let limit = records::candidate_limit(p.text("limit").as_deref());
            let query = p.text("q").unwrap_or_default();
            records::link_candidates(file, field_id, &query, limit)
        }
        "views.list" => tables::list_views(file, doc, p.id("tableId")?),
        "views.create" => {
            let table_id = p.id("tableId")?;
            tables::create_view(file, doc, table_id, p.body()?)
        }
        "views.update" => {
            let (table_id, view_id) = (p.id("tableId")?, p.id("viewId")?);
            tables::update_view(file, doc, table_id, view_id, params)
        }
        "views.delete" => tables::delete_view(file, p.id("tableId")?, p.id("viewId")?),
        "views.getFilterTree" => view_config::get_filter_tree(file, p.view()?),
        "views.putFilterTree" => {
            let request = p.body()?;
            view_config::put_filter_tree(file, p.view()?, request)
        }
        "views.getSorts" => view_config::get_sorts(file, p.view()?),
        "views.putSorts" => {
            let request = p.body()?;
            view_config::put_sorts(file, p.view()?, request)
        }
        "views.getGroups" => view_config::get_groups(file, p.view()?),
        "views.putGroups" => {
            let request = p.body()?;
            view_config::put_groups(file, p.view()?, request)
        }
        "views.patchConfig" => {
            let request = p.body()?;
            let (table_id, view_id) = (p.id("tableId")?, p.id("viewId")?);
            view_config::patch_config(file, table_id, view_id, request)
        }
        "views.listFields" => view_config::list_view_fields(file, p.view()?),
        "views.patchField" => {
            let request = p.body()?;
            let view_id = p.view()?;
            view_config::patch_view_field(file, view_id, p.id("fieldId")?, request)
        }
        "records.list" => {
            let (limit, offset) = p.window();
            records::list(file, doc, p.id("tableId")?, limit, offset)
        }
        "records.create" => {
            let request = p.body()?;
            let record = records::create(file, p.id("tableId")?, request)?;
            Ok(respond::record(doc, &record))
        }
        "records.update" => {
            let request = p.body()?;
            let (table_id, record_id) = (p.id("tableId")?, p.id("recordId")?);
            let (record, _) = records::update(file, table_id, record_id, request)?;
            Ok(respond::record(doc, &record))
        }
        "records.delete" => records::delete(file, p.id("tableId")?, p.id("recordId")?),
        "records.history" => {
            let (table_id, record_id) = (p.id("tableId")?, p.id("recordId")?);
            let (limit, offset) = p.window();
            records::history(file, table_id, record_id, limit, offset)
        }
        "records.bulkDelete" => {
            let request = p.body()?;
            view_config::bulk_delete(file, p.id("tableId")?, request)
        }
        "records.bulkCopy" => {
            let request = p.body()?;
            view_config::bulk_copy(file, p.id("tableId")?, request)
        }
        "links.list" => {
            let (table_id, record_id) = (p.id("tableId")?, p.id("recordId")?);
            let field_id = records::link_field_id(p.text("field_id").as_deref())?;
            records::list_links(file, table_id, record_id, field_id)
        }
        "links.replace" | "links.delete" => {
            let (table_id, record_id) = (p.id("tableId")?, p.id("recordId")?);
            let request = p
                .body::<records::LinkRequest>()
                .map_err(|_| ApiError::bad_request("Invalid request body"))?
                .check()?;
            if method == "links.replace" {
                records::replace_links(file, table_id, record_id, request)
            } else {
                records::delete_links(file, table_id, record_id, request)
            }
        }
        "csv.import" => {
            let request: records::CsvRequest = p.body()?;
            let rows = records::parse_csv(&request.content.unwrap_or_default())?;
            records::import_csv(file, p.id("tableId")?, &rows)
        }
        "csv.export" => {
            let (name, content) = records::export_csv(file, p.id("tableId")?)?;
            Ok(serde_json::json!({ "name": name, "content": content }))
        }
        "markdown.export" => records::export_markdown(file, p.id("tableId")?),
        "transact" => {
            let request = p.body::<transact::TransactRequest>()?.check()?;
            Ok(transact::transact(file, doc, &request)?.0)
        }
        "undo" => Ok(transact::undo_or_redo(file, doc, false)?.0),
        "redo" => Ok(transact::undo_or_redo(file, doc, true)?.0),
        "historyState" => Ok(transact::history_state(file)),
        "dashboards.list" => dashboards::list(file),
        "dashboards.upsert" => dashboards::upsert(file, &p.key("dashboardId"), params),
        "dashboards.delete" => dashboards::delete(file, &p.key("dashboardId")),
        other => Err(ApiError::UnknownMethod(other.to_owned())),
    }
}

struct Params<'a>(&'a Map<String, Value>);

impl Params<'_> {
    /// A string, or a number in decimal.
    fn text(&self, key: &str) -> Option<String> {
        match self.0.get(key)? {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        }
    }

    fn key(&self, key: &str) -> String {
        self.text(key).unwrap_or_default()
    }

    fn id(&self, key: &str) -> ApiResult<i64> {
        parse_id(&self.key(key))
    }

    fn view(&self) -> ApiResult<i64> {
        self.id("tableId")?;
        self.id("viewId")
    }

    fn window(&self) -> (i64, i64) {
        list_window(
            self.text("limit").as_deref(),
            self.text("offset").as_deref(),
        )
    }

    fn body<T: DeserializeOwned>(&self) -> ApiResult<T> {
        serde_json::from_value(Value::Object(self.0.clone())).map_err(|_| ApiError::InvalidBody)
    }
}
