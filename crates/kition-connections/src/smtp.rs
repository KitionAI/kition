//! A small SMTP client: implicit TLS or required STARTTLS, PLAIN auth only
//! over encrypted connections (or to localhost), and errors rendered as
//! `<code> <message>` like the legacy client.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(30);

/// A failed SMTP step with a classified error code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for SmtpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.message.is_empty() {
            f.write_str(self.code)
        } else {
            f.write_str(&self.message)
        }
    }
}

pub const ERR_CONNECTION_INVALID: &str = "connection_invalid";
pub const ERR_AUTH_FAILED: &str = "auth_failed";
pub const ERR_TLS_FAILED: &str = "tls_failed";
pub const ERR_STARTTLS_UNSUPPORTED: &str = "starttls_unsupported";
pub const ERR_CONNECT_REFUSED: &str = "connect_refused";
pub const ERR_DNS_FAILED: &str = "dns_failed";
pub const ERR_DELIVERY_FAILED: &str = "delivery_failed";

fn error(code: &'static str, message: impl Into<String>) -> SmtpError {
    SmtpError {
        code,
        message: message.into(),
    }
}

#[derive(Debug, Clone)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub from: String,
    pub from_name: String,
    /// `starttls`, `tls`, or `plain`.
    pub tls_mode: String,
    /// Optional `http(s)://` or `socks5(h)://` proxy URL; empty dials direct.
    pub proxy: String,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub to: String,
    pub subject: String,
    pub body: String,
}

/// An SMTP reply: code and message lines joined with `\n`.
#[derive(Debug)]
struct Reply {
    code: u16,
    text: String,
}

impl Reply {
    fn error_text(&self) -> String {
        format!("{:03} {}", self.code, self.text)
    }
}

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

pub type BoxedStream = Box<dyn Stream>;

struct Session {
    io: BufReader<Box<dyn Stream>>,
    extensions: Vec<(String, String)>,
    encrypted: bool,
}

impl Session {
    async fn read_reply(&mut self) -> std::io::Result<Reply> {
        let mut code;
        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            if self.io.read_line(&mut line).await? == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "EOF",
                ));
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line.len() < 3 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("short response: {line}"),
                ));
            }
            code = line[..3].parse().map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid response code")
            })?;
            lines.push(line.get(4..).unwrap_or_default().to_owned());
            if line.as_bytes().get(3) != Some(&b'-') {
                break;
            }
        }
        Ok(Reply {
            code,
            text: lines.join("\n"),
        })
    }

    async fn command(&mut self, line: &str) -> std::io::Result<Reply> {
        self.io
            .get_mut()
            .write_all(format!("{line}\r\n").as_bytes())
            .await?;
        self.io.get_mut().flush().await?;
        self.read_reply().await
    }

    /// Sends a command and requires a reply code in `expected`.
    async fn expect(&mut self, line: &str, expected: &[u16]) -> Result<Reply, String> {
        let reply = self.command(line).await.map_err(|e| e.to_string())?;
        if expected.contains(&reply.code) {
            Ok(reply)
        } else {
            Err(reply.error_text())
        }
    }

    async fn hello(&mut self) -> Result<(), String> {
        let reply = self
            .command("EHLO localhost")
            .await
            .map_err(|e| e.to_string())?;
        if reply.code == 250 {
            self.extensions = reply
                .text
                .lines()
                .skip(1)
                .map(|line| {
                    let (key, value) = line.split_once(' ').unwrap_or((line, ""));
                    (key.to_uppercase(), value.to_owned())
                })
                .collect();
            return Ok(());
        }
        self.expect("HELO localhost", &[250]).await.map(|_| ())
    }

    fn has_extension(&self, name: &str) -> bool {
        self.extensions.iter().any(|(key, _)| key == name)
    }
}

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

pub(crate) async fn wrap_tls(
    stream: Box<dyn Stream>,
    host: &str,
) -> Result<Box<dyn Stream>, String> {
    let name = ServerName::try_from(host.to_owned()).map_err(|e| e.to_string())?;
    let tls = tls_connector()?
        .connect(name, stream)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Box::new(tls))
}

fn classify_dial(err: &std::io::Error, host: &str) -> SmtpError {
    let message = err.to_string();
    if err.kind() == std::io::ErrorKind::ConnectionRefused || message.contains("refused") {
        return error(
            ERR_CONNECT_REFUSED,
            format!("dial tcp {host}: connect: connection refused"),
        );
    }
    if message.contains("failed to lookup")
        || message.contains("nodename nor servname")
        || message.contains("not known")
    {
        return error(
            ERR_DNS_FAILED,
            format!("dial tcp: lookup {host}: no such host"),
        );
    }
    error(ERR_DELIVERY_FAILED, message)
}

