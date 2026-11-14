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
use kition_kit_process_protocol::types::{CancelRequestParams, Empty, InitializeParams, InitializeResult};
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
        matches!(self, Self::Launch(_) | Self::Timeout(_) | Self::Closed | Self::Io(_))
    }
}

type Pending = Mutex<HashMap<RequestId, oneshot::Sender<Result<Value, RpcError>>>>;

struct Shared {
    writer: tokio::sync::Mutex<BoxWriter>,
    pending: Pending,
    next_id: AtomicI64,
}

/// One connection to a kit.
pub struct KitClient {
    shared: Arc<Shared>,
    notifications: tokio::sync::Mutex<mpsc::UnboundedReceiver<Notification>>,
    closed: watch::Receiver<bool>,
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
        let shared = Arc::new(Shared { writer: tokio::sync::Mutex::new(writer), pending: Mutex::new(HashMap::new()), next_id: AtomicI64::new(1) });
        let (notify_tx, notify_rx) = mpsc::unbounded_channel();
        let (closed_tx, closed_rx) = watch::channel(false);
        tokio::spawn(read_loop(reader, Arc::clone(&shared), notify_tx, closed_tx, service));
        Self { shared, notifications: tokio::sync::Mutex::new(notify_rx), closed: closed_rx }
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
        let id = RequestId::Number(self.shared.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending().insert(id.clone(), tx);
        let request = Message::Request(Request { id: id.clone(), method: method.to_owned(), params: Some(params) });
        if let Err(error) = self.send(&request.to_value()).await {
            self.pending().remove(&id);
            return Err(error);
        }
        let outcome = match limit {
            None => rx.await,
            Some(limit) => match tokio::time::timeout(limit, rx).await {
                Ok(outcome) => outcome,
                Err(_) => {
                    self.pending().remove(&id);
                    let _ = self.notify::<CancelRequest>(&CancelRequestParams { id }).await;
                    return Err(ClientError::Timeout(method.to_owned()));
                }
            },
        };
        match outcome {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(ClientError::Rpc(error)),
            Err(_) => Err(ClientError::Closed),
        }
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

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<RequestId, oneshot::Sender<Result<Value, RpcError>>>> {
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
                    let _ = sender.send(response.outcome);
                }
            }
            Ok(Message::Notification(notification)) => {
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
