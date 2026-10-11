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

/// The offered tool names, sorted. Hosted tools (`web_search`,
/// `image_generation` on Responses) carry their type instead of a name.
fn tool_names(body: &Value) -> Vec<String> {
    let mut names: Vec<String> = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            tool["name"]
                .as_str()
                .or_else(|| tool["function"]["name"].as_str())
                .or_else(|| tool["type"].as_str())
                .map(str::to_owned)
        })
        .collect();
    names.sort();
    names
}

/// The prompt as a sorted set of non-empty lines, without the tool list
/// line, so the two modes can join sections differently. Reads Responses
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
    lines.dedup();
    lines
}

/// The first model request of a one-turn session in either mode.
async fn first_request(harness_mode: bool, wire_api: &str, extra: Value) -> Value {
    let Harness { app, .. } = app_with(harness_mode);
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
    bodies.first().cloned().unwrap_or_default()
}

async fn assert_pane_parity_on(wire_api: &str, extra: Value) {
    let legacy = first_request(false, wire_api, extra.clone()).await;
    let harness = first_request(true, wire_api, extra.clone()).await;
    assert!(!tool_names(&legacy).is_empty(), "no tools for {extra}");
    assert!(!prompt_lines(&legacy).is_empty(), "no prompt for {extra}");
    assert_eq!(
        tool_names(&harness),
        tool_names(&legacy),
        "tools differ for {wire_api} {extra}"
    );
    assert_eq!(
        prompt_lines(&harness),
        prompt_lines(&legacy),
        "prompt differs for {wire_api} {extra}"
    );
}

async fn assert_pane_parity(extra: Value) {
    assert_pane_parity_on("responses", extra).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn panes_offer_the_same_tools_and_prompt_on_the_harness() {
    for pane in ["document", "table", "workflow", "gallery"] {
        assert_pane_parity(json!({ "pane_context": pane })).await;
    }
    assert_pane_parity(json!({ "pane_context": "document", "active_document_path": "Notes/a.md" }))
        .await;
    assert_pane_parity(
        json!({ "pane_context": "document", "active_document_path": "art/Cover.psd" }),
    )
    .await;
    assert_pane_parity(
        json!({ "pane_context": "document", "execution_mode": "preview", "task_mode": "table" }),
    )
    .await;
    assert_pane_parity(json!({
        "pane_context": "table",
        "prompt_context": "Extra context from the client.",
        "table_plan_context": { "summary": "Import", "final_unique_by": ["url"], "estimated_create": 2 },
    }))
    .await;
    assert_pane_parity(json!({ "pane_context": "workflow", "active_workflow_id": "wf-1" })).await;
    assert_pane_parity(json!({ "pane_context": "table", "active_data_document_id": 1, "active_data_table_id": 2, "execution_mode": "research" })).await;
    assert_pane_parity(json!({ "pane_context": "document", "active_data_document_id": 1 })).await;
    assert_pane_parity(json!({
        "pane_context": "whiteboard",
        "whiteboard_context": {
            "type": "whiteboard.context", "schema_version": 1,
            "board": { "id": "b1", "path": "Boards/a.kiboard", "title": "A" },
            "scope": "viewport", "viewport": {}, "selected_element_ids": [],
            "elements": [{ "id": "n1", "kind": "mind_node" }], "clusters": [], "recent_operations": [],
        },
    }))
    .await;
    assert_pane_parity(json!({ "pane_context": "whiteboard" })).await;
    assert_pane_parity(json!({
        "pane_context": "design",
        "design_context": {
            "type": "design.context", "schema_version": 1,
            "design": { "id": "d1", "path": "a.kidesign", "title": "A" },
            "artboard": { "width": 800, "height": 600, "background": "#ffffff" },
            "selected_layer_ids": [], "recent_operations": [],
            "layers": [{ "id": "t1", "kind": "text" }, { "id": "bg", "kind": "rectangle", "locked": true }],
        },
    }))
    .await;
    assert_pane_parity(json!({ "pane_context": "design" })).await;
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
    assert_pane_parity(json!({ "local_sources": [source("notes", &plain)] })).await;
    assert_pane_parity(json!({ "pane_context": "table", "local_sources": [source("notes", &plain), source("repo", &git)] })).await;
    // Chat Completions has no hosted search or images, so `image_search`
    // is offered outside the gallery and `web_search` is not.
    for pane in ["document", "gallery", "whiteboard"] {
        assert_pane_parity_on("chat_completions", json!({ "pane_context": pane })).await;
    }
}
