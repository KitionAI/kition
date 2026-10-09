//! Fetching new messages from an IMAP mailbox.

use std::sync::Arc;
use std::time::Duration;

use futures::TryStreamExt;
use futures::future::BoxFuture;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::types::ConnectionConfig;

pub const IMAP_TIMEOUT: Duration = Duration::from_secs(120);
pub const FETCH_LIMIT: usize = 100;
pub const MAX_RAW_MESSAGE_BYTES: usize = 25 << 20;

pub const ERR_AUTHENTICATION: &str = "authentication_failed";
pub const ERR_CONNECTION: &str = "connection_failed";
pub const ERR_MAILBOX: &str = "mailbox_unavailable";
pub const ERR_TLS: &str = "tls_failed";
pub const ERR_INVALID_CONFIG: &str = "invalid_config";

/// A classified failure. Plain failures (without a code) report
/// `connection_failed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncError {
    pub code: String,
    pub message: String,
}

impl SyncError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    pub fn plain(message: impl Into<String>) -> Self {
        Self {
            code: String::new(),
            message: message.into(),
        }
    }

    pub fn code_or_default(&self) -> &str {
        if self.code.is_empty() {
            ERR_CONNECTION
        } else {
            &self.code
        }
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Cursor {
    pub uid_validity: u32,
    pub uid: u32,
}

#[derive(Debug, Clone)]
pub struct FetchedMessage {
    pub uid: u32,
    /// Server receive time in Unix milliseconds.
    pub internal_date: Option<i64>,
    pub raw: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct FetchBatch {
    pub uid_validity: u32,
    /// Messages available after the cursor (the batch holds at most
    /// [`FETCH_LIMIT`]).
    pub total: usize,
    pub messages: Vec<FetchedMessage>,
}

pub trait MailboxFetcher: Send + Sync {
    fn test<'a>(
        &'a self,
        config: &'a ConnectionConfig,
        password: &'a str,
    ) -> BoxFuture<'a, Result<(), SyncError>>;
    fn fetch<'a>(
        &'a self,
        config: &'a ConnectionConfig,
        password: &'a str,
        cursor: Cursor,
    ) -> BoxFuture<'a, Result<FetchBatch, SyncError>>;
}

pub fn validate_connection(config: &ConnectionConfig, password: &str) -> Result<(), String> {
    if config.host.trim().is_empty() {
        return Err("IMAP host is required".into());
    }
    if !(1..=65535).contains(&config.port) {
        return Err("IMAP port must be between 1 and 65535".into());
    }
    if !matches!(config.tls_mode.as_str(), "tls" | "starttls" | "plain") {
        return Err("IMAP TLS mode must be tls, starttls, or plain".into());
    }
    if config.username.trim().is_empty() {
        return Err("IMAP username is required".into());
    }
    if password.is_empty() {
        return Err("IMAP password is required".into());
    }
    if config.mailbox.trim().is_empty() {
        return Err("IMAP mailbox is required".into());
    }
    Ok(())
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug> Stream for T {}

type Session = async_imap::Session<Box<dyn Stream>>;

fn tls_connector() -> Result<TlsConnector, String> {
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])
    .map_err(|e| e.to_string())?;
    let config = rustls_platform_verifier::BuilderVerifierExt::with_platform_verifier(config)
        .map_err(|e| e.to_string())?
        .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

async fn wrap_tls(stream: Box<dyn Stream>, host: &str) -> Result<Box<dyn Stream>, String> {
    let name = ServerName::try_from(host.to_owned()).map_err(|e| e.to_string())?;
    let tls = tls_connector()?
        .connect(name, stream)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Box::new(tls))
}

fn wrap(code: &str, operation: &str, err: impl std::fmt::Display) -> SyncError {
    SyncError::new(code, format!("{operation}: {err}"))
}

