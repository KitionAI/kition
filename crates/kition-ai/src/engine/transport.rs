//! HTTP plumbing shared by every provider wire: authentication headers,
//! endpoint rules, error text, retry classification, bounded body reads,
//! and server-sent-event line reading.

use std::time::Duration;

use futures::StreamExt;
use kition_core::coerce::first_non_empty;
use serde_json::Value;

use super::error::{AiError, AiResult};
use super::types::{RuntimeModel, Usage};

pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const STREAM_HEADER_TIMEOUT: Duration = Duration::from_secs(300);
pub(crate) const IMAGE_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
pub(crate) const MIB: usize = 1 << 20;

/// Authentication and JSON headers for a provider call.
pub(crate) fn chat_headers(model: &RuntimeModel) -> AiResult<Vec<(String, String)>> {
    let token = first_non_empty(&[model.api_key.trim(), model.access_token.trim()]).to_owned();
    if token.is_empty() {
        return Err(AiError::msg(
            "runtime provider is missing API Key or Access Token",
        ));
    }
    let header_name = first_non_empty(&[model.auth_header.trim(), "Authorization"]).to_owned();
    let scheme = first_non_empty(&[model.auth_scheme.trim(), "bearer"]);
    let mut headers = vec![
        ("Accept".to_owned(), "application/json".to_owned()),
        ("Content-Type".to_owned(), "application/json".to_owned()),
    ];
    match scheme {
        "bearer" => headers.push((header_name, format!("Bearer {token}"))),
        "raw" => headers.push((header_name, token)),
        "x-api-key" => headers.push((
            first_non_empty(&[model.auth_header.trim(), "X-API-Key"]).to_owned(),
            token,
        )),
        _ => {
            return Err(AiError::msg(
                "this custom authentication mode is not supported yet",
            ));
        }
    }
    Ok(headers)
}

/// Adds the provider headers to a request whose body was set with `.json()`,
/// which already sets `Content-Type`, and sends exactly one `Accept`. Some
/// gateways reject a repeated `Content-Type` ("Unsupported content type").
pub(crate) fn json_request(
    mut request: reqwest::RequestBuilder,
    headers: &[(String, String)],
    streaming: bool,
) -> reqwest::RequestBuilder {
    for (key, value) in headers.iter().filter(|(key, _)| {
        !key.eq_ignore_ascii_case("Content-Type") && !key.eq_ignore_ascii_case("Accept")
    }) {
        request = request.header(key, value);
    }
    request.header(
        "Accept",
        if streaming {
            "text/event-stream"
        } else {
            "application/json"
        },
    )
}

/// Sets `name` to `value`, replacing any header of the same name.
pub(crate) fn set_header(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    headers.retain(|(key, _)| !key.eq_ignore_ascii_case(name));
    headers.push((name.to_owned(), value.to_owned()));
}

/// OpenAI-compatible providers default to the `/v1` path. DeepSeek's
/// renderer-side settings already send the `/anthropic` Messages path, so a
/// non-empty path here (including `/anthropic`) is left unchanged.
pub(crate) fn normalize_base_url(provider_type: &str, raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        return String::new();
    }
    if !matches!(provider_type, "deepseek" | "openai-oauth2" | "openai") {
        return value.trim_end_matches('/').to_owned();
    }
    match url::Url::parse(value) {
        Ok(mut parsed) if parsed.has_host() => {
            if parsed.path().is_empty() || parsed.path() == "/" {
                parsed.set_path("/v1");
            }
            parsed.as_str().trim_end_matches('/').to_owned()
        }
        _ => value.trim_end_matches('/').to_owned(),
    }
}

pub(crate) fn validate_endpoint(endpoint: &str) -> AiResult<String> {
    let value = endpoint.trim();
    let parsed = match url::Url::parse(value) {
        Ok(parsed) if parsed.has_host() && !parsed.host_str().unwrap_or_default().is_empty() => {
            parsed
        }
        _ => {
            return Err(AiError::msg(format!(
                "invalid runtime provider URL: {value}; it must start with http:// or https://"
            )));
        }
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AiError::msg(format!(
            "invalid runtime provider URL scheme: {}",
            parsed.scheme()
        )));
    }
    Ok(parsed.as_str().trim_end_matches('/').to_owned())
}

