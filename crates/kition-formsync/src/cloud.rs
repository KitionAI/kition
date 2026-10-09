//! Kition Cloud form source API.

use std::time::Duration;

use kition_core::cloud::CloudSession;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::types::{Field, SaveWorkflowInput};

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CloudSource {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub public_url: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CloudSubmission {
    #[serde(default)]
    pub cursor_id: i64,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub values: serde_json::Map<String, Value>,
    #[serde(default)]
    pub submitted_at: Value,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CloudSubmissionPage {
    #[serde(default)]
    pub items: Vec<CloudSubmission>,
}

#[derive(Clone)]
pub struct CloudClient {
    http: reqwest::Client,
}

impl Default for CloudClient {
    fn default() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self { http }
    }
}

impl CloudClient {
    pub async fn ensure_source(
        &self,
        session: &CloudSession,
        binding_id: &str,
        input: &SaveWorkflowInput,
    ) -> Result<CloudSource, String> {
        let payload = json!({
            "client_binding_id": binding_id,
            "fields": input.fields,
            "name": input.name,
            "template_id": input.template_id,
        });
        self.request(
            session,
            reqwest::Method::POST,
            "/api/desktop/form-sources",
            Some(payload),
        )
        .await
    }

    pub async fn update_source(
        &self,
        session: &CloudSession,
        source_id: &str,
        name: &str,
        fields: &[Field],
        published: bool,
    ) -> Result<CloudSource, String> {
        let payload = json!({ "fields": fields, "name": name, "status": if published { "active" } else { "paused" } });
        let path = format!("/api/desktop/form-sources/{}", path_escape(source_id));
        self.request(session, reqwest::Method::PATCH, &path, Some(payload))
            .await
    }

    pub async fn list_submissions(
        &self,
        session: &CloudSession,
        source_id: &str,
        after_id: i64,
        limit: i64,
    ) -> Result<CloudSubmissionPage, String> {
        let path = format!(
            "/api/desktop/form-sources/{}/submissions?after_id={after_id}&limit={limit}",
            path_escape(source_id)
        );
        self.request(session, reqwest::Method::GET, &path, None)
            .await
    }

    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        session: &CloudSession,
        method: reqwest::Method,
        path: &str,
        payload: Option<Value>,
    ) -> Result<T, String> {
        let url = format!("{}{path}", session.base_url.trim_end_matches('/'));
        let mut request = self
            .http
            .request(method, url)
            .header("Accept", "application/json")
            .header(
                "Authorization",
                format!("Bearer {}", session.access_token.trim()),
            );
        if let Some(payload) = payload {
            request = request.json(&payload);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("Kition Cloud form sync is unavailable: {e}"))?;
        let status = response.status();
        let body = response.bytes().await.map_err(|e| e.to_string())?;
        let body = &body[..body.len().min(4 << 20)];
        #[derive(Deserialize)]
        struct Envelope {
            #[serde(default)]
            data: Option<Value>,
            #[serde(default)]
            error: String,
        }
        let envelope: Envelope = serde_json::from_slice(body)
            .map_err(|_| "Kition Cloud returned an invalid form sync response".to_owned())?;
        if status.as_u16() >= 400 {
            let message = match envelope.error.trim() {
                "" => format!(
                    "{} {}",
                    status.as_u16(),
                    status.canonical_reason().unwrap_or_default()
                ),
                message => message.to_owned(),
            };
            return Err(format!("Kition Cloud form sync failed: {message}"));
        }
        let data = envelope
            .data
            .filter(|d| !d.is_null())
            .ok_or_else(|| "Kition Cloud returned an empty form sync response".to_owned())?;
        serde_json::from_value(data).map_err(|e| e.to_string())
    }
}

/// Percent-encodes a path segment.
fn path_escape(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                char::from(b).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}