/// Classifies a failed SMTP command by its reply text.
fn classify_command(message: String) -> SmtpError {
    if message.starts_with("535") || message.contains("authentication failed") {
        return error(ERR_AUTH_FAILED, message);
    }
    if message.starts_with("550") || message.starts_with("553") || message.starts_with("554") {
        return error(ERR_CONNECTION_INVALID, message);
    }
    error(ERR_DELIVERY_FAILED, message)
}

fn is_localhost(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Connects, negotiates TLS and authentication, runs `work`, then quits.
async fn with_session<F, Fut>(config: &SmtpConfig, work: F) -> Result<(), SmtpError>
where
    F: FnOnce(Session) -> Fut,
    Fut: std::future::Future<Output = Result<Session, SmtpError>>,
{
    let address = format!("{}:{}", config.host, config.port);
    let host_port = if config.host.contains(':') {
        format!("[{}]:{}", config.host, config.port)
    } else {
        address.clone()
    };
    let tcp: Box<dyn Stream> =
        if !config.proxy.trim().is_empty() && !crate::proxy::should_bypass(&config.host) {
            crate::proxy::dial(
                config.proxy.trim(),
                &config.host,
                config.port,
                CONNECT_TIMEOUT,
            )
            .await
            .map_err(|e| error(ERR_DELIVERY_FAILED, e))?
        } else {
            match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&address)).await {
                Err(_) => {
                    return Err(error(
                        ERR_DELIVERY_FAILED,
                        format!("dial tcp {host_port}: i/o timeout"),
                    ));
                }
                Ok(Err(err)) => return Err(classify_dial(&err, &host_port)),
                Ok(Ok(tcp)) => Box::new(tcp),
            }
        };
    let session_future = async {
        let mut stream: Box<dyn Stream> = tcp;
        let mut encrypted = false;
        if config.tls_mode == "tls" {
            stream = wrap_tls(stream, &config.host)
                .await
                .map_err(|e| error(ERR_TLS_FAILED, e))?;
            encrypted = true;
        }
        let mut session = Session {
            io: BufReader::new(stream),
            extensions: Vec::new(),
            encrypted,
        };
        let greeting = session
            .read_reply()
            .await
            .map_err(|e| error(ERR_DELIVERY_FAILED, e.to_string()))?;
        if greeting.code != 220 {
            return Err(error(ERR_DELIVERY_FAILED, greeting.error_text()));
        }
        session
            .hello()
            .await
            .map_err(|e| error(ERR_DELIVERY_FAILED, e))?;

        if config.tls_mode == "starttls" {
            if !session.has_extension("STARTTLS") {
                return Err(error(
                    ERR_STARTTLS_UNSUPPORTED,
                    format!(
                        "server {} does not advertise STARTTLS but tlsMode=starttls",
                        config.host
                    ),
                ));
            }
            session
                .expect("STARTTLS", &[220])
                .await
                .map_err(|e| error(ERR_TLS_FAILED, e))?;
            let plain = session.io.into_inner();
            let upgraded = wrap_tls(plain, &config.host)
                .await
                .map_err(|e| error(ERR_TLS_FAILED, e))?;
            session = Session {
                io: BufReader::new(upgraded),
                extensions: Vec::new(),
                encrypted: true,
            };
            session
                .hello()
                .await
                .map_err(|e| error(ERR_TLS_FAILED, e))?;
        }

        if !config.username.is_empty() || !config.password.is_empty() {
            if !session.encrypted && config.tls_mode != "plain" {
                return Err(error(
                    ERR_TLS_FAILED,
                    format!(
                        "refusing to send AUTH over plaintext connection (tlsMode={})",
                        config.tls_mode
                    ),
                ));
            }
            if session.has_extension("AUTH") {
                if !session.encrypted && !is_localhost(&config.host) {
                    return Err(error(ERR_AUTH_FAILED, "unencrypted connection"));
                }
                let token = STANDARD.encode(format!("\0{}\0{}", config.username, config.password));
                session
                    .expect(&format!("AUTH PLAIN {token}"), &[235])
                    .await
                    .map_err(|e| error(ERR_AUTH_FAILED, e))?;
            }
        }
        let mut session = work(session).await?;
        session
            .expect("QUIT", &[221])
            .await
            .map_err(|e| error(ERR_DELIVERY_FAILED, e))?;
        Ok(())
    };
    match tokio::time::timeout(SESSION_TIMEOUT, session_future).await {
        Ok(result) => result,
        Err(_) => Err(error(ERR_DELIVERY_FAILED, "i/o timeout")),
    }
}

