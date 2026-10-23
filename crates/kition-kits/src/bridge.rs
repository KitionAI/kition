//! The Kit AI bridge (Kition Kit Standard A7 to A10): when a file is open in a kit editor in the
//! renderer, the agent's kit tools act on that live editor instead of a headless copy, so the
//! person sees the edit at once and it joins the editor's undo history.
//!
//! The renderer holds one stream per window, `GET /v1/kits/bridge` (server-sent events). Each
//! event is one JSON-RPC 2.0 message from the runtime (the harness) to the renderer (the host):
//! `kit/documents`, `kit/call`, and `kit/preview` requests. The renderer answers with
//! `POST /v1/kits/bridge?session=<id>`, one JSON-RPC message per request, and sends `kit.changed`
//! notifications the same way. A stream that closes takes its pending requests with it; the
//! agent then falls back to the headless kit.
//!
//! The same stream carries the document bridge (`document_bridge.rs`): the window announces the
//! Markdown documents it has open with a `documents.open` notification, and the runtime sends
//! `document/read` and `document/apply` requests for the agent's edits to them.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

/// How long the renderer has to list its open documents.
const DOCUMENTS_TIMEOUT: Duration = Duration::from_secs(3);
/// How long one tool call on a live document may take (a long series of edits).
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// A document open in a renderer kit editor, as `kit/documents` reports it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDocument {
    /// Workspace-relative, `/`-separated.
    pub path: String,
    /// The kit's id, for example `kit.vector`.
    pub kit: String,
    pub dirty: bool,
    pub revision: u64,
    /// The bridge session (renderer window) that has it open.
    #[serde(default)]
    pub session: u64,
}

/// A bridge request the editor refused: its message, and the error's `data` when it sent one (an
/// object-model refusal's `{ code, index, message }`, a refusal's `{ reason }`), so the agent's
/// tools can answer a structured error code.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BridgeFailure {
    pub message: String,
    pub data: Option<Value>,
}

impl BridgeFailure {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            data: None,
        }
    }
}

impl From<&str> for BridgeFailure {
    fn from(message: &str) -> Self {
        Self::new(message)
    }
}

impl std::fmt::Display for BridgeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

type Pending = oneshot::Sender<Result<Value, BridgeFailure>>;

struct Session {
    tx: mpsc::UnboundedSender<Value>,
    pending: Mutex<HashMap<u64, Pending>>,
    /// The text documents the window has open, as its last `documents.open` listed them.
    documents: Mutex<BTreeSet<String>>,
}

/// A live document's edit, as `kit.changed` reported it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveChange {
    /// Workspace-relative, `/`-separated.
    pub path: String,
    pub revision: u64,
    /// `person` or `agent`.
    pub by: String,
}

/// The runtime's end of the bridge: the connected renderer windows and their pending requests.
pub struct Bridge {
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
    next_session: AtomicU64,
    next_request: AtomicU64,
    /// The last revision each live document reported through `kit.changed`, by path.
    revisions: Mutex<HashMap<String, (u64, String)>>,
    /// Every `kit.changed`, for whoever follows live edits (the host table client's triggers).
    changes: tokio::sync::broadcast::Sender<LiveChange>,
}

impl Default for Bridge {
    fn default() -> Self {
        Self {
            sessions: Mutex::default(),
            next_session: AtomicU64::default(),
            next_request: AtomicU64::default(),
            revisions: Mutex::default(),
            changes: tokio::sync::broadcast::channel(256).0,
        }
    }
}

/// Paths as both sides name them: workspace-relative, no leading `./` or `/`.
pub fn normalize(path: &str) -> String {
    path.trim()
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_owned()
}

