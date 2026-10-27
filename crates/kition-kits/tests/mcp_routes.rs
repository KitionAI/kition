//! `POST /mcp/kits`: Kition's kit tools as an MCP server over Streamable HTTP, as DeepSeek
//! Harness's `dsh-mcp-client` and other MCP clients reach a running Kition.

use std::path::PathBuf;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kition_http::AuthConfig;
use kition_kits::{KITS, KitManager, KitsState, router};
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

fn app(kits: KitManager) -> Router {
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    kition_store::seed::run(&db.conn().unwrap_or_else(|err| panic!("{err}")))
        .unwrap_or_else(|err| panic!("{err}"));
    router(KitsState {
        auth: AuthConfig {
            db,
            jwt_secret: "test".into(),
            disabled: true,
        },
        kits,
    })
}

async fn post(app: &Router, message: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri("/mcp/kits")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(Body::from(message.to_string()))
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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn speaks_mcp_over_http() {
    let app = app(KitManager::new(None, Vec::new()));
    let (status, init) = post(&app, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(
        init["result"]["capabilities"]["tools"]["listChanged"],
        false
    );
    let (status, body) = post(
        &app,
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await;
    assert_eq!((status, body), (StatusCode::ACCEPTED, Value::Null));
    assert_eq!(
        post(&app, json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }))
            .await
            .1["result"],
        json!({})
    );
    assert_eq!(
        post(
            &app,
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })
        )
        .await
        .1["result"]["tools"],
        json!([]),
        "no kit is installed"
    );
}

/// The Vector kit's executable, when it is built in the sibling kit checkout or named by its
/// environment variable.
fn vector_binary() -> Option<PathBuf> {
    let kit = KITS.iter().find(|kit| kit.id == "kit.vector")?;
    if let Some(path) = std::env::var_os(kit.binary_env).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let sibling = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../../kition-vector/target/debug/kit-vector{}",
        std::env::consts::EXE_SUFFIX
    ));
    sibling.is_file().then_some(sibling)
}

#[tokio::test]
async fn calls_a_real_kit_and_returns_its_preview() {
    let (Some(binary), Some(kit)) = (
        vector_binary(),
        KITS.iter().find(|kit| kit.id == "kit.vector"),
    ) else {
        eprintln!("skipped: build kit-vector (cargo build -p kit-vector in its repository)");
        return;
    };
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(dir.path().join("art")).unwrap_or_else(|err| panic!("{err}"));
    std::fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/Drawing.kvector"),
        dir.path().join("art/Drawing.kvector"),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(dir.path().to_path_buf()), vec![(kit, Some(binary))]);
    let app = app(kits.clone());
    let (_, listed) = post(
        &app,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
    )
    .await;
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool["name"].as_str())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        names,
        [
            "vector_inspect",
            "vector_commands",
            "vector_run",
            "vector_draft_ready",
            "vector_draft_reopen",
            "vector_query",
            "vector_batch",
            "vector_check"
        ]
    );
    assert_eq!(
        listed["result"]["tools"][7]["annotations"]["readOnlyHint"], true,
        "vector_check changes nothing"
    );
    assert_eq!(
        listed["result"]["tools"][6]["annotations"]["readOnlyHint"], false,
        "vector_batch writes"
    );
    assert_eq!(
        listed["result"]["tools"][0]["annotations"]["readOnlyHint"],
        true
    );
    assert_eq!(
        listed["result"]["tools"][2]["annotations"]["readOnlyHint"],
        false
    );

    let (_, inspected) = post(&app, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "vector_inspect", "arguments": { "path": "art/Drawing.kvector" } } })).await;
    let result = &inspected["result"];
    assert_eq!(result["isError"], false, "{result}");
    assert_eq!(result["structuredContent"]["path"], "art/Drawing.kvector");
    let image = result["content"]
        .as_array()
        .and_then(|content| content.iter().find(|block| block["type"] == "image"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(image["mimeType"], "image/png");

    let (_, refused) = post(&app, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "vector_inspect", "arguments": { "path": "../outside.kvector" } } })).await;
    assert_eq!(refused["result"]["isError"], true);
    assert!(
        refused["result"]["structuredContent"]["error"]["code"].is_string(),
        "{refused}"
    );

    // The object model of the real kit: read, or a clear `unsupported` when its build serves none.
    let (_, queried) = post(&app, json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "vector_query", "arguments": { "path": "art/Drawing.kvector", "describe": true } } })).await;
    let result = &queried["result"];
    if result["isError"] == true {
        assert_eq!(
            result["structuredContent"]["error"]["code"], "unsupported",
            "{result}"
        );
    } else {
        assert!(
            result["structuredContent"]["objects"][0]["id"].is_string(),
            "{result}"
        );
        assert!(result["structuredContent"]["types"].is_string(), "{result}");
    }
    // Diagnostics of the real kit, or a clear `unsupported` when its build predates `document.check`.
    let (_, checked) = post(&app, json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "vector_check", "arguments": { "path": "art/Drawing.kvector" } } })).await;
    let result = &checked["result"];
    if result["isError"] == true {
        assert_eq!(
            result["structuredContent"]["error"]["code"], "unsupported",
            "{result}"
        );
    } else {
        assert!(
            result["structuredContent"]["diagnostics"].is_array(),
            "{result}"
        );
    }
    kits.shutdown().await;
}
