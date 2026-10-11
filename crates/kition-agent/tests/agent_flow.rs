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

struct Harness {
    app: Router,
    db: Db,
    workspace: tempfile::TempDir,
    _uploads: tempfile::TempDir,
    _config: tempfile::TempDir,
}

fn app_with(harness_mode: bool) -> Harness {
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
        harness: harness_mode,
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
    Harness {
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

#[tokio::test(flavor = "multi_thread")]
async fn streams_a_turn_with_a_tool_call() {
    tool_call_turn(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_a_turn_with_a_tool_call_on_the_harness() {
    tool_call_turn(true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_outside_the_policy_wait_for_approval() {
    approval_turns(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_outside_the_policy_wait_for_approval_on_the_harness() {
    approval_turns(true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_a_turn_over_chat_completions() {
    chat_completions_turn(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_a_turn_over_chat_completions_on_the_harness() {
    chat_completions_turn(true).await;
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
async fn a_second_harness_turn_is_refused_while_the_first_runs() {
    let Harness { app, .. } = app_with(true);
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
    let Harness { app, .. } = app_with(true);
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
}

async fn chat_completions_turn(harness_mode: bool) {
    let Harness { app, workspace, .. } = app_with(harness_mode);
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

async fn tool_call_turn(harness_mode: bool) {
    let Harness {
        app, db, workspace, ..
    } = app_with(harness_mode);
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

    if harness_mode {
        let log = kition_harness::log::SqliteLog::new(db.clone());
        let events = kition_harness::log::SessionLog::read(&log, &format!("agent:{session_id}"))
            .unwrap_or_else(|error| panic!("{error}"));
        let kinds: Vec<&str> = events.iter().map(|event| event.body.kind()).collect();
        assert_eq!(kinds.first(), Some(&"turn/start"), "{kinds:?}");
        assert!(kinds.contains(&"tool/result"), "{kinds:?}");
        assert_eq!(kinds.last(), Some(&"turn/end"), "{kinds:?}");
        assert_session_events_api(&app, session_id).await;
    }
}

/// A provider-native output item that carries a secret-looking string.
const RAW_SECRET: &str = "fake-raw-item-secret-4d1c";

#[tokio::test(flavor = "multi_thread")]
async fn the_session_events_api_keeps_provider_native_items_out() {
    let Harness { app, db, .. } = app_with(true);
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

async fn approval_turns(harness_mode: bool) {
    let Harness { app, workspace, .. } = app_with(harness_mode);
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
/// without the tool list line, so the two modes can join sections
/// differently. Reads Responses
/// `instructions` and system or developer items, and Chat Completions
/// system messages.
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
    harness_mode: bool,
    wire_api: &str,
    files: &[(&str, &[u8])],
    extra: Value,
) -> (Value, std::path::PathBuf) {
    let Harness { app, workspace, .. } = app_with(harness_mode);
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
    let golden: Value = if write {
        Value::Null
    } else {
        serde_json::from_str(
            &std::fs::read_to_string(golden_path()).unwrap_or_else(|err| panic!("{err}")),
        )
        .unwrap_or_else(|err| panic!("{err}"))
    };
    // Each tool's object is stored once under `tools`; a scenario lists the
    // names it offers.
    let mut written_tools = serde_json::Map::new();
    let mut written = serde_json::Map::new();
    for Scenario {
        name,
        wire_api,
        files,
        extra,
    } in scenarios
    {
        // The golden data was frozen from the original loop's requests.
        let (body, workspace) = first_request_with(!write, wire_api, files, extra.clone()).await;
        let temp_paths = [
            workspace,
            plain.path().to_path_buf(),
            git.path().to_path_buf(),
        ];
        let mut actual = expectation(&body, &temp_paths);
        let offered = actual["tools"].as_array().cloned().unwrap_or_default();
        assert!(!offered.is_empty(), "no tools for {name}");
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
        let names: Vec<String> = offered
            .iter()
            .map(|tool| tool["name"].as_str().unwrap_or_default().to_owned())
            .collect();
        actual["tools"] = json!(names);
        if write {
            for tool in offered {
                let tool_name = tool["name"].as_str().unwrap_or_default().to_owned();
                if let Some(known) = written_tools.get(&tool_name) {
                    assert_eq!(known, &tool, "{tool_name} differs between scenarios");
                }
                written_tools.insert(tool_name, tool);
            }
            written.insert(name, actual);
            continue;
        }
        let expected = &golden["scenarios"][&name];
        assert!(expected.is_object(), "no golden entry for {name}");
        for key in ["tools", "prompt", "conversation"] {
            assert_eq!(
                actual[key], expected[key],
                "{key} differs from the golden data for {name}"
            );
        }
        for tool in offered {
            let tool_name = tool["name"].as_str().unwrap_or_default();
            assert_eq!(
                tool, golden["tools"][tool_name],
                "{tool_name} differs from the golden data for {name}"
            );
        }
    }
    if write {
        let path = golden_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap_or_else(|err| panic!("{err}"));
        }
        written_tools.sort_keys();
        let golden = json!({ "tools": written_tools, "scenarios": written });
        let text = serde_json::to_string_pretty(&golden).unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(path, text + "\n").unwrap_or_else(|err| panic!("{err}"));
    }
}