impl Bridge {
    /// A new renderer stream: its session id, and the messages to send it.
    pub fn connect(self: &Arc<Self>) -> (u64, mpsc::UnboundedReceiver<Value>) {
        let id = self.next_session.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = tx.send(
            json!({ "jsonrpc": "2.0", "method": "bridge.ready", "params": { "session": id } }),
        );
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                id,
                Arc::new(Session {
                    tx,
                    pending: Mutex::new(HashMap::new()),
                    documents: Mutex::default(),
                }),
            );
        (id, rx)
    }

    /// The renderer's stream closed: its pending requests fail at once.
    pub fn disconnect(&self, session: u64) {
        let removed = self
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&session);
        if let Some(session) = removed {
            for (_, waiting) in session
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .drain()
            {
                let _ = waiting.send(Err("the editor window closed".into()));
            }
        }
    }

    /// Hears every live document's `kit.changed` from now on.
    pub fn subscribe_changes(&self) -> tokio::sync::broadcast::Receiver<LiveChange> {
        self.changes.subscribe()
    }

    pub fn connected(&self) -> bool {
        !self
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }

    /// Sends `method` with `params` as a notification (no reply expected) to every connected
    /// renderer window, such as `table/changed`. A window whose stream has gone away silently
    /// drops the message; it reconnects and resyncs on its own.
    pub fn broadcast(&self, method: &str, params: Value) {
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        for session in sessions {
            let _ = session
                .tx
                .send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
        }
    }

    fn session(&self, id: u64) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
            .cloned()
    }

    /// The newest window whose last `documents.open` listed `path` (already normalized).
    pub(crate) fn window_with_document(&self, path: &str) -> Option<u64> {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|(_, session)| {
                session
                    .documents
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .contains(path)
            })
            .map(|(id, _)| *id)
            .max()
    }

    /// A message the renderer posted: an answer to a request, or a `kit.changed` or
    /// `documents.open` notification.
    pub fn receive(&self, session: u64, message: &Value) -> Result<(), String> {
        let Some(open) = self.session(session) else {
            return Err(format!("no bridge session {session}"));
        };
        if message.get("method").and_then(Value::as_str) == Some("documents.open") {
            let paths: BTreeSet<String> = message["params"]["paths"]
                .as_array()
                .ok_or("`documents.open` needs a `paths` array")?
                .iter()
                .filter_map(Value::as_str)
                .map(normalize)
                .filter(|path| !path.is_empty())
                .collect();
            tracing::debug!(session, open = paths.len(), "documents open in a window");
            *open
                .documents
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = paths;
            return Ok(());
        }
        if message.get("method").and_then(Value::as_str) == Some("kit.changed") {
            let params = &message["params"];
            let path = normalize(params["path"].as_str().unwrap_or_default());
            let by = params["by"].as_str().unwrap_or("person").to_owned();
            let revision = params["revision"].as_u64().unwrap_or_default();
            tracing::debug!(%path, revision, %by, "kit document changed");
            self.revisions
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(path.clone(), (revision, by.clone()));
            let _ = self.changes.send(LiveChange { path, revision, by });
            return Ok(());
        }
        let id = message
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("a bridge answer needs a numeric id")?;
        let waiting = open
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id)
            .ok_or_else(|| format!("no pending request {id}"))?;
        let outcome = match message.get("error") {
            Some(error) => Err(BridgeFailure {
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("the editor failed")
                    .to_owned(),
                data: error.get("data").filter(|data| !data.is_null()).cloned(),
            }),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = waiting.send(outcome);
        Ok(())
    }

    pub(crate) async fn request(
        &self,
        session: u64,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.request_detailed(session, method, params, timeout)
            .await
            .map_err(|failure| failure.message)
    }

    async fn request_detailed(
        &self,
        session: u64,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeFailure> {
        let open = self
            .session(session)
            .ok_or_else(|| BridgeFailure::new("the editor window closed"))?;
        let id = self.next_request.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        open.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, tx);
        if open
            .tx
            .send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .is_err()
        {
            self.disconnect(session);
            return Err(BridgeFailure::new("the editor window closed"));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err(BridgeFailure::new("the editor window closed")),
            Err(_) => {
                open.pending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&id);
                Err(BridgeFailure {
                    message: format!("the editor did not answer `{method}` in time"),
                    data: Some(json!({ "reason": "timeout" })),
                })
            }
        }
    }

    /// The documents open in every connected renderer window.
    pub async fn documents(&self) -> Vec<LiveDocument> {
        let sessions: Vec<u64> = self
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .copied()
            .collect();
        let mut all = Vec::new();
        for session in sessions {
            let Ok(listed) = self
                .request(session, "kit/documents", json!({}), DOCUMENTS_TIMEOUT)
                .await
            else {
                continue;
            };
            let documents: Vec<LiveDocument> =
                serde_json::from_value(listed.get("documents").cloned().unwrap_or(Value::Null))
                    .unwrap_or_default();
            all.extend(documents.into_iter().map(|document| LiveDocument {
                session,
                path: normalize(&document.path),
                ..document
            }));
        }
        all
    }

    /// The live editor that has `path` open, if any.
    pub async fn find(&self, path: &str) -> Option<LiveDocument> {
        if !self.connected() {
            return None;
        }
        let path = normalize(path);
        self.documents()
            .await
            .into_iter()
            .find(|document| document.path == path)
    }

    /// Runs one of the kit's document tools (`inspect`, `commands`, `run`, `describe`, `batch`,
    /// `draft_ready`, `draft_reopen`) on the live document; answers the tool's canonical output.
    pub async fn call(
        &self,
        document: &LiveDocument,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, BridgeFailure> {
        let params = json!({ "path": document.path, "kit": document.kit, "tool": tool, "arguments": arguments });
        self.request_detailed(document.session, "kit/call", params, CALL_TIMEOUT)
            .await
    }

    /// A PNG preview of the live document, at most `max_size` pixels on its longer side.
    pub async fn preview(&self, document: &LiveDocument, max_size: u32) -> Result<Vec<u8>, String> {
        self.preview_of(document, max_size, false).await
    }

    /// A PNG preview of the agent's draft of the live document (standard 2.0 A12).
    pub async fn preview_draft(
        &self,
        document: &LiveDocument,
        max_size: u32,
    ) -> Result<Vec<u8>, String> {
        self.preview_of(document, max_size, true).await
    }

    async fn preview_of(
        &self,
        document: &LiveDocument,
        max_size: u32,
        draft: bool,
    ) -> Result<Vec<u8>, String> {
        use base64::Engine as _;
        let mut params = json!({ "path": document.path, "maxSize": max_size });
        if draft {
            params["draft"] = Value::Bool(true);
        }
        let answer = self
            .request(document.session, "kit/preview", params, CALL_TIMEOUT)
            .await?;
        let encoded = answer
            .get("png")
            .and_then(Value::as_str)
            .ok_or("the preview had no image")?;
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| error.to_string())
    }

    /// The last change a live document reported: its revision, and who made it (`person` or `agent`).
    pub fn last_change(&self, path: &str) -> Option<(u64, String)> {
        self.revisions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&normalize(path))
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A renderer window that answers like the real one, on its own task.
    fn renderer(bridge: &Arc<Bridge>, documents: Value) -> u64 {
        let (session, mut rx) = bridge.connect();
        let bridge = bridge.clone();
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let Some(id) = message["id"].as_u64() else {
                    continue;
                };
                let result = match message["method"].as_str() {
                    Some("kit/documents") => json!({ "documents": documents }),
                    Some("kit/call") if message["params"]["tool"] == "fail" => {
                        let _ = bridge.receive(session, &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "refused", "data": { "code": "read-only", "index": 0, "message": "refused" } } }));
                        continue;
                    }
                    Some("kit/call") => json!({ "echo": message["params"] }),
                    Some("kit/preview") => json!({ "png": "iVBORw0K" }),
                    _ => continue,
                };
                let _ = bridge.receive(
                    session,
                    &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                );
            }
        });
        session
    }

    #[tokio::test]
    async fn calls_reach_the_window_that_has_the_file_open() {
        let bridge = Arc::new(Bridge::default());
        assert!(
            bridge.find("art/a.kvector").await.is_none(),
            "no windows: headless"
        );
        renderer(&bridge, json!([]));
        let second = renderer(
            &bridge,
            json!([{ "path": "/art/a.kvector", "kit": "kit.vector", "dirty": false, "revision": 3 }]),
        );
        let live = bridge
            .find("./art/a.kvector")
            .await
            .unwrap_or_else(|| panic!("found"));
        assert_eq!(
            (live.session, live.revision, live.path.as_str()),
            (second, 3, "art/a.kvector")
        );
        let answer = bridge
            .call(&live, "run", json!({ "steps": [] }))
            .await
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(answer["echo"]["tool"], "run");
        assert_eq!(answer["echo"]["kit"], "kit.vector");
        assert_eq!(
            bridge.call(&live, "fail", json!({})).await,
            Err(BridgeFailure {
                message: "refused".into(),
                data: Some(json!({ "code": "read-only", "index": 0, "message": "refused" })),
            }),
            "the editor's error data reaches the tools"
        );
        assert_eq!(
            bridge.preview(&live, 64).await.unwrap_or_default()[..4],
            [0x89, b'P', b'N', b'G']
        );
    }

    #[tokio::test]
    async fn a_closed_window_fails_its_calls_at_once() {
        let bridge = Arc::new(Bridge::default());
        let (session, rx) = bridge.connect();
        let live = LiveDocument {
            path: "a.keffect".into(),
            kit: "kit.effect".into(),
            dirty: false,
            revision: 1,
            session,
        };
        let call = {
            let bridge = bridge.clone();
            let live = live.clone();
            tokio::spawn(async move { bridge.call(&live, "inspect", json!({})).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(rx);
        bridge.disconnect(session);
        let outcome = call.await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(outcome, Err("the editor window closed".into()));
        assert!(!bridge.connected());
        assert!(
            bridge
                .receive(session, &json!({ "id": 1, "result": {} }))
                .is_err()
        );
    }

    #[tokio::test]
    async fn remembers_who_changed_a_document() {
        let bridge = Arc::new(Bridge::default());
        let (session, _rx) = bridge.connect();
        bridge
            .receive(session, &json!({ "jsonrpc": "2.0", "method": "kit.changed", "params": { "path": "a.kdesign", "revision": 7, "by": "agent" } }))
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(
            bridge.last_change("/a.kdesign"),
            Some((7, "agent".to_owned()))
        );
    }

    #[tokio::test]
    async fn broadcast_reaches_every_connected_window_as_a_notification() {
        let bridge = Arc::new(Bridge::default());
        let (first, mut first_rx) = bridge.connect();
        let (second, mut second_rx) = bridge.connect();
        // Drain the `bridge.ready` each session gets on connect.
        let _ = first_rx.recv().await;
        let _ = second_rx.recv().await;

        bridge.broadcast("table/changed", json!({ "documentId": "1" }));

        let expected = json!({
            "jsonrpc": "2.0",
            "method": "table/changed",
            "params": { "documentId": "1" },
        });
        assert_eq!(first_rx.recv().await, Some(expected.clone()));
        assert_eq!(second_rx.recv().await, Some(expected));

        bridge.disconnect(first);
        bridge.disconnect(second);
        // A broadcast with no connected window is a no-op, not an error.
        bridge.broadcast("table/changed", json!({}));
    }
}
