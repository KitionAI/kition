//! The data-document routes and `kition_table_api::handle` answer the same requests with the
//! same JSON: one sequence of requests runs over HTTP against a workspace document and through
//! `handle` against a byte copy of the same file, and every answer (or error) is compared.
//! Timestamps and random ids (row keys, generated option ids) are the only differences allowed;
//! they are normalized before comparing.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kition_core::events::EventBus;
use kition_datadoc::index::{self, NewDocument};
use kition_datadoc::{DataDocState, ImportStore, TableDocuments};
use kition_http::AuthConfig;
use kition_kdm::Origin;
use kition_kitable::{CreateOptions, FieldSpec, KitableFile, TableSpec};
use kition_store::Db;
use kition_table_api::DocRef;
use serde_json::{Map, Value, json};
use tower::ServiceExt;

fn ok<T, E: std::fmt::Display>(result: Result<T, E>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

/// What a request answered: its data, or its error's status and message.
#[derive(Debug, Clone, PartialEq)]
enum Outcome {
    Data(Value),
    Error(u16, String),
}

/// One request, as a route (`verb`, `path` under the document, `query`, `body`) and as a
/// `handle` call (`method`, with params made of `ids`, `query`, and `body`).
struct Req {
    verb: &'static str,
    path: String,
    method: &'static str,
    ids: Value,
    query: Value,
    body: Option<Value>,
    /// Sent as the `Kition-Session` window (`session:test`).
    session: bool,
}

fn req(verb: &'static str, path: impl Into<String>, method: &'static str, ids: Value) -> Req {
    Req {
        verb,
        path: path.into(),
        method,
        ids,
        query: json!({}),
        body: None,
        session: false,
    }
}

impl Req {
    fn query(mut self, query: Value) -> Self {
        self.query = query;
        self
    }

    fn body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    fn session(mut self) -> Self {
        self.session = true;
        self
    }

    fn params(&self) -> Value {
        let mut params = Map::new();
        for part in [Some(&self.ids), Some(&self.query), self.body.as_ref()]
            .into_iter()
            .flatten()
        {
            if let Value::Object(map) = part {
                params.extend(map.clone());
            }
        }
        Value::Object(params)
    }
}

struct Http {
    app: Router,
    document_id: i64,
}

impl Http {
    async fn send(&self, req: &Req) -> Outcome {
        let mut uri = format!("/data-documents/{}{}", self.document_id, req.path);
        if let Value::Object(query) = &req.query {
            let pairs: Vec<String> = query
                .iter()
                .map(|(key, value)| match value {
                    Value::String(text) => format!("{key}={text}"),
                    other => format!("{key}={other}"),
                })
                .collect();
            if !pairs.is_empty() {
                uri = format!("{uri}?{}", pairs.join("&"));
            }
        }
        let mut request = Request::builder().method(req.verb).uri(uri);
        if req.session {
            request = request.header("Kition-Session", "test");
        }
        let request = ok(request.header("content-type", "application/json").body(
            req.body
                .as_ref()
                .map_or_else(Body::empty, |body| Body::from(body.to_string())),
        ));
        let response = ok(self.app.clone().oneshot(request).await);
        let status = response.status();
        let csv = response
            .headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/csv"));
        let disposition = response
            .headers()
            .get(http::header::CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let bytes = ok(response.into_body().collect().await).to_bytes();
        if csv {
            // The route sends the export as a file; `handle` answers its name and content.
            let name = disposition
                .trim_start_matches("attachment; filename=\"")
                .trim_end_matches(".csv\"")
                .to_owned();
            let content = String::from_utf8_lossy(&bytes).into_owned();
            return Outcome::Data(json!({ "name": name, "content": content }));
        }
        let envelope: Value = ok(serde_json::from_slice(&bytes));
        if status == StatusCode::OK {
            Outcome::Data(envelope["data"].clone())
        } else {
            Outcome::Error(
                status.as_u16(),
                envelope["message"].as_str().unwrap_or_default().to_owned(),
            )
        }
    }
}

struct Api {
    file: KitableFile,
    doc: DocRef,
}

impl Api {
    fn send(&mut self, req: &Req) -> Outcome {
        // The routes act as the request's window, or as the runtime's default origin.
        let origin = if req.session {
            Origin::person("session:test")
        } else {
            Origin::system("unknown")
        };
        self.file.set_origin(origin);
        let answer = kition_table_api::handle(&mut self.file, &self.doc, req.method, &req.params());
        self.file.set_origin(Origin::system("unknown"));
        match answer {
            Ok(value) => Outcome::Data(value),
            Err(kition_table_api::ApiError::InvalidBody) => {
                // The runtime answers its localized generic message.
                let error = kition_core::AppError::localized_bad_request("common.bad_request");
                Outcome::Error(400, error.to_string())
            }
            Err(err) => Outcome::Error(err.status(), err.to_string()),
        }
    }
}

/// Timestamps become 0; a row key of the table becomes `row-<position>` (its file's own random
/// key), and any other UUID `uuid-<n>`, numbered by first appearance. Changed and deleted
/// records are sets (ordered by their random keys), so they are sorted after renaming.
fn normalize(value: &Value, names: &mut HashMap<String, String>) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    let value = match key.as_str() {
                        "created_at" | "updated_at" => json!(0),
                        "recordsUpserted" | "recordsDeleted" => {
                            let mut items = normalize(value, names);
                            if let Value::Array(items) = &mut items {
                                items.sort_by_key(Value::to_string);
                            }
                            items
                        }
                        _ => normalize(value, names),
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(|v| normalize(v, names)).collect()),
        Value::String(text) if is_uuid(text) => {
            let next = format!("uuid-{}", names.len());
            Value::String(names.entry(text.clone()).or_insert(next).clone())
        }
        other => other.clone(),
    }
}

