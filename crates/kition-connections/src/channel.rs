//! The `email_smtp` channel: schema, validation, verification, delivery.

use std::time::Instant;

use serde_json::{Map, Value, json};

use crate::secret::SecretBag;
use crate::smtp::{self, ERR_CONNECTION_INVALID, Message, SmtpConfig, SmtpError};
use crate::store::{CHANNEL_EMAIL_SMTP, Connection, TestResult};

/// Codes for network failures that should not invalidate a connection.
pub fn is_transient(code: &str) -> bool {
    matches!(
        code,
        smtp::ERR_CONNECT_REFUSED | smtp::ERR_DNS_FAILED | smtp::ERR_DELIVERY_FAILED
    )
}

pub fn schema() -> Value {
    json!({
        "channel": CHANNEL_EMAIL_SMTP,
        "label": "Email SMTP",
        "icon": "mail",
        "description": "Send workflow emails through an SMTP server.",
        "auth": "form",
        "fields": [
            { "key": "name", "label": "Name", "type": "text", "required": true },
            { "key": "host", "label": "Host", "type": "text", "required": true },
            { "key": "port", "label": "Port", "type": "number", "required": true, "default": 587 },
            { "key": "username", "label": "Username", "type": "text", "required": true },
            { "key": "password", "label": "Password", "type": "secret", "required": true, "helpText": "Stored encrypted by the local Kition API." },
            { "key": "tlsMode", "label": "TLS", "type": "select", "required": true, "default": "starttls", "options": [
                { "value": "starttls", "label": "STARTTLS" },
                { "value": "tls", "label": "TLS" },
                { "value": "plain", "label": "Plain" }
            ] },
            { "key": "from", "label": "From address", "type": "email", "required": true },
            { "key": "fromName", "label": "From name", "type": "text", "required": false }
        ]
    })
}

fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(other) => other.to_string(),
    }
}

pub fn config(settings: &Map<String, Value>, secrets: &SecretBag) -> Result<SmtpConfig, String> {
    let port = match settings.get("port") {
        Some(Value::Number(n)) => n.as_f64().map_or(587, |f| f as i64),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(587),
        _ => 587,
    };
    let mut tls_mode = text(settings.get("tlsMode")).trim().to_lowercase();
    if tls_mode.is_empty() {
        tls_mode = "starttls".into();
    }
    let config = SmtpConfig {
        host: text(settings.get("host")).trim().to_owned(),
        port: u16::try_from(port).unwrap_or(0),
        username: text(settings.get("username")).trim().to_owned(),
        password: secrets
            .get("password")
            .map(|p| p.trim().to_owned())
            .unwrap_or_default(),
        from: text(settings.get("from")).trim().to_owned(),
        from_name: text(settings.get("fromName")).trim().to_owned(),
        tls_mode,
        proxy: String::new(),
    };
    if config.host.is_empty() {
        return Err("host required".into());
    }
    if port <= 0 {
        return Err("port required".into());
    }
    if config.username.is_empty() {
        return Err("username required".into());
    }
    if config.from.is_empty() {
        return Err("from address required".into());
    }
    Ok(config)
}

pub fn validate(settings: &Map<String, Value>, secrets: &SecretBag) -> Result<(), String> {
    let config = config(settings, secrets)?;
    smtp::parse_address(&config.from).map_err(|err| format!("from address invalid: {err}"))?;
    if config.password.is_empty() {
        return Err("password required".into());
    }
    Ok(())
}

pub async fn test(connection: &Connection, secrets: &SecretBag) -> TestResult {
    let start = Instant::now();
    let config = match config(&connection.settings, secrets) {
        Ok(config) => config,
        Err(message) => {
            return TestResult {
                ok: false,
                latency_ms: 0,
                message,
                error_code: ERR_CONNECTION_INVALID.into(),
            };
        }
    };
    let result = smtp::verify(&config).await;
    let latency_ms = i64::try_from(start.elapsed().as_millis()).unwrap_or(i64::MAX);
    match result {
        Ok(()) => TestResult {
            ok: true,
            latency_ms,
            message: "SMTP connection verified".into(),
            error_code: String::new(),
        },
        Err(err) => TestResult {
            ok: false,
            latency_ms,
            message: err.to_string(),
            error_code: err.code.into(),
        },
    }
}

pub async fn deliver(
    connection: &Connection,
    secrets: &SecretBag,
    message: &Message,
) -> Result<(), SmtpError> {
    let config = config(&connection.settings, secrets).map_err(|message| SmtpError {
        code: ERR_CONNECTION_INVALID,
        message,
    })?;
    smtp::send(&config, message).await
}
