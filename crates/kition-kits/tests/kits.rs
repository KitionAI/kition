//! The `/kits` routes against the mock kit: open a workspace file, edit it as a person and as
//! the agent, see the change version move, save, and stay inside the workspace.
//!
//! The mock kit executable is built with the workspace (`cargo test --workspace`); when it is
//! missing the tests say so and pass.

use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kition_http::AuthConfig;
use kition_kits::{Caller, KitAgent, KitDefinition, KitManager, KitsState, router};
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

static MOCK: KitDefinition = KitDefinition {
    id: "kit.mock",
    name: "Mock kit",
    binary_env: "KITION_KIT_MOCK_BINARY",
    extensions: &["mocktext"],
    creates: &[("mocktext", "mock.text")],
    embeds: false,
    exports: &["mockout"],
    agent: KitAgent {
        prefix: "mock",
        noun: "mock document",
        formats: ".mocktext",
        reports: "its text",
        covers: "text edits",
        queries: "`append`",
        command: "text.append",
    },
};

fn mock_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?;
    let path = dir.join(format!("kition-kit-mock{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

struct Fixture {
    app: Router,
    kits: KitManager,
    dir: tempfile::TempDir,
}

fn fixture() -> Option<Fixture> {
    let Some(binary) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return None;
    };
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(dir.path().join("art")).unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(dir.path().join("art/note.mocktext"), "hello")
        .unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(&MOCK, Some(binary))]);
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    kition_store::seed::run(&db.conn().unwrap_or_else(|err| panic!("{err}")))
        .unwrap_or_else(|err| panic!("{err}"));
    let auth = AuthConfig {
        db,
        jwt_secret: "test".into(),
        disabled: true,
    };
    let app = router(KitsState {
        auth,
        kits: kits.clone(),
    });
    Some(Fixture { app, kits, dir })
}