fn truncate_chars(text: &str, limit: usize) -> Option<String> {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(limit).collect();
    chars.next().map(|_| head)
}

/// The human-readable part of a provider error body.
pub fn compact_error(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body).trim().to_owned();
    if text.is_empty() {
        return "Unknown error".to_owned();
    }
    let text = match extract_error_message(&text) {
        Some(extracted) => extracted,
        None => text,
    };
    match truncate_chars(&text, 800) {
        Some(head) => format!("{head}..."),
        None => text,
    }
}

/// `{"error": {"message"|"code"}}`, `{"error": "..."}`, `{"message"}`, or
/// `{"detail": "..."|{"message"}}`.
fn extract_error_message(text: &str) -> Option<String> {
    if !text.starts_with('{') {
        return None;
    }
    let parsed: serde_json::Map<String, Value> = serde_json::from_str(text).ok()?;
    let string = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    match parsed.get("error") {
        Some(Value::String(message)) if !message.trim().is_empty() => {
            return Some(message.trim().to_owned());
        }
        Some(Value::Object(error)) => {
            if let Some(message) = string(error.get("message")) {
                return Some(message);
            }
            if let Some(code) = string(error.get("code")) {
                return Some(code);
            }
        }
        _ => {}
    }
    if let Some(message) = string(parsed.get("message")) {
        return Some(message);
    }
    match parsed.get("detail") {
        Some(Value::String(detail)) if !detail.trim().is_empty() => Some(detail.trim().to_owned()),
        Some(Value::Object(detail)) => string(detail.get("message")),
        _ => None,
    }
}

/// Logs a failed provider response without the credentials.
pub(crate) fn log_provider_failure(
    model: &RuntimeModel,
    wire_api: &str,
    endpoint: &str,
    status: u16,
    body: &[u8],
) {
    let text = String::from_utf8_lossy(body).trim().to_owned();
    let text = match truncate_chars(&text, 4000) {
        Some(head) => format!("{head}...(truncated)"),
        None => text,
    };
    tracing::warn!(
        provider = %model.provider_type,
        wire_api,
        model = %model.model_name,
        endpoint,
        status,
        body = %text,
        "[ai.runtime] provider call failed"
    );
}

/// The full text of an error and its causes.
fn error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

/// Why a request got no response.
#[derive(Debug)]
pub(crate) enum SendFailure {
    Http(reqwest::Error),
    /// A streaming call's response headers did not arrive in time.
    HeaderTimeout,
}

impl SendFailure {
    fn text(&self) -> String {
        match self {
            Self::Http(error) => error_chain(error),
            Self::HeaderTimeout => "timeout awaiting response headers".to_owned(),
        }
    }
}

/// Sends a request: buffered calls get an overall timeout, streams only a
/// timeout for the response headers.
pub(crate) async fn send(
    request: reqwest::RequestBuilder,
    streaming: bool,
) -> Result<reqwest::Response, SendFailure> {
    if !streaming {
        return request
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(SendFailure::Http);
    }
    match tokio::time::timeout(STREAM_HEADER_TIMEOUT, request.send()).await {
        Ok(result) => result.map_err(SendFailure::Http),
        Err(_) => Err(SendFailure::HeaderTimeout),
    }
}

/// Why a request never got a response, and whether retrying may help.
pub(crate) fn network_failure_reason(failure: &SendFailure) -> (&'static str, bool) {
    let message = failure.text().to_lowercase();
    let timed_out = match failure {
        SendFailure::Http(error) => error.is_timeout(),
        SendFailure::HeaderTimeout => true,
    };
    if message.contains("certificate")
        || message.contains("invalidcertificate")
        || message.contains("unknownissuer")
        || message.contains("http response to https client")
    {
        return ("tls_configuration_error", false);
    }
    if message.contains("tls handshake") && message.contains("timeout") {
        return ("tls_handshake_timeout", true);
    }
    if timed_out || message.contains("timed out") || message.contains("timeout") {
        return ("connection_timeout", true);
    }
    if message.contains("dns error")
        || message.contains("failed to lookup address")
        || message.contains("no such host")
        || message.contains("name or service not known")
        || message.contains("nodename nor servname")
    {
        return ("dns_failure", true);
    }
    if message.contains("connection reset") || message.contains("broken pipe") {
        return ("connection_reset", true);
    }
    if message.contains("unexpected eof")
        || message.contains("connection closed")
        || message.contains("incomplete message")
    {
        return ("connection_closed", true);
    }
    ("network_error", true)
}