fn is_uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

fn normalized(outcome: &Outcome, row_keys: &[String]) -> Outcome {
    let mut names: HashMap<String, String> = row_keys
        .iter()
        .enumerate()
        .map(|(index, key)| (key.clone(), format!("row-{index}")))
        .collect();
    match outcome {
        Outcome::Data(value) => Outcome::Data(normalize(value, &mut names)),
        error => error.clone(),
    }
}

struct Fixture {
    http: Http,
    api: Api,
    table_id: i64,
    title: String,
    _dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let dir = ok(tempfile::tempdir());
    let workspace_dir = dir.path().join("workspace");
    ok(std::fs::create_dir_all(&workspace_dir));
    let db = ok(Db::open_in_memory());
    let conn = ok(db.conn());
    ok(kition_store::seed::run(&conn));
    let user_id = ok(kition_store::users::find_local_user(&conn))
        .unwrap_or_else(|| panic!("seed::run did not leave a local user"))
        .id;

    let path = workspace_dir.join("Test.kitable");
    let mut file = ok(KitableFile::create(&path, &CreateOptions::default()));
    let table = ok(file.create_table(&TableSpec {
        name: "Items".into(),
        fields: vec![FieldSpec {
            name: "title".into(),
            title: "Title".into(),
            field_type: "text".into(),
            primary: true,
            required: true,
            ..Default::default()
        }],
        ..Default::default()
    }));
    file.close();
    let copy = dir.path().join("Copy.kitable");
    ok(std::fs::copy(&path, &copy));

