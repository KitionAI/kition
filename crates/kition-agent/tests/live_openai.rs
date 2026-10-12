//! Agent turns against the real OpenAI API, on both wires. Ignored by
//! default; they cost a few cents and need a key.
//!
//! Put the key in a file outside the repository (never in the command line or
//! the repository), then run:
//!
//! ```bash
//! KITION_LIVE_OPENAI_KEY_FILE="$HOME/.config/kition-live/openai.key" \
//!   cargo test -p kition-agent --test live_openai -- --ignored --nocapture --test-threads=1
//! ```
//!
//! `KITION_LIVE_OPENAI_MODEL` picks the model (default `gpt-4.1-mini`), and
//! `KITION_LIVE_OPENAI_BASE_URL` a compatible endpoint (default
//! `https://api.openai.com/v1`).

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use http::Request;
use http_body_util::BodyExt;
use kition_agent::{Agent, AgentConfig, AgentState, router};
use kition_ai::engine::Engine;
use kition_harness::log::{SessionLog, SqliteLog};
use kition_http::AuthConfig;
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

const FILE: &str = "Notes/live.md";
const LINE: &str = "hello from the live test";

struct Live {
    app: Router,
    db: Db,
    workspace: tempfile::TempDir,
    _uploads: tempfile::TempDir,
    _config: tempfile::TempDir,
}

fn app() -> Live {
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
    let app = router(AgentState {
        auth: AuthConfig {
            db: db.clone(),
            jwt_secret: "test".into(),
            disabled: true,
        },
        agent,
        ai_gate: Arc::new(|| true),
    });
    Live {
        app,
        db,
        workspace,
        _uploads: uploads,
        _config: config,
    }
}

/// The key, or `None` to skip when no key file is configured.
fn api_key() -> Option<String> {
    let path = std::env::var("KITION_LIVE_OPENAI_KEY_FILE").ok()?;
    let key = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("cannot read KITION_LIVE_OPENAI_KEY_FILE: {err}"));
    let key = key.trim().to_owned();
    (!key.is_empty()).then_some(key)
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

async fn turn(live: &Live, session_id: i64, key: &str, wire_api: &str, content: &str) -> String {
    let model = std::env::var("KITION_LIVE_OPENAI_MODEL").unwrap_or_else(|_| "gpt-4.1-mini".into());
    let base_url = std::env::var("KITION_LIVE_OPENAI_BASE_URL")
        .unwrap_or_else(|_| "https://api.openai.com/v1".into());
    let body = json!({
        "content": content,
        "runtime_model": {
            "provider_type": "openai", "model_name": model, "base_url": base_url,
            "wire_api": wire_api, "api_key": key,
        },
    });
    let (status, bytes) = call(
        &live.app,
        "POST",
        &format!("/agent/sessions/{session_id}/messages/stream"),
        body,
    )
    .await;
    let text = String::from_utf8_lossy(&bytes).to_string();
    assert_eq!(status, 200, "{text}");
    let lines: Vec<Value> = text
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let last = lines.last().cloned().unwrap_or_default();
    assert_eq!(
        (last["method"].as_str(), last["params"]["status"].as_str()),
        (Some("session.status"), Some("idle")),
        "{lines:?}"
    );
    let events: Vec<&Value> = lines
        .iter()
        .filter(|line| line["method"] == "session.event")
        .map(|line| &line["params"]["event"])
        .collect();
    let end = events
        .iter()
        .rev()
        .find(|event| event["type"] == "turn/end")
        .copied()
        .cloned()
        .unwrap_or_default();
    assert_ne!(
        end["reason"], "awaiting-approval",
        "the model chose a shell command, which waits for approval: {events:?}"
    );
    assert_eq!(end["reason"], "completed", "{end}");
    let reply = events
        .iter()
        .rev()
        .find(|event| event["type"] == "assistant/message")
        .and_then(|event| event["content"].as_str())
        .unwrap_or_default()
        .to_owned();
    println!("[{wire_api}] reply: {reply}");
    assert!(!reply.trim().is_empty(), "empty reply: {events:?}");
    reply
}

async fn two_turns(wire_api: &str) {
    let Some(key) = api_key() else {
        println!("skipped: set KITION_LIVE_OPENAI_KEY_FILE");
        return;
    };
    let live = app();
    let (status, body) = call(
        &live.app,
        "POST",
        "/agent/sessions",
        json!({ "language": "English" }),
    )
    .await;
    assert_eq!(status, 200);
    let session_id = serde_json::from_slice::<Value>(&body).unwrap_or_default()["data"]["id"]
        .as_i64()
        .unwrap_or_default();

    turn(
        &live,
        session_id,
        &key,
        wire_api,
        &format!(
            "Create the workspace file `{FILE}` containing exactly the line `{LINE}` \
             with the document tools (not shell commands). Then read the file back \
             with a document tool and tell me its first line."
        ),
    )
    .await;
    let written = std::fs::read_to_string(live.workspace.path().join(FILE)).unwrap_or_default();
    assert!(written.contains(LINE), "file content: {written:?}");

    let reply = turn(
        &live,
        session_id,
        &key,
        wire_api,
        "Without using any tool: which file did you create in my previous message, and what line did it contain?",
    )
    .await;
    assert!(
        reply.contains("live.md"),
        "the second turn lost the history: {reply}"
    );

    let log = SqliteLog::new(live.db.clone());
    let events = log
        .read(&format!("agent:{session_id}"))
        .unwrap_or_else(|error| panic!("{error}"));
    let kinds: Vec<&str> = events.iter().map(|event| event.body.kind()).collect();
    assert_eq!(
        kinds.iter().filter(|kind| **kind == "turn/start").count(),
        2,
        "{kinds:?}"
    );
    assert!(kinds.contains(&"tool/result"), "{kinds:?}");
    println!("[{wire_api}] session log: {} events", events.len());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "calls the real OpenAI API"]
async fn openai_responses() {
    two_turns("responses").await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "calls the real OpenAI API"]
async fn openai_chat_completions() {
    two_turns("chat_completions").await;
}