/// Connects and issues NOOP.
pub async fn verify(config: &SmtpConfig) -> Result<(), SmtpError> {
    with_session(config, |mut session| async move {
        session
            .expect("NOOP", &[250])
            .await
            .map_err(classify_command)?;
        Ok(session)
    })
    .await
}

/// Strips CR and LF so header values cannot inject new headers.
pub fn sanitize_header(value: &str) -> String {
    value.chars().filter(|c| *c != '\r' && *c != '\n').collect()
}

/// `"Name" <address>` with the name quoted (and encoded when non-ASCII).
fn format_address(name: &str, address: &str) -> String {
    if name.is_ascii() {
        let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\" <{address}>")
    } else {
        format!("=?utf-8?q?{}?= <{address}>", q_encode(name))
    }
}

fn q_encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b' ' => "_".to_owned(),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'!' | b'*' | b'+' | b'-' | b'/' => {
                char::from(b).to_string()
            }
            other => format!("={other:02X}"),
        })
        .collect()
}

pub fn build_message(config: &SmtpConfig, message: &Message) -> String {
    let from = if config.from_name.is_empty() {
        sanitize_header(&config.from)
    } else {
        format_address(
            &sanitize_header(&config.from_name),
            &sanitize_header(&config.from),
        )
    };
    let headers = [
        format!("From: {from}"),
        format!("To: {}", sanitize_header(&message.to)),
        format!("Subject: {}", sanitize_header(&message.subject)),
        "MIME-Version: 1.0".to_owned(),
        "Content-Type: text/plain; charset=UTF-8".to_owned(),
        "Content-Transfer-Encoding: 8bit".to_owned(),
    ];
    let body = message.body.replace("\r\n", "\n").replace('\n', "\r\n");
    format!("{}\r\n\r\n{body}", headers.join("\r\n"))
}

/// Delivers one plain-text message.
pub async fn send(config: &SmtpConfig, message: &Message) -> Result<(), SmtpError> {
    if let Err(err) = parse_address(&message.to) {
        return Err(error(
            ERR_CONNECTION_INVALID,
            format!("email recipient invalid: {err}"),
        ));
    }
    if message.subject.is_empty() {
        return Err(error(ERR_CONNECTION_INVALID, "email subject required"));
    }
    let data = build_message(config, message);
    let from = config.from.clone();
    let to = message.to.clone();
    with_session(config, |mut session| async move {
        let mut mail = format!("MAIL FROM:<{from}>");
        if session.has_extension("8BITMIME") {
            mail.push_str(" BODY=8BITMIME");
        }
        if session.has_extension("SMTPUTF8") {
            mail.push_str(" SMTPUTF8");
        }
        session
            .expect(&mail, &[250])
            .await
            .map_err(classify_command)?;
        session
            .expect(&format!("RCPT TO:<{to}>"), &[250, 251])
            .await
            .map_err(classify_command)?;
        session
            .expect("DATA", &[354])
            .await
            .map_err(classify_command)?;
        let mut stuffed = String::new();
        for line in data.split("\r\n") {
            if line.starts_with('.') {
                stuffed.push('.');
            }
            stuffed.push_str(line);
            stuffed.push_str("\r\n");
        }
        stuffed.push_str(".\r\n");
        let writer = session.io.get_mut();
        writer
            .write_all(stuffed.as_bytes())
            .await
            .map_err(|e| classify_command(e.to_string()))?;
        writer
            .flush()
            .await
            .map_err(|e| classify_command(e.to_string()))?;
        let reply = session
            .read_reply()
            .await
            .map_err(|e| classify_command(e.to_string()))?;
        if reply.code != 250 {
            return Err(classify_command(reply.error_text()));
        }
        Ok(session)
    })
    .await
}