pub(crate) fn network_error(prefix: &str, endpoint: &str, failure: &SendFailure) -> AiError {
    let message = failure.text().trim().to_owned();
    let message = match truncate_chars(&message, 220) {
        Some(head) => format!("{head}..."),
        None => message,
    };
    let (reason, retryable) = network_failure_reason(failure);
    AiError::Provider {
        message: format!("{prefix}: {endpoint} ({message})"),
        retryable,
        reason: reason.to_owned(),
        retry_after: Duration::ZERO,
    }
}

fn retryable_status(status: u16) -> (bool, &'static str) {
    match status {
        408 => (true, "request_timeout"),
        429 => (true, "rate_limited"),
        500 | 502 | 503 | 504 => (true, "server_unavailable"),
        _ => (false, "http_error"),
    }
}

/// Seconds, or an HTTP date in the future.
pub(crate) fn parse_retry_after(value: &str) -> Duration {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Duration::ZERO;
    }
    if let Ok(seconds) = trimmed.parse::<i64>() {
        return if seconds > 0 {
            Duration::from_secs(seconds as u64)
        } else {
            Duration::ZERO
        };
    }
    chrono::DateTime::parse_from_rfc2822(trimmed)
        .ok()
        .and_then(|when| {
            (when.with_timezone(&chrono::Utc) - chrono::Utc::now())
                .to_std()
                .ok()
        })
        .unwrap_or(Duration::ZERO)
}

pub(crate) fn status_error(prefix: &str, status: u16, retry_after: &str, body: &[u8]) -> AiError {
    let (retryable, reason) = retryable_status(status);
    AiError::Provider {
        message: format!("{prefix}: {}", compact_error(body)),
        retryable,
        reason: reason.to_owned(),
        retry_after: parse_retry_after(retry_after),
    }
}

/// Kition Cloud's structured HTTP 402 reply.
pub(crate) fn credits_exhausted(body: &[u8]) -> AiError {
    let error = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| value.get("error").cloned())
        .unwrap_or(Value::Null);
    let field = |key: &str| {
        error
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let code = first_non_empty(&[&field("code"), &field("type")]).to_owned();
    let message = first_non_empty(&[
        &field("message"),
        "Hosted credits exhausted; please top up to continue.",
    ])
    .to_owned();
    AiError::CreditsExhausted {
        message,
        code,
        topup_url: field("topup_url"),
    }
}

/// Reads at most `limit` bytes of a response body.
pub(crate) async fn read_limited(response: reqwest::Response, limit: usize) -> AiResult<Vec<u8>> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| AiError::msg(error.to_string()))?;
        let room = limit.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= limit {
            break;
        }
    }
    Ok(body)
}

pub(crate) fn header(response: &reqwest::Response, name: &str) -> String {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned()
}

/// Reads a server-sent-event stream line by line without a line-length cap.
pub(crate) struct SseLines {
    stream: futures::stream::BoxStream<'static, reqwest::Result<bytes::Bytes>>,
    buffer: Vec<u8>,
    done: bool,
}

impl SseLines {
    /// Lines of a fixed stream body, for parser tests.
    #[cfg(test)]
    pub fn from_text(text: &str) -> Self {
        Self {
            stream: futures::stream::iter([Ok(bytes::Bytes::from(text.to_owned()))]).boxed(),
            buffer: Vec::new(),
            done: false,
        }
    }

    pub fn new(response: reqwest::Response) -> Self {
        Self {
            stream: response.bytes_stream().boxed(),
            buffer: Vec::new(),
            done: false,
        }
    }

