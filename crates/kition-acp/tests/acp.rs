//! The ACP server driven as a client drives it: over a byte pipe, with a scripted agent runtime,
//! and over HTTP against a stand-in for Kition's agent API.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use kition_acp::{HttpRuntime, Options, Runtime, serve};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, WriteHalf};
use tokio::sync::mpsc;

/// A client end of the pipe: writes requests, reads what the server sends.
struct Client {
    writer: WriteHalf<DuplexStream>,
    lines: Lines<BufReader<tokio::io::ReadHalf<DuplexStream>>>,
}

impl Client {
    fn start<R: Runtime>(runtime: Arc<R>, options: Options) -> Self {
        let (client, server) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server);
        tokio::spawn(serve(runtime, server_read, server_write, options));
        let (read, writer) = tokio::io::split(client);
        Self {
            writer,
            lines: BufReader::new(read).lines(),
        }
    }

    async fn send(&mut self, message: Value) {
        self.writer
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap_or_else(|err| panic!("{err}"));
    }

    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(10), self.lines.next_line())
            .await
            .unwrap_or_else(|_| panic!("the server said nothing"))
            .unwrap_or_else(|err| panic!("{err}"))
            .unwrap_or_else(|| panic!("the server closed"));
        serde_json::from_str(&line).unwrap_or_else(|err| panic!("{err}: {line}"))
    }

    /// Everything the server sends until the answer to request `id`.
    async fn until_answer(&mut self, id: u64) -> (Vec<Value>, Value) {
        let mut seen = Vec::new();
        loop {
            let message = self.next().await;
            if message["id"] == id && message.get("method").is_none() {
                return (seen, message);
            }
            seen.push(message);
        }
    }
}

fn event(event: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": "session.event", "params": { "sessionId": "agent:42", "event": event } })
}

/// A runtime whose turns are scripted: the first asks to run a command, the one after the
/// approval finishes; a prompt saying `wait` never ends.
#[derive(Default)]
struct Scripted {
    requests: Mutex<Vec<(String, Value)>>,
}

impl Runtime for Scripted {
    fn new_session(&self, _title: String) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async { Ok("42".to_owned()) })
    }

    fn prompt(
        &self,
        session: String,
        request: Value,
        lines: mpsc::UnboundedSender<Value>,
    ) -> BoxFuture<'_, Result<(), String>> {
        self.requests
            .lock()
            .unwrap_or_else(|err| panic!("{err}"))
            .push((session, request.clone()));
        Box::pin(async move {
            let script = if request.get("shell_approval").is_some() {
                vec![
                    event(
                        json!({ "type": "tool/result", "callId": "c1", "name": "exec_command", "value": { "exit": 0 }, "content": [{ "type": "text", "text": "built" }], "isError": false }),
                    ),
                    event(
                        json!({ "type": "assistant/message", "content": "Built it.", "stopReason": "end_turn", "provider": "", "model": "" }),
                    ),
                    event(json!({ "type": "turn/end", "turn": 2, "reason": "completed" })),
                ]
            } else if request["content"] == "wait" {
                let _ = lines.send(event(json!({ "type": "turn/start", "turn": 1 })));
                futures::future::pending::<()>().await;
                Vec::new()
            } else {
                vec![
                    event(
                        json!({ "type": "tool/call", "callId": "c1", "name": "exec_command", "arguments": { "command": "make" }, "hosted": false }),
                    ),
                    event(
                        json!({ "type": "approval/asked", "id": "approval:c1", "toolName": "exec_command", "callId": "c1", "reason": "runs make" }),
                    ),
                    event(json!({ "type": "turn/end", "turn": 1, "reason": "awaiting-approval" })),
                ]
            };
            for line in script {
                let _ = lines.send(line);
            }
            Ok(())
        })
    }
}

