//! Attachments held in the `.kitable` file as blobs, through the runtime's routes: uploads store
//! a blob (not a workspace file), `GET .../blobs/{hash}` serves its bytes, a path attachment that
//! names a workspace asset becomes a blob when it is written again (and one that cannot be read,
//! or names any other file, stays as it is), and co-editing carries blobs beside the changes
//! that reference them.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use base64::Engine as _;
use http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use kition_core::events::EventBus;
use kition_datadoc::index::{self, NewDocument};
use kition_datadoc::{DataDocState, ImportStore, TableDocuments};
use kition_http::AuthConfig;
use kition_kitable::blobs::{blob_hash, blob_url};
use kition_kitable::{CreateOptions, FieldSpec, KitableFile, TableSpec};
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

const HERE: &str = "Here.kitable";
const THERE: &str = "There.kitable";

fn ok<T, E: std::fmt::Display>(result: Result<T, E>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

struct Fixture {
    app: Router,
    state: DataDocState,
    here_id: String,
    there_id: String,
    table_id: i64,
    record_id: i64,
    dir: tempfile::TempDir,
}

/// `Here.kitable` with a table "Photos" (title, files: attachment) and one record, and its copy
/// `There.kitable`: one document in two files, both indexed.
fn fixture() -> Fixture {
    let dir = ok(tempfile::tempdir());
    let workspace_dir = dir.path().to_path_buf();
    let db = ok(Db::open_in_memory());
    let conn = ok(db.conn());
    ok(kition_store::seed::run(&conn));
    let user_id = ok(kition_store::users::find_local_user(&conn))
        .unwrap_or_else(|| panic!("no local user"))
        .id;

    let here = workspace_dir.join(HERE);
    let mut file = ok(KitableFile::create(&here, &CreateOptions::default()));
    let table = ok(file.create_table(&TableSpec {
        name: "Photos".into(),
        fields: vec![
            FieldSpec {
                name: "title".into(),
                title: "Title".into(),
                field_type: "text".into(),
                primary: true,
                ..Default::default()
            },
            FieldSpec {
                name: "files".into(),
                title: "Files".into(),
                field_type: "attachment".into(),
                ..Default::default()
            },
        ],
        ..Default::default()
    }));
    let record = ok(file.create_record(
        table.id,
        &json!({ "title": "Beach" })
            .as_object()
            .cloned()
            .unwrap_or_default(),
    ));
    file.close();
    ok(std::fs::copy(&here, workspace_dir.join(THERE)));

    let mut ids = Vec::new();
    for path in [HERE, THERE] {
        let doc = ok(index::insert(
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
        ));
        ids.push(doc.id.to_string());
    }
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
    let app = kition_datadoc::router(state.clone());
    Fixture {
        app,
        state,
        there_id: ids.pop().unwrap_or_default(),
        here_id: ids.pop().unwrap_or_default(),
        table_id: table.id,
        record_id: record.id,
        dir,
    }
}

/// A picture's bytes: a PNG signature and some content.
fn picture(seed: u8) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend((0..300u32).map(|index| (index as u8).wrapping_add(seed)));
    bytes
}

/// The status, headers, and body bytes of one request.
async fn send(app: &Router, request: Request<Body>) -> (StatusCode, http::HeaderMap, Vec<u8>) {
    let response = ok(app.clone().oneshot(request).await);
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = ok(response.into_body().collect().await).to_bytes().to_vec();
    (status, headers, bytes)
}

/// `data` of a JSON request's 200 answer.
async fn json_call(app: &Router, method: &str, uri: &str, body: Value) -> Value {
    let request = ok(Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string())));
    let (status, _, bytes) = send(app, request).await;
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    assert_eq!(status, StatusCode::OK, "{method} {uri}: {value}");
    value["data"].clone()
}

/// Uploads `bytes` as `name` through the multipart route; answers the attachment value.
async fn upload(f: &Fixture, name: &str, mime: &str, bytes: &[u8]) -> Value {
    let boundary = "kition-test-boundary";
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = ok(Request::builder()
        .method("POST")
        .uri(format!(
            "/data-documents/{}/tables/{}/attachments",
            f.here_id, f.table_id
        ))
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body)));
    let (status, _, bytes) = send(&f.app, request).await;
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    assert_eq!(status, StatusCode::OK, "{value}");
    value["data"].clone()
}

/// `GET .../blobs/{hash}` of the document `document_id`.
async fn read_blob(
    f: &Fixture,
    document_id: &str,
    hash: &str,
) -> (StatusCode, http::HeaderMap, Vec<u8>) {
    let request = ok(Request::builder()
        .uri(format!("/data-documents/{document_id}/blobs/{hash}"))
        .body(Body::empty()));
    send(&f.app, request).await
}

