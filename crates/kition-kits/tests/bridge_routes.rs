//! The Kit AI bridge over HTTP, as a renderer window uses it: `GET /kits/bridge` streams the
//! runtime's JSON-RPC requests as server-sent events, and `POST /kits/bridge?session=` answers
//! them. The runtime finds the window with a file open and runs the agent's call there.

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use kition_http::AuthConfig;
use kition_kits::{KitManager, KitsState, router};
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

fn app() -> (Router, KitManager) {
    let kits = KitManager::new(None, Vec::new());
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    kition_store::seed::run(&db.conn().unwrap_or_else(|err| panic!("{err}")))
        .unwrap_or_else(|err| panic!("{err}"));
    let auth = AuthConfig {
        db,
        jwt_secret: "test".into(),
        disabled: true,
    };
    (
        router(KitsState {
            auth,
            kits: kits.clone(),
        }),
        kits,
    )
}

/// Validates a bridge message against one `$defs` entry of `contracts/runtime/kits.schema.json`.
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

/// Reads server-sent events from a response body, one JSON message per `data:` line.
struct Events {
    body: Body,
    buffer: String,
}

impl Events {
    async fn next(&mut self) -> Value {
        loop {
            if let Some(end) = self.buffer.find("\n\n") {
                let frame: String = self.buffer.drain(..end + 2).collect();
                let data: String = frame
                    .lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .map(str::trim)
                    .collect();
                if data.is_empty() {
                    continue;
                }
                return serde_json::from_str(&data).unwrap_or_else(|err| panic!("{err}: {data}"));
            }
            let frame = self
                .body
                .frame()
                .await
                .unwrap_or_else(|| panic!("the stream ended"))
                .unwrap_or_else(|err| panic!("{err}"));
            if let Ok(bytes) = frame.into_data() {
                self.buffer.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
    }
}

async fn post(app: &Router, session: u64, message: Value) -> StatusCode {
    let request = Request::builder()
        .method("POST")
        .uri(format!("/kits/bridge?session={session}"))
        .header("content-type", "application/json")
        .body(Body::from(message.to_string()))
        .unwrap_or_else(|err| panic!("{err}"));
    app.clone()
        .oneshot(request)
        .await
        .unwrap_or_else(|err| panic!("{err}"))
        .status()
}

#[tokio::test]
async fn the_agent_reaches_the_window_with_the_file_open() {
    let (app, kits) = app();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/kits/bridge")
                .body(Body::empty())
                .unwrap_or_else(|err| panic!("{err}")),
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut events = Events {
        body: response.into_body(),
        buffer: String::new(),
    };
    let ready = events.next().await;
    assert_eq!(ready["method"], "bridge.ready");
    let session = ready["params"]["session"]
        .as_u64()
        .unwrap_or_else(|| panic!("a session id"));

    // The window: lists its open drawing, then runs the agent's call.
    let window = {
        let app = app.clone();
        tokio::spawn(async move {
            let listing = events.next().await;
            assert_eq!(listing["method"], "kit/documents");
            let documents = json!({ "documents": [{ "path": "art/Logo.vectorcraft", "kit": "kit.vector", "dirty": false, "revision": 4 }] });
            assert_eq!(
                post(
                    &app,
                    session,
                    json!({ "jsonrpc": "2.0", "id": listing["id"], "result": documents })
                )
                .await,
                StatusCode::OK
            );
            let call = events.next().await;
            assert_eq!(call["method"], "kit/call");
            assert_eq!(call["params"]["tool"], "run");
            let result = json!({ "completed": [{ "command": "shape.ellipse", "changed": true, "result": null }], "saved": true });
            assert_eq!(
                post(
                    &app,
                    session,
                    json!({ "jsonrpc": "2.0", "id": call["id"], "result": result })
                )
                .await,
                StatusCode::OK
            );
            let changed = json!({ "jsonrpc": "2.0", "method": "kit.changed", "params": { "path": "art/Logo.vectorcraft", "revision": 5, "by": "agent" } });
            assert_eq!(post(&app, session, changed).await, StatusCode::OK);
            events
        })
    };

    let live = kits
        .bridge()
        .find("art/Logo.vectorcraft")
        .await
        .unwrap_or_else(|| panic!("the window has it open"));
    assert_eq!(
        (live.kit.as_str(), live.revision, live.session),
        ("kit.vector", 4, session)
    );
    let ran = kits
        .bridge()
        .call(
            &live,
            "run",
            json!({ "steps": [{ "command": "shape.ellipse" }], "save": true }),
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(ran["completed"][0]["changed"], true);
    let events = window.await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(
        kits.bridge().last_change("art/Logo.vectorcraft"),
        Some((5, "agent".to_owned()))
    );

    // An answer to no request, or from no session, is refused.
    assert_eq!(
        post(
            &app,
            session,
            json!({ "jsonrpc": "2.0", "id": 999, "result": {} })
        )
        .await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        post(
            &app,
            session + 100,
            json!({ "jsonrpc": "2.0", "id": 1, "result": {} })
        )
        .await,
        StatusCode::NOT_FOUND
    );

    // When the window's stream goes away, the agent falls back to the headless kit.
    drop(events);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(!kits.bridge().connected());
    assert!(kits.bridge().find("art/Logo.vectorcraft").await.is_none());
}

#[tokio::test]
async fn the_agent_edits_a_document_open_in_a_window() {
    let (app, kits) = app();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/kits/bridge")
                .body(Body::empty())
                .unwrap_or_else(|err| panic!("{err}")),
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let mut events = Events {
        body: response.into_body(),
        buffer: String::new(),
    };
    let session = events.next().await["params"]["session"]
        .as_u64()
        .unwrap_or_else(|| panic!("a session id"));
    let announced = json!({ "jsonrpc": "2.0", "method": "documents.open", "params": { "paths": ["Notes/Plan.md"] } });
    check_contract("bridgeDocumentsOpen", &announced["params"]);
    assert_eq!(post(&app, session, announced).await, StatusCode::OK);
    assert_eq!(
        kits.bridge().document_window("Notes/Plan.md"),
        Some(session)
    );

    let window = {
        let app = app.clone();
        tokio::spawn(async move {
            let apply = events.next().await;
            assert_eq!(apply["method"], "document/apply");
            check_contract("bridgeDocumentApplyParams", &apply["params"]);
            assert_eq!(
                apply["params"],
                json!({ "path": "Notes/Plan.md", "content": "# Plan\n", "tool": "document_write" })
            );
            let result = json!({ "applied": true, "content": "# Plan\n" });
            check_contract("bridgeDocumentApplyResult", &result);
            assert_eq!(
                post(
                    &app,
                    session,
                    json!({ "jsonrpc": "2.0", "id": apply["id"], "result": result })
                )
                .await,
                StatusCode::OK
            );
            events
        })
    };
    let applied = kits
        .bridge()
        .apply_document(
            session,
            &kition_kits::DocumentApply {
                path: "Notes/Plan.md".into(),
                content: "# Plan\n".into(),
                tool: "document_write".into(),
                turn_id: None,
            },
            kition_kits::document_bridge::DOCUMENT_APPLY_TIMEOUT,
        )
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(
        (applied.applied, applied.content.as_deref()),
        (true, Some("# Plan\n"))
    );
    drop(window.await.unwrap_or_else(|err| panic!("{err}")));
    for (def, valid, invalid) in [
        (
            "bridgeDocumentApplyResult",
            json!({ "applied": false, "reason": "not-open" }),
            json!({ "applied": true }),
        ),
        (
            "bridgeDocumentReadResult",
            json!({ "open": true, "content": "" }),
            json!({ "open": false, "content": "x" }),
        ),
        (
            "bridgeDocumentReadParams",
            json!({ "path": "Notes/Plan.md" }),
            json!({ "path": "../Plan.md" }),
        ),
    ] {
        check_contract(def, &valid);
        let mut schema: Value =
            serde_json::from_str(include_str!("../../../contracts/runtime/kits.schema.json"))
                .unwrap_or_else(|err| panic!("{err}"));
        schema["$ref"] = json!(format!("#/$defs/{def}"));
        assert!(
            !jsonschema::is_valid(&schema, &invalid),
            "{def} accepts {invalid}"
        );
    }
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(kits.bridge().document_window("Notes/Plan.md"), None);
}
