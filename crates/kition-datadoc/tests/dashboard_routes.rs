//! Dashboards over HTTP: the route round trip, the `table/changed` event, the workspace-DB
//! `meta.dashboards` migration, and that copying a `.kitable` file keeps its dashboards now
//! that they live in it instead of beside it.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kition_core::events::{DomainEvent, EventBus};
use kition_datadoc::index::{self, NewDocument};
use kition_datadoc::{DataDocState, ImportStore, TableDocuments};
use kition_http::AuthConfig;
use kition_kitable::{CreateOptions, FieldSpec, KitableFile, TableSpec};
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

const SESSION: &str = "Kition-Session";

struct Fixture {
    app: Router,
    state: DataDocState,
    document_id: String,
    table_id: i64,
    user_id: i64,
    path: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let workspace_dir = dir.path().to_path_buf();
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
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
            meta: json!({ "storage": "kitable_file" })
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
    let app = kition_datadoc::router(state.clone());
    Fixture {
        app,
        state,
        document_id: doc.id.to_string(),
        table_id: table.id,
        user_id,
        path: absolute,
        _dir: dir,
    }
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let request = request
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .unwrap_or_else(|err| panic!("{err}"));
    let response = app
        .clone()
        .oneshot(request)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap_or_else(|err| panic!("{err}"))
        .to_bytes();
    let value: Value =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({ "raw": bytes.len() }));
    // Every response is `Envelope { code, message, data }`; callers want the data.
    let data = value.get("data").cloned().unwrap_or(value);
    (status, data)
}

fn dashboard_body(table_id: i64, title: &str) -> Value {
    json!({
        "title": title,
        "order": 0,
        "source_table_id": table_id,
        "layout": [{ "widget_id": "w1", "x": 0, "y": 0, "w": 2, "h": 2 }],
        "widgets": [{ "id": "w1", "title": "Count", "type": "metric", "query": { "aggregation": "count" } }],
    })
}

#[tokio::test]
async fn dashboard_route_round_trip() {
    let f = fixture();
    let dashboards_url = format!("/data-documents/{}/dashboards", f.document_id);

    let (status, listed) = call(&f.app, "GET", &dashboards_url, &[(SESSION, "abc")], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["items"], json!([]));
    assert_eq!(listed["total"], 0);

    let (status, created) = call(
        &f.app,
        "PUT",
        &format!("{dashboards_url}/d1"),
        &[(SESSION, "abc")],
        Some(dashboard_body(f.table_id, "Overview")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["id"], "d1");
    assert_eq!(created["title"], "Overview");
    assert_eq!(created["source_table_id"], f.table_id);
    assert_eq!(created["widgets"][0]["id"], "w1");

    let (status, listed) = call(&f.app, "GET", &dashboards_url, &[(SESSION, "abc")], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["total"], 1);
    assert_eq!(listed["items"][0]["id"], "d1");

    let (status, updated) = call(
        &f.app,
        "PUT",
        &format!("{dashboards_url}/d1"),
        &[(SESSION, "abc")],
        Some(dashboard_body(f.table_id, "Overview 2")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["id"], "d1", "the same id names the same dashboard");
    assert_eq!(updated["title"], "Overview 2");

    let (status, deleted) = call(
        &f.app,
        "DELETE",
        &format!("{dashboards_url}/d1"),
        &[(SESSION, "abc")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert_eq!(deleted["deleted"], true);

    let (status, listed) = call(&f.app, "GET", &dashboards_url, &[(SESSION, "abc")], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["total"], 0);
}

#[tokio::test]
async fn dashboard_writes_publish_table_changed() {
    let f = fixture();
    let mut events = f.state.events.subscribe();

    let (status, _) = call(
        &f.app,
        "PUT",
        &format!("/data-documents/{}/dashboards/d1", f.document_id),
        &[(SESSION, "abc")],
        Some(dashboard_body(f.table_id, "Overview")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
        .await
        .unwrap_or_else(|_| panic!("no table/changed event arrived"))
        .unwrap_or_else(|err| panic!("{err}"));
    let DomainEvent::TableChanged(payload) = event else {
        panic!("expected a TableChanged event");
    };
    assert_eq!(payload["documentId"], f.document_id);
    assert_eq!(payload["dashboards"], true);
    assert_eq!(payload["origin"], "person:session:abc");
}

#[tokio::test]
async fn opening_a_document_moves_legacy_meta_dashboards_into_the_file() {
    let f = fixture();
    {
        let conn = f.state.db.conn().unwrap_or_else(|err| panic!("{err}"));
        let mut doc = index::find(&conn, f.user_id, &f.document_id)
            .unwrap_or_else(|err| panic!("{err}"))
            .unwrap_or_else(|| panic!("fixture document is missing"));
        doc.meta = json!({
            "storage": "kitable_file",
            "dashboards": [{
                "id": "legacy-1",
                "title": "Legacy",
                "order": 0,
                "source_table_id": f.table_id,
                "layout": [],
                "widgets": [],
            }],
        });
        index::save(&conn, &mut doc).unwrap_or_else(|err| panic!("{err}"));
    }

    let (status, listed) = call(
        &f.app,
        "GET",
        &format!("/data-documents/{}/dashboards", f.document_id),
        &[(SESSION, "abc")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["total"], 1);
    assert_eq!(listed["items"][0]["id"], "legacy-1");
    assert_eq!(listed["items"][0]["title"], "Legacy");

    let conn = f.state.db.conn().unwrap_or_else(|err| panic!("{err}"));
    let reloaded = index::find(&conn, f.user_id, &f.document_id)
        .unwrap_or_else(|err| panic!("{err}"))
        .unwrap_or_else(|| panic!("fixture document is missing"));
    assert!(
        reloaded.meta.get("dashboards").is_none(),
        "the migrated dashboards are removed from the workspace-DB meta: {}",
        reloaded.meta
    );
}

#[tokio::test]
async fn copying_the_kitable_file_keeps_its_dashboards() {
    let f = fixture();
    let (status, _) = call(
        &f.app,
        "PUT",
        &format!("/data-documents/{}/dashboards/d1", f.document_id),
        &[(SESSION, "abc")],
        Some(dashboard_body(f.table_id, "Overview")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let copy_path = f.path.with_file_name("Copy.kitable");
    std::fs::copy(&f.path, &copy_path).unwrap_or_else(|err| panic!("{err}"));

    let copy = KitableFile::open(&copy_path).unwrap_or_else(|err| panic!("{err}"));
    let dashboards = copy.list_dashboards().unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(dashboards.len(), 1);
    assert_eq!(dashboards[0].id, "d1");
    assert_eq!(dashboards[0].name, "Overview");
}
