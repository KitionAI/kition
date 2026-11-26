// Copied from kition-sdk crates/kition-kit-host/src/client.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A Kit Process Protocol client connection: request and response correlation,
//! timeouts with `$/cancelRequest`, a notification stream, and, on the host
//! connection, the answers to the kit's own requests (`files.*`, section 5.1).

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use kition_kit_process_protocol::framing::{self, read_frame_async, write_frame_async};
use kition_kit_process_protocol::launch::request_timeout;
use kition_kit_process_protocol::methods::{CancelRequest, Initialize, Initialized};
use kition_kit_process_protocol::transport::{BoxReader, BoxWriter};
use kition_kit_process_protocol::types::{Empty, InitializeParams, InitializeResult};
use kition_kit_process_protocol::{Message, Notification, NotificationMethod, Request, RequestId, RequestMethod, RpcError};
use serde_json::Value;
use tokio::io::BufReader;
use tokio::sync::{mpsc, oneshot, watch};

use crate::kit_files::HostService;
use crate::process::LaunchError;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// The kit could not be started ([`crate::HeadlessKit::launch`]).
    #[error(transparent)]
    Launch(#[from] LaunchError),
    #[error("kit error: {0}")]
    Rpc(RpcError),
    #[error("`{0}` timed out")]
    Timeout(String),
    #[error("the kit exceeded its process memory ceiling")]
    MemoryLimit,
    #[error("the kit was stopped because its resident size could not be monitored")]
    MemoryMonitor,
    #[error("the kit request was cancelled")]
    Cancelled,
    #[error("the kit closed the connection")]
    Closed,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("could not encode or decode a message: {0}")]
    Json(#[from] serde_json::Error),
}

impl ClientError {
    /// The JSON-RPC error, when the kit answered with one.
    pub fn rpc(&self) -> Option<&RpcError> {
        match self {
            Self::Rpc(error) => Some(error),
            _ => None,
        }
    }

    /// The Kit Process Protocol reason (`error.data.reason`) of a JSON-RPC error, as sent.
    pub fn reason(&self) -> Option<&str> {
        self.data()?.get("reason")?.as_str()
    }

    /// The JSON-RPC error's `data`.
    pub fn data(&self) -> Option<&Value> {
        self.rpc()?.data.as_ref()
    }

    /// Whether the kit itself is gone or unresponsive rather than refusing this one request: the
    /// host should stop using the process.
    pub fn is_fatal(&self) -> bool {
        matches!(self, Self::Launch(_) | Self::Timeout(_) | Self::MemoryLimit | Self::MemoryMonitor | Self::Closed | Self::Io(_))
    }
}

struct Waiting {
    answer: oneshot::Sender<Result<Value, RpcError>>,
    progress: Option<mpsc::Sender<kition_kit_process_protocol::types::ProgressParams>>,
}

type Pending = Mutex<HashMap<RequestId, Waiting>>;
type AbortAction = Arc<dyn Fn() -> tokio::task::JoinHandle<()> + Send + Sync>;
type AbortActions = Arc<Mutex<HashMap<String, AbortAction>>>;

/// The control of one outer host call. A scope follows its sequential kit requests; request
/// ids remain local to each connection and are never exposed as MCP progress tokens.
#[derive(Clone)]
pub struct RequestControl {
    pub cancelled: watch::Receiver<bool>,
    pub progress: Option<mpsc::Sender<kition_kit_process_protocol::types::ProgressParams>>,
    aborts: AbortActions,
}

tokio::task_local! {
    static CONTROL: RequestControl;
}

impl RequestControl {
    pub fn new(cancelled: watch::Receiver<bool>, progress: Option<mpsc::Sender<kition_kit_process_protocol::types::ProgressParams>>) -> Self {
        Self { cancelled, progress, aborts: Arc::default() }
    }

    pub fn on_abort(key: String, action: AbortAction) {
        let _ = CONTROL.try_with(|control| control.aborts.lock().unwrap_or_else(PoisonError::into_inner).insert(key, action));
    }

    pub fn abort(&self) -> Vec<tokio::task::JoinHandle<()>> {
        let actions = std::mem::take(&mut *self.aborts.lock().unwrap_or_else(PoisonError::into_inner));
        actions.into_values().map(|action| action()).collect()
    }

    pub async fn scope<F: std::future::Future>(&self, future: F) -> F::Output {
        CONTROL.scope(self.clone(), future).await
    }
}