/// Validates a response against one `$defs` entry of `contracts/runtime/kits.schema.json`.
fn check_contract(def: &str, instance: &Value) {
    let mut schema: Value =
        serde_json::from_str(include_str!("../../../contracts/runtime/kits.schema.json"))
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

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
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

#[tokio::test]
async fn opens_edits_and_saves_a_workspace_file() {
    let Some(f) = fixture() else { return };
    let (status, listed) = call(&f.app, "GET", "/kits", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["data"]["kits"][0]["installed"], true, "{listed}");
    check_contract("kitList", &listed["data"]);

    let (status, opened) = call(
        &f.app,
        "POST",
        "/kits/documents",
        Some(json!({ "path": "art/note.mocktext" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{opened}");
    let doc = &opened["data"];
    check_contract("documentView", doc);
    assert_eq!(doc["path"], "art/note.mocktext");
    assert_eq!(doc["dirty"], false);
    assert_eq!(doc["details"]["text"], "hello");
    let id = doc["documentId"].as_str().unwrap_or_default().to_owned();
    let base = format!("/kits/kit.mock/documents/{id}");

    let (status, executed) = call(
        &f.app,
        "POST",
        &format!("{base}/commands"),
        Some(json!({ "command": "text.append", "params": { "text": "!" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{executed}");
    assert_eq!(executed["data"]["changed"], true);
    check_contract("executeResult", &executed["data"]);
    assert_eq!(executed["data"]["document"]["dirty"], true);
    assert_eq!(executed["data"]["document"]["details"]["text"], "hello!");

    // The agent edits the same document over its own connection; the tab sees a new version.
    let before = executed["data"]["document"]["version"]
        .as_u64()
        .unwrap_or_default();
    let agent = f
        .kits
        .open(Caller::Agent, "art/note.mocktext")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(agent.document_id, id, "the agent shares the open document");
    f.kits
        .execute(
            Caller::Agent,
            "kit.mock",
            &id,
            "text.append",
            serde_json::Map::from_iter([("text".into(), json!("?"))]),
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let (_, refreshed) = call(&f.app, "GET", &base, None).await;
    assert!(
        refreshed["data"]["version"].as_u64().unwrap_or_default() > before,
        "{refreshed}"
    );
    assert_eq!(refreshed["data"]["details"]["text"], "hello!?");

    let (status, preview) = call(&f.app, "GET", &format!("{base}/preview?maxSize=64"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        preview["raw"].as_u64().unwrap_or_default() > 8,
        "a PNG body"
    );

    let (status, saved) = call(&f.app, "POST", &format!("{base}/save"), None).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["data"]["dirty"], false);
    let text = std::fs::read_to_string(f.dir.path().join("art/note.mocktext"))
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(text, "hello!?");

    let (status, _) = call(&f.app, "DELETE", &base, None).await;
    assert_eq!(status, StatusCode::OK);
    f.kits.shutdown().await;
}

#[tokio::test]
async fn creates_untitled_documents_with_unused_names() {
    let Some(f) = fixture() else { return };
    let (status, created) = call(
        &f.app,
        "POST",
        "/kits/documents/new",
        Some(json!({ "folder": "art", "extension": "mocktext" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    check_contract("documentView", &created["data"]);
    assert_eq!(created["data"]["path"], "art/Untitled image.mocktext");
    assert_eq!(created["data"]["dirty"], false);
    assert!(f.dir.path().join("art/Untitled image.mocktext").is_file());
    let (_, second) = call(
        &f.app,
        "POST",
        "/kits/documents/new",
        Some(json!({ "folder": "art", "extension": "mocktext" })),
    )
    .await;
    assert_eq!(second["data"]["path"], "art/Untitled image 2.mocktext");
    let (status, _) = call(
        &f.app,
        "POST",
        "/kits/documents/new",
        Some(json!({ "folder": "missing", "extension": "mocktext" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &f.app,
        "POST",
        "/kits/documents/new",
        Some(json!({ "extension": "exe" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &f.app,
        "POST",
        "/kits/documents/new",
        Some(json!({ "extension": "mocktext", "width": 0 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    f.kits.shutdown().await;
}

#[tokio::test]
async fn in_page_editors_save_kit_files_inside_the_workspace() {
    let Some(f) = fixture() else { return };
    let put = |uri: &str| {
        let request = Request::builder()
            .method("PUT")
            .uri(uri)
            .header("content-type", "application/octet-stream")
            .body(Body::from("saved"))
            .unwrap_or_else(|err| panic!("{err}"));
        let app = f.app.clone();
        async move {
            app.oneshot(request)
                .await
                .unwrap_or_else(|err| panic!("{err}"))
                .status()
        }
    };
    assert_eq!(
        put("/kits/files?path=art/note.mocktext").await,
        StatusCode::OK
    );
    // An export is written once, as a new file, and never over an existing one.
    assert_eq!(
        put("/kits/files?path=art/note.mockout").await,
        StatusCode::OK
    );
    assert_eq!(
        put("/kits/files?path=art/note.mockout").await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("art/note.mocktext")).unwrap_or_default(),
        "saved"
    );
    for path in ["art/note.txt", "../x.mocktext", "missing/x.mocktext"] {
        assert_eq!(
            put(&format!("/kits/files?path={path}")).await,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
}

#[tokio::test]
async fn rejects_paths_outside_the_workspace_and_unknown_kits() {
    let Some(f) = fixture() else { return };
    for path in [
        "../escape.mocktext",
        "/etc/passwd.mocktext",
        "art/../../x.mocktext",
        "art\\note.mocktext",
    ] {
        let (status, body) = call(
            &f.app,
            "POST",
            "/kits/documents",
            Some(json!({ "path": path })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
    }
    let (status, _) = call(
        &f.app,
        "POST",
        "/kits/documents",
        Some(json!({ "path": "art/missing.mocktext" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &f.app,
        "POST",
        "/kits/documents",
        Some(json!({ "path": "art/note.txt" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&f.app, "GET", "/kits/kit.nope/documents/1", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(&f.app, "GET", "/kits/kit.mock/documents/doc-404", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    f.kits.shutdown().await;
}

#[tokio::test]
async fn a_missing_kit_reports_not_installed() {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(dir.path().join("a.mocktext"), "x").unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(&MOCK, None)]);
    assert!(!kits.statuses()[0].installed);
    let error = kits
        .open(Caller::User, "a.mocktext")
        .await
        .err()
        .map(|error| error.to_string())
        .unwrap_or_default();
    assert!(error.contains("KITION_KIT_MOCK_BINARY"), "{error}");
}