async fn set_files(f: &Fixture, value: Value) -> Value {
    json_call(
        &f.app,
        "PATCH",
        &format!(
            "/data-documents/{}/tables/{}/records/{}",
            f.here_id, f.table_id, f.record_id
        ),
        json!({ "values": { "files": value } }),
    )
    .await["values"]["files"]
        .clone()
}

/// The record's `files` value as the records route lists it.
async fn files_of(f: &Fixture) -> Value {
    let page = json_call(
        &f.app,
        "GET",
        &format!(
            "/data-documents/{}/tables/{}/records",
            f.here_id, f.table_id
        ),
        Value::Null,
    )
    .await;
    page["items"][0]["values"]["files"].clone()
}

#[tokio::test]
async fn an_upload_is_stored_in_the_file_and_served_from_it() {
    let f = fixture();
    let bytes = picture(1);
    let attachment = upload(&f, "beach.png", "image/png", &bytes).await;
    let hash = blob_hash(&bytes);
    assert_eq!(attachment["url"], json!(blob_url(&hash)));
    assert_eq!(attachment["name"], json!("beach.png"));
    assert_eq!(attachment["mimeType"], json!("image/png"));
    assert_eq!(attachment["sizeBytes"], json!(bytes.len()));
    assert_eq!(attachment["sha256"], json!(hash));
    assert!(attachment.get("workspacePath").is_none());
    assert!(
        !f.dir.path().join(".kition/assets/sha256").exists(),
        "an upload writes no workspace file"
    );

    let (status, headers, body) = read_blob(&f, &f.here_id, &hash).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, bytes);
    assert_eq!(headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");

    // The cell names the blob; the value stays as stored.
    assert_eq!(
        set_files(&f, json!([attachment.clone()])).await,
        json!([attachment])
    );

    let (status, _, _) = read_blob(&f, &f.here_id, &blob_hash(b"unknown")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // The copy of the document holds no such blob.
    let (status, _, _) = read_blob(&f, &f.there_id, &hash).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_blob_that_could_run_as_a_page_downloads_instead() {
    let f = fixture();
    let attachment = upload(&f, "page.html", "text/html", b"<script>alert(1)</script>").await;
    let hash = attachment["sha256"].as_str().unwrap_or_default().to_owned();
    let (status, headers, _) = read_blob(&f, &f.here_id, &hash).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(headers[header::CONTENT_DISPOSITION], "attachment");
}

#[tokio::test]
async fn old_path_attachments_keep_showing_and_become_blobs_when_written() {
    let f = fixture();
    let bytes = picture(2);
    let asset = ok(f.state.assets.save_bytes(&bytes, "old.png", "image/png"));
    let old = json!({
        "url": asset.url, "name": "old.png", "mimeType": "image/png", "sizeBytes": asset.size_bytes,
        "assetId": asset.asset_id, "sha256": asset.sha256, "workspacePath": asset.workspace_path,
    });
    // An older build wrote the path value straight into the file.
    {
        let tables = f.state.tables.clone();
        let absolute = f.state.workspace_dir.join(HERE);
        let (table_id, record_id, value) = (f.table_id, f.record_id, old.clone());
        ok(tokio::task::spawn_blocking(move || {
            let (mut file, _) = ok(tables.open(&absolute, kition_kdm::Origin::system("test")));
            let values = json!({ "files": [value] })
                .as_object()
                .cloned()
                .unwrap_or_default();
            ok(file.update_record(table_id, record_id, &values, None));
        })
        .await);
    }
    // Reading changes nothing: the path value is still there, as it was.
    assert_eq!(files_of(&f).await, json!([old.clone()]));

    // Written again through Kition (a new attachment added next to it): the asset's bytes become a
    // blob of the file and the value names it; the new one is kept as it is.
    let new = upload(&f, "new.png", "image/png", &picture(3)).await;
    let written = set_files(&f, json!([old.clone(), new.clone()])).await;
    let hash = blob_hash(&bytes);
    assert_eq!(written[0]["url"], json!(blob_url(&hash)));
    assert_eq!(written[0]["name"], json!("old.png"));
    assert_eq!(written[0]["mimeType"], json!("image/png"));
    assert!(written[0].get("workspacePath").is_none());
    assert_eq!(written[1], new);
    assert_eq!(files_of(&f).await, written);
    let (status, _, body) = read_blob(&f, &f.here_id, &hash).await;
    assert_eq!((status, body), (StatusCode::OK, bytes));
    // The workspace file is never touched.
    assert!(f.dir.path().join(&asset.workspace_path).is_file());
}

#[tokio::test]
async fn path_attachments_that_cannot_be_read_or_name_other_files_stay_paths() {
    let f = fixture();
    // A missing asset, and a workspace file that is not an asset (a co-editor could name any).
    ok(std::fs::write(f.dir.path().join("private.png"), picture(4)));
    let missing = json!({
        "url": format!("/workspace-files/.kition/assets/sha256/ab/{}.png", blob_hash(b"gone")),
        "name": "gone.png", "mimeType": "image/png",
    });
    let private = json!({ "url": "/workspace-files/private.png", "name": "private.png", "mimeType": "image/png" });
    let named = json!({ "url": "", "name": "named.png", "workspacePath": "private.png" });
    // An asset whose bytes do not hash to its name.
    let forged_path = format!(
        ".kition/assets/sha256/ab/{}.png",
        blob_hash(b"something else")
    );
    ok(std::fs::create_dir_all(
        f.dir.path().join(".kition/assets/sha256/ab"),
    ));
    ok(std::fs::write(f.dir.path().join(&forged_path), picture(5)));
    let forged = json!({ "url": format!("/workspace-files/{forged_path}"), "name": "forged.png" });
    let remote = json!({ "url": "https://example.com/a.png", "name": "a.png" });
    let value = json!([missing, private, named, forged, remote]);
    assert_eq!(set_files(&f, value.clone()).await, value);
    let (status, _, _) = read_blob(&f, &f.here_id, &blob_hash(&picture(4))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn transactions_store_path_attachments_as_blobs_too() {
    let f = fixture();
    let bytes = picture(6);
    let asset = ok(f.state.assets.save_bytes(&bytes, "pasted.png", "image/png"));
    let path_value = json!([{ "url": asset.url, "name": "pasted.png", "mimeType": "image/png" }]);
    let rows = json_call(
        &f.app,
        "POST",
        &format!("/data-documents/{}/transact", f.here_id),
        json!({ "ops": [{ "op": "records.create", "tableId": f.table_id, "at": null, "records": [{ "title": "Pasted", "files": path_value }] }] }),
    )
    .await;
    assert_eq!(rows["created"].as_array().map(Vec::len), Some(1));
    let page = json_call(
        &f.app,
        "GET",
        &format!(
            "/data-documents/{}/tables/{}/records",
            f.here_id, f.table_id
        ),
        Value::Null,
    )
    .await;
    let created = page["items"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item["values"]["title"] == json!("Pasted"))
        })
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(
        created["values"]["files"][0]["url"],
        json!(blob_url(&blob_hash(&bytes)))
    );
}

#[tokio::test]
async fn co_editing_carries_a_blob_attachment_to_the_other_copy() {
    let f = fixture();
    let bytes = picture(7);
    let attachment = upload(&f, "sunset.png", "image/png", &bytes).await;
    set_files(&f, json!([attachment.clone()])).await;

    let target = json_call(
        &f.app,
        "POST",
        "/data-documents/replica/version",
        json!({ "path": THERE }),
    )
    .await;
    let exported = json_call(
        &f.app,
        "POST",
        "/data-documents/replica/export",
        json!({ "path": HERE, "since": target["version"] }),
    )
    .await;
    let section = ok(base64::engine::general_purpose::STANDARD
        .decode(exported["blobs"].as_str().unwrap_or_default()));
    let entries = ok(kition_kitable::blobs::decode_blob_section(&section));
    assert_eq!(entries, vec![(blob_hash(&bytes), bytes.clone())]);

    json_call(
        &f.app,
        "POST",
        "/data-documents/replica/import",
        json!({ "path": THERE, "changes": exported["changes"], "blobs": exported["blobs"] }),
    )
    .await;
    let page = json_call(
        &f.app,
        "GET",
        &format!(
            "/data-documents/{}/tables/{}/records",
            f.there_id, f.table_id
        ),
        Value::Null,
    )
    .await;
    assert_eq!(page["items"][0]["values"]["files"], json!([attachment]));
    let (status, _, body) = read_blob(&f, &f.there_id, &blob_hash(&bytes)).await;
    assert_eq!((status, body), (StatusCode::OK, bytes));

    // Blobs that do not hash to their name are refused, and nothing is imported.
    let forged =
        kition_kitable::blobs::encode_blob_section([(blob_hash(b"a").as_str(), b"b".as_slice())]);
    let request = ok(Request::builder()
        .method("POST")
        .uri("/data-documents/replica/import")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "path": THERE, "changes": exported["changes"], "blobs": base64::engine::general_purpose::STANDARD.encode(forged) }).to_string(),
        )));
    let (status, _, _) = send(&f.app, request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_shared_table_is_created_with_its_blobs() {
    let f = fixture();
    let bytes = picture(8);
    let attachment = upload(&f, "shared.png", "image/png", &bytes).await;
    set_files(&f, json!([attachment])).await;
    let exported = json_call(
        &f.app,
        "POST",
        "/data-documents/replica/export",
        json!({ "path": HERE }),
    )
    .await;
    let created = json_call(
        &f.app,
        "POST",
        "/data-documents/replica/create",
        json!({ "path": "Shared/Photos.kitable", "changes": exported["changes"], "blobs": exported["blobs"] }),
    )
    .await;
    let document_id = created["documentId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (status, _, body) = read_blob(&f, &document_id, &blob_hash(&bytes)).await;
    assert_eq!((status, body), (StatusCode::OK, bytes));
}
