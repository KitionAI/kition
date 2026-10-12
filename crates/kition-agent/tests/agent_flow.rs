//! A streamed agent turn against a fake provider (Responses or Chat
//! Completions): the model asks for `artifact_write`, the runtime runs it,
//! and the model then answers.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use axum::Router;
use axum::body::Body;
use axum::routing::post;
use http::Request;
use http_body_util::BodyExt;
use kition_agent::{Agent, AgentConfig, AgentState, router};
use kition_ai::engine::Engine;
use kition_http::AuthConfig;
use kition_store::Db;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tower::ServiceExt;

fn sse(events: &[Value]) -> String {
    events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>()
        + "data: [DONE]\n\n"
}

fn tool_call(name: &str, arguments: Value) -> String {
    let item = json!({
        "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": name,
        "arguments": arguments.to_string(),
    });
    sse(&[
        json!({ "type": "response.output_item.done", "output_index": 0, "item": item }),
        json!({ "type": "response.completed", "response": { "status": "completed", "output": [item] } }),
    ])
}

fn answer(parts: &[&str]) -> String {
    let mut events: Vec<Value> = parts
        .iter()
        .map(|part| json!({ "type": "response.output_text.delta", "delta": part }))
        .collect();
    events.push(json!({ "type": "response.completed", "response": { "status": "completed", "output": [] } }));
    sse(&events)
}

/// A Chat Completions tool call to `name`, split across chunks.
fn chat_tool_call(name: &str, arguments: Value) -> String {
    let arguments = arguments.to_string();
    let (head, tail) = arguments.split_at(arguments.len() / 2);
    sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "role": "assistant", "reasoning_content": "Save the plan." } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
            { "index": 0, "id": "call_1", "type": "function", "function": { "name": name, "arguments": head } },
        ] } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": tail } },
        ] } }] }),
        json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }] }),
        json!({ "choices": [], "usage": { "prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13 } }),
    ])
}

fn chat_answer(parts: &[&str]) -> String {
    let mut chunks: Vec<Value> = parts
        .iter()
        .map(|part| json!({ "choices": [{ "index": 0, "delta": { "content": part } }] }))
        .collect();
    chunks.push(json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] }));
    sse(&chunks)
}

/// Serves the scripted Responses bodies in order.
async fn fake_provider(script: Vec<String>) -> String {
    fake_provider_at("/responses", script).await
}

/// Serves the scripted bodies in order at `path`.
async fn fake_provider_at(path: &str, script: Vec<String>) -> String {
    recording_provider_at(path, script).await.0
}

/// Every request body a fake provider received, in order.
type Bodies = Arc<Mutex<Vec<Value>>>;

/// Serves the scripted Responses bodies in order and records each request.
async fn recording_provider(script: Vec<String>) -> (String, Bodies) {
    recording_provider_at("/responses", script).await
}