#[tokio::test]
async fn a_prompt_runs_asks_for_permission_and_ends() {
    let runtime = Arc::new(Scripted::default());
    let mut client = Client::start(
        Arc::clone(&runtime),
        Options {
            model: Some(json!({ "model_name": "m", "wire_api": "chat_completions" })),
            kit_edit_mode: "draft".into(),
        },
    );
    client.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1, "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } } } })).await;
    let (_, init) = client.until_answer(1).await;
    assert_eq!(init["result"]["protocolVersion"], 1);
    assert_eq!(init["result"]["agentCapabilities"]["loadSession"], false);
    assert_eq!(init["result"]["authMethods"], json!([]));

    client.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "session/new", "params": { "cwd": "/work/site", "mcpServers": [] } })).await;
    let (_, created) = client.until_answer(2).await;
    let session = created["result"]["sessionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert_eq!(session, "kition-42");

    client.send(json!({ "jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": { "sessionId": session, "prompt": [{ "type": "text", "text": "Build the site" }] } })).await;
    // The tool call shows, then the server asks the client to allow it.
    let mut updates = Vec::new();
    let permission = loop {
        let message = client.next().await;
        if message["method"] == "session/request_permission" {
            break message;
        }
        updates.push(message["params"]["update"].clone());
    };
    assert_eq!(updates[0]["sessionUpdate"], "tool_call");
    assert_eq!(updates[0]["kind"], "execute");
    assert_eq!(
        updates[1],
        json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "pending" })
    );
    assert_eq!(permission["params"]["sessionId"], session);
    assert_eq!(
        permission["params"]["toolCall"]["title"],
        "exec_command: make"
    );
    let kinds: Vec<&str> = permission["params"]["options"]
        .as_array()
        .map(|options| {
            options
                .iter()
                .filter_map(|option| option["kind"].as_str())
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(kinds, ["allow_once", "allow_always", "reject_once"]);
    client.send(json!({ "jsonrpc": "2.0", "id": permission["id"], "result": { "outcome": { "outcome": "selected", "optionId": "allow_once" } } })).await;

    let (updates, answer) = client.until_answer(3).await;
    assert_eq!(answer["result"], json!({ "stopReason": "end_turn" }));
    let kinds: Vec<&str> = updates
        .iter()
        .filter_map(|update| update["params"]["update"]["sessionUpdate"].as_str())
        .collect();
    assert_eq!(kinds, ["tool_call_update", "agent_message_chunk"]);
    let requests = runtime
        .requests
        .lock()
        .unwrap_or_else(|err| panic!("{err}"))
        .clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].0, "42");
    assert_eq!(requests[0].1["content"], "Build the site");
    assert_eq!(requests[0].1["kit_edit_mode"], "draft");
    assert_eq!(requests[0].1["runtime_model"]["model_name"], "m");
    assert_eq!(
        requests[1].1["shell_approval"],
        json!({ "call_id": "c1", "decision": "allow_once" })
    );
    assert_eq!(requests[1].1["hide_user_message"], true);

    // Unknown methods and sessions are errors; nothing breaks.
    client
        .send(json!({ "jsonrpc": "2.0", "id": 4, "method": "session/load", "params": {} }))
        .await;
    assert_eq!(client.until_answer(4).await.1["error"]["code"], -32601);
    client.send(json!({ "jsonrpc": "2.0", "id": 5, "method": "session/prompt", "params": { "sessionId": "nope", "prompt": [{ "type": "text", "text": "x" }] } })).await;
    assert_eq!(client.until_answer(5).await.1["error"]["code"], -32602);
}

#[tokio::test]
async fn a_cancelled_prompt_stops() {
    let runtime = Arc::new(Scripted::default());
    let mut client = Client::start(runtime, Options::default());
    client.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "session/new", "params": { "cwd": "/work", "mcpServers": [] } })).await;
    let session = client.until_answer(1).await.1["result"]["sessionId"].clone();
    client.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "session/prompt", "params": { "sessionId": session, "prompt": [{ "type": "text", "text": "wait" }] } })).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    client.send(json!({ "jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": { "sessionId": session, "prompt": [{ "type": "text", "text": "again" }] } })).await;
    assert_eq!(
        client.until_answer(3).await.1["error"]["code"],
        -32602,
        "one prompt at a time"
    );
    client.send(json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session } })).await;
    assert_eq!(
        client.until_answer(2).await.1["result"],
        json!({ "stopReason": "cancelled" })
    );
}

const API_TOKEN: &str = "acp-test-token";

