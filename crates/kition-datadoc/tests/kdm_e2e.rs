//! End-to-end coverage for the last three Table-on-the-KDM behaviors of this phase, across the
//! route, manager, and event layers together (the real runtime is impractical to drive from
//! Playwright for the first two — they need no browser, only the HTTP API and the manager — so
//! they live here instead of in `e2e/`; the third complements `transact_routes.rs`'s in-place
//! external edit with an actual file replacement):
//!
//! - a workflow-created record reaches an already-open table live, not just on its next reload;
//! - an agent run's several writes collapse into one undo step;
//! - replacing the `.kitable` file on disk with an edited copy (a new inode at the same path, as
//!   a sync tool or another machine would leave it) is merged, not silently ignored or clobbered.

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kition_core::events::{DomainEvent, EventBus};
use kition_datadoc::index::{self, NewDocument};
use kition_datadoc::{DataDocState, ImportStore, TableDocuments};
use kition_http::AuthConfig;
use kition_kdm::Origin;
use kition_kitable::{CellEdit, CreateOptions, FieldSpec, KitableFile, TableOp, TableSpec};
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Fixture {
    app: Router,
    state: DataDocState,
    user_id: i64,
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
        ai_gate: std::sync::Arc::new(|| false),
        imports: ImportStore::default(),
        ai: None,
        tables: TableDocuments::default(),
    };
    let app = kition_datadoc::router(state.clone());
    Fixture {
        app,
        state,
        user_id,
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

const SESSION: &str = "Kition-Session";

fn row_titles(records: &Value) -> Vec<Value> {
    records["data"]["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| item["values"]["title"].clone())
        .collect()
}

/// A workflow writes through the manager (not through a window's own `transact`); the already
/// open table must see the new row at once, over the `table/changed` event the kit bridge
/// forwards, not only the next time it happens to reload.
#[tokio::test]
async fn workflow_created_record_appears_live_in_open_table() {
    let f = fixture();

    // Opens the table the way a window does, so the manager caches a handle for it.
    let (status, _) = call(
        &f.app,
        "GET",
        &format!("/data-documents/{}/history-state", f.document_id),
        &[(SESSION, "window-1")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let mut events = f.state.events.subscribe();

    let record_id = f
        .state
        .create_record_for_workflow(
            f.user_id,
            &f.document_id,
            &f.table_id.to_string(),
            &json!({ "title": "From a workflow" })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            Origin::system("workflow"),
        )
        .unwrap_or_else(|err| panic!("{err}"));
    assert!(!record_id.is_empty());

    // RecordCreated drives `record.created` workflow triggers; TableChanged is what an open
    // table listens to, over the kit bridge, to show the row live.
    let first = events
        .try_recv()
        .unwrap_or_else(|err| panic!("expected RecordCreated: {err}"));
    assert!(matches!(first, DomainEvent::RecordCreated(_)), "{first:?}");

    let second = events
        .try_recv()
        .unwrap_or_else(|err| panic!("expected TableChanged: {err}"));
    let DomainEvent::TableChanged(payload) = second else {
        panic!("expected a TableChanged event, got {second:?}");
    };
    assert_eq!(payload["documentId"], f.document_id);
    assert_eq!(payload["origin"], "workflow");
    assert_eq!(
        payload["recordsUpserted"].as_array().map(Vec::len),
        Some(1),
        "{payload}"
    );

    // The handle the manager cached above (not a fresh one) reflects the write at once.
    let (status, records) = call(
        &f.app,
        "GET",
        &format!(
            "/data-documents/{}/tables/{}/records",
            f.document_id, f.table_id
        ),
        &[(SESSION, "window-1")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{records}");
    assert!(
        row_titles(&records).contains(&json!("From a workflow")),
        "{records}"
    );
}

/// An agent run's several table writes, grouped the way `kition-agent`'s tools group them
/// (`begin_undo_group`/`end_undo_group` around more than one `transact`), undo as one step.
#[tokio::test]
async fn agent_write_is_one_undo_step() {
    let f = fixture();
    let origin = Origin::agent("run:test-1");
    let (doc, mut file, table) = f
        .state
        .agent_table(
            f.user_id,
            f.document_id
                .parse()
                .unwrap_or_else(|err| panic!("{err}")),
            f.table_id,
            origin,
        )
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(doc.id.to_string(), f.document_id);
    assert_eq!(table.id, f.table_id);
    assert!(!file.can_undo());

    file.begin_undo_group()
        .unwrap_or_else(|err| panic!("{err}"));
    let (ids, _) = file
        .transact(&[TableOp::RecordsCreate {
            table_id: f.table_id,
            at: None,
            records: vec![
                json!({ "title": "Agent row" })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            ],
        }])
        .unwrap_or_else(|err| panic!("{err}"));
    let row_key = ids
        .into_iter()
        .next()
        .unwrap_or_else(|| panic!("records.create did not return a row key"));
    file.transact(&[TableOp::CellsSet {
        table_id: f.table_id,
        records: vec![CellEdit {
            row_key: row_key.clone(),
            values: json!({ "title": "Agent row, edited" })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        }],
    }])
    .unwrap_or_else(|err| panic!("{err}"));
    file.end_undo_group();

    assert!(
        file.can_undo(),
        "the agent run's grouped writes should be undoable"
    );

    let (done, change) = file.undo().unwrap_or_else(|err| panic!("{err}"));
    assert!(done, "{change:?}");
    assert_eq!(
        change.records_deleted,
        vec![(f.table_id, row_key)],
        "one undo should remove the record the whole run created, not just revert its last edit: {change:?}"
    );
    assert!(
        !file.can_undo(),
        "the agent run's two writes were one undo step, not two"
    );
}

/// Someone edits a *copy* of the `.kitable` file (a sync conflict, another machine) and then
/// atomically replaces the original with it: a new inode at the same path, not an in-place
/// write. The manager must notice and merge it, the same way it merges an in-place external edit
/// (`transact_routes.rs`'s `an_external_edit_is_merged_and_published_as_table_changed`).
#[tokio::test]
async fn external_replacement_with_an_edited_copy_merges() {
    let f = fixture();

    // Opens through the manager once, so it caches a handle and the file identity it later
    // compares against.
    let (status, _) = call(
        &f.app,
        "GET",
        &format!("/data-documents/{}/history-state", f.document_id),
        &[(SESSION, "window-1")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let copy_path = f.path.with_extension("copy.kitable");
    std::fs::copy(&f.path, &copy_path).unwrap_or_else(|err| panic!("{err}"));
    let mut copy = KitableFile::open(&copy_path).unwrap_or_else(|err| panic!("{err}"));
    copy.set_origin(Origin::person("someone-else"));
    copy.transact(&[TableOp::RecordsCreate {
        table_id: f.table_id,
        at: None,
        records: vec![
            json!({ "title": "From the edited copy" })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        ],
    }])
    .unwrap_or_else(|err| panic!("{err}"));
    copy.close();
    // Atomic replace: same path, new inode, exactly as an external sync tool would leave it.
    std::fs::rename(&copy_path, &f.path).unwrap_or_else(|err| panic!("{err}"));

    let mut events = f.state.events.subscribe();

    let (status, history) = call(
        &f.app,
        "GET",
        &format!("/data-documents/{}/history-state", f.document_id),
        &[(SESSION, "window-1")],
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
    assert_eq!(payload["origin"], "external");
    assert_eq!(
        payload["recordsUpserted"].as_array().map(Vec::len),
        Some(1),
        "{payload}"
    );

    let (status, records) = call(
        &f.app,
        "GET",
        &format!(
            "/data-documents/{}/tables/{}/records",
            f.document_id, f.table_id
        ),
        &[(SESSION, "window-1")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{records}");
    assert!(
        row_titles(&records).contains(&json!("From the edited copy")),
        "{records}"
    );
}
