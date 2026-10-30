//! An agent turn against the real Anthropic Messages API that calls one kit
//! tool. Ignored by default: it costs a few cents, needs a key, and real-model
//! runs happen only when the owner starts them (F-QA-16).
//!
//! Put the key in a file outside the repository (never in the command line or
//! the repository), build the mock kit, then run:
//!
//! ```bash
//! cargo build -p kition-kit-mock
//! KITION_LIVE_ANTHROPIC_KEY_FILE="$HOME/.config/kition-live/anthropic.key" \
//!   cargo test -p kition-agent --test live_anthropic -- --ignored --nocapture --test-threads=1
//! ```
//!
//! `KITION_LIVE_ANTHROPIC_MODEL` picks the model (default `claude-opus-5`),
//! and `KITION_LIVE_ANTHROPIC_BASE_URL` the endpoint (default
//! `https://api.anthropic.com`).
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use http::Request;
use http_body_util::BodyExt;
use kition_agent::{Agent, AgentConfig, AgentState, router};
use kition_ai::engine::Engine;
use kition_http::AuthConfig;
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

const NOTE: &str = "art/Note.kvector";

struct Live {
    app: Router,
    _workspace: tempfile::TempDir,
    _uploads: tempfile::TempDir,
    _config: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

/// The key, or `None` to skip when no key file is configured.
fn api_key() -> Option<String> {
    let path = std::env::var("KITION_LIVE_ANTHROPIC_KEY_FILE").ok()?;
    let key = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("cannot read KITION_LIVE_ANTHROPIC_KEY_FILE: {err}"));
    let key = key.trim().to_owned();
    (!key.is_empty()).then_some(key)
}

fn mock_kit() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.parent()?.join("kition-kit-mock");
    path.is_file().then_some(path)
}

/// A launcher that starts the mock kit as `kit.vector` for `.kvector` files.
fn as_vector(dir: &Path, mock: &Path) -> PathBuf {
    let script = dir.join("kit-vector-mock.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_AS=kit.vector:kvector exec '{}' \"$@\"\n",
            mock.display()
        ),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .unwrap_or_else(|err| panic!("{err}"));
    script
}

fn app(mock: &Path) -> Live {
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let uploads = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let config = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(workspace.path().join("art")).unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join(NOTE), "hello").unwrap_or_else(|err| panic!("{err}"));
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    kition_store::seed::run(&db.conn().unwrap_or_else(|err| panic!("{err}")))
        .unwrap_or_else(|err| panic!("{err}"));
    let vector = kition_kits::definitions::fixture_kit("kit.vector");
    let kits = kition_kits::KitManager::new(
        Some(workspace.path().to_path_buf()),
        vec![(vector, Some(as_vector(bin.path(), mock)))],
    );
    let agent = Agent::new(AgentConfig {
        db: db.clone(),
        engine: Engine::new(uploads.path().to_path_buf(), None),
        workspace_dir: workspace.path().to_path_buf(),
        upload_dir: uploads.path().to_path_buf(),
        policy_path: Some(config.path().join("execpolicy.toml")),
        hooks: None,
        smtp: None,
        portal_base_url: String::new(),
        mcp_path: None,
        workflow_prompt: None,
        kits: Some(kits),
    });
    let app = router(AgentState {
        auth: AuthConfig {
            db,
            jwt_secret: "test".into(),
            disabled: true,
        },
        agent,
        ai_gate: Arc::new(|| true),
    });
    Live {
        app,
        _workspace: workspace,
        _uploads: uploads,
        _config: config,
        _bin: bin,
    }
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

/// One turn; answers the turn's session events.
async fn turn(live: &Live, session_id: i64, key: &str, content: &str) -> Vec<Value> {
    let model =
        std::env::var("KITION_LIVE_ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-opus-5".into());
    let base_url = std::env::var("KITION_LIVE_ANTHROPIC_BASE_URL")
        .unwrap_or_else(|_| "https://api.anthropic.com".into());
    let body = json!({
        "content": content,
        "runtime_model": {
            "provider_type": "anthropic", "model_name": model, "base_url": base_url,
            "wire_api": "anthropic_messages", "api_key": key, "reasoning_effort": "medium",
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
    let events: Vec<Value> = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|line| line["method"] == "session.event")
        .map(|line| line["params"]["event"].clone())
        .collect();
    let end = events
        .iter()
        .rev()
        .find(|event| event["type"] == "turn/end")
        .cloned()
        .unwrap_or_default();
    assert_eq!(end["reason"], "completed", "{events:?}");
    for message in events
        .iter()
        .filter(|event| event["type"] == "assistant/message")
    {
        println!("usage: {}", message["usage"]);
    }
    events
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "calls the real Anthropic API"]
async fn anthropic_inspects_a_kit_file() {
    let Some(key) = api_key() else {
        println!("skipped: set KITION_LIVE_ANTHROPIC_KEY_FILE");
        return;
    };
    let Some(mock) = mock_kit() else {
        println!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let live = app(&mock);
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
    let events = turn(
        &live,
        session_id,
        &key,
        &format!("Inspect the drawing `{NOTE}` with its kit and tell me what text it holds."),
    )
    .await;
    assert!(
        events
            .iter()
            .any(|event| event["type"] == "tool/result" && event["name"] == "vector_inspect"),
        "the model did not inspect the kit file: {events:?}"
    );
    // A second turn extends the same append-only history.
    let events = turn(
        &live,
        session_id,
        &key,
        "Without using any tool: which file did you inspect?",
    )
    .await;
    let reply = events
        .iter()
        .rev()
        .find(|event| event["type"] == "assistant/message")
        .and_then(|event| event["content"].as_str())
        .unwrap_or_default()
        .to_owned();
    println!("reply: {reply}");
    assert!(reply.contains("Note.kvector"), "{reply}");
}