/// Dial failures worded like the legacy network errors the client knows.
fn dial_error_text(err: &std::io::Error, host: &str, port: i64) -> String {
    let address = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let message = err.to_string();
    if err.kind() == std::io::ErrorKind::ConnectionRefused || message.contains("refused") {
        return format!("dial tcp {address}: connect: connection refused");
    }
    if message.contains("failed to lookup")
        || message.contains("nodename nor servname")
        || message.contains("not known")
    {
        return format!("dial tcp: lookup {host}: no such host");
    }
    message
}

fn is_tls_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("tls") || lower.contains("certificate") || lower.contains("handshake")
}

/// Connects, authenticates, and identifies the client.
async fn connect(config: &ConnectionConfig, password: &str) -> Result<Session, SyncError> {
    let config = config.clone().normalized();
    validate_connection(&config, password).map_err(|e| SyncError::new(ERR_INVALID_CONFIG, e))?;
    let address = format!("{}:{}", config.host, config.port);
    let connect_error = |err: String| {
        let code = if config.tls_mode != "plain" && is_tls_error(&err) {
            ERR_TLS
        } else {
            ERR_CONNECTION
        };
        wrap(code, "connect to IMAP server", err)
    };
    let tcp = tokio::time::timeout(Duration::from_secs(30), TcpStream::connect(&address))
        .await
        .map_err(|_| connect_error("i/o timeout".into()))?
        .map_err(|e| connect_error(dial_error_text(&e, &config.host, config.port)))?;
    let mut stream: Box<dyn Stream> = Box::new(tcp);
    if config.tls_mode == "tls" {
        stream = wrap_tls(stream, &config.host)
            .await
            .map_err(connect_error)?;
    }
    let mut client = async_imap::Client::new(stream);
    client
        .read_response()
        .await
        .ok_or_else(|| wrap(ERR_CONNECTION, "read IMAP greeting", "EOF"))?
        .map_err(|e| wrap(ERR_CONNECTION, "read IMAP greeting", e))?;
    if config.tls_mode == "starttls" {
        client
            .run_command_and_check_ok("STARTTLS", None)
            .await
            .map_err(|e| connect_error(e.to_string()))?;
        let upgraded = wrap_tls(client.into_inner(), &config.host)
            .await
            .map_err(connect_error)?;
        client = async_imap::Client::new(upgraded);
    }
    let mut session = client
        .login(&config.username, password)
        .await
        .map_err(|(err, _)| wrap(ERR_AUTHENTICATION, "authenticate IMAP account", err))?;
    let capabilities = session
        .capabilities()
        .await
        .map_err(|e| wrap(ERR_CONNECTION, "identify IMAP client", e))?;
    if capabilities.has_str("ID") {
        session
            .id([
                ("name", Some("Kition")),
                ("version", Some("1.0")),
                ("vendor", Some("Kition")),
                ("support-url", Some("https://kition.ai")),
            ])
            .await
            .map_err(|e| wrap(ERR_CONNECTION, "identify IMAP client", e))?;
    }
    Ok(session)
}

async fn close(mut session: Session) {
    let _ = session.logout().await;
}

/// The real IMAP implementation.
#[derive(Debug, Clone, Default)]
pub struct ImapFetcher;

impl ImapFetcher {
    async fn test_inner(config: &ConnectionConfig, password: &str) -> Result<(), SyncError> {
        let mut session = connect(config, password).await?;
        let mailbox = config.clone().normalized().mailbox;
        let result = session
            .examine(&mailbox)
            .await
            .map_err(|e| wrap(ERR_MAILBOX, "select mailbox", e));
        close(session).await;
        result.map(|_| ())
    }

    async fn fetch_inner(
        config: &ConnectionConfig,
        password: &str,
        cursor: Cursor,
    ) -> Result<FetchBatch, SyncError> {
        let mut session = connect(config, password).await?;
        let result =
            Self::fetch_with(&mut session, &config.clone().normalized().mailbox, cursor).await;
        close(session).await;
        result
    }