    /// The next line without its terminator, or `None` at the end.
    pub async fn next_line(&mut self) -> AiResult<Option<String>> {
        loop {
            if let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let mut line: Vec<u8> = self.buffer.drain(..=position).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
            }
            if self.done {
                if self.buffer.is_empty() {
                    return Ok(None);
                }
                let line = std::mem::take(&mut self.buffer);
                let text = String::from_utf8_lossy(&line);
                return Ok(Some(text.trim_end_matches(['\r', '\n']).to_owned()));
            }
            match self.stream.next().await {
                Some(Ok(chunk)) => self.buffer.extend_from_slice(&chunk),
                Some(Err(error)) => {
                    return Err(AiError::msg(format!(
                        "failed to read runtime provider stream response: {error}"
                    )));
                }
                None => self.done = true,
            }
        }
    }

    /// The next `data:` payload, skipping comments, event names, and blank
    /// lines. `[DONE]` is returned as-is.
    pub async fn next_data(&mut self) -> AiResult<Option<String>> {
        while let Some(line) = self.next_line().await? {
            let line = line.trim();
            if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
                continue;
            }
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if !data.is_empty() {
                return Ok(Some(data.to_owned()));
            }
        }
        Ok(None)
    }
}

/// A rough token estimate: a quarter of the characters, with floors.
pub fn estimate_usage(prompt: &str, completion: &str) -> (i64, i64) {
    let prompt_tokens = (prompt.chars().count() as i64 / 4).max(8);
    let completion_tokens = (completion.chars().count() as i64 / 4).max(16);
    (prompt_tokens, completion_tokens)
}

pub(crate) fn elapsed_ms(started: std::time::Instant) -> i64 {
    started.elapsed().as_millis() as i64
}

/// Usage from a provider's `input_tokens`/`output_tokens` report, or an
/// estimate when there is none.
pub(crate) fn usage_from(
    raw: Option<&Value>,
    prompt: &str,
    content: &str,
    started: std::time::Instant,
    anthropic: bool,
) -> Usage {
    let mut usage = Usage {
        response_time_ms: elapsed_ms(started),
        ..Usage::default()
    };
    if let Some(Value::Object(entry)) = raw {
        let int = |key: &str| kition_core::coerce::as_i64(entry.get(key).unwrap_or(&Value::Null));
        let input = int("input_tokens");
        let output = int("output_tokens");
        usage.prompt_tokens = input;
        usage.completion_tokens = output;
        if anthropic {
            // With server-side compaction the top-level counts leave out
            // the compaction iterations; the billed total sums them all.
            if let Some(iterations) = entry.get("iterations").and_then(Value::as_array)
                && !iterations.is_empty()
            {
                let sum = |key: &str| -> i64 {
                    iterations
                        .iter()
                        .map(|iteration| {
                            kition_core::coerce::as_i64(iteration.get(key).unwrap_or(&Value::Null))
                        })
                        .sum()
                };
                usage.prompt_tokens = sum("input_tokens");
                usage.completion_tokens = sum("output_tokens");
            }
            usage.cache_creation_input_tokens = int("cache_creation_input_tokens");
            usage.cache_read_input_tokens = int("cache_read_input_tokens");
            usage.total_tokens = usage.prompt_tokens
                + usage.completion_tokens
                + usage.cache_creation_input_tokens
                + usage.cache_read_input_tokens;
        } else {
            let total = int("total_tokens");
            usage.total_tokens = if total == 0 { input + output } else { total };
        }
        return usage;
    }
    let (prompt_tokens, completion_tokens) = estimate_usage(prompt, content);
    usage.prompt_tokens = prompt_tokens;
    usage.completion_tokens = completion_tokens;
    usage.total_tokens = prompt_tokens + completion_tokens;
    usage
}

