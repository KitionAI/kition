//! The user's network proxy. It is stored in `proxy.json` with the password
//! in the secure store, handed to the runtime through environment variables,
//! and applied to the desktop's own HTTP clients and web view.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::secure_store::SecureStore;
use crate::workspace::files::encode_uri_component;

const FILE_NAME: &str = "proxy.json";
const SECRET_KEY: &str = "kition-desktop-proxy-password";
const DEFAULT_NO_PROXY: &str = "localhost, 127.0.0.1, ::1";
const SUPPORTED_SCHEMES: [&str; 4] = ["http", "https", "socks5", "socks5h"];

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub enabled: bool,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub no_proxy: String,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            scheme: "http".into(),
            host: String::new(),
            port: 0,
            username: String::new(),
            no_proxy: DEFAULT_NO_PROXY.into(),
        }
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
        _ => false,
    }
}

fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn clamp_port(value: Option<&Value>) -> u16 {
    let parsed = match value {
        Some(Value::Number(number)) => number.as_f64().map(|n| n.trunc() as i64),
        Some(Value::String(text)) => {
            let digits: String = text
                .trim()
                .chars()
                .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
                .collect();
            digits.parse::<i64>().ok()
        }
        _ => None,
    };
    parsed
        .filter(|port| (0..=65535).contains(port))
        .map(|port| port as u16)
        .unwrap_or(0)
}

/// Reads a renderer or on-disk config, dropping anything invalid.
pub fn sanitize(raw: &Value) -> ProxyConfig {
    if !raw.is_object() {
        return ProxyConfig::default();
    }
    let scheme = text(raw.get("scheme")).to_lowercase();
    let no_proxy = text(raw.get("noProxy"));
    ProxyConfig {
        enabled: truthy(raw.get("enabled")),
        scheme: if SUPPORTED_SCHEMES.contains(&scheme.as_str()) {
            scheme
        } else {
            "http".into()
        },
        host: text(raw.get("host")),
        port: clamp_port(raw.get("port")),
        username: text(raw.get("username")),
        no_proxy: if no_proxy.is_empty() {
            DEFAULT_NO_PROXY.into()
        } else {
            no_proxy
        },
    }
}

fn no_proxy_entries(value: &str) -> Vec<String> {
    value
        .split(|ch: char| ch == ',' || ch.is_whitespace())
        .map(|entry| entry.trim().to_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect()
}

pub fn proxy_url(config: &ProxyConfig, password: &str) -> String {
    if config.host.is_empty() {
        return String::new();
    }
    let user = match (config.username.is_empty(), password.is_empty()) {
        (true, _) => String::new(),
        (false, true) => format!("{}@", encode_uri_component(&config.username)),
        (false, false) => format!(
            "{}:{}@",
            encode_uri_component(&config.username),
            encode_uri_component(password)
        ),
    };
    let port = if config.port > 0 {
        format!(":{}", config.port)
    } else {
        String::new()
    };
    format!("{}://{user}{}{port}", config.scheme, config.host)
}

pub struct ProxyManager {
    file: PathBuf,
    config: ProxyConfig,
    password: String,
    loaded: bool,
}

impl ProxyManager {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join(FILE_NAME),
            config: ProxyConfig::default(),
            password: String::new(),
            loaded: false,
        }
    }

    pub fn load(&mut self, secrets: &SecureStore) {
        if self.loaded {
            return;
        }
        self.config = match fs::read_to_string(&self.file) {
            Ok(raw) => serde_json::from_str::<Value>(&raw)
                .map(|value| sanitize(&value))
                .unwrap_or_default(),
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    eprintln!(
                        "proxy config: failed to read {}: {error}",
                        self.file.display()
                    );
                }
                ProxyConfig::default()
            }
        };
        self.password = secrets.get(SECRET_KEY).unwrap_or_else(|error| {
            eprintln!("proxy config: failed to read password: {error}");
            String::new()
        });
        self.loaded = true;
    }

    /// What the renderer may see: never the password itself.
    pub fn state(&self) -> Value {
        let mut state = serde_json::to_value(&self.config).unwrap_or_else(|_| json!({}));
        if let Some(object) = state.as_object_mut() {
            object.insert("hasPassword".into(), Value::Bool(!self.password.is_empty()));
        }
        state
    }

    pub fn config(&self) -> &ProxyConfig {
        &self.config
    }

    /// Saves `payload`. A `password` key replaces the stored password, and an
    /// empty one deletes it; a missing key keeps it.
    pub fn save(&mut self, payload: &Value, secrets: &SecureStore) -> io::Result<Value> {
        self.load(secrets);
        let next = sanitize(payload);
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent)?;
        }
        let serialized = serde_json::to_string_pretty(&next).map_err(io::Error::other)?;
        fs::write(&self.file, serialized)?;
        self.config = next;
        if let Some(password) = payload.get("password") {
            let password = text(Some(password));
            if password.is_empty() {
                secrets.delete(SECRET_KEY)?;
            } else {
                secrets.set(SECRET_KEY, &password)?;
            }
            self.password = password;
        }
        Ok(self.state())
    }

    /// The active proxy URL, or `None` when disabled.
    pub fn active_url(&self) -> Option<String> {
        (self.config.enabled && !self.config.host.is_empty())
            .then(|| proxy_url(&self.config, &self.password))
    }

    /// Variables for the runtime process. Empty values unset variables
    /// inherited from the user's shell, so "no proxy" really means none.
    pub fn env_overrides(&self) -> Vec<(&'static str, String)> {
        let keys = [
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "https_proxy",
            "http_proxy",
            "NO_PROXY",
            "no_proxy",
            "KITION_SMTP_PROXY",
        ];
        if !self.loaded {
            return Vec::new();
        }
        let Some(url) = self.active_url() else {
            return keys.iter().map(|key| (*key, String::new())).collect();
        };
        let no_proxy = no_proxy_entries(&self.config.no_proxy).join(",");
        keys.iter()
            .map(|key| {
                let value = if key.eq_ignore_ascii_case("no_proxy") {
                    no_proxy.clone()
                } else {
                    url.clone()
                };
                (*key, value)
            })
            .collect()
    }

    /// Whether the runtime must restart to pick up the change.
    pub fn requires_restart(previous: &Value, next: &Value, password_changed: bool) -> bool {
        password_changed
            || ["enabled", "scheme", "host", "port", "username", "noProxy"]
                .iter()
                .any(|key| previous.get(key) != next.get(key))
    }
}