    async fn fetch_with(
        session: &mut Session,
        mailbox: &str,
        cursor: Cursor,
    ) -> Result<FetchBatch, SyncError> {
        let selected = session
            .examine(mailbox)
            .await
            .map_err(|e| wrap(ERR_MAILBOX, "select mailbox", e))?;
        let uid_validity = selected.uid_validity.unwrap_or(0);
        let start = if cursor.uid_validity == 0 || cursor.uid_validity != uid_validity {
            1
        } else {
            cursor.uid.saturating_add(1)
        };
        let mut uids: Vec<u32> = session
            .uid_search(format!("UID {start}:*"))
            .await
            .map_err(|e| wrap(ERR_CONNECTION, "search mailbox", e))?
            .into_iter()
            .filter(|uid| *uid >= start)
            .collect();
        // Some providers truncate ranged UID SEARCH results; scan UIDs by
        // sequence number before downloading bodies.
        if uids.len() == 1 || (start == 1 && selected.exists as usize > uids.len()) {
            let listed: Vec<u32> = session
                .fetch("1:*", "(UID)")
                .await
                .map_err(|e| wrap(ERR_CONNECTION, "list mailbox UIDs", e))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|e| wrap(ERR_CONNECTION, "list mailbox UIDs", e))?
                .into_iter()
                .filter_map(|item| item.uid)
                .filter(|uid| *uid >= start)
                .collect();
            if listed.len() > uids.len() {
                uids = listed;
            }
        }
        uids.sort_unstable();
        uids.dedup();
        let total = uids.len();
        uids.truncate(FETCH_LIMIT);
        let mut batch = FetchBatch {
            uid_validity,
            total,
            messages: Vec::new(),
        };
        if uids.is_empty() {
            return Ok(batch);
        }
        let set = uids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let fetched = session
            .uid_fetch(&set, "(UID INTERNALDATE RFC822.SIZE BODY.PEEK[])")
            .await
            .map_err(|e| wrap(ERR_CONNECTION, "fetch messages", e))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| wrap(ERR_CONNECTION, "fetch messages", e))?;
        for item in fetched {
            let Some(uid) = item.uid.filter(|uid| *uid > 0) else {
                continue;
            };
            let limit_error = || {
                SyncError::plain(format!(
                    "message UID {uid} exceeds the {} MB import limit",
                    MAX_RAW_MESSAGE_BYTES >> 20
                ))
            };
            if item.size.unwrap_or(0) as usize > MAX_RAW_MESSAGE_BYTES {
                return Err(limit_error());
            }
            let raw = item.body().unwrap_or_default();
            if raw.len() > MAX_RAW_MESSAGE_BYTES {
                return Err(limit_error());
            }
            batch.messages.push(FetchedMessage {
                uid,
                internal_date: item.internal_date().map(|d| d.timestamp_millis()),
                raw: raw.to_vec(),
            });
        }
        batch.messages.sort_by_key(|m| m.uid);
        Ok(batch)
    }
}

impl MailboxFetcher for ImapFetcher {
    fn test<'a>(
        &'a self,
        config: &'a ConnectionConfig,
        password: &'a str,
    ) -> BoxFuture<'a, Result<(), SyncError>> {
        Box::pin(async move {
            tokio::time::timeout(IMAP_TIMEOUT, Self::test_inner(config, password))
                .await
                .unwrap_or_else(|_| {
                    Err(wrap(
                        ERR_CONNECTION,
                        "connect to IMAP server",
                        "i/o timeout",
                    ))
                })
        })
    }

    fn fetch<'a>(
        &'a self,
        config: &'a ConnectionConfig,
        password: &'a str,
        cursor: Cursor,
    ) -> BoxFuture<'a, Result<FetchBatch, SyncError>> {
        Box::pin(async move {
            tokio::time::timeout(IMAP_TIMEOUT, Self::fetch_inner(config, password, cursor))
                .await
                .unwrap_or_else(|_| Err(wrap(ERR_CONNECTION, "fetch messages", "i/o timeout")))
        })
    }
}
