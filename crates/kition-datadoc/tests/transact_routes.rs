//! The Table on the KDM's write path over HTTP: `transact`, `undo`, `redo`, `history-state`,
//! and the external-change merge, against the real `KitableFile` replica (no stubs).

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kition_core::events::{DomainEvent, EventBus};
use kition_datadoc::index::{self, NewDocument};
use kition_datadoc::{DataDocState, ImportStore, TableDocuments};
use kition_http::AuthConfig;
use kition_kdm::Origin;
use kition_kitable::{CreateOptions, FieldSpec, KitableFile, TableSpec};
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Fixture {
    app: Router,
    state: DataDocState,
    document_id: String,
    table_id: i64,
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
    let value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({ "raw": bytes.len() }));
    (status, value)
}

/// Validates `instance` against one self-contained `$defs` entry of
/// `contracts/runtime/data-documents-transact.schema.json` (no cross-file `$ref`s, so no
/// retriever is needed).
fn check_contract(def: &str, instance: &Value) {
    let mut schema: Value = serde_json::from_str(include_str!(
        "../../../contracts/runtime/data-documents-transact.schema.json"
    ))
    .unwrap_or_else(|err| panic!("{err}"));
    schema["$ref"] = json!(format!("#/$defs/{def}"));
    let validator = jsonschema::validator_for(&schema).unwrap_or_else(|err| panic!("{err}"));
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|error| format!("{error} at {}", error.instance_path()))
        .collect();
    assert!(
        errors.is_empty(),
        "{def}: {}\n{instance}",
        errors.join("; ")
    );
}

const SESSION: &str = "Kition-Session";

#[tokio::test]
async fn transact_creates_a_record_and_returns_the_change() {
    let f = fixture();
    let (status, body) = call(
        &f.app,
        "POST",
        &format!("/data-documents/{}/transact", f.document_id),
        &[(SESSION, "abc-123")],
        Some(json!({
            "ops": [
                {
                    "op": "records.create",
                    "tableId": f.table_id,
                    "at": null,
                    "records": [{ "title": "Ada" }],
                },
            ],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    check_contract("transactResponse", data);
    assert_eq!(data["created"].as_array().map(Vec::len), Some(1), "{data}");
    let row_key = data["created"][0].as_str().unwrap_or_default().to_owned();
    let change = &data["change"];
    assert_eq!(change["documentId"], f.document_id);
    assert_eq!(change["origin"], "person:session:abc-123");
    assert_eq!(
        change["recordsUpserted"],
        json!([[f.table_id, row_key]]),
        "{change}"
    );
    assert_eq!(change["recordsDeleted"], json!([]));
    assert_eq!(change["dashboards"], false);
}

#[tokio::test]
async fn transact_rejects_an_empty_ops_list() {
    let f = fixture();
    let (status, _) = call(
        &f.app,
        "POST",
        &format!("/data-documents/{}/transact", f.document_id),
        &[(SESSION, "abc-123")],
        Some(json!({ "ops": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn undo_and_redo_round_trip_a_transact() {
    let f = fixture();
    let create = json!({
        "ops": [
            {
                "op": "records.create",
                "tableId": f.table_id,
                "at": null,
                "records": [{ "title": "Ada" }],
            },
        ],
    });
    let (status, _) = call(
        &f.app,
        "POST",
        &format!("/data-documents/{}/transact", f.document_id),
        &[(SESSION, "abc-123")],
        Some(create),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, history) = call(
        &f.app,
        "GET",
        &format!("/data-documents/{}/history-state", f.document_id),
        &[(SESSION, "abc-123")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    check_contract("historyStateResponse", &history["data"]);
    assert_eq!(history["data"]["canUndo"], true);
    assert_eq!(history["data"]["canRedo"], false);

    let (status, undone) = call(
        &f.app,
        "POST",
        &format!("/data-documents/{}/undo", f.document_id),
        &[(SESSION, "abc-123")],
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{undone}");
    check_contract("undoRedoResponse", &undone["data"]);
    assert_eq!(undone["data"]["done"], true);
    assert_eq!(
        undone["data"]["change"]["recordsDeleted"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "{undone}"
    );

    let (status, history) = call(
        &f.app,
        "GET",
        &format!("/data-documents/{}/history-state", f.document_id),
        &[(SESSION, "abc-123")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history["data"]["canUndo"], false);
    assert_eq!(history["data"]["canRedo"], true);

    let (status, redone) = call(
        &f.app,
        "POST",
        &format!("/data-documents/{}/redo", f.document_id),
        &[(SESSION, "abc-123")],
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{redone}");
    check_contract("undoRedoResponse", &redone["data"]);
    assert_eq!(redone["data"]["done"], true);
    assert_eq!(
        redone["data"]["change"]["recordsUpserted"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "{redone}"
    );
}

#[tokio::test]
async fn redo_with_nothing_to_redo_answers_done_false() {
    let f = fixture();
    let (status, body) = call(
        &f.app,
        "POST",
        &format!("/data-documents/{}/redo", f.document_id),
        &[(SESSION, "abc-123")],
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["done"], false);
}

#[tokio::test]
async fn an_external_edit_is_merged_and_published_as_table_changed() {
    let f = fixture();
    // Open the file through the manager once, so it caches a handle (and the identity it later
    // compares against).
    let (status, _) = call(
        &f.app,
        "GET",
        &format!("/data-documents/{}/history-state", f.document_id),
        &[(SESSION, "abc-123")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Someone else (another process, another copy) writes the same file directly, outside the
    // manager entirely.
    let mut outside = KitableFile::open(&f.path).unwrap_or_else(|err| panic!("{err}"));
    outside.set_origin(Origin::person("someone-else"));
    outside
        .transact(&[kition_kitable::TableOp::RecordsCreate {
            table_id: f.table_id,
            at: None,
            records: vec![
                json!({ "title": "From outside" })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            ],
        }])
        .unwrap_or_else(|err| panic!("{err}"));
    outside.close();

    let mut events = f.state.events.subscribe();

    // The next request through the manager must notice the file changed on disk and merge it.
    let (status, history) = call(
        &f.app,
        "GET",
        &format!("/data-documents/{}/history-state", f.document_id),
        &[(SESSION, "abc-123")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{history}");

    let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
        .await
        .unwrap_or_else(|_| panic!("no table/changed event arrived"))
        .unwrap_or_else(|err| panic!("{err}"));
    let DomainEvent::TableChanged(payload) = event else {
        panic!("expected a TableChanged event");
    };
    assert_eq!(payload["documentId"], f.document_id);
    assert_eq!(payload["documentPath"], "Test.kitable");
    assert_eq!(payload["origin"], "external");
    assert_eq!(
        payload["recordsUpserted"].as_array().map(Vec::len),
        Some(1),
        "{payload}"
    );
}
