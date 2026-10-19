//! Where the agent runs: [`HttpRuntime`] is a running Kition's agent API on loopback; tests use
//! their own [`Runtime`].

use futures::StreamExt;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// Kition's agent, as the ACP server drives it.
pub trait Runtime: Send + Sync + 'static {
    /// Makes an agent session titled `title`; answers its id.
    fn new_session(&self, title: String) -> BoxFuture<'_, Result<String, String>>;

    /// Runs one turn of `session` with the stream request `request` (`StreamRequest`: `content`,
    /// `runtime_model`, `shell_approval`, …), sending each notification of the turn's stream to
    /// `lines` as it arrives. Resolves when the stream ends.
    fn prompt(
        &self,
        session: String,
        request: Value,
        lines: mpsc::UnboundedSender<Value>,
    ) -> BoxFuture<'_, Result<(), String>>;
}

/// A running Kition's agent API, for example `http://127.0.0.1:<port>/api/v1`.
pub struct HttpRuntime {
    base: String,
    token: Option<String>,
    client: reqwest::Client,
}

impl HttpRuntime {
    /// `base` must be a loopback URL: Kition's API binds to `127.0.0.1` only.
    pub fn new(base: &str, token: Option<String>) -> Result<Self, String> {
        let url = reqwest::Url::parse(base).map_err(|error| format!("`{base}`: {error}"))?;
        let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        if !loopback || !matches!(url.scheme(), "http" | "https") {
            return Err(format!(
                "`{base}` is not Kition's loopback API (http://127.0.0.1:<port>/api/v1)"
            ));
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            token,
            client,
        })
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        let request = self.client.post(format!("{}{path}", self.base));
        match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }
}

/// The message of a refused API request: the envelope's `message`, or the body.
async fn refusal(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| value["message"].as_str().map(str::to_owned))
        .unwrap_or(body);
    format!("Kition answered {status}: {message}")
}

impl Runtime for HttpRuntime {
    fn new_session(&self, title: String) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move {
            let response = self
                .post("/agent/sessions")
                .json(&json!({ "title": title }))
                .send()
                .await
                .map_err(|error| format!("Kition is not reachable: {error}"))?;
            if !response.status().is_success() {
                return Err(refusal(response).await);
            }
            let envelope: Value = response.json().await.map_err(|error| error.to_string())?;
            match &envelope["data"]["id"] {
                Value::Number(id) => Ok(id.to_string()),
                Value::String(id) if !id.is_empty() => Ok(id.clone()),
                _ => Err(format!("Kition made no session: {envelope}")),
            }
        })
    }

    fn prompt(
        &self,
        session: String,
        request: Value,
        lines: mpsc::UnboundedSender<Value>,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let response = self
                .post(&format!("/agent/sessions/{session}/messages/stream"))
                .json(&request)
                .send()
                .await
                .map_err(|error| format!("Kition is not reachable: {error}"))?;
            if !response.status().is_success() {
                return Err(refusal(response).await);
            }
            let mut body = response.bytes_stream();
            let mut pending: Vec<u8> = Vec::new();
            while let Some(chunk) = body.next().await {
                let chunk =
                    chunk.map_err(|error| format!("the turn's stream broke off: {error}"))?;
                pending.extend_from_slice(&chunk);
                while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = pending.drain(..=end).collect();
                    if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                        let _ = lines.send(value);
                    }
                }
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&pending) {
                let _ = lines.send(value);
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_loopback_api_is_accepted() {
        assert!(HttpRuntime::new("http://127.0.0.1:4310/api/v1", None).is_ok());
        assert!(HttpRuntime::new("http://localhost:4310/api/v1/", None).is_ok());
        for refused in [
            "http://example.com/api/v1",
            "ftp://127.0.0.1/api/v1",
            "not a url",
        ] {
            assert!(HttpRuntime::new(refused, None).is_err(), "{refused}");
        }
    }
}