    let doc = ok(index::insert(
        &conn,
        NewDocument {
            user_id,
            workspace_root: workspace_dir.to_string_lossy().into_owned(),
            path: "Test.kitable".into(),
            title: "Test".into(),
            description: String::new(),
            icon: String::new(),
            color: String::new(),
            meta: json!({ "storage": "kitable_file" })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        },
    ));
    drop(conn);
    let assets = ok(kition_workspace::AssetStore::new(&workspace_dir, None));
    let state = DataDocState {
        auth: AuthConfig {
            db: db.clone(),
            jwt_secret: "test".into(),
            disabled: true,
        },
        db,
        workspace_dir,
        assets,
        events: EventBus::default(),
        workflow_cleaner: None,
        ai_gate: Arc::new(|| false),
        imports: ImportStore::default(),
        ai: None,
        tables: TableDocuments::default(),
    };
    Fixture {
        http: Http {
            app: kition_datadoc::router(state),
            document_id: doc.id,
        },
        api: Api {
            file: ok(KitableFile::open(&copy)),
            doc: DocRef {
                document_id: doc.id,
                user_id: doc.user_id,
            },
        },
        table_id: table.id,
        title: "title".into(),
        _dir: dir,
    }
}

impl Fixture {
    /// Runs `req` both ways and asserts the answers agree; answers the route's.
    async fn same(&mut self, req: Req) -> Outcome {
        let http = self.http.send(&req).await;
        let api = self.api.send(&req);
        self.compare(&req, &http, &api).await;
        http
    }

    /// Like [`Fixture::same`], for a request that needs each side's own row keys (random per
    /// file): `make` builds it from the table's row keys in order.
    async fn same_with_keys(&mut self, make: impl Fn(&[String]) -> Req) -> Outcome {
        let http_keys = self.http_keys().await;
        let api_keys = self.api_keys();
        assert_eq!(http_keys.len(), api_keys.len());
        let (http_req, api_req) = (make(&http_keys), make(&api_keys));
        let http = self.http.send(&http_req).await;
        let api = self.api.send(&api_req);
        self.compare(&api_req, &http, &api).await;
        http
    }

    async fn compare(&self, req: &Req, http: &Outcome, api: &Outcome) {
        let http_keys = self.http_keys().await;
        let api_keys = self.api_keys();
        assert_eq!(
            normalized(http, &http_keys),
            normalized(api, &api_keys),
            "{} {} ({}) answered differently",
            req.verb,
            req.path,
            req.method
        );
    }

    fn api_keys(&self) -> Vec<String> {
        ok(self.api.file.list_records(self.table_id))
            .into_iter()
            .map(|record| record.row_key)
            .collect()
    }

