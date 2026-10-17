//! A `.kitable` file's KDM replica over HTTP, as co-editing relays it: `replica/version`,
//! `replica/export`, `replica/import`, and the `table/changed` and `table/replica-changed`
//! events, against two real copies of one document (no stubs).

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use base64::Engine as _;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kition_core::events::{DomainEvent, EventBus};
use kition_datadoc::index::{self, NewDocument};
use kition_datadoc::{DataDocState, ImportStore, TableDocuments};
use kition_http::AuthConfig;
use kition_kitable::{CreateOptions, FieldSpec, KitableFile, TableSpec};
use kition_store::Db;
use serde_json::{Value, json};
use tokio::sync::broadcast::Receiver;
use tower::ServiceExt;

const HERE: &str = "Here.kitable";
const THERE: &str = "There.kitable";
const SESSION: &str = "Kition-Session";

struct Fixture {
    app: Router,
    state: DataDocState,
    /// Data document ids of `HERE` and `THERE`.
    here_id: String,
    there_id: String,
    table_id: i64,
    _dir: tempfile::TempDir,
}

/// `Here.kitable` with a table "Items" (title) and its copy `There.kitable`: one document in
/// two files, both indexed, with replica-changed events published.
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

    let here = workspace_dir.join(HERE);
    let mut file =
        KitableFile::create(&here, &CreateOptions::default()).unwrap_or_else(|err| panic!("{err}"));
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
    std::fs::copy(&here, workspace_dir.join(THERE)).unwrap_or_else(|err| panic!("{err}"));

    let mut ids = Vec::new();
    for path in [HERE, THERE] {
        let doc = index::insert(
            &conn,
            NewDocument {
                user_id,
                workspace_root: workspace_dir.to_string_lossy().into_owned(),
                path: path.into(),
                title: path.trim_end_matches(".kitable").into(),
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
        ids.push(doc.id.to_string());
    }
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
    state.publish_replica_changes();
    let app = kition_datadoc::router(state.clone());
    Fixture {
        app,
        state,
        there_id: ids.pop().unwrap_or_default(),
        here_id: ids.pop().unwrap_or_default(),
        table_id: table.id,
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

/// `data` of a 200 answer to `POST /data-documents/replica/<action>`.
async fn replica(app: &Router, action: &str, body: Value) -> Value {
    let (status, response) = call(
        app,
        "POST",
        &format!("/data-documents/replica/{action}"),
        &[],
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{action}: {response}");
    response["data"].clone()
}

/// Validates `instance` against one self-contained `$defs` entry of
/// `contracts/runtime/data-documents-replica.schema.json`.
fn check_contract(def: &str, instance: &Value) {
    let mut schema: Value = serde_json::from_str(include_str!(
        "../../../contracts/runtime/data-documents-replica.schema.json"
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

/// Exports from `from` what `to` lacks and imports it into `to`, as the relay does; answers the
/// import's `data`.
async fn send(app: &Router, from: &str, to: &str) -> Value {
    let target = replica(app, "version", json!({ "path": to })).await;
    let exported = replica(
        app,
        "export",
        json!({ "path": from, "since": target["version"] }),
    )
    .await;
    replica(
        app,
        "import",
        json!({ "path": to, "changes": exported["changes"] }),
    )
    .await
}

async fn create_record(f: &Fixture, document_id: &str, session: &str, title: &str) -> String {
    let (status, body) = call(
        &f.app,
        "POST",
        &format!("/data-documents/{document_id}/transact"),
        &[(SESSION, session)],
        Some(json!({
            "ops": [{
                "op": "records.create",
                "tableId": f.table_id,
                "at": null,
                "records": [{ "title": title }],
            }],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["data"]["created"][0]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

async fn set_title(f: &Fixture, document_id: &str, session: &str, row_key: &str, title: &str) {
    let (status, body) = call(
        &f.app,
        "POST",
        &format!("/data-documents/{document_id}/transact"),
        &[(SESSION, session)],
        Some(json!({
            "ops": [{
                "op": "cells.set",
                "tableId": f.table_id,
                "records": [{ "rowKey": row_key, "values": { "title": title } }],
            }],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// Every record's row key and title in the document's file, sorted.
async fn titles(f: &Fixture, path: &str) -> Vec<(String, Value)> {
    let tables = f.state.tables.clone();
    let absolute = f.state.workspace_dir.join(path);
    let table_id = f.table_id;
    tokio::task::spawn_blocking(move || {
        let (file, _) = tables
            .open(&absolute, kition_kdm::Origin::system("test"))
            .unwrap_or_else(|err| panic!("{err}"));
        let mut rows: Vec<(String, Value)> = file
            .list_records(table_id)
            .unwrap_or_else(|err| panic!("{err}"))
            .into_iter()
            .map(|record| {
                let title = record.values.get("title").cloned().unwrap_or(Value::Null);
                (record.row_key, title)
            })
            .collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        rows
    })
    .await
    .unwrap_or_else(|err| panic!("{err}"))
}

/// Every event published until none arrives for a moment.
async fn drain(events: &mut Receiver<DomainEvent>) -> Vec<DomainEvent> {
    let mut seen = Vec::new();
    while let Ok(Ok(event)) = tokio::time::timeout(Duration::from_millis(200), events.recv()).await
    {
        seen.push(event);
    }
    seen
}

fn table_changed(events: &[DomainEvent]) -> Vec<&Value> {
    events
        .iter()
        .filter_map(|event| match event {
            DomainEvent::TableChanged(payload) => Some(payload),
            _ => None,
        })
        .collect()
}

fn replica_changed(events: &[DomainEvent]) -> Vec<&Value> {
    events
        .iter()
        .filter_map(|event| match event {
            DomainEvent::TableReplicaChanged(payload) => Some(payload),
            _ => None,
        })
        .collect()
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[tokio::test]
async fn version_names_the_document_and_its_replica() {
    let f = fixture();
    let here = replica(&f.app, "version", json!({ "path": HERE })).await;
    check_contract("versionResponse", &here);
    assert_eq!(here["documentId"], f.here_id);
    assert_eq!(here["documentPath"], HERE);
    let there = replica(&f.app, "version", json!({ "path": THERE })).await;
    assert_eq!(there["documentId"], f.there_id);
    assert_eq!(
        here["docId"], there["docId"],
        "a copy is the same KDM document"
    );
    assert_eq!(here["version"], there["version"]);

    let exported = replica(&f.app, "export", json!({ "path": HERE })).await;
    check_contract("exportResponse", &exported);
    assert!(
        !exported["changes"].as_str().unwrap_or_default().is_empty(),
        "an export from nothing holds the whole history"
    );
}

#[tokio::test]
async fn two_files_exchanging_changes_converge() {
    let f = fixture();
    let ours = create_record(&f, &f.here_id, "here", "From here").await;
    let theirs = create_record(&f, &f.there_id, "there", "From there").await;

    let into_there = send(&f.app, HERE, THERE).await;
    assert_eq!(into_there["change"]["origin"], "import:sync");
    assert_eq!(into_there["change"]["documentId"], f.there_id);
    send(&f.app, THERE, HERE).await;

    let here = titles(&f, HERE).await;
    assert_eq!(here, titles(&f, THERE).await);
    assert!(here.contains(&(ours, json!("From here"))), "{here:?}");
    assert!(here.contains(&(theirs, json!("From there"))), "{here:?}");
    let here_version = replica(&f.app, "version", json!({ "path": HERE })).await;
    let there_version = replica(&f.app, "version", json!({ "path": THERE })).await;
    assert_eq!(here_version["version"], there_version["version"]);
}

#[tokio::test]
async fn an_import_publishes_table_changed_and_no_replica_change() {
    let f = fixture();
    let row = create_record(&f, &f.here_id, "here", "From here").await;
    let mut events = f.state.events.subscribe();

    let imported = send(&f.app, HERE, THERE).await;
    let seen = drain(&mut events).await;
    let changed = table_changed(&seen);
    assert_eq!(changed.len(), 1, "{seen:?}");
    let payload = changed[0];
    assert_eq!(payload["documentId"], f.there_id);
    assert_eq!(payload["documentPath"], THERE);
    assert_eq!(payload["origin"], "import:sync");
    assert_eq!(
        payload["recordsUpserted"],
        json!([[f.table_id, row]]),
        "{payload}"
    );
    assert_eq!(
        &imported["change"]["recordsUpserted"],
        &payload["recordsUpserted"]
    );
    assert!(
        replica_changed(&seen).is_empty(),
        "an import is not reported back to the relay: {seen:?}"
    );

    // The same changes again change nothing, and publish nothing.
    let again = send(&f.app, HERE, THERE).await;
    assert_eq!(again["change"]["recordsUpserted"], json!([]));
    assert!(table_changed(&drain(&mut events).await).is_empty());
}

#[tokio::test]
async fn a_local_transaction_publishes_the_new_replica_version() {
    let f = fixture();
    let mut events = f.state.events.subscribe();
    create_record(&f, &f.here_id, "here", "From here").await;

    let seen = drain(&mut events).await;
    let changed = replica_changed(&seen);
    assert_eq!(changed.len(), 1, "{seen:?}");
    let payload = changed[0];
    check_contract("replicaChanged", payload);
    assert_eq!(payload["documentPath"], HERE);
    let now = replica(&f.app, "version", json!({ "path": HERE })).await;
    assert_eq!(payload["version"], now["version"]);
    assert_eq!(payload["docId"], now["docId"]);

    // Reading the replica is no transaction.
    replica(&f.app, "export", json!({ "path": HERE })).await;
    assert!(replica_changed(&drain(&mut events).await).is_empty());
}

#[tokio::test]
async fn undo_after_an_import_undoes_only_the_own_last_edit() {
    let f = fixture();
    let row = create_record(&f, &f.here_id, "here", "Draft").await;
    send(&f.app, HERE, THERE).await;
    // A co-editor adds a record; the person here then retitles theirs.
    let other = create_record(&f, &f.there_id, "there", "Theirs").await;
    set_title(&f, &f.here_id, "here", &row, "Final").await;
    send(&f.app, THERE, HERE).await;

    let (status, body) = call(
        &f.app,
        "POST",
        &format!("/data-documents/{}/undo", f.here_id),
        &[(SESSION, "here")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["done"], true);
    let here = titles(&f, HERE).await;
    assert!(
        here.contains(&(row.clone(), json!("Draft"))),
        "the own retitle is undone: {here:?}"
    );
    assert!(
        here.contains(&(other.clone(), json!("Theirs"))),
        "the imported record stays: {here:?}"
    );

    // Undo again reverts the own first edit (the record), never the import.
    let (status, body) = call(
        &f.app,
        "POST",
        &format!("/data-documents/{}/undo", f.here_id),
        &[(SESSION, "here")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let here = titles(&f, HERE).await;
    assert!(here.iter().all(|(key, _)| *key != row), "{here:?}");
    assert!(here.contains(&(other, json!("Theirs"))), "{here:?}");
}

#[tokio::test]
async fn export_since_a_version_holds_only_newer_changes() {
    let f = fixture();
    let before = replica(&f.app, "version", json!({ "path": HERE })).await;
    let nothing = replica(
        &f.app,
        "export",
        json!({ "path": HERE, "since": before["version"] }),
    )
    .await;
    let all_before = replica(&f.app, "export", json!({ "path": HERE })).await;

    create_record(&f, &f.here_id, "here", "Newer").await;
    let newer = replica(
        &f.app,
        "export",
        json!({ "path": HERE, "since": before["version"] }),
    )
    .await;
    let all = replica(&f.app, "export", json!({ "path": HERE })).await;
    let len = |value: &Value| value["changes"].as_str().unwrap_or_default().len();
    assert!(len(&newer) > len(&nothing));
    assert!(len(&newer) < len(&all), "{} vs {}", len(&newer), len(&all));
    assert!(len(&all) > len(&all_before));

    // `There` is still at `before`: the newer changes alone bring it up to date.
    let imported = replica(
        &f.app,
        "import",
        json!({ "path": THERE, "changes": newer["changes"] }),
    )
    .await;
    assert_eq!(
        imported["change"]["recordsUpserted"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "{imported}"
    );
    assert_eq!(imported["version"], newer["version"]);
    assert_eq!(titles(&f, HERE).await, titles(&f, THERE).await);
}

#[tokio::test]
async fn bad_requests_are_refused() {
    let f = fixture();
    let (status, _) = call(
        &f.app,
        "POST",
        "/data-documents/replica/import",
        &[],
        Some(json!({ "path": THERE, "changes": "" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "empty changes");
    let (status, _) = call(
        &f.app,
        "POST",
        "/data-documents/replica/import",
        &[],
        Some(json!({ "path": THERE, "changes": base64(b"not a kdm export") })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "bytes that are no export");
    let (status, _) = call(
        &f.app,
        "POST",
        "/data-documents/replica/export",
        &[],
        Some(json!({ "path": HERE, "since": "not base64!" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "since that is no base64");
    let (status, _) = call(
        &f.app,
        "POST",
        "/data-documents/replica/version",
        &[],
        Some(json!({ "path": "Missing.kitable" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "no such file");
}