/// A stand-in for Kition's agent API: makes session 7, and streams a turn in pieces.
async fn kition_api(seen: Arc<Mutex<Vec<Value>>>) -> String {
    use axum::Json;
    use axum::body::Body;
    use axum::extract::{Path, State};
    use axum::routing::post;

    let app = axum::Router::new()
        .route(
            "/api/v1/agent/sessions",
            post(|| async { Json(json!({ "code": 200, "message": "success", "data": { "id": 7, "title": "Editor session in site" } })) }),
        )
        .route(
            "/api/v1/agent/sessions/{id}/messages/stream",
            post(
                |State(seen): State<Arc<Mutex<Vec<Value>>>>, Path(id): Path<String>, Json(request): Json<Value>| async move {
                    seen.lock().unwrap_or_else(|err| panic!("{err}")).push(json!({ "id": id, "request": request }));
                    let lines = [
                        json!({ "jsonrpc": "2.0", "method": "session.status", "params": { "sessionId": "agent:7", "status": "running" } }),
                        json!({ "jsonrpc": "2.0", "method": "agent/assistant-stream", "params": { "sessionId": "agent:7", "frame": { "type": "chunk", "attemptId": "a", "revision": 1, "index": 0, "time": 0, "chunk": { "type": "text-delta", "index": 0, "text": "Hello" } } } }),
                        json!({ "jsonrpc": "2.0", "method": "session.event", "params": { "sessionId": "agent:7", "event": { "seq": 2, "at": 0, "type": "assistant/message", "turn": 1, "step": 1, "content": "Hello", "stopReason": "end_turn", "provider": "", "model": "" } } }),
                        json!({ "jsonrpc": "2.0", "method": "session.event", "params": { "sessionId": "agent:7", "event": { "seq": 3, "at": 0, "type": "turn/end", "turn": 1, "reason": "completed" } } }),
                    ];
                    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
                    // Split mid-line, as a network delivers it.
                    let (first, rest) = text.split_at(text.len() / 2);
                    let chunks = vec![Ok::<_, std::convert::Infallible>(first.to_owned()), Ok(rest.to_owned())];
                    Body::from_stream(futures::stream::iter(chunks))
                },
            ),
        )
        .with_state(seen);
    // Behind the runtime's own gate: every call needs the API token.
    let app = kition_http::guard(
        app,
        kition_http::gate::ApiGate::new(API_TOKEN, "/api/v1"),
        kition_http::cors::CorsPolicy::default(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let address = listener.local_addr().unwrap_or_else(|err| panic!("{err}"));
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://{address}/api/v1")
}

#[tokio::test]
async fn drives_kitions_agent_api_over_http() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let base = kition_api(Arc::clone(&seen)).await;
    let runtime = HttpRuntime::new(&base, API_TOKEN.into()).unwrap_or_else(|err| panic!("{err}"));
    let mut client = Client::start(Arc::new(runtime), Options::default());
    client.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "session/new", "params": { "cwd": "/work/site", "mcpServers": [] } })).await;
    let session = client.until_answer(1).await.1["result"]["sessionId"].clone();
    assert_eq!(session, "kition-7");
    client.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "session/prompt", "params": { "sessionId": session, "prompt": [{ "type": "text", "text": "Say hello" }] } })).await;
    let (updates, answer) = client.until_answer(2).await;
    assert_eq!(
        answer["result"],
        json!({ "stopReason": "end_turn" }),
        "{updates:?}"
    );
    assert_eq!(
        updates
            .iter()
            .map(|update| update["params"]["update"].clone())
            .collect::<Vec<_>>(),
        [
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Hello" } })
        ]
    );
    let seen = seen.lock().unwrap_or_else(|err| panic!("{err}")).clone();
    assert_eq!(seen[0]["id"], "7");
    assert_eq!(seen[0]["request"]["content"], "Say hello");
    assert_eq!(seen[0]["request"]["kit_edit_mode"], "live");
}

#[tokio::test]
async fn a_wrong_api_token_is_refused() {
    let base = kition_api(Arc::new(Mutex::new(Vec::new()))).await;
    let runtime = HttpRuntime::new(&base, "wrong".into()).unwrap_or_else(|err| panic!("{err}"));
    let refused = kition_acp::Runtime::new_session(&runtime, "x".into()).await;
    assert!(
        refused.as_ref().is_err_and(|error| error.contains("401")),
        "{refused:?}"
    );
}