    async fn http_keys(&self) -> Vec<String> {
        let list = req(
            "GET",
            format!("/tables/{}/records", self.table_id),
            "records.list",
            json!({}),
        );
        match self.http.send(&list).await {
            Outcome::Data(data) => data["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["row_key"].as_str().map(str::to_owned))
                .collect(),
            other => panic!("listing records failed: {other:?}"),
        }
    }
}

fn data(outcome: Outcome) -> Value {
    match outcome {
        Outcome::Data(value) => value,
        other => panic!("expected data, got {other:?}"),
    }
}

#[tokio::test]
async fn routes_and_handle_answer_the_same() {
    let mut f = fixture();
    let t = f.table_id;
    let title = f.title.clone();
    let ids = json!({ "tableId": t });
    let tables = format!("/tables/{t}");

    // Tables, fields, and views.
    f.same(req("GET", "/tables", "tables.list", json!({})))
        .await;
    let status = data(
        f.same(
            req("POST", format!("{tables}/fields"), "fields.create", ids.clone())
                .body(json!({ "title": "Status", "type": "single_select", "options": { "choices": ["Open", "Done"] } })),
        )
        .await,
    );
    let status_id = status["id"].as_i64().unwrap_or_default();
    let status_name = status["name"].as_str().unwrap_or_default().to_owned();
    let field_ids = json!({ "tableId": t, "fieldId": status_id });
    f.same(
        req(
            "PATCH",
            format!("{tables}/fields/{status_id}"),
            "fields.update",
            field_ids.clone(),
        )
        .body(json!({ "title": "State", "required": false })),
    )
    .await;
    let copy = data(
        f.same(req(
            "POST",
            format!("{tables}/fields/{status_id}/duplicate"),
            "fields.duplicate",
            field_ids.clone(),
        ))
        .await,
    );
    let copy_id = copy["id"].as_i64().unwrap_or_default();
    let link = data(
        f.same(
            req("POST", format!("{tables}/fields"), "fields.create", ids.clone())
                .body(json!({ "title": "Related", "type": "link_to_record", "options": { "target_table_id": t, "allow_multiple": true } })),
        )
        .await,
    );
    let link_id = link["id"].as_i64().unwrap_or_default();
    f.same(req(
        "GET",
        format!("{tables}/fields"),
        "fields.list",
        ids.clone(),
    ))
    .await;
    let view = data(
        f.same(
            req(
                "POST",
                format!("{tables}/views"),
                "views.create",
                ids.clone(),
            )
            .body(json!({ "title": "Board", "type": "grid" })),
        )
        .await,
    );
    let view_id = view["id"].as_i64().unwrap_or_default();
    let views = format!("{tables}/views/{view_id}");
    let view_ids = json!({ "tableId": t, "viewId": view_id });
    f.same(
        req("PATCH", views.clone(), "views.update", view_ids.clone())
            .body(json!({ "title": "Board 2" })),
    )
    .await;
    f.same(req(
        "GET",
        format!("{tables}/views"),
        "views.list",
        ids.clone(),
    ))
    .await;

    // Records, paging, history.
    for name in ["Alpha", "Beta", "Gamma"] {
        f.same(
            req(
                "POST",
                format!("{tables}/records"),
                "records.create",
                ids.clone(),
            )
            .body(json!({ "values": { &title: name, &status_name: "Open" } })),
        )
        .await;
    }
    f.same(
        req(
            "GET",
            format!("{tables}/records"),
            "records.list",
            ids.clone(),
        )
        .query(json!({ "limit": "2", "offset": "1" })),
    )
    .await;
    f.same(
        req(
            "PATCH",
            format!("{tables}/records/1"),
            "records.update",
            json!({ "tableId": t, "recordId": 1 }),
        )
        .body(json!({ "values": { &status_name: "Done" } })),
    )
    .await;
    f.same(req(
        "GET",
        format!("{tables}/records/1/history"),
        "records.history",
        json!({ "tableId": t, "recordId": 1 }),
    ))
    .await;

    // Links.
    let record_ids = json!({ "tableId": t, "recordId": 1 });
    f.same_with_keys(|keys| {
        req(
            "POST",
            format!("{tables}/records/1/links"),
            "links.replace",
            record_ids.clone(),
        )
        .body(json!({ "field_id": link_id, "target_row_keys": [keys[1], keys[2]] }))
    })
    .await;
    f.same(
        req(
            "GET",
            format!("{tables}/records/1/links"),
            "links.list",
            record_ids.clone(),
        )
        .query(json!({ "field_id": link_id })),
    )
    .await;
    f.same(
        req(
            "GET",
            format!("{tables}/fields/{link_id}/link-candidates"),
            "fields.linkCandidates",
            json!({ "tableId": t, "fieldId": link_id }),
        )
        .query(json!({ "q": "Ga", "limit": "5" })),
    )
    .await;
    f.same_with_keys(|keys| {
        req(
            "DELETE",
            format!("{tables}/records/1/links"),
            "links.delete",
            record_ids.clone(),
        )
        .body(json!({ "field_id": link_id, "target_row_keys": [keys[2]] }))
    })
    .await;

    // View configuration.
    f.same(
        req(
            "PUT",
            format!("{views}/filter-tree"),
            "views.putFilterTree",
            view_ids.clone(),
        )
        .body(json!({
            "tree": { "conjunction": "AND", "children": [
                { "condition": { "field_id": status_id, "operator": "is", "value": "Open" } },
                { "group": { "conjunction": "or", "children": [] } }
            ] }
        })),
    )
    .await;
    f.same(req(
        "GET",
        format!("{views}/filter-tree"),
        "views.getFilterTree",
        view_ids.clone(),
    ))
    .await;
    f.same(
        req(
            "PUT",
            format!("{views}/sorts"),
            "views.putSorts",
            view_ids.clone(),
        )
        .body(json!({ "items": [{ "field_id": status_id, "direction": "desc" }] })),
    )
    .await;
    f.same(req(
        "GET",
        format!("{views}/sorts"),
        "views.getSorts",
        view_ids.clone(),
    ))
    .await;
    f.same(
        req(
            "PUT",
            format!("{views}/groups"),
            "views.putGroups",
            view_ids.clone(),
        )
        .body(json!({ "items": [{ "field_id": copy_id, "direction": "asc" }] })),
    )
    .await;
    f.same(req(
        "GET",
        format!("{views}/groups"),
        "views.getGroups",
        view_ids.clone(),
    ))
    .await;
    f.same(
        req(
            "PATCH",
            format!("{views}/config"),
            "views.patchConfig",
            view_ids.clone(),
        )
        .body(json!({ "row_height": "tall", "frozen_column_count": 1, "search_query": " " })),
    )
    .await;
    f.same(
        req(
            "PATCH",
            format!("{views}/config"),
            "views.patchConfig",
            view_ids.clone(),
        )
        .body(json!({ "frozen_column_count": -1 })),
    )
    .await;
    f.same(req(
        "GET",
        format!("{views}/view-fields"),
        "views.listFields",
        view_ids.clone(),
    ))
    .await;
    f.same(
        req(
            "PATCH",
            format!("{views}/view-fields/{status_id}"),
            "views.patchField",
            json!({ "tableId": t, "viewId": view_id, "fieldId": status_id }),
        )
        .body(json!({ "width": 240, "visible": false })),
    )
    .await;

    // The write path: transact, undo, redo, history state.
    f.same_with_keys(|keys| {
        req("POST", "/transact", "transact", json!({}))
            .session()
            .body(json!({ "ops": [
                { "op": "cells.set", "tableId": t, "records": [{ "rowKey": keys[0], "values": { &title: "Alpha 2" } }] },
                { "op": "records.create", "tableId": t, "at": null, "records": [{}] },
            ] }))
    })
    .await;
    f.same(
        req("POST", "/transact", "transact", json!({}))
            .session()
            .body(json!({ "ops": [] })),
    )
    .await;
    f.same(req("POST", "/undo", "undo", json!({})).session())
        .await;
    f.same(req("POST", "/redo", "redo", json!({})).session())
        .await;
    f.same(req("GET", "/history-state", "historyState", json!({})))
        .await;

    // Bulk operations, CSV and Markdown.
    f.same_with_keys(|keys| {
        req(
            "POST",
            format!("{tables}/records/bulk-copy"),
            "records.bulkCopy",
            ids.clone(),
        )
        .body(json!({ "row_keys": [keys[0]], "target_position": 1 }))
    })
    .await;
    f.same_with_keys(|keys| {
        req(
            "POST",
            format!("{tables}/records/bulk-delete"),
            "records.bulkDelete",
            ids.clone(),
        )
        .body(json!({ "row_keys": [keys[1], "missing"] }))
    })
    .await;
    f.same(
        req(
            "POST",
            format!("{tables}/import/csv"),
            "csv.import",
            ids.clone(),
        )
        .body(json!({ "content": "Title,State\nDelta,Done\n\"Eps, ilon\",Open\n" })),
    )
    .await;
    f.same(
        req(
            "POST",
            format!("{tables}/import/csv"),
            "csv.import",
            ids.clone(),
        )
        .body(json!({ "content": "a,b\n1\n" })),
    )
    .await;
    f.same(req(
        "GET",
        format!("{tables}/export/csv"),
        "csv.export",
        ids.clone(),
    ))
    .await;
    f.same(req(
        "GET",
        format!("{tables}/export/markdown"),
        "markdown.export",
        ids.clone(),
    ))
    .await;

    // Dashboards.
    let dashboard = json!({ "dashboardId": "d1" });
    f.same(
        req("PUT", "/dashboards/d1", "dashboards.upsert", dashboard.clone())
            .session()
            .body(json!({ "title": "Overview", "order": 1, "source_table_id": t, "layout": [], "widgets": [{ "id": "w1", "type": "metric" }] })),
    )
    .await;
    f.same(req("GET", "/dashboards", "dashboards.list", json!({})))
        .await;
    f.same(req("DELETE", "/dashboards/d1", "dashboards.delete", dashboard).session())
        .await;

    // Errors.
    f.same(
        req(
            "PATCH",
            format!("{tables}/records/999"),
            "records.update",
            json!({ "tableId": t, "recordId": 999 }),
        )
        .body(json!({ "values": {} })),
    )
    .await;
    f.same(req(
        "GET",
        "/tables/0/fields",
        "fields.list",
        json!({ "tableId": 0 }),
    ))
    .await;
    f.same(req(
        "GET",
        "/tables/999/views",
        "views.list",
        json!({ "tableId": 999 }),
    ))
    .await;
    f.same(req(
        "GET",
        format!("{tables}/records/1/links"),
        "links.list",
        record_ids.clone(),
    ))
    .await;
    f.same(
        req(
            "POST",
            format!("{tables}/records/1/links"),
            "links.replace",
            record_ids.clone(),
        )
        .body(json!({ "target_row_keys": [] })),
    )
    .await;
    f.same(req(
        "DELETE",
        format!("{tables}/views/999"),
        "views.delete",
        json!({ "tableId": t, "viewId": 999 }),
    ))
    .await;

    // Deletes, then a new table.
    f.same(req(
        "DELETE",
        format!("{tables}/records/2"),
        "records.delete",
        json!({ "tableId": t, "recordId": 2 }),
    ))
    .await;
    f.same(req(
        "DELETE",
        views.clone(),
        "views.delete",
        view_ids.clone(),
    ))
    .await;
    f.same(req(
        "DELETE",
        format!("{tables}/fields/{copy_id}"),
        "fields.delete",
        json!({ "tableId": t, "fieldId": copy_id }),
    ))
    .await;
    let created = data(
        f.same(
            req("POST", "/tables", "tables.create", json!({}))
                .body(json!({ "title": "Second", "fields": [{ "title": "Name", "type": "text", "primary": true }], "views": [{ "title": "All", "type": "grid" }] })),
        )
        .await,
    );
    let second = created["id"].as_i64().unwrap_or_default();
    f.same(
        req(
            "PATCH",
            format!("/tables/{second}"),
            "tables.update",
            json!({ "tableId": second }),
        )
        .body(json!({ "title": "Second table", "description": "More" })),
    )
    .await;
    f.same(req(
        "DELETE",
        format!("/tables/{second}"),
        "tables.delete",
        json!({ "tableId": second }),
    ))
    .await;
    f.same(req("GET", "/tables", "tables.list", json!({})))
        .await;
}

#[test]
fn unknown_methods_and_bad_params_are_refused() {
    let dir = ok(tempfile::tempdir());
    let mut file = ok(KitableFile::create(
        &dir.path().join("A.kitable"),
        &CreateOptions::default(),
    ));
    let doc = DocRef::default();
    let unknown = kition_table_api::handle(&mut file, &doc, "records.nope", &Value::Null);
    assert_eq!(
        unknown.as_ref().map_err(kition_table_api::ApiError::status),
        Err(404)
    );
    let bad = kition_table_api::handle(&mut file, &doc, "tables.list", &json!([1]));
    assert_eq!(bad, Err(kition_table_api::ApiError::InvalidBody));
    let methods: Vec<&str> = kition_table_api::METHODS
        .iter()
        .map(|(name, _)| *name)
        .collect();
    for method in methods {
        let answer = kition_table_api::handle(&mut file, &doc, method, &json!({}));
        assert!(
            !matches!(answer, Err(kition_table_api::ApiError::UnknownMethod(_))),
            "{method} is listed but not handled"
        );
    }
}