struct PendingRequest {
    shared: Arc<Shared>,
    id: RequestId,
    complete: bool,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.shared.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&self.id);
        if !self.complete {
            let shared = Arc::clone(&self.shared);
            let id = self.id.clone();
            tokio::spawn(async move { cancel_on(&shared, id).await });
        }
    }
}

async fn cancel_on(shared: &Shared, id: RequestId) {
    let notification = Notification::new(CancelRequest::NAME, Some(serde_json::json!({ "id": id })));
    // A wedged writer cannot extend a deadline or prevent process termination.
    let _ = tokio::time::timeout(Duration::from_millis(100), send_on(shared, &notification.to_value())).await;
}

struct Shared {
    writer: tokio::sync::Mutex<BoxWriter>,
    pending: Pending,
}

/// One connection to a kit.
pub struct KitClient {
    shared: Arc<Shared>,
    notifications: tokio::sync::Mutex<mpsc::UnboundedReceiver<Notification>>,
    closed: watch::Receiver<bool>,
    request_ids: Arc<AtomicI64>,
}

impl KitClient {
    /// Wraps a connected transport and starts reading from it. The kit's own requests are
    /// answered `-32601`: an agent connection serves none.
    pub fn new(reader: BoxReader, writer: BoxWriter) -> Self {
        Self::serving(reader, writer, None)
    }

    /// [`KitClient::new`] for the host connection: `service` answers the kit's requests, each on
    /// a blocking thread, while the connection goes on reading.
    pub fn serving(reader: BoxReader, writer: BoxWriter, service: Option<Arc<dyn HostService>>) -> Self {
        let shared = Arc::new(Shared { writer: tokio::sync::Mutex::new(writer), pending: Mutex::new(HashMap::new()) });
        let (notify_tx, notify_rx) = mpsc::unbounded_channel();
        let (closed_tx, closed_rx) = watch::channel(false);
        tokio::spawn(read_loop(reader, Arc::clone(&shared), notify_tx, closed_tx, service));
        Self { shared, notifications: tokio::sync::Mutex::new(notify_rx), closed: closed_rx, request_ids: Arc::new(AtomicI64::new(1)) }
    }

    /// Connections to one kit share a sequence because kit.progress is broadcast to all of them.
    /// This prevents one connection's progress being mistaken for another connection's request.
    pub fn with_request_ids(mut self, request_ids: Arc<AtomicI64>) -> Self {
        self.request_ids = request_ids;
        self
    }

    /// Sends a typed request with the method's default deadline.
    pub async fn call<M: RequestMethod>(&self, params: &M::Params) -> Result<M::Result, ClientError> {
        self.call_with_timeout::<M>(params, request_timeout(M::NAME)).await
    }

    pub async fn call_with_timeout<M: RequestMethod>(&self, params: &M::Params, limit: Option<Duration>) -> Result<M::Result, ClientError> {
        let value = self.request(M::NAME, serde_json::to_value(params)?, limit).await?;
        Ok(serde_json::from_value(value)?)
    }

    /// Sends a request with raw JSON parameters. When the deadline passes the
    /// request is cancelled with `$/cancelRequest`.
    pub async fn request(&self, method: &str, params: Value, limit: Option<Duration>) -> Result<Value, ClientError> {
        let control = CONTROL.try_with(Clone::clone).ok();
        if control.as_ref().is_some_and(|control| *control.cancelled.borrow()) {
            return Err(ClientError::Cancelled);
        }
        let id = RequestId::Number(self.request_ids.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending().insert(id.clone(), Waiting { answer: tx, progress: control.as_ref().and_then(|control| control.progress.clone()) });
        let mut pending = PendingRequest { shared: Arc::clone(&self.shared), id: id.clone(), complete: false };
        let request = Message::Request(Request { id: id.clone(), method: method.to_owned(), params: Some(params) });
        let exchange = async {
            self.send(&request.to_value()).await?;
            match rx.await {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(error)) => Err(ClientError::Rpc(error)),
                Err(_) => Err(ClientError::Closed),
            }
        };
        let deadline = async {
            match limit {
                Some(limit) => tokio::time::sleep(limit).await,
                None => std::future::pending::<()>().await,
            }
        };
        let cancelled = async {
            match control {
                Some(mut control) => {
                    if control.cancelled.wait_for(|cancelled| *cancelled).await.is_err() {
                        std::future::pending::<()>().await;
                    }
                }
                None => std::future::pending::<()>().await,
            }
        };
        let outcome = tokio::select! {
            biased;
            () = cancelled => Err(ClientError::Cancelled),
            () = deadline => Err(ClientError::Timeout(method.to_owned())),
            result = exchange => result,
        };
        self.pending().remove(&id);
        if matches!(outcome, Err(ClientError::Timeout(_) | ClientError::Cancelled)) {
            cancel_on(&self.shared, id).await;
        }
        pending.complete = true;
        outcome
    }