/// Opens a TCP connection to the proxy and reports the latency. It does not
/// authenticate or tunnel anything.
pub async fn test_connection(target: &ProxyConfig) -> Value {
    if target.host.is_empty() || target.port == 0 {
        return json!({ "ok": false, "message": "host or port not set" });
    }
    let started = Instant::now();
    let address = format!("{}:{}", target.host, target.port);
    match tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(&address),
    )
    .await
    {
        Ok(Ok(_)) => json!({ "ok": true, "latencyMs": started.elapsed().as_millis() as u64 }),
        Ok(Err(error)) => json!({ "ok": false, "message": error.to_string() }),
        Err(_) => json!({
            "ok": false,
            "message": format!("connect timeout (5s) - {}:{}", target.host, target.port),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_and_builds_urls() {
        let config = sanitize(&json!({
            "enabled": true,
            "scheme": "SOCKS5",
            "host": " proxy.local ",
            "port": "1080",
            "username": "me@x",
        }));
        assert_eq!(config.scheme, "socks5");
        assert_eq!(config.port, 1080);
        assert_eq!(config.no_proxy, DEFAULT_NO_PROXY);
        assert_eq!(
            proxy_url(&config, "p:w"),
            "socks5://me%40x:p%3Aw@proxy.local:1080"
        );
        assert_eq!(
            sanitize(&json!({ "scheme": "ftp", "port": 70000 })).scheme,
            "http"
        );
        assert_eq!(sanitize(&json!({ "port": 70000 })).port, 0);
    }

    #[test]
    fn saves_state_and_env_overrides() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let secrets = SecureStore::new(dir.path());
        let mut manager = ProxyManager::new(dir.path());
        manager.load(&secrets);
        let disabled = manager.env_overrides();
        assert!(disabled.iter().all(|(_, value)| value.is_empty()));

        let state = manager
            .save(
                &json!({ "enabled": true, "host": "h", "port": 8080, "noProxy": "a.com  B.com", "password": "pw", "username": "u" }),
                &secrets,
            )
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(state["hasPassword"], json!(true));
        assert!(state.get("password").is_none());
        let env: std::collections::HashMap<_, _> = manager.env_overrides().into_iter().collect();
        assert_eq!(env["HTTPS_PROXY"], "http://u:pw@h:8080");
        assert_eq!(env["NO_PROXY"], "a.com,b.com");

        let mut reloaded = ProxyManager::new(dir.path());
        reloaded.load(&secrets);
        assert_eq!(reloaded.active_url().as_deref(), Some("http://u:pw@h:8080"));
        assert!(ProxyManager::requires_restart(
            &json!({ "host": "a" }),
            &json!({ "host": "b" }),
            false
        ));
        assert!(!ProxyManager::requires_restart(
            &json!({ "host": "a" }),
            &json!({ "host": "a" }),
            false
        ));
    }
}
