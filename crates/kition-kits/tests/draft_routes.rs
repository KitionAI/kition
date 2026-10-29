//! The `/kits/drafts` routes over a headless draft (KHP A27) of a mock kit file: the
//! person lists it, compares it, has a merge refused while the file changed since the draft
//! forked, merges it anyway, and discards another. The draft is made as `kition-kits-mcp
//! --drafts` makes a `file` draft: a copy of the file and the edited copy beside it.
//!
//! The mock kit executable is built with the workspace (`cargo test --workspace`); when it is
//! missing the tests say so and pass.

use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kition_http::AuthConfig;
use kition_kits::{KitAgent, KitDefinition, KitManager, KitsState, drafts, router};
use kition_store::Db;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

static MOCK: KitDefinition = KitDefinition {
    id: "kit.mock",
    name: "Mock kit",
    binary_env: "KITION_KIT_MOCK_BINARY",
    extensions: &["mocktext"],
    creates: &[("mocktext", "mock.text")],
    base_name: "Untitled Mock kit",
    exports: &[],
    agent: KitAgent {
        prefix: "mock",
        noun: "mock document",
        formats: ".mocktext",
        reports: "its text",
        covers: "text edits",
        queries: "`append`",
        command: "text.append",
        render: None,
        export: None,
    },
};

const FILE: &str = "art/note.mocktext";

fn mock_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?;
    let path = dir.join(format!("kition-kit-mock{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn write(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|err| panic!("{err}"));
    }
    std::fs::write(path, bytes).unwrap_or_else(|err| panic!("{err}"));
}

/// A `file` draft of `path` in `workspace`, as `kition-kits-mcp --drafts` keeps one: the file as
/// it was, the agent's edited copy, and `draft.json`.
fn make_draft(workspace: &Path, path: &str, base: &[u8], draft: &[u8]) {
    let dir = drafts::folder(workspace, path);
    write(&dir.join("base.mocktext"), base);
    write(&dir.join("draft.mocktext"), draft);
    let meta = json!({
        "version": 1,
        "path": path,
        "kit": "kit.mock",
        "mode": "file",
        "state": "ready",
        "baseSha256": sha256(base),
        "created": 1_760_000_000_000_u64,
        "updated": 1_760_000_000_000_u64,
    });
    write(&dir.join("draft.json"), meta.to_string().as_bytes());
}

fn app(workspace: &Path, binary: PathBuf) -> Router {
    let kits = KitManager::new(Some(workspace.to_path_buf()), vec![(&MOCK, Some(binary))]);
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    kition_store::seed::run(&db.conn().unwrap_or_else(|err| panic!("{err}")))
        .unwrap_or_else(|err| panic!("{err}"));
    let auth = AuthConfig {
        db,
        jwt_secret: "test".into(),
        disabled: true,
    };
    router(KitsState { auth, kits })
}

/// Validates an answer against one `$defs` entry of `contracts/runtime/kits.schema.json`.
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
async fn the_person_reviews_merges_and_discards_headless_drafts() {
    let Some(binary) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let workspace = dir.path();
    write(&workspace.join(FILE), b"hello");
    make_draft(workspace, FILE, b"hello", b"hello world");
    let app = app(workspace, binary);

    let (status, listed) = call(&app, "GET", "/kits/drafts", None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    check_contract("draftList", &listed["data"]);
    assert_eq!(listed["data"]["drafts"][0]["path"], FILE);
    assert_eq!(listed["data"]["drafts"][0]["stale"], false);

    let (status, compared) = call(
        &app,
        "GET",
        &format!("/kits/drafts/compare?path={FILE}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{compared}");
    check_contract("draftComparison", &compared["data"]);
    assert_eq!(compared["data"]["mode"], "file");
    assert_eq!(compared["data"]["diff"], Value::Null);
    assert!(
        compared["data"]["summary"]["draft"].is_string(),
        "{compared}"
    );

    // The person edits the file meanwhile: merging would drop that edit, so it is refused.
    write(&workspace.join(FILE), b"hello again");
    let (status, refused) = call(
        &app,
        "POST",
        "/kits/drafts/merge",
        Some(json!({ "path": FILE })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["data"]["reason"], "stale", "{refused}");
    let (_, listed) = call(&app, "GET", "/kits/drafts", None).await;
    assert_eq!(listed["data"]["drafts"][0]["stale"], true);

    let (status, merged) = call(
        &app,
        "POST",
        "/kits/drafts/merge",
        Some(json!({ "path": FILE, "overwrite": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{merged}");
    check_contract("draftMergeResult", &merged["data"]);
    assert_eq!(
        std::fs::read(workspace.join(FILE)).unwrap_or_default(),
        b"hello world"
    );
    assert!(!drafts::folder(workspace, FILE).exists());

    make_draft(workspace, FILE, b"hello world", b"bye");
    let (status, discarded) = call(
        &app,
        "POST",
        "/kits/drafts/discard",
        Some(json!({ "path": FILE })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{discarded}");
    check_contract("draftDiscardResult", &discarded["data"]);
    assert_eq!(
        std::fs::read(workspace.join(FILE)).unwrap_or_default(),
        b"hello world",
        "discarding leaves the file as it is"
    );
    let (status, missing) = call(
        &app,
        "POST",
        "/kits/drafts/discard",
        Some(json!({ "path": FILE })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{missing}");
    assert_eq!(missing["data"]["reason"], "not-found");
    let (_, listed) = call(&app, "GET", "/kits/drafts", None).await;
    assert_eq!(listed["data"]["drafts"], json!([]));
}