/// Serves the scripted bodies in order at `path` and records each request.
async fn recording_provider_at(path: &str, script: Vec<String>) -> (String, Bodies) {
    let calls = Arc::new(AtomicUsize::new(0));
    let script = Arc::new(script);
    let bodies = Bodies::default();
    let recorded = bodies.clone();
    let app = Router::new().route(
        path,
        post(move |request: axum::body::Bytes| {
            let (calls, script, recorded) = (calls.clone(), script.clone(), recorded.clone());
            async move {
                recorded
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(serde_json::from_slice(&request).unwrap_or_default());
                let index = calls.fetch_add(1, Ordering::SeqCst);
                let body = script
                    .get(index)
                    .cloned()
                    .unwrap_or_else(|| answer(&["(script exhausted)"]));
                ([(http::header::CONTENT_TYPE, "text/event-stream")], body)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let addr = listener.local_addr().unwrap_or_else(|err| panic!("{err}"));
    tokio::spawn(async move { axum::serve(listener, app).await });
    (format!("http://{addr}"), bodies)
}

async fn call(app: &Router, method: &str, uri: &str, body: Value) -> (u16, Vec<u8>) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|err| panic!("{err}"));
    let response = app
        .clone()
        .oneshot(request)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .map(|body| body.to_bytes().to_vec())
        .unwrap_or_default();
    (status, bytes)
}

fn data(bytes: &[u8]) -> Value {
    serde_json::from_slice::<Value>(bytes).unwrap_or_default()["data"].clone()
}

struct Fixture {
    app: Router,
    db: Db,
    workspace: tempfile::TempDir,
    _uploads: tempfile::TempDir,
    _config: tempfile::TempDir,
}

fn app() -> Fixture {
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let uploads = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let config = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    kition_store::seed::run(&db.conn().unwrap_or_else(|err| panic!("{err}")))
        .unwrap_or_else(|err| panic!("{err}"));
    let agent = Agent::new(AgentConfig {
        db: db.clone(),
        engine: Engine::new(uploads.path().to_path_buf(), None),
        workspace_dir: workspace.path().to_path_buf(),
        upload_dir: uploads.path().to_path_buf(),
        policy_path: Some(config.path().join("execpolicy.toml")),
        hooks: None,
        smtp: None,
        tables: None,
        portal_base_url: String::new(),
        mcp_path: None,
        workflow_prompt: None,
        kits: None,
    });
    let db_handle = db.clone();
    let app = router(AgentState {
        auth: AuthConfig {
            db,
            jwt_secret: "test".into(),
            disabled: true,
        },
        agent,
        ai_gate: Arc::new(|| true),
    });
    Fixture {
        app,
        db: db_handle,
        workspace,
        _uploads: uploads,
        _config: config,
    }
}

async fn new_session(app: &Router) -> i64 {
    let (status, body) = call(
        app,
        "POST",
        "/agent/sessions",
        json!({ "language": "English" }),
    )
    .await;
    assert_eq!(status, 200);
    data(&body)["id"].as_i64().unwrap_or_default()
}

async fn stream(app: &Router, session_id: i64, base_url: &str, extra: Value) -> Vec<Value> {
    stream_on(app, session_id, base_url, "responses", extra).await
}

async fn stream_on(
    app: &Router,
    session_id: i64,
    base_url: &str,
    wire_api: &str,
    extra: Value,
) -> Vec<Value> {
    let mut body = json!({
        "content": "Write a short plan",
        "runtime_model": { "provider_type": "custom", "model_name": "test-model", "base_url": base_url, "wire_api": wire_api, "api_key": "k" },
    });
    if let (Some(body), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        body.extend(extra.clone());
    }
    let (status, bytes) = call(
        app,
        "POST",
        &format!("/agent/sessions/{session_id}/messages/stream"),
        body,
    )
    .await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// A `/responses` provider whose first call signals `entered` and waits for
/// `release`; every call then answers with plain text.
async fn blocking_provider(entered: Arc<Notify>, release: Arc<Notify>) -> String {
    let calls = Arc::new(AtomicUsize::new(0));
    let app = Router::new().route(
        "/responses",
        post(move || {
            let (calls, entered, release) = (calls.clone(), entered.clone(), release.clone());
            async move {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    entered.notify_one();
                    release.notified().await;
                }
                (
                    [(http::header::CONTENT_TYPE, "text/event-stream")],
                    answer(&["Done."]),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let addr = listener.local_addr().unwrap_or_else(|err| panic!("{err}"));
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://{addr}")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_turn_is_refused_while_the_first_runs() {
    let Fixture { app, .. } = app();
    let session_id = new_session(&app).await;
    let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let base_url = blocking_provider(entered.clone(), release.clone()).await;
    let first = {
        let (app, base_url) = (app.clone(), base_url.clone());
        tokio::spawn(async move { stream(&app, session_id, &base_url, json!({})).await })
    };
    entered.notified().await;
    let body = json!({
        "content": "And another thing",
        "runtime_model": { "provider_type": "custom", "model_name": "test-model", "base_url": base_url, "wire_api": "responses", "api_key": "k" },
    });
    let uri = format!("/agent/sessions/{session_id}/messages/stream");
    let (status, bytes) = call(&app, "POST", &uri, body.clone()).await;
    assert_eq!(status, 409, "{}", String::from_utf8_lossy(&bytes));
    assert!(
        String::from_utf8_lossy(&bytes).contains("still answering"),
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    release.notify_one();
    let frames = first.await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(
        frames.last().cloned().unwrap_or_default()["type"],
        "done",
        "{frames:?}"
    );
    let (status, _) = call(&app, "POST", &uri, body).await;
    assert_eq!(status, 200, "the session is free once the first turn ends");
}

/// A 1x1 PNG.
const PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/// A provider whose image endpoint returns one pixel and whose `/responses`
/// endpoint records each request and answers with plain text.
async fn image_and_text_provider() -> (String, Bodies) {
    let bodies = Bodies::default();
    let recorded = bodies.clone();
    let app = Router::new()
        .route(
            "/images/generations",
            post(|| async { axum::Json(json!({ "data": [{ "b64_json": PIXEL_PNG }] })) }),
        )
        .route(
            "/responses",
            post(move |request: axum::body::Bytes| {
                let recorded = recorded.clone();
                async move {
                    recorded
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(serde_json::from_slice(&request).unwrap_or_default());
                    (
                        [(http::header::CONTENT_TYPE, "text/event-stream")],
                        answer(&["It is a fox."]),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let addr = listener.local_addr().unwrap_or_else(|err| panic!("{err}"));
    tokio::spawn(async move { axum::serve(listener, app).await });
    (format!("http://{addr}"), bodies)
}

#[tokio::test(flavor = "multi_thread")]
async fn an_image_exchange_is_history_for_the_next_turn() {
    let Fixture { app, .. } = app();
    let session_id = new_session(&app).await;
    let (base_url, bodies) = image_and_text_provider().await;
    // A first ordinary turn, so the session already has an event log.
    let frames = stream(&app, session_id, &base_url, json!({ "content": "Hello" })).await;
    assert_eq!(
        frames.last().cloned().unwrap_or_default()["type"],
        "done",
        "{frames:?}"
    );
    let frames = stream(
        &app,
        session_id,
        &base_url,
        json!({
            "content": "A red fox",
            "image_generation_intent": {
                "type": "image_generation.intent", "schema_version": 1, "request_id": "req-1",
                "operation": "generate", "instruction": "A red fox", "locale": "en-US",
                "aspect_ratio": "1:1", "quality": "low", "resolution": "1K", "variants": 1,
                "text_mode": "no_text", "reference_paths": [], "surface": "chat",
                "target": { "type": "image.target.chat" }, "placement_preference": "review",
                "client_capability_version": 1,
            },
        }),
    )
    .await;
    let done = frames.last().cloned().unwrap_or_default();
    let reply = done["extra_data"]["message"]["content"].clone();
    assert!(reply.is_string(), "{frames:?}");
    let events = session_events(&app, session_id).await;
    let composer = events
        .iter()
        .rposition(|event| event["type"] == "turn/start")
        .unwrap_or_default();
    let turn: Vec<&Value> = events[composer..].iter().collect();
    let kinds: Vec<&str> = turn.iter().filter_map(|e| e["type"].as_str()).collect();
    assert_eq!(
        kinds,
        [
            "turn/start",
            "step/start",
            "user/message",
            "tool/call",
            "tool/result",
            "deliverables/presented",
            "assistant/message",
            "step/end",
            "turn/end",
        ],
        "{turn:?}"
    );
    assert_eq!(turn[0]["turn"], 2);
    assert_eq!(turn[2]["content"][0]["text"], "A red fox");
    assert_eq!(turn[2]["source"]["kind"], "user");
    let call_id = turn[3]["callId"].as_str().unwrap_or_default();
    assert!(
        call_id.starts_with("img_") && call_id.ends_with("_0"),
        "{call_id}"
    );
    assert_eq!(turn[3]["name"], "image_generation");
    assert_eq!(turn[3]["arguments"]["request_id"], "req-1");
    assert_eq!(turn[3]["arguments"]["variant_index"], 0);
    assert_eq!(turn[3]["arguments"]["variant_count"], 1);
    assert_eq!(turn[3]["arguments"]["reference_count"], 0);
    assert_eq!(
        turn[3]["arguments"]["intent_sha256"].as_str().map(str::len),
        Some(64)
    );
    assert_eq!(turn[4]["callId"], call_id);
    assert_eq!(turn[4]["isError"], false);
    assert_eq!(turn[4]["meta"]["kind"], "image_generation.variant");
    assert_eq!(turn[4]["meta"]["request_id"], "req-1");
    assert_eq!(turn[4]["meta"]["artifact"]["call_id"], call_id);
    assert_eq!(turn[4]["value"], turn[4]["meta"]["artifact"]);
    let path = turn[4]["meta"]["artifact"]["path"].clone();
    assert_eq!(turn[5]["files"][0]["path"], path);
    assert_eq!(turn[6]["content"], reply);
    assert_eq!(turn[8]["reason"], "completed");
    check_image_contract("variantMeta", &turn[4]["meta"]);
    check_image_contract("variantCall", &turn[3]["arguments"]);

    let intent = json!({
        "type": "image_generation.intent", "schema_version": 1, "request_id": "req-1",
        "operation": "generate", "instruction": "A red fox", "locale": "en-US",
        "aspect_ratio": "1:1", "quality": "low", "resolution": "1K", "variants": 1,
        "text_mode": "no_text", "reference_paths": [], "surface": "chat",
        "target": { "type": "image.target.chat" }, "placement_preference": "review",
        "client_capability_version": 1,
    });
    let before = events.len();
    stream(
        &app,
        session_id,
        &base_url,
        json!({ "content": "A red fox", "image_generation_intent": intent }),
    )
    .await;
    assert_eq!(
        session_events(&app, session_id).await.len(),
        before,
        "a repeat appends nothing"
    );
    let mut changed = intent.clone();
    changed["quality"] = json!("high");
    let (status, _) = call(
        &app,
        "POST",
        &format!("/agent/sessions/{session_id}/messages/stream"),
        json!({ "content": "A red fox", "image_generation_intent": changed }),
    )
    .await;
    assert_eq!(status, 409, "a request id names one set of settings");

    let frames = stream(
        &app,
        session_id,
        &base_url,
        json!({ "content": "What did you draw?" }),
    )
    .await;
    assert_eq!(
        frames.last().cloned().unwrap_or_default()["type"],
        "done",
        "{frames:?}"
    );
    let bodies = bodies.lock().unwrap_or_else(PoisonError::into_inner);
    assert_eq!(bodies.len(), 2, "two ordinary turns reach the model");
    let history = Value::Array(conversation(&bodies[1])).to_string();
    assert!(history.contains("A red fox"), "{history}");
    assert!(
        history.contains(reply.as_str().unwrap_or_default()),
        "{history}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_stops_at_the_step_limit() {
    let Fixture { app, .. } = app();
    let session_id = new_session(&app).await;
    let script = (0..20)
        .map(|_| tool_call("document_list", json!({})))
        .collect();
    let base_url = fake_provider(script).await;
    let frames = stream(&app, session_id, &base_url, json!({})).await;
    let error = frames
        .iter()
        .find(|frame| frame["type"] == "error")
        .cloned()
        .unwrap_or_default();
    assert!(
        error
            .to_string()
            .contains("the turn exceeded 16 model steps; narrow the task or clarify the next step"),
        "{frames:?}"
    );
}

/// A provider whose image endpoint signals `entered` and never answers,
/// while `/responses` answers with plain text.
async fn stuck_image_provider(entered: Arc<Notify>) -> String {
    let app = Router::new()
        .route(
            "/images/generations",
            post(move || {
                let entered = entered.clone();
                async move {
                    entered.notify_one();
                    std::future::pending::<()>().await;
                    ""
                }
            }),
        )
        .route(
            "/responses",
            post(|| async {
                (
                    [(http::header::CONTENT_TYPE, "text/event-stream")],
                    answer(&["Done."]),
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let addr = listener.local_addr().unwrap_or_else(|err| panic!("{err}"));
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://{addr}")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disconnected_image_turn_releases_its_session() {
    let Fixture { app, .. } = app();
    let session_id = new_session(&app).await;
    let entered = Arc::new(Notify::new());
    let base_url = stuck_image_provider(entered.clone()).await;
    let model = json!({ "provider_type": "custom", "model_name": "test-model", "base_url": base_url, "wire_api": "responses", "api_key": "k" });
    let uri = format!("/agent/sessions/{session_id}/messages/stream");
    let body = json!({
        "content": "A red fox",
        "runtime_model": model,
        "image_generation_intent": {
            "type": "image_generation.intent", "schema_version": 1, "request_id": "req-1",
            "operation": "generate", "instruction": "A red fox", "locale": "en-US",
            "aspect_ratio": "1:1", "quality": "low", "resolution": "1K", "variants": 1,
            "text_mode": "no_text", "reference_paths": [], "surface": "chat",
            "target": { "type": "image.target.chat" }, "placement_preference": "review",
            "client_capability_version": 1,
        },
    });
    let request = Request::builder()
        .method("POST")
        .uri(&uri)
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|err| panic!("{err}"));
    let response = app
        .clone()
        .oneshot(request)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(response.status(), 200);
    tokio::time::timeout(std::time::Duration::from_secs(10), entered.notified())
        .await
        .unwrap_or_else(|err| panic!("the image call never started: {err}"));
    drop(response);

    let retry = json!({ "content": "And now text", "runtime_model": model });
    let mut status = 0;
    for _ in 0..20 {
        status = call(&app, "POST", &uri, retry.clone()).await.0;
        if status != 409 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(status, 200, "the session stays busy after the client left");
    let events = session_events(&app, session_id).await;
    let of_image_turn = |kind: &str| -> Vec<&Value> {
        events
            .iter()
            .filter(|e| e["type"] == kind && e["turn"] == 1)
            .collect()
    };
    assert_eq!(of_image_turn("turn/start").len(), 1, "{events:?}");
    let ends = of_image_turn("turn/end");
    assert_eq!(ends.len(), 1, "{events:?}");
    assert_eq!(ends[0]["reason"], "cancelled", "{events:?}");
    assert_eq!(of_image_turn("step/end").len(), 1, "{events:?}");
    let stopped = events
        .iter()
        .find(|e| e["type"] == "tool/result" && e["name"] == "image_generation")
        .cloned()
        .unwrap_or_default();
    assert_eq!(stopped["isError"], true, "{events:?}");
}

/// Validates `instance` against one `$defs` entry of the image generation contract.
fn check_image_contract(def: &str, instance: &Value) {
    let mut schema: Value = serde_json::from_str(include_str!(
        "../../../contracts/runtime/agent-image-generation.schema.json"
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

#[tokio::test(flavor = "multi_thread")]
async fn streams_a_turn_over_chat_completions() {
    let Fixture { app, workspace, .. } = app();
    let session_id = new_session(&app).await;
    let base_url = fake_provider_at(
        "/chat/completions",
        vec![
            chat_tool_call(
                "artifact_write",
                json!({ "path": "Notes/plan.md", "content": "# Plan\n\nShip it." }),
            ),
            chat_answer(&["Saved ", "`Notes/plan.md`."]),
        ],
    )
    .await;
    let frames = stream_on(&app, session_id, &base_url, "chat_completions", json!({})).await;
    let kinds: Vec<&str> = frames.iter().filter_map(|f| f["type"].as_str()).collect();
    assert!(!kinds.contains(&"error"), "{frames:?}");
    assert!(kinds.contains(&"artifact"), "{kinds:?}");
    assert!(kinds.contains(&"model_delta"), "{kinds:?}");
    let done = frames.last().cloned().unwrap_or_default();
    assert_eq!(done["type"], "done", "{frames:?}");
    assert_eq!(
        done["extra_data"]["message"]["content"],
        "Saved `Notes/plan.md`."
    );
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("Notes/plan.md")).unwrap_or_default(),
        "# Plan\n\nShip it."
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_a_turn_with_a_tool_call() {
    let Fixture {
        app, db, workspace, ..
    } = app();
    let session_id = new_session(&app).await;
    let base_url = fake_provider(vec![
        tool_call(
            "artifact_write",
            json!({ "path": "Notes/plan.md", "content": "# Plan\n\nShip it." }),
        ),
        answer(&["Saved ", "`Notes/plan.md`."]),
    ])
    .await;
    let frames = stream(&app, session_id, &base_url, json!({})).await;
    let kinds: Vec<&str> = frames.iter().filter_map(|f| f["type"].as_str()).collect();
    assert_eq!(kinds.first(), Some(&"started"), "{kinds:?}");
    assert!(kinds.contains(&"user_message"));
    assert!(kinds.contains(&"artifact"), "{kinds:?}");
    assert!(kinds.contains(&"model_delta"));
    assert!(!kinds.contains(&"error"), "{frames:?}");
    let done = frames.last().cloned().unwrap_or_default();
    assert_eq!(done["type"], "done");
    assert_eq!(
        done["extra_data"]["message"]["content"],
        "Saved `Notes/plan.md`."
    );
    assert_eq!(done["extra_data"]["artifact"]["path"], "Notes/plan.md");
    assert_eq!(done["extra_data"]["session"]["status"], "idle");
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("Notes/plan.md")).unwrap_or_default(),
        "# Plan\n\nShip it."
    );

    let (_, body) = call(
        &app,
        "GET",
        &format!("/agent/sessions/{session_id}/tool-calls"),
        json!({}),
    )
    .await;
    let calls = data(&body)["items"].clone();
    assert_eq!(calls[0]["tool_name"], "artifact_write");
    assert_eq!(calls[0]["status"], "completed");
    let (_, body) = call(
        &app,
        "GET",
        &format!("/agent/sessions/{session_id}/messages"),
        json!({}),
    )
    .await;
    assert_eq!(data(&body)["items"].as_array().map(Vec::len), Some(2));
    let (_, body) = call(
        &app,
        "GET",
        &format!("/agent/sessions/{session_id}/events"),
        json!({}),
    )
    .await;
    let events: Vec<String> = data(&body)["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e["event_type"].as_str().map(str::to_owned))
        .collect();
    for expected in [
        "task.created",
        "tool.requested",
        "artifact.created",
        "tool.completed",
        "task.completed",
    ] {
        assert!(
            events.iter().any(|e| e == expected),
            "missing {expected} in {events:?}"
        );
    }

    let (status, _) = call(&app, "GET", "/agent/sessions/999/messages", json!({})).await;
    assert_eq!(status, 404);
    let (status, body) = call(&app, "GET", "/agent/capabilities", json!({})).await;
    assert_eq!(status, 200);
    assert!(
        data(&body)["tools"]
            .as_array()
            .is_some_and(|tools| tools.len() > 30)
    );

    let log = kition_harness::log::SqliteLog::new(db.clone());
    let events = kition_harness::log::SessionLog::read(&log, &format!("agent:{session_id}"))
        .unwrap_or_else(|error| panic!("{error}"));
    let kinds: Vec<&str> = events.iter().map(|event| event.body.kind()).collect();
    assert_eq!(kinds.first(), Some(&"turn/start"), "{kinds:?}");
    assert!(kinds.contains(&"tool/result"), "{kinds:?}");
    assert_eq!(kinds.last(), Some(&"turn/end"), "{kinds:?}");
    assert_session_events_api(&app, session_id).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn requests_without_a_usable_model_are_refused_before_streaming() {
    let Fixture { app, .. } = app();
    let session_id = new_session(&app).await;
    let uri = format!("/agent/sessions/{session_id}/messages/stream");
    let (status, body) = call(&app, "POST", &uri, json!({ "content": "hi" })).await;
    assert_eq!(status, 400, "{}", String::from_utf8_lossy(&body));
    assert!(String::from_utf8_lossy(&body).contains("Configure a text model"));
    let (status, body) = call(
        &app,
        "POST",
        &uri,
        json!({ "content": "hi", "runtime_model": { "model_name": "m", "wire_api": "completions" } }),
    )
    .await;
    assert_eq!(status, 400);
    assert!(String::from_utf8_lossy(&body).contains("no longer supported"));
    assert!(session_events(&app, session_id).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn hosted_search_and_image_calls_are_logged() {
    let Fixture { app, workspace, .. } = app();
    let session_id = new_session(&app).await;
    let output = json!([
        { "type": "web_search_call", "id": "ws_1", "status": "completed",
          "action": { "type": "search", "query": "fox facts" } },
        { "type": "image_generation_call", "id": "ig_1", "status": "completed",
          "result": PIXEL_PNG, "size": "1024x1024" },
        { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Here is a fox." }] },
    ]);
    let hosted = sse(&[
        json!({ "type": "response.output_text.delta", "delta": "Here is a fox." }),
        json!({ "type": "response.completed", "response": { "status": "completed", "output": output } }),
    ]);
    let base_url = fake_provider(vec![hosted, answer(&["Done."])]).await;
    stream(
        &app,
        session_id,
        &base_url,
        json!({ "content": "Draw a fox" }),
    )
    .await;
    let events = session_events(&app, session_id).await;
    let kinds: Vec<&str> = events.iter().filter_map(|e| e["type"].as_str()).collect();
    let message = kinds
        .iter()
        .position(|kind| *kind == "assistant/message")
        .unwrap_or_else(|| panic!("{kinds:?}"));
    assert_eq!(
        &kinds[message..message + 7],
        [
            "assistant/message",
            "tool/call",
            "tool/result",
            "tool/call",
            "tool/result",
            "deliverables/presented",
            "user/message",
        ],
        "{events:?}"
    );
    let search = &events[message + 1];
    assert_eq!(
        (search["name"].as_str(), search["callId"].as_str()),
        (Some("web_search"), Some("ws_1"))
    );
    assert_eq!(search["arguments"]["query"], "fox facts");
    assert_eq!(events[message + 2]["meta"]["hosted"], true);
    assert_eq!(events[message + 2]["isError"], false);
    assert_eq!(events[message + 3]["name"], "image_generation");
    let image = &events[message + 5];
    assert_eq!(image["callId"], "ig_1");
    let path = image["files"][0]["path"].as_str().unwrap_or_default();
    assert!(workspace.path().join(path).is_file(), "{path}");
    assert_eq!(events[message + 6]["source"]["kind"], "tool-follow-up");
}

/// The session's logged events through `GET /session-events`, each checked
/// against the contract.
async fn session_events(app: &Router, session_id: i64) -> Vec<Value> {
    let uri = format!("/agent/sessions/{session_id}/session-events");
    let (status, body) = call(app, "GET", &uri, json!({})).await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let items = data(&body)["items"].as_array().cloned().unwrap_or_default();
    for item in &items {
        check_session_events_contract("sessionEvent", item);
    }
    items
}

#[tokio::test(flavor = "multi_thread")]
async fn a_document_write_presents_the_document_after_its_result() {
    let Fixture { app, workspace, .. } = app();
    std::fs::create_dir_all(workspace.path().join("Notes")).unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("Notes/plan.md"), "old")
        .unwrap_or_else(|err| panic!("{err}"));
    let session_id = new_session(&app).await;
    let base_url = fake_provider(vec![
        tool_call(
            "document_write",
            json!({ "path": "Notes/plan.md", "content": "# Plan" }),
        ),
        answer(&["Updated."]),
    ])
    .await;
    stream(&app, session_id, &base_url, json!({})).await;
    let events = session_events(&app, session_id).await;
    let result = events
        .iter()
        .position(|event| event["type"] == "tool/result" && event["name"] == "document_write")
        .unwrap_or_else(|| panic!("no document_write result: {events:?}"));
    let presented = &events[result + 1];
    assert_eq!(presented["type"], "deliverables/presented", "{events:?}");
    assert_eq!(presented["callId"], "call_1");
    assert_eq!(presented["turn"], 1);
    assert_eq!(presented["files"][0]["path"], "Notes/plan.md");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_update_plan_call_logs_the_todo_list() {
    let Fixture { app, .. } = app();
    let session_id = new_session(&app).await;
    let base_url = fake_provider(vec![
        tool_call(
            "update_plan",
            json!({ "explanation": "Two steps", "plan": [
                { "step": "Draft", "status": "in_progress" },
                { "step": "Review", "status": "pending" },
            ] }),
        ),
        answer(&["Planned."]),
    ])
    .await;
    stream(&app, session_id, &base_url, json!({})).await;
    let events = session_events(&app, session_id).await;
    let todos = events
        .iter()
        .find(|event| event["type"] == "todo/write")
        .cloned()
        .unwrap_or_else(|| panic!("no todo/write: {events:?}"));
    assert_eq!(
        todos["todos"],
        json!([
            { "content": "Draft", "status": "in_progress" },
            { "content": "Review", "status": "pending" },
        ])
    );
}

/// A provider-native output item that carries a secret-looking string.
const RAW_SECRET: &str = "fake-raw-item-secret-4d1c";

#[tokio::test(flavor = "multi_thread")]
async fn the_session_events_api_keeps_provider_native_items_out() {
    let Fixture { app, db, .. } = app();
    let session_id = new_session(&app).await;
    let raw = json!({ "type": "provider_note", "id": "pn_1", "note": RAW_SECRET });
    let item = json!({
        "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "artifact_write",
        "arguments": json!({ "path": "Notes/plan.md", "content": "# Plan" }).to_string(),
    });
    let first = sse(&[
        json!({ "type": "response.output_item.done", "output_index": 1, "item": item }),
        json!({ "type": "response.completed", "response": { "status": "completed", "output": [raw, item] } }),
    ]);
    let base_url = fake_provider(vec![first, answer(&["Saved."])]).await;
    let frames = stream(&app, session_id, &base_url, json!({})).await;
    assert_eq!(
        frames.last().cloned().unwrap_or_default()["type"],
        "done",
        "{frames:?}"
    );

    let log = kition_harness::log::SqliteLog::new(db.clone());
    let stored = kition_harness::log::SessionLog::read(&log, &format!("agent:{session_id}"))
        .unwrap_or_else(|error| panic!("{error}"));
    let stored = serde_json::to_string(&stored).unwrap_or_default();
    assert!(
        stored.contains(RAW_SECRET),
        "the log keeps raw items for replay"
    );
    assert!(stored.contains("rawItems"));

    let uri = format!("/agent/sessions/{session_id}/session-events");
    let (status, body) = call(&app, "GET", &uri, json!({})).await;
    assert_eq!(status, 200);
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains(RAW_SECRET), "{text}");
    assert!(!text.contains("rawItems"), "{text}");
    let page = data(&body);
    check_session_events_contract("page", &page);
    assert!(
        page["items"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|event| event["type"] == "assistant/message"),
        "{page}"
    );
}

/// Validates `instance` against one `$defs` entry of the session events contract.
fn check_session_events_contract(def: &str, instance: &Value) {
    let mut schema: Value = serde_json::from_str(include_str!(
        "../../../contracts/runtime/agent-session-events.schema.json"
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

/// `GET /agent/sessions/{id}/session-events` pages the session event log.
async fn assert_session_events_api(app: &Router, session_id: i64) {
    let uri = format!("/agent/sessions/{session_id}/session-events");
    let (status, body) = call(app, "GET", &uri, json!({})).await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let page = data(&body);
    check_session_events_contract("page", &page);
    let items = page["items"].as_array().cloned().unwrap_or_default();
    assert_eq!(
        items.first().map(|e| e["type"].clone()),
        Some(json!("turn/start"))
    );
    assert_eq!(
        items.last().map(|e| e["type"].clone()),
        Some(json!("turn/end"))
    );
    for item in &items {
        check_session_events_contract("sessionEvent", item);
    }
    let seqs: Vec<u64> = items.iter().filter_map(|e| e["seq"].as_u64()).collect();
    assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]), "{seqs:?}");
    let last = seqs.last().copied().unwrap_or_default();
    assert_eq!(page["next_after"], json!(last));

    let middle = seqs.get(seqs.len() / 2).copied().unwrap_or_default();
    let (status, body) = call(app, "GET", &format!("{uri}?after={middle}"), json!({})).await;
    assert_eq!(status, 200);
    let rest = data(&body);
    assert_eq!(
        rest["items"][0]["seq"],
        json!(middle + 1),
        "the page starts after the given seq"
    );
    assert_eq!(rest["next_after"], json!(last));

    let (status, body) = call(app, "GET", &format!("{uri}?after={last}"), json!({})).await;
    assert_eq!(status, 200);
    let empty = data(&body);
    assert_eq!(empty["items"], json!([]));
    assert_eq!(empty["next_after"], json!(last));
    check_session_events_contract("page", &empty);

    let (status, _) = call(app, "GET", "/agent/sessions/999/session-events", json!({})).await;
    assert_eq!(status, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_outside_the_policy_wait_for_approval() {
    let Fixture { app, workspace, .. } = app();
    let session_id = new_session(&app).await;
    let command = json!({ "cmd": ["ls && touch approved.txt"], "shell": "sh" });
    let base_url = fake_provider(vec![
        tool_call("exec_command", command.clone()),
        tool_call("exec_command", command),
        answer(&["Done."]),
    ])
    .await;
    let frames = stream(&app, session_id, &base_url, json!({})).await;
    let done = frames.last().cloned().unwrap_or_default();
    assert_eq!(
        done["extra_data"]["awaiting_shell_approval"], true,
        "{frames:?}"
    );
    let pending = &done["extra_data"]["shell_approval_required"];
    assert_eq!(pending["requires"], "approval");
    let events = session_events(&app, session_id).await;
    let tail: Vec<&Value> = events.iter().rev().take(4).rev().collect();
    assert_eq!(tail[0]["type"], "tool/result", "{tail:?}");
    assert_eq!(tail[0]["meta"]["kind"], "shell.approval");
    assert_eq!(tail[0]["meta"]["command"], "ls && touch approved.txt");
    assert_eq!(tail[1]["type"], "approval/asked");
    assert_eq!(tail[1]["toolName"], "exec_command");
    assert_eq!(tail[1]["callId"], tail[0]["callId"]);
    assert_eq!(tail[2]["type"], "step/end");
    assert_eq!(tail[3]["type"], "turn/end");
    assert_eq!(tail[3]["reason"], "awaiting-approval");
    assert!(!workspace.path().join("approved.txt").exists());
    let tool_call_id = pending["tool_call_id"].as_i64().unwrap_or_default();

    let (status, _) = call(
        &app,
        "POST",
        &format!("/agent/sessions/{session_id}/messages/stream"),
        json!({ "content": "x", "shell_approval": { "tool_call_id": 9999, "decision": "allow_once" } }),
    )
    .await;
    assert_eq!(status, 400);

    let frames = stream(
        &app,
        session_id,
        &base_url,
        json!({
            "content": "Approved",
            "hide_user_message": true,
            "shell_approval": { "tool_call_id": tool_call_id, "decision": "allow_once" },
        }),
    )
    .await;
    let done = frames.last().cloned().unwrap_or_default();
    assert_eq!(
        done["extra_data"]["message"]["content"], "Done.",
        "{frames:?}"
    );
    assert!(workspace.path().join("approved.txt").exists());

    let uri = format!("/agent/sessions/{session_id}/session-events");
    let (_, body) = call(&app, "GET", &uri, json!({})).await;
    let items = data(&body)["items"].as_array().cloned().unwrap_or_default();
    for item in &items {
        check_session_events_contract("sessionEvent", item);
    }
    let sources: Vec<Value> = items
        .iter()
        .filter(|event| event["type"] == "user/message")
        .map(|event| event["source"]["kind"].clone())
        .collect();
    assert_eq!(sources, [json!("user"), json!("approval")]);
    let asked = items
        .iter()
        .find(|event| event["type"] == "approval/asked")
        .cloned()
        .unwrap_or_default();
    assert_eq!(asked["toolName"], "exec_command", "{asked}");
    assert_eq!(
        asked["id"],
        json!(format!(
            "approval:{}",
            asked["callId"].as_str().unwrap_or_default()
        ))
    );
}

/// The offered tools as `{ name, description, parameters }`, sorted by
/// name. Hosted tools (`web_search`, `image_generation` on Responses) carry
/// their type instead of a name and keep their whole object. Reads
/// Responses and Chat Completions tool shapes.
fn tools(body: &Value) -> Vec<Value> {
    let mut tools: Vec<(String, Value)> = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| {
            let spec = if tool["function"].is_object() {
                &tool["function"]
            } else {
                tool
            };
            let name = spec["name"]
                .as_str()
                .or_else(|| tool["type"].as_str())
                .unwrap_or_default()
                .to_owned();
            let normalized = if spec["name"].is_string() {
                json!({
                    "name": name,
                    "description": spec["description"],
                    "parameters": spec["parameters"],
                })
            } else {
                json!({ "name": name, "hosted": tool })
            };
            (name, normalized)
        })
        .collect();
    tools.sort_by(|a, b| a.0.cmp(&b.0));
    tools.into_iter().map(|(_, tool)| tool).collect()
}

/// Everything but the system prompt: the user's message with its parts.
fn conversation(body: &Value) -> Vec<Value> {
    body["input"]
        .as_array()
        .into_iter()
        .chain(body["messages"].as_array())
        .flatten()
        .filter(|item| item["role"] != "system" && item["role"] != "developer")
        .cloned()
        .collect()
}

/// The prompt as a sorted list of non-empty lines, duplicates kept,
/// without the tool list line, so how sections are joined does not matter.
/// Reads Responses `instructions` and system or developer items, and Chat
/// Completions system messages.
fn prompt_lines(body: &Value) -> Vec<String> {
    let mut text = body["instructions"].as_str().unwrap_or_default().to_owned();
    for item in body["input"]
        .as_array()
        .into_iter()
        .chain(body["messages"].as_array())
        .flatten()
    {
        if item["role"] == "system" || item["role"] == "developer" {
            text.push('\n');
            text.push_str(
                &item["content"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| item["content"].to_string()),
            );
        }
    }
    let mut lines: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("Available tools:"))
        .map(str::to_owned)
        .collect();
    lines.sort();
    lines
}

/// The first model request after writing `files` into the workspace, and
/// the workspace path.
async fn first_request_with(
    wire_api: &str,
    files: &[(&str, &[u8])],
    extra: Value,
) -> (Value, std::path::PathBuf) {
    let Fixture { app, workspace, .. } = app();
    for (path, bytes) in files {
        let path = workspace.path().join(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap_or_else(|err| panic!("{err}"));
        }
        std::fs::write(path, bytes).unwrap_or_else(|err| panic!("{err}"));
    }
    let session_id = new_session(&app).await;
    let (base_url, bodies) = if wire_api == "chat_completions" {
        recording_provider_at("/chat/completions", vec![chat_answer(&["ok"])]).await
    } else {
        recording_provider(vec![answer(&["ok"])]).await
    };
    let frames = stream_on(&app, session_id, &base_url, wire_api, extra).await;
    assert!(
        !frames.iter().any(|frame| frame["type"] == "error"),
        "{frames:?}"
    );
    let bodies = bodies.lock().unwrap_or_else(PoisonError::into_inner);
    let body = bodies.first().cloned().unwrap_or_default();
    (body, workspace.path().to_path_buf())
}

/// One pane scenario: a stable name, the wire API, workspace files, and
/// the request fields.
struct Scenario<'a> {
    name: String,
    wire_api: &'static str,
    files: &'a [(&'a str, &'a [u8])],
    extra: Value,
}

fn scenario<'a>(name: &str, wire_api: &'static str, extra: Value) -> Scenario<'a> {
    Scenario {
        name: name.to_owned(),
        wire_api,
        files: &[],
        extra,
    }
}

/// The tools, prompt lines, and user message of `body`, with every temp
/// path replaced by `<workspace>` so the expectation holds on any host.
fn expectation(body: &Value, temp_paths: &[std::path::PathBuf]) -> Value {
    let mut paths: Vec<String> = Vec::new();
    for path in temp_paths {
        if let Ok(real) = path.canonicalize() {
            paths.push(real.to_string_lossy().into_owned());
        }
        paths.push(path.to_string_lossy().into_owned());
    }
    // Longest first, so a canonical path is not left half replaced.
    paths.sort_by_key(|path| std::cmp::Reverse(path.len()));
    let mut text = json!({
        "tools": tools(body),
        "prompt": prompt_lines(body),
        "conversation": conversation(body),
    })
    .to_string();
    for path in paths.iter().filter(|path| !path.is_empty()) {
        text = text.replace(path.as_str(), "<workspace>");
    }
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("{err}"))
}

/// `value` with every object's keys sorted, so equal definitions serialize
/// the same way.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical(&map[key])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

/// The first 16 hex digits of the SHA-256 of a tool's canonical JSON.
fn tool_digest(tool: &Value) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(canonical(tool).to_string().as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `items` without one occurrence of each of `remove`.
fn without(items: &[String], remove: &[String]) -> Vec<String> {
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for item in remove {
        *counts.entry(item).or_default() += 1;
    }
    items
        .iter()
        .filter(|item| match counts.get_mut(item.as_str()) {
            Some(count) if *count > 0 => {
                *count -= 1;
                false
            }
            _ => true,
        })
        .cloned()
        .collect()
}

/// What one scenario sent: tool digests by name, sorted prompt lines, and
/// the user message.
struct Observed {
    tools: std::collections::BTreeMap<String, String>,
    prompt: Vec<String>,
    conversation: Value,
}

impl Observed {
    fn new(expectation: &Value) -> Self {
        let tools = expectation["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|tool| {
                (
                    tool["name"].as_str().unwrap_or_default().to_owned(),
                    tool_digest(tool),
                )
            })
            .collect();
        let prompt = expectation["prompt"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|line| line.as_str().map(str::to_owned))
            .collect();
        Self {
            tools,
            prompt,
            conversation: expectation["conversation"].clone(),
        }
    }
}

/// The golden file: the prompt lines every scenario shares, each tool's
/// digest, and per scenario its tool names, its other prompt lines, and
/// the user message.
fn golden_from(observed: &[(String, Observed)]) -> Value {
    let mut shared = observed
        .first()
        .map(|(_, first)| first.prompt.clone())
        .unwrap_or_default();
    for (_, scenario) in observed {
        let missing = without(&shared, &scenario.prompt);
        shared = without(&shared, &missing);
    }
    let mut tools = std::collections::BTreeMap::new();
    let mut scenarios = serde_json::Map::new();
    for (name, scenario) in observed {
        for (tool, digest) in &scenario.tools {
            if let Some(known) = tools.insert(tool.clone(), digest.clone()) {
                assert_eq!(&known, digest, "{tool} differs between scenarios");
            }
        }
        scenarios.insert(
            name.clone(),
            json!({
                "tools": scenario.tools.keys().collect::<Vec<_>>(),
                "prompt": without(&scenario.prompt, &shared),
                "conversation": scenario.conversation,
            }),
        );
    }
    json!({ "prompt": shared, "tools": tools, "scenarios": scenarios })
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
}

/// Every difference between `observed` and the golden data, readably.
fn golden_differences(golden: &Value, observed: &[(String, Observed)]) -> Vec<String> {
    let mut problems = Vec::new();
    let expected: std::collections::BTreeSet<String> = golden["scenarios"]
        .as_object()
        .map(|scenarios| scenarios.keys().cloned().collect())
        .unwrap_or_default();
    let ran: std::collections::BTreeSet<String> =
        observed.iter().map(|(name, _)| name.clone()).collect();
    if expected != ran {
        problems.push(format!(
            "scenarios differ: golden only {:?}, test only {:?}",
            expected.difference(&ran).collect::<Vec<_>>(),
            ran.difference(&expected).collect::<Vec<_>>()
        ));
    }
    let shared = strings(&golden["prompt"]);
    for (name, scenario) in observed {
        let entry = &golden["scenarios"][name];
        if !entry.is_object() {
            continue;
        }
        let names: Vec<String> = scenario.tools.keys().cloned().collect();
        let golden_names = strings(&entry["tools"]);
        let added = without(&names, &golden_names);
        let removed = without(&golden_names, &names);
        if !added.is_empty() || !removed.is_empty() {
            problems.push(format!(
                "{name}: tools added {added:?}, removed {removed:?}"
            ));
        }
        let changed: Vec<&String> = scenario
            .tools
            .iter()
            .filter(|(tool, digest)| {
                golden["tools"][tool.as_str()]
                    .as_str()
                    .is_some_and(|known| known != digest.as_str())
            })
            .map(|(tool, _)| tool)
            .collect();
        if !changed.is_empty() {
            problems.push(format!("{name}: tool definitions changed {changed:?}"));
        }
        let mut golden_prompt = shared.clone();
        golden_prompt.extend(strings(&entry["prompt"]));
        let added = without(&scenario.prompt, &golden_prompt);
        let removed = without(&golden_prompt, &scenario.prompt);
        if !added.is_empty() || !removed.is_empty() {
            problems.push(format!(
                "{name}: prompt lines added {added:#?}, removed {removed:#?}"
            ));
        }
        if scenario.conversation != entry["conversation"] {
            problems.push(format!(
                "{name}: user message {} instead of {}",
                scenario.conversation, entry["conversation"]
            ));
        }
    }
    problems
}

fn golden_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/panes.json")
}

#[tokio::test(flavor = "multi_thread")]
async fn panes_offer_the_expected_tools_and_prompt() {
    let mut scenarios: Vec<Scenario<'_>> = Vec::new();
    for pane in ["document", "table", "workflow", "gallery"] {
        scenarios.push(scenario(pane, "responses", json!({ "pane_context": pane })));
    }
    scenarios.push(scenario(
        "document-active-markdown",
        "responses",
        json!({ "pane_context": "document", "active_document_path": "Notes/a.md" }),
    ));
    scenarios.push(scenario(
        "document-active-psd",
        "responses",
        json!({ "pane_context": "document", "active_document_path": "art/Cover.psd" }),
    ));
    scenarios.push(scenario(
        "document-preview-table-task",
        "responses",
        json!({ "pane_context": "document", "execution_mode": "preview", "task_mode": "table" }),
    ));
    scenarios.push(scenario(
        "table-plan-and-prompt-context",
        "responses",
        json!({
            "pane_context": "table",
            "prompt_context": "Extra context from the client.",
            "table_plan_context": { "summary": "Import", "final_unique_by": ["url"], "estimated_create": 2 },
        }),
    ));
    scenarios.push(scenario(
        "workflow-active",
        "responses",
        json!({ "pane_context": "workflow", "active_workflow_id": "wf-1" }),
    ));
    scenarios.push(scenario(
        "table-active-research",
        "responses",
        json!({ "pane_context": "table", "active_data_document_id": 1, "active_data_table_id": 2, "execution_mode": "research" }),
    ));
    scenarios.push(scenario(
        "document-active-data-document",
        "responses",
        json!({ "pane_context": "document", "active_data_document_id": 1 }),
    ));
    scenarios.push(scenario(
        "whiteboard-context",
        "responses",
        json!({
            "pane_context": "whiteboard",
            "whiteboard_context": {
                "type": "whiteboard.context", "schema_version": 1,
                "board": { "id": "b1", "path": "Boards/a.kiboard", "title": "A" },
                "scope": "viewport", "viewport": {}, "selected_element_ids": [],
                "elements": [{ "id": "n1", "kind": "mind_node" }], "clusters": [], "recent_operations": [],
            },
        }),
    ));
    scenarios.push(scenario(
        "whiteboard",
        "responses",
        json!({ "pane_context": "whiteboard" }),
    ));
    scenarios.push(scenario(
        "design-context",
        "responses",
        json!({
            "pane_context": "design",
            "design_context": {
                "type": "design.context", "schema_version": 1,
                "design": { "id": "d1", "path": "a.kidesign", "title": "A" },
                "artboard": { "width": 800, "height": 600, "background": "#ffffff" },
                "selected_layer_ids": [], "recent_operations": [],
                "layers": [{ "id": "t1", "kind": "text" }, { "id": "bg", "kind": "rectangle", "locked": true }],
            },
        }),
    ));
    scenarios.push(scenario(
        "design",
        "responses",
        json!({ "pane_context": "design" }),
    ));
    let plain = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(plain.path().join("AGENTS.md"), "Prefer small diffs.")
        .unwrap_or_else(|err| panic!("{err}"));
    let git = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let status = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(git.path())
        .status()
        .unwrap_or_else(|err| panic!("{err}"));
    assert!(status.success());
    let source = |id: &str, dir: &tempfile::TempDir| json!({ "id": id, "label": id, "root_path": dir.path().to_string_lossy(), "access": "read" });
    scenarios.push(scenario(
        "local-source",
        "responses",
        json!({ "local_sources": [source("notes", &plain)] }),
    ));
    scenarios.push(scenario(
        "table-local-sources-with-git",
        "responses",
        json!({ "pane_context": "table", "local_sources": [source("notes", &plain), source("repo", &git)] }),
    ));
    // Attachments: a file the runtime cannot extract and an image, so the
    // attachment block and the image parts of the user message both show.
    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R',
    ];
    let files: &[(&str, &[u8])] = &[
        ("Notes/brief.md", b"# Brief\n\nShip it."),
        ("Images/dot.png", PNG),
    ];
    let attached = json!({ "attachment_paths": ["Notes/brief.md", "Images/dot.png"] });
    for wire_api in ["responses", "chat_completions"] {
        scenarios.push(Scenario {
            name: format!("attachments-{wire_api}"),
            wire_api,
            files,
            extra: attached.clone(),
        });
    }
    // Chat Completions has no hosted search or images, so `image_search`
    // is offered outside the gallery and `web_search` is not.
    for pane in ["document", "gallery", "whiteboard"] {
        scenarios.push(scenario(
            &format!("{pane}-chat-completions"),
            "chat_completions",
            json!({ "pane_context": pane }),
        ));
    }

    let write = std::env::var("KITION_WRITE_GOLDEN").is_ok_and(|value| value == "1");
    let mut observed: Vec<(String, Observed)> = Vec::new();
    for Scenario {
        name,
        wire_api,
        files,
        extra,
    } in scenarios
    {
        let (body, workspace) = first_request_with(wire_api, files, extra.clone()).await;
        let temp_paths = [
            workspace,
            plain.path().to_path_buf(),
            git.path().to_path_buf(),
        ];
        let actual = expectation(&body, &temp_paths);
        assert!(
            actual["tools"]
                .as_array()
                .is_some_and(|tools| !tools.is_empty()),
            "no tools for {name}"
        );
        assert!(
            actual["prompt"]
                .as_array()
                .is_some_and(|lines| !lines.is_empty()),
            "no prompt for {name}"
        );
        if name.starts_with("attachments-") {
            let lines = prompt_lines(&body);
            for path in ["- Notes/brief.md (unknown)", "- Images/dot.png (image)"] {
                assert!(
                    lines.iter().any(|line| line.starts_with(path)),
                    "{path} missing from {lines:?}"
                );
            }
            let user = Value::Array(conversation(&body)).to_string();
            assert!(user.contains("data:image/png;base64,"), "{user}");
        }
        observed.push((name, Observed::new(&actual)));
    }
    if write {
        let path = golden_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap_or_else(|err| panic!("{err}"));
        }
        let text = serde_json::to_string_pretty(&golden_from(&observed))
            .unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(path, text + "\n").unwrap_or_else(|err| panic!("{err}"));
        return;
    }
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(golden_path()).unwrap_or_else(|err| panic!("{err}")),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    let problems = golden_differences(&golden, &observed);
    assert!(
        problems.is_empty(),
        "the requests differ from tests/golden/panes.json (KITION_WRITE_GOLDEN=1 rewrites it):\n{}",
        problems.join("\n")
    );
}