/// The image type of `data` by its magic bytes, like a browser sniffer.
pub fn sniff_mime(data: &[u8]) -> &'static str {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if data.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        "image/gif"
    } else if data.len() >= 14 && &data[..4] == b"RIFF" && &data[8..14] == b"WEBPVP" {
        "image/webp"
    } else if data.starts_with(b"BM") {
        "image/bmp"
    } else if data.starts_with(b"\x00\x00\x01\x00") {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(scheme: &str, header: &str) -> RuntimeModel {
        RuntimeModel {
            api_key: " key ".into(),
            auth_scheme: scheme.into(),
            auth_header: header.into(),
            ..RuntimeModel::default()
        }
    }

    #[test]
    fn json_requests_send_each_content_header_once() {
        let headers = chat_headers(&model("", "")).unwrap_or_default();
        let client = reqwest::Client::new();
        for (streaming, accept) in [(true, "text/event-stream"), (false, "application/json")] {
            let request = json_request(
                client
                    .post("http://127.0.0.1:9/v1/chat/completions")
                    .json(&serde_json::json!({})),
                &headers,
                streaming,
            )
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
            let content_types: Vec<_> = request.headers().get_all("content-type").iter().collect();
            assert_eq!(content_types, ["application/json"]);
            let accepts: Vec<_> = request.headers().get_all("accept").iter().collect();
            assert_eq!(accepts, [accept]);
            assert!(request.headers().get("authorization").is_some());
        }
    }

    #[test]
    fn builds_auth_headers() {
        let headers = chat_headers(&model("", "")).unwrap_or_default();
        assert!(headers.contains(&("Authorization".into(), "Bearer key".into())));
        let headers = chat_headers(&model("x-api-key", "")).unwrap_or_default();
        assert!(headers.contains(&("X-API-Key".into(), "key".into())));
        let headers = chat_headers(&model("raw", "Api-Key")).unwrap_or_default();
        assert!(headers.contains(&("Api-Key".into(), "key".into())));
        assert_eq!(
            chat_headers(&model("oauth", ""))
                .err()
                .map(|e| e.to_string()),
            Some("this custom authentication mode is not supported yet".into())
        );
        assert!(chat_headers(&RuntimeModel::default()).is_err());
    }

    #[test]
    fn normalizes_base_urls() {
        assert_eq!(
            normalize_base_url("openai", "https://api.openai.com"),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            normalize_base_url("openai", "https://x.test/custom/"),
            "https://x.test/custom"
        );
        assert_eq!(
            normalize_base_url("anthropic", "https://api.anthropic.com/"),
            "https://api.anthropic.com"
        );
        assert_eq!(
            normalize_base_url("deepseek", "https://api.deepseek.com/anthropic"),
            "https://api.deepseek.com/anthropic"
        );
        assert_eq!(normalize_base_url("openai", ""), "");
        assert!(validate_endpoint("localhost:8080/v1").is_err());
        assert_eq!(
            validate_endpoint("ftp://x.test/a")
                .err()
                .map(|e| e.to_string()),
            Some("invalid runtime provider URL scheme: ftp".into())
        );
        assert_eq!(
            validate_endpoint("https://x.test/v1/responses")
                .ok()
                .as_deref(),
            Some("https://x.test/v1/responses")
        );
    }

    #[test]
    fn compacts_provider_errors() {
        assert_eq!(
            compact_error(br#"{"error":{"message":"bad key","code":"x"}}"#),
            "bad key"
        );
        assert_eq!(compact_error(br#"{"error":{"code":"quota"}}"#), "quota");
        assert_eq!(compact_error(br#"{"error":"nope"}"#), "nope");
        assert_eq!(compact_error(br#"{"detail":{"message":"d"}}"#), "d");
        assert_eq!(compact_error(b"  plain  "), "plain");
        assert_eq!(compact_error(b""), "Unknown error");
        assert_eq!(compact_error("x".repeat(900).as_bytes()).len(), 803);
    }

    #[test]
    fn classifies_status_errors() {
        let error = status_error("call failed", 429, "3", br#"{"error":"slow down"}"#);
        assert_eq!(error.to_string(), "call failed: slow down");
        assert_eq!(
            error.retry_info(),
            (true, "rate_limited", Duration::from_secs(3))
        );
        assert!(!status_error("x", 400, "", b"").retry_info().0);
        assert_eq!(parse_retry_after("-1"), Duration::ZERO);
    }

    #[test]
    fn parses_credit_errors() {
        let error = credits_exhausted(br#"{"error":{"message":"m","type":"t","topup_url":"u"}}"#);
        assert_eq!(error.credits_exhausted(), Some(("m", "t", "u")));
        let fallback = credits_exhausted(b"");
        assert_eq!(
            fallback.to_string(),
            "Hosted credits exhausted; please top up to continue."
        );
    }

    #[test]
    fn estimates_usage() {
        assert_eq!(estimate_usage("", ""), (8, 16));
        assert_eq!(
            estimate_usage(&"a".repeat(400), &"b".repeat(400)),
            (100, 100)
        );
    }

    #[test]
    fn sniffs_images() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\nrest"), "image/png");
        assert_eq!(sniff_mime(b"RIFF1234WEBPVP8 "), "image/webp");
        assert_eq!(sniff_mime(b"<svg"), "application/octet-stream");
    }
}
