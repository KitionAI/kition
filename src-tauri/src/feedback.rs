//! Sends in-app feedback to the Kition portal. A signed-in report whose
//! token was rejected is retried anonymously.

use std::time::{Duration, SystemTime};

use serde_json::{Value, json};
use url::Url;

use crate::request::Request;
use crate::workspace::files::iso_time;

const MIN_LENGTH: usize = 10;
const MAX_LENGTH: usize = 500;
const CONTACT_EMAIL_MAX_LENGTH: usize = 254;
const TIMEOUT: Duration = Duration::from_secs(15);

fn normalize_portal_url(value: &str) -> Result<String, String> {
    let url = Url::parse(value.trim()).map_err(|error| error.to_string())?;
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("feedback service URL must use HTTPS".into());
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

/// The report payload, or the validation error the form shows.
pub fn build_payload(request: &Request) -> Result<(String, Value), String> {
    let description = request.trimmed("description");
    let length = description.chars().count();
    if !(MIN_LENGTH..=MAX_LENGTH).contains(&length) {
        return Err(format!(
            "feedback must be {MIN_LENGTH}-{MAX_LENGTH} characters"
        ));
    }
    let contact_email = request.trimmed("contact_email");
    if contact_email.chars().count() > CONTACT_EMAIL_MAX_LENGTH {
        return Err("contact email is too long".into());
    }
    Ok((
        request.trimmed("access_token"),
        json!({
            "schema_version": 1,
            "requestId": "",
            "taskId": "",
            "runtimeMode": "hosted",
            "errorCode": "",
            "errorMessage": "",
            "description": description,
            "contactEmail": contact_email,
            "timestamp": iso_time(SystemTime::now()),
            "via": "desktop",
        }),
    ))
}

async fn post(
    client: &reqwest::Client,
    base_url: &str,
    payload: &Value,
    token: &str,
) -> Result<(reqwest::StatusCode, Value), String> {
    let path = if token.is_empty() {
        "/api/issue-reports/anonymous"
    } else {
        "/api/issue-reports"
    };
    let mut builder = client
        .post(format!("{base_url}{path}"))
        .timeout(TIMEOUT)
        .json(payload);
    if !token.is_empty() {
        builder = builder.bearer_auth(token);
    }
    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    Ok((status, body))
}

pub async fn submit(
    client: &reqwest::Client,
    portal_base_url: &str,
    request: &Request,
) -> Result<Value, String> {
    let base_url = normalize_portal_url(portal_base_url)?;
    let (token, payload) = build_payload(request)?;
    let mut result = post(client, &base_url, &payload, &token).await?;
    if !token.is_empty() && result.0 == reqwest::StatusCode::UNAUTHORIZED {
        result = post(client, &base_url, &payload, "").await?;
    }
    let (status, body) = result;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("feedback submission failed ({})", status.as_u16())));
    }
    let data = match body.get("data") {
        Some(data) if data.is_object() => data.clone(),
        _ => body,
    };
    let ticket = data
        .get("ticketId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if ticket.is_empty() {
        return Err("feedback service returned an invalid response".into());
    }
    Ok(json!({
        "ticket_id": ticket,
        "accepted_at": data.get("accepted_at").and_then(Value::as_str).unwrap_or_default(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_reports() {
        let short = Request::new(Some(json!({ "description": "too short" })));
        assert_eq!(
            build_payload(&short).err().as_deref(),
            Some("feedback must be 10-500 characters")
        );
        let ok = Request::new(Some(json!({
            "description": "  The export button does nothing.  ",
            "contact_email": "a@b.c",
            "access_token": " t ",
        })));
        let (token, payload) = build_payload(&ok).unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(token, "t");
        assert_eq!(
            payload["description"],
            json!("The export button does nothing.")
        );
        assert_eq!(payload["via"], json!("desktop"));
    }

    #[test]
    fn requires_https_outside_loopback() {
        assert!(normalize_portal_url("http://example.com").is_err());
        assert_eq!(
            normalize_portal_url("http://127.0.0.1:9000/")
                .ok()
                .as_deref(),
            Some("http://127.0.0.1:9000")
        );
        assert_eq!(
            normalize_portal_url("https://kition.ai").ok().as_deref(),
            Some("https://kition.ai")
        );
    }
}
