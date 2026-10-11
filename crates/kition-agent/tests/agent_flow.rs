//! A streamed agent turn against a fake provider (Responses or Chat
//! Completions): the model asks for `artifact_write`, the runtime runs it,
//! and the model then answers.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

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
    let calls = Arc::new(AtomicUsize::new(0));
    let script = Arc::new(script);
    let app = Router::new().route(
        path,
        post(move || {
            let (calls, script) = (calls.clone(), script.clone());
            async move {
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
    format!("http://{addr}")
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
    }
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