    pub async fn notify<N: NotificationMethod>(&self, params: &N::Params) -> Result<(), ClientError> {
        let notification = Notification::new(N::NAME, Some(serde_json::to_value(params)?));
        self.send(&notification.to_value()).await
    }

    /// Writes one raw frame. Conformance tests use it for malformed input.
    pub async fn send_raw(&self, frame: &[u8]) -> Result<(), ClientError> {
        let mut writer = self.shared.writer.lock().await;
        write_frame_async(&mut *writer, frame)
            .await
            .map_err(|error| if kition_kit_process_protocol::transport::is_disconnect(&error) { ClientError::Closed } else { ClientError::Io(error) })
    }

    async fn send(&self, message: &Value) -> Result<(), ClientError> {
        send_on(&self.shared, message).await
    }

    /// `kit.initialize` followed by the `kit.initialized` notification.
    pub async fn initialize(&self, params: &InitializeParams) -> Result<InitializeResult, ClientError> {
        let result = self.call::<Initialize>(params).await?;
        self.notify::<Initialized>(&Empty {}).await?;
        Ok(result)
    }

    /// The next notification from the kit, or `None` once the connection closed.
    pub async fn next_notification(&self) -> Option<Notification> {
        self.notifications.lock().await.recv().await
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Waits until the kit closes the connection, up to `limit`. Returns
    /// whether it closed.
    pub async fn wait_closed(&self, limit: Duration) -> bool {
        let mut closed = self.closed.clone();
        tokio::time::timeout(limit, closed.wait_for(|closed| *closed)).await.is_ok()
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<RequestId, Waiting>> {
        self.shared.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

async fn send_on(shared: &Shared, message: &Value) -> Result<(), ClientError> {
    let frame = framing::encode(message)?;
    let mut writer = shared.writer.lock().await;
    write_frame_async(&mut *writer, &frame)
        .await
        .map_err(|error| if kition_kit_process_protocol::transport::is_disconnect(&error) { ClientError::Closed } else { ClientError::Io(error) })
}

/// Answers one request from the kit with `service`, off the reading task.
fn answer(shared: &Arc<Shared>, service: Option<&Arc<dyn HostService>>, request: Request) {
    let shared = Arc::clone(shared);
    let service = service.cloned();
    tokio::spawn(async move {
        let Request { id, method, params } = request;
        let outcome = match service {
            None => Err(RpcError::method_not_found(&method)),
            Some(service) => tokio::task::spawn_blocking(move || service.serve(&method, params.unwrap_or_else(|| Value::Object(Default::default()))))
                .await
                .unwrap_or_else(|_| Err(RpcError::internal("the host failed while answering the kit"))),
        };
        let _ = send_on(&shared, &kition_kit_process_protocol::Response { id: Some(id), outcome }.to_value()).await;
    });
}

async fn read_loop(
    reader: BoxReader,
    shared: Arc<Shared>,
    notifications: mpsc::UnboundedSender<Notification>,
    closed: watch::Sender<bool>,
    service: Option<Arc<dyn HostService>>,
) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        let frame = match read_frame_async(&mut reader, &mut line).await {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(error) if error.is_recoverable() => {
                tracing::warn!(target: "kition_kit", "dropped an unreadable frame from a kit: {error}");
                continue;
            }
            Err(_) => break,
        };
        match Message::parse(&frame) {
            Ok(Message::Response(response)) => {
                let Some(id) = response.id else { continue };
                let sender = shared.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
                if let Some(sender) = sender {
                    let _ = sender.answer.send(response.outcome);
                }
            }
            Ok(Message::Notification(notification)) => {
                if notification.method == "kit.progress"
                    && let Some(params) = notification.params.as_ref()
                    && let Ok(progress) = serde_json::from_value::<kition_kit_process_protocol::types::ProgressParams>(params.clone())
                {
                    let pending = shared.pending.lock().unwrap_or_else(PoisonError::into_inner);
                    if let Some(sender) = pending.get(&progress.token).and_then(|waiting| waiting.progress.as_ref()) {
                        let _ = sender.try_send(progress);
                    }
                }
                let _ = notifications.send(notification);
            }
            Ok(Message::Request(request)) => answer(&shared, service.as_ref(), request),
            Err(_) => {
                tracing::warn!(target: "kition_kit", "dropped a malformed message from a kit")
            }
        }
    }
    // Dropping the senders fails every pending request with `Closed`.
    shared.pending.lock().unwrap_or_else(PoisonError::into_inner).clear();
    let _ = closed.send(true);
}

#[cfg(test)]
mod control_tests {
    use super::*;
    use serde_json::json;

    type PeerReader = BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>;
    type PeerWriter = tokio::io::WriteHalf<tokio::io::DuplexStream>;

    fn pair() -> (Arc<KitClient>, PeerReader, PeerWriter) {
        let (client, peer) = tokio::io::duplex(8192);
        let (reader, writer) = tokio::io::split(client);
        let (peer_reader, peer_writer) = tokio::io::split(peer);
        (Arc::new(KitClient::new(Box::new(reader), Box::new(writer))), BufReader::new(peer_reader), peer_writer)
    }

    #[tokio::test]
    async fn progress_is_correlated_and_unrelated_tokens_are_dropped() {
        let (client, mut reader, mut writer) = pair();
        let (_cancel, cancelled) = watch::channel(false);
        let (progress, mut received) = mpsc::channel(4);
        let control = RequestControl::new(cancelled, Some(progress));
        let peer = async {
            let request = read_frame_async(&mut reader, &mut Vec::new()).await.unwrap().unwrap();
            let request: Value = serde_json::from_str(&request).unwrap();
            for token in [json!(999), request["id"].clone()] {
                let frame = framing::encode(&json!({ "jsonrpc": "2.0", "method": "kit.progress", "params": {
                    "token": token, "title": "Saving", "fraction": 0.5, "done": false,
                } }))
                .unwrap();
                write_frame_async(&mut writer, &frame).await.unwrap();
            }
            let frame = framing::encode(&json!({ "jsonrpc": "2.0", "id": request["id"], "result": {} })).unwrap();
            write_frame_async(&mut writer, &frame).await.unwrap();
        };
        let (answer, ()) = tokio::join!(control.scope(client.request("file.save", json!({}), Some(Duration::from_secs(2)))), peer);
        assert_eq!(answer.unwrap(), json!({}));
        assert_eq!(received.try_recv().unwrap().title, "Saving");
        assert!(received.try_recv().is_err());
        assert!(client.pending().is_empty());
    }

    #[tokio::test]
    async fn cancellation_and_timeout_send_the_existing_cancel_message_and_clear_pending() {
        for cancel in [true, false] {
            let (client, mut reader, _writer) = pair();
            let (cancel_tx, cancelled) = watch::channel(false);
            let control = RequestControl::new(cancelled, None);
            let request = control.scope(client.request("commands.execute", json!({}), Some(Duration::from_millis(20))));
            let peer = async {
                let request = read_frame_async(&mut reader, &mut Vec::new()).await.unwrap().unwrap();
                let request: Value = serde_json::from_str(&request).unwrap();
                if cancel {
                    cancel_tx.send(true).unwrap();
                }
                let notification =
                    tokio::time::timeout(Duration::from_secs(2), read_frame_async(&mut reader, &mut Vec::new())).await.unwrap().unwrap().unwrap();
                let notification: Value = serde_json::from_str(&notification).unwrap();
                assert_eq!(notification["method"], "$/cancelRequest");
                assert_eq!(notification["params"]["id"], request["id"]);
            };
            let (result, ()) = tokio::join!(request, peer);
            if cancel {
                assert!(matches!(result, Err(ClientError::Cancelled)));
            } else {
                assert!(matches!(result, Err(ClientError::Timeout(_))));
            }
            assert!(client.pending().is_empty());
        }
    }

    #[tokio::test]
    async fn a_blocked_writer_is_also_bounded_by_the_request_deadline() {
        let (client, _peer) = tokio::io::duplex(1);
        let (reader, writer) = tokio::io::split(client);
        let client = KitClient::new(Box::new(reader), Box::new(writer));
        let result = tokio::time::timeout(Duration::from_secs(2), client.request("kit.ping", json!({}), Some(Duration::from_millis(10)))).await.unwrap();
        assert!(matches!(result, Err(ClientError::Timeout(_))));
        assert!(client.pending().is_empty());
    }
}