/// A minimal RFC 5322 address check with the legacy parser's messages.
pub fn parse_address(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("mail: no address".to_owned());
    }
    let address = match (value.rfind('<'), value.rfind('>')) {
        (Some(open), Some(close)) if open < close => value[open + 1..close].trim(),
        (Some(_), _) => return Err("mail: unclosed angle-addr".to_owned()),
        _ => value,
    };
    let Some((local, domain)) = address.split_once('@') else {
        return Err("mail: missing '@' or angle-addr".to_owned());
    };
    if local.is_empty() {
        return Err("mail: no local-part".to_owned());
    }
    if domain.is_empty()
        || domain.contains('@')
        || domain.contains(char::is_whitespace)
        || local.contains(char::is_whitespace)
    {
        return Err("mail: invalid string".to_owned());
    }
    Ok(address.to_owned())
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    use super::*;

    #[test]
    fn addresses() {
        assert_eq!(parse_address("a@b.com"), Ok("a@b.com".into()));
        assert_eq!(parse_address("Ada <a@b.com>"), Ok("a@b.com".into()));
        assert!(parse_address("").is_err());
        assert_eq!(
            parse_address("nope"),
            Err("mail: missing '@' or angle-addr".into())
        );
    }

    #[test]
    fn builds_messages_without_header_injection() {
        let config = SmtpConfig {
            host: "h".into(),
            port: 25,
            username: String::new(),
            password: String::new(),
            from: "bot@x.com".into(),
            from_name: "Kition Bot".into(),
            tls_mode: "plain".into(),
            proxy: String::new(),
        };
        let message = Message {
            to: "a@b.com".into(),
            subject: "Hi\nBcc: evil@x.com".into(),
            body: "one\ntwo\r\n.three".into(),
        };
        let raw = build_message(&config, &message);
        assert!(raw.starts_with(
            "From: \"Kition Bot\" <bot@x.com>\r\nTo: a@b.com\r\nSubject: HiBcc: evil@x.com\r\n"
        ));
        assert!(raw.ends_with("\r\n\r\none\r\ntwo\r\n.three"));
    }

    /// A scripted plaintext SMTP server for one session.
    async fn fake_server(script: &'static [(&'static str, &'static str)]) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap_or_else(|err| panic!("{err}"));
        let port = listener.local_addr().map(|a| a.port()).unwrap_or_default();
        tokio::spawn(async move {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let mut io = BufReader::new(stream);
            let _ = io.get_mut().write_all(b"220 fake ESMTP\r\n").await;
            for (expect, reply) in script {
                let mut line = String::new();
                if io.read_line(&mut line).await.unwrap_or(0) == 0 {
                    return;
                }
                assert!(line.starts_with(expect), "expected {expect}, got {line}");
                if *expect == "DATA" {
                    let _ = io.get_mut().write_all(b"354 go\r\n").await;
                    loop {
                        let mut data = String::new();
                        if io.read_line(&mut data).await.unwrap_or(0) == 0 || data == ".\r\n" {
                            break;
                        }
                    }
                }
                let _ = io.get_mut().write_all(reply.as_bytes()).await;
            }
        });
        port
    }

    fn plain(port: u16) -> SmtpConfig {
        SmtpConfig {
            host: "127.0.0.1".into(),
            port,
            username: "u".into(),
            password: "p".into(),
            from: "bot@x.com".into(),
            from_name: String::new(),
            tls_mode: "plain".into(),
            proxy: String::new(),
        }
    }

    #[tokio::test]
    async fn verifies_and_sends_over_plain_localhost() {
        let port = fake_server(&[
            ("EHLO", "250-fake\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n"),
            ("AUTH PLAIN", "235 ok\r\n"),
            ("NOOP", "250 ok\r\n"),
            ("QUIT", "221 bye\r\n"),
        ])
        .await;
        assert_eq!(verify(&plain(port)).await, Ok(()));

        let port = fake_server(&[
            ("EHLO", "250-fake\r\n250 8BITMIME\r\n"),
            ("MAIL FROM:<bot@x.com> BODY=8BITMIME", "250 ok\r\n"),
            ("RCPT TO:<a@b.com>", "250 ok\r\n"),
            ("DATA", "250 queued\r\n"),
            ("QUIT", "221 bye\r\n"),
        ])
        .await;
        let message = Message {
            to: "a@b.com".into(),
            subject: "s".into(),
            body: "b".into(),
        };
        assert_eq!(send(&plain(port), &message).await, Ok(()));
    }

    #[tokio::test]
    async fn classifies_failures() {
        let port = fake_server(&[
            ("EHLO", "250-fake\r\n250 AUTH PLAIN\r\n"),
            ("AUTH PLAIN", "535 5.7.8 bad credentials\r\n"),
        ])
        .await;
        let err = verify(&plain(port)).await.err();
        assert_eq!(err.as_ref().map(|e| e.code), Some(ERR_AUTH_FAILED));
        assert_eq!(
            err.map(|e| e.message),
            Some("535 5.7.8 bad credentials".into())
        );

        let port = fake_server(&[("EHLO", "250 fake\r\n")]).await;
        let mut starttls = plain(port);
        starttls.tls_mode = "starttls".into();
        assert_eq!(
            verify(&starttls).await.err().map(|e| e.code),
            Some(ERR_STARTTLS_UNSUPPORTED)
        );

        let closed = TcpListener::bind("127.0.0.1:0")
            .await
            .map(|l| l.local_addr().map(|a| a.port()).unwrap_or(1))
            .unwrap_or(1);
        assert_eq!(
            verify(&plain(closed)).await.err().map(|e| e.code),
            Some(ERR_CONNECT_REFUSED)
        );
    }
}
