//! Tunnels an SMTP connection through an HTTP(S) CONNECT or SOCKS5 proxy,
//! honoring `KITION_SMTP_NO_PROXY` / `NO_PROXY`.

use std::time::Duration;

use base64::Engine;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::smtp::BoxedStream;

/// True when `host` is listed in the no-proxy variables.
pub fn should_bypass(host: &str) -> bool {
    let read = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let Some(list) = read("KITION_SMTP_NO_PROXY")
        .or_else(|| read("NO_PROXY"))
        .or_else(|| read("no_proxy"))
    else {
        return false;
    };
    if list == "*" {
        return true;
    }
    let host = host.trim().to_lowercase();
    list.split(',')
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .any(|entry| {
            entry == host
                || (entry.starts_with('.') && host.ends_with(&entry))
                || (!entry.contains('/')
                    && !entry.starts_with('.')
                    && host.ends_with(&format!(".{entry}")))
        })
}

struct ProxyUrl {
    scheme: String,
    host: String,
    port: u16,
    user: Option<(String, Option<String>)>,
}

fn parse_proxy(raw: &str) -> Result<ProxyUrl, String> {
    let raw = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    };
    let url = url::Url::parse(&raw).map_err(|e| e.to_string())?;
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_matches(['[', ']'])
        .to_owned();
    if host.is_empty() {
        return Err("invalid smtp proxy URL".into());
    }
    let scheme = url.scheme().to_lowercase();
    let default_port = match scheme.as_str() {
        "https" => 443,
        "socks5" | "socks5h" => 1080,
        _ => 80,
    };
    let user = (!url.username().is_empty() || url.password().is_some()).then(|| {
        let decode = |s: &str| percent_decode(s);
        (decode(url.username()), url.password().map(decode))
    });
    Ok(ProxyUrl {
        scheme,
        host,
        port: url.port().unwrap_or(default_port),
        user,
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&text[i + 1..(i + 3).min(text.len())], 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Connects to `host:port` through the proxy.
pub async fn dial(
    proxy: &str,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<BoxedStream, String> {
    let proxy = parse_proxy(proxy)?;
    let target = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let connect = async {
        let tcp = TcpStream::connect((proxy.host.as_str(), proxy.port))
            .await
            .map_err(|e| e.to_string())?;
        match proxy.scheme.as_str() {
            "http" | "https" => {
                let stream: BoxedStream = if proxy.scheme == "https" {
                    crate::smtp::wrap_tls(Box::new(tcp), &proxy.host)
                        .await
                        .map_err(|e| format!("smtp proxy tls handshake: {e}"))?
                } else {
                    Box::new(tcp)
                };
                http_connect(stream, &target, &proxy).await
            }
            "socks5" | "socks5h" => socks5(tcp, host, port, &proxy)
                .await
                .map_err(|e| format!("smtp proxy socks5 dial: {e}")),
            other => Err(format!("unsupported smtp proxy scheme {}", quote(other))),
        }
    };
    match tokio::time::timeout(timeout, connect).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "smtp proxy dial: timeout after {}s",
            timeout.as_secs()
        )),
    }
}

fn quote(text: &str) -> String {
    format!("{text:?}")
}

async fn http_connect(
    mut stream: BoxedStream,
    target: &str,
    proxy: &ProxyUrl,
) -> Result<BoxedStream, String> {
    let mut request = format!(
        "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\nUser-Agent: Kition-SMTP/1.0\r\n"
    );
    if let Some((user, Some(password))) = &proxy.user {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut status = String::new();
    reader
        .read_line(&mut status)
        .await
        .map_err(|e| e.to_string())?;
    if !status.contains(" 200 ") {
        return Err(format!("smtp proxy CONNECT failed: {}", status.trim()));
    }
    loop {
        let mut line = String::new();
        if reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?
            == 0
            || line.trim().is_empty()
        {
            break;
        }
    }
    // Bytes already buffered past the headers belong to the tunnel.
    Ok(Box::new(reader))
}

async fn socks5(
    mut tcp: TcpStream,
    host: &str,
    port: u16,
    proxy: &ProxyUrl,
) -> Result<BoxedStream, String> {
    let io = |e: std::io::Error| e.to_string();
    let methods: &[u8] = if proxy.user.is_some() {
        &[0x00, 0x02]
    } else {
        &[0x00]
    };
    let mut hello = vec![0x05, u8::try_from(methods.len()).unwrap_or(1)];
    hello.extend_from_slice(methods);
    tcp.write_all(&hello).await.map_err(io)?;
    let mut choice = [0u8; 2];
    tcp.read_exact(&mut choice).await.map_err(io)?;
    match choice[1] {
        0x00 => {}
        0x02 => {
            let (user, password) = proxy.user.clone().unwrap_or_default();
            let password = password.unwrap_or_default();
            let mut auth = vec![
                0x01,
                u8::try_from(user.len()).map_err(|_| "username too long")?,
            ];
            auth.extend_from_slice(user.as_bytes());
            auth.push(u8::try_from(password.len()).map_err(|_| "password too long")?);
            auth.extend_from_slice(password.as_bytes());
            tcp.write_all(&auth).await.map_err(io)?;
            let mut status = [0u8; 2];
            tcp.read_exact(&mut status).await.map_err(io)?;
            if status[1] != 0 {
                return Err("username/password authentication failed".into());
            }
        }
        _ => return Err("no acceptable authentication methods".into()),
    }
    let mut request = vec![
        0x05,
        0x01,
        0x00,
        0x03,
        u8::try_from(host.len()).map_err(|_| "host too long")?,
    ];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    tcp.write_all(&request).await.map_err(io)?;
    let mut reply = [0u8; 4];
    tcp.read_exact(&mut reply).await.map_err(io)?;
    if reply[1] != 0 {
        return Err(format!("unknown error {}", reply[1]));
    }
    let skip = match reply[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await.map_err(io)?;
            usize::from(len[0])
        }
        _ => return Err("unknown address type".into()),
    };
    let mut rest = vec![0u8; skip + 2];
    tcp.read_exact(&mut rest).await.map_err(io)?;
    Ok(Box::new(tcp))
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    #[tokio::test]
    async fn tunnels_through_http_connect() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap_or_else(|e| panic!("{e}"));
        let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap_or_else(|e| panic!("{e}"));
            let mut buf = vec![0u8; 512];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]).into_owned();
            assert!(request.starts_with("CONNECT mail.test:25 HTTP/1.1\r\n"));
            assert!(request.contains("Proxy-Authorization: Basic dTpw\r\n"));
            let _ = socket
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await;
            let _ = socket.write_all(b"220 hello\r\n").await;
        });
        let mut stream = dial(
            &format!("http://u:p@{addr}"),
            "mail.test",
            25,
            Duration::from_secs(5),
        )
        .await
        .unwrap_or_else(|e| panic!("{e}"));
        let mut greeting = String::new();
        let _ = stream.read_to_string(&mut greeting).await;
        assert_eq!(greeting, "220 hello\r\n");
    }

    #[test]
    fn parses_proxy_urls() {
        let proxy = parse_proxy("proxy.test:3128").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!((proxy.scheme.as_str(), proxy.port), ("http", 3128));
        assert_eq!(
            parse_proxy("socks5://a%40b:p@s.test")
                .map(|p| (p.port, p.user))
                .ok(),
            Some((1080, Some(("a@b".into(), Some("p".into())))))
        );
    }
}
