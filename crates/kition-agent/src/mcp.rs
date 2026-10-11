//! External MCP servers configured in `mcp.toml`. Their tools join the
//! agent's tool list as `<server>__<tool>`. Supports the stdio and
//! streamable HTTP transports.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, RwLock, oneshot};

use crate::run::{Run, ToolError, ToolOutput, ToolResult, truncate_chars};

pub const SEPARATOR: &str = "__";
const CONFIG_FILE: &str = "mcp.toml";
const PROTOCOL_VERSION: &str = "2025-06-18";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub name: String,
    pub transport: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub command: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub auth_ref: String,
}

impl ServerConfig {
    pub fn normalized(mut self) -> Self {
        self.name = self.name.trim().to_owned();
        self.transport = self.transport.trim().to_owned();
        self.command = self.command.trim().to_owned();
        self.url = self.url.trim().to_owned();
        self.auth_ref = self.auth_ref.trim().to_owned();
        self
    }

    pub fn validate(&self) -> Result<(), String> {
        let name = &self.name;
        if name.is_empty() {
            return Err("mcp server: name is required".into());
        }
        if name.contains([' ', '\t', '/', '\\', ':']) || name.contains(SEPARATOR) {
            return Err(format!(
                "mcp server {name:?}: name must not contain whitespace, path separators, or \"__\""
            ));
        }
        match self.transport.as_str() {
            "stdio" if self.command.is_empty() => Err(format!(
                "mcp server {name:?}: stdio transport requires command"
            )),
            "streamable_http" if self.url.is_empty() => Err(format!(
                "mcp server {name:?}: streamable_http transport requires url"
            )),
            "stdio" | "streamable_http" => Ok(()),
            other => Err(format!("mcp server {name:?}: unknown transport {other:?}")),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct ConfigFile {
    #[serde(default)]
    server: Vec<ServerConfig>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ToolInfo {
    pub server: String,
    pub tool: String,
    pub qualified: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(skip)]
    pub input_schema: Option<Value>,
}

impl ToolInfo {
    /// The tool as the model sees it: the qualified name and a description
    /// that names the server.
    pub fn model_spec(&self) -> kition_ai::engine::ToolSpec {
        let description = if self.description.trim().is_empty() {
            format!("External MCP tool from {}", self.server)
        } else {
            format!("[MCP {}] {}", self.server, self.description.trim())
        };
        kition_ai::engine::ToolSpec {
            name: self.qualified.clone(),
            description,
            input_schema: self.input_schema.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ServerStatus {
    pub name: String,
    pub transport: String,
    pub connected: bool,
    pub tool_count: usize,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_tried: Option<i64>,
}

// --- Transports ----------------------------------------------------------

type Pending = Arc<std::sync::Mutex<HashMap<i64, oneshot::Sender<Value>>>>;

struct StdioClient {
    stdin: Mutex<tokio::process::ChildStdin>,
    pending: Pending,
    _child: tokio::process::Child,
}

struct HttpClient {
    http: reqwest::Client,
    url: String,
    headers: BTreeMap<String, String>,
    session: Mutex<Option<String>>,
}

enum Transport {
    Stdio(StdioClient),
    Http(HttpClient),
}

struct Client {
    transport: Transport,
    next_id: AtomicI64,
}

fn rpc_result(message: Value) -> Result<Value, String> {
    if let Some(error) = message.get("error") {
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("request failed");
        return Err(text.to_owned());
    }
    Ok(message.get("result").cloned().unwrap_or(Value::Null))
}

impl Client {
    async fn spawn(config: &ServerConfig) -> Result<Self, String> {
        let transport = match config.transport.as_str() {
            "stdio" => {
                let mut child = tokio::process::Command::new(&config.command)
                    .args(&config.args)
                    .envs(&config.env)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .spawn()
                    .map_err(|error| format!("start transport: {error}"))?;
                let stdin = child.stdin.take().ok_or("start transport: no stdin")?;
                let stdout = child.stdout.take().ok_or("start transport: no stdout")?;
                let pending: Pending = Arc::default();
                let readers = pending.clone();
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let Ok(message) = serde_json::from_str::<Value>(&line) else {
                            continue;
                        };
                        let Some(id) = message.get("id").and_then(Value::as_i64) else {
                            continue;
                        };
                        if message.get("method").is_some() {
                            continue;
                        }
                        let waiter = readers
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .remove(&id);
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(message);
                        }
                    }
                });
                Transport::Stdio(StdioClient {
                    stdin: Mutex::new(stdin),
                    pending,
                    _child: child,
                })
            }
            _ => Transport::Http(HttpClient {
                http: reqwest::Client::new(),
                url: config.url.clone(),
                headers: config.headers.clone(),
                session: Mutex::new(None),
            }),
        };
        Ok(Self {
            transport,
            next_id: AtomicI64::new(1),
        })
    }

    async fn send(&self, message: Value, id: Option<i64>) -> Result<Value, String> {
        match &self.transport {
            Transport::Stdio(client) => {
                let receiver = id.map(|id| {
                    let (sender, receiver) = oneshot::channel();
                    client
                        .pending
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .insert(id, sender);
                    receiver
                });
                let mut line = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
                line.push(b'\n');
                {
                    let mut stdin = client.stdin.lock().await;
                    stdin
                        .write_all(&line)
                        .await
                        .map_err(|e| format!("write: {e}"))?;
                    stdin.flush().await.map_err(|e| format!("write: {e}"))?;
                }
                match receiver {
                    None => Ok(Value::Null),
                    Some(receiver) => receiver
                        .await
                        .map_err(|_| "server closed the connection".to_owned()),
                }
            }
            Transport::Http(client) => {
                let mut request = client
                    .http
                    .post(&client.url)
                    .header(http::header::ACCEPT, "application/json, text/event-stream")
                    .json(&message);
                for (key, value) in &client.headers {
                    request = request.header(key, value);
                }
                if let Some(session) = client.session.lock().await.clone() {
                    request = request.header("Mcp-Session-Id", session);
                }
                let response = request
                    .send()
                    .await
                    .map_err(|e| format!("request failed: {}", e.without_url()))?;
                if let Some(session) = response
                    .headers()
                    .get("mcp-session-id")
                    .and_then(|v| v.to_str().ok())
                {
                    *client.session.lock().await = Some(session.to_owned());
                }
                if !response.status().is_success() {
                    return Err(format!("HTTP {}", response.status().as_u16()));
                }
                let Some(id) = id else { return Ok(Value::Null) };
                let event_stream = response
                    .headers()
                    .get(http::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.contains("text/event-stream"));
                let body = response.text().await.map_err(|e| e.to_string())?;
                if !event_stream {
                    return serde_json::from_str(&body)
                        .map_err(|_| "invalid JSON-RPC response".to_owned());
                }
                body.lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
                    .find(|message| message.get("id").and_then(Value::as_i64) == Some(id))
                    .ok_or_else(|| "no response in event stream".to_owned())
            }
        }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        rpc_result(self.send(message, Some(id)).await?)
    }

    async fn notify(&self, method: &str) -> Result<(), String> {
        self.send(json!({ "jsonrpc": "2.0", "method": method }), None)
            .await
            .map(|_| ())
    }

    async fn connect(config: &ServerConfig) -> Result<(Self, Vec<ToolInfo>), String> {
        let client = Self::spawn(config).await?;
        client
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "kition-agent", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .await
            .map_err(|e| format!("initialize: {e}"))?;
        client.notify("notifications/initialized").await?;
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let params = cursor
                .as_ref()
                .map_or_else(|| json!({}), |c| json!({ "cursor": c }));
            let page = client
                .request("tools/list", params)
                .await
                .map_err(|e| format!("list tools: {e}"))?;
            for tool in page["tools"].as_array().into_iter().flatten() {
                let name = tool["name"].as_str().unwrap_or_default().to_owned();
                if name.is_empty() {
                    continue;
                }
                tools.push(ToolInfo {
                    qualified: format!("{}{SEPARATOR}{name}", config.name),
                    server: config.name.clone(),
                    tool: name,
                    title: tool["title"].as_str().unwrap_or_default().to_owned(),
                    description: tool["description"].as_str().unwrap_or_default().to_owned(),
                    input_schema: tool.get("inputSchema").cloned(),
                });
            }
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        tools.sort_by(|a, b| a.tool.cmp(&b.tool));
        Ok((client, tools))
    }
}

// --- Manager -------------------------------------------------------------

struct Server {
    config: ServerConfig,
    client: Option<Arc<Client>>,
    tools: Vec<ToolInfo>,
    status: ServerStatus,
}

/// The configured servers and their live connections.
pub struct Manager {
    path: Option<PathBuf>,
    servers: RwLock<BTreeMap<String, Server>>,
}

/// `$KITION_CONFIG_DIR/mcp.toml`, else `~/.kition/mcp.toml`.
pub fn default_path() -> Option<PathBuf> {
    crate::execpolicy::default_path().map(|path| path.with_file_name(CONFIG_FILE))
}

impl Manager {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            servers: RwLock::new(BTreeMap::new()),
        }
    }

    pub fn path(&self) -> String {
        self.path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    pub fn configs(&self) -> Result<Vec<ServerConfig>, String> {
        let Some(path) = &self.path else {
            return Ok(Vec::new());
        };
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        let mut file: ConfigFile =
            toml::from_str(&text).map_err(|e| format!("mcp config parse: {e}"))?;
        file.server.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(file.server)
    }

    fn save(&self, servers: &[ServerConfig]) -> Result<(), String> {
        let path = self.path.as_ref().ok_or("mcp config: path not set")?;
        let text = toml::to_string(&ConfigFile {
            server: servers.to_vec(),
        })
        .map_err(|e| e.to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, text).map_err(|e| e.to_string())
    }

    pub async fn upsert(&self, config: ServerConfig) -> Result<(), String> {
        config.validate()?;
        let mut configs = self.configs()?;
        configs.retain(|existing| existing.name != config.name);
        configs.push(config);
        configs.sort_by(|a, b| a.name.cmp(&b.name));
        self.save(&configs)?;
        self.reload().await
    }

    pub async fn delete(&self, name: &str) -> Result<bool, String> {
        let mut configs = self.configs()?;
        let before = configs.len();
        configs.retain(|existing| existing.name != name);
        if configs.len() == before {
            return Ok(false);
        }
        self.save(&configs)?;
        self.reload().await?;
        Ok(true)
    }

    /// Reconnects servers whose configuration changed and drops removed
    /// ones.
    pub async fn reload(&self) -> Result<(), String> {
        let configs = self.configs()?;
        let mut servers = self.servers.write().await;
        servers.retain(|name, server| {
            configs.iter().any(|config| {
                &config.name == name && *config == server.config && server.client.is_some()
            })
        });
        for config in configs {
            if servers.contains_key(&config.name) {
                continue;
            }
            let mut status = ServerStatus {
                name: config.name.clone(),
                transport: config.transport.clone(),
                last_tried: Some(kition_core::now_millis()),
                ..ServerStatus::default()
            };
            let (client, tools) = if config.enabled {
                match tokio::time::timeout(CONNECT_TIMEOUT, Client::connect(&config)).await {
                    Ok(Ok((client, tools))) => (Some(Arc::new(client)), tools),
                    Ok(Err(error)) => {
                        status.error = error;
                        (None, Vec::new())
                    }
                    Err(_) => {
                        status.error = "connect timed out".into();
                        (None, Vec::new())
                    }
                }
            } else {
                (None, Vec::new())
            };
            status.connected = client.is_some();
            status.tool_count = tools.len();
            servers.insert(
                config.name.clone(),
                Server {
                    config,
                    client,
                    tools,
                    status,
                },
            );
        }
        Ok(())
    }

    pub async fn tools(&self) -> Vec<ToolInfo> {
        self.servers
            .read()
            .await
            .values()
            .flat_map(|server| server.tools.clone())
            .collect()
    }

    pub async fn statuses(&self) -> HashMap<String, ServerStatus> {
        self.servers
            .read()
            .await
            .iter()
            .map(|(name, server)| (name.clone(), server.status.clone()))
            .collect()
    }

    async fn call_tool(&self, qualified: &str, arguments: Value) -> Result<Value, String> {
        let (server, tool) = qualified
            .split_once(SEPARATOR)
            .ok_or("mcp: invalid tool name")?;
        let client = {
            let servers = self.servers.read().await;
            let entry = servers
                .get(server)
                .ok_or_else(|| format!("mcp: server {server:?} is not configured"))?;
            entry.client.clone().ok_or_else(|| {
                let mut message = format!("mcp: server {server} is not connected");
                if !entry.status.error.is_empty() {
                    message.push_str(&format!(" ({})", entry.status.error));
                }
                message
            })?
        };
        tokio::time::timeout(
            CALL_TIMEOUT,
            client.request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            ),
        )
        .await
        .map_err(|_| format!("mcp: tool {qualified:?} timed out"))?
        .map_err(|error| format!("mcp: tool {qualified:?} call failed: {error}"))
    }
}

pub fn is_mcp_tool(name: &str) -> bool {
    name.split_once(SEPARATOR)
        .is_some_and(|(server, tool)| !server.is_empty() && !tool.is_empty())
}

pub async fn call(run: &Run, name: &str, input: &Value) -> ToolResult {
    if !is_mcp_tool(name) {
        return Err(format!("Tool {name} is not registered").into());
    }
    let (server, tool) = name.split_once(SEPARATOR).unwrap_or_default();
    let result = run.agent.mcp().call_tool(name, input.clone()).await?;
    let text: Vec<String> = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| match item["text"].as_str() {
            Some(text) if item["type"] == "text" => text.to_owned(),
            _ => item.to_string(),
        })
        .filter(|text| !text.is_empty())
        .collect();
    let text = text.join("\n");
    let is_error = result["isError"].as_bool().unwrap_or(false);
    let mut output = json!({ "server": server, "tool": tool, "text": text });
    if let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null()) {
        output["structured"] = structured.clone();
    }
    if is_error {
        output["is_error"] = json!(true);
    }
    let summary = if text.trim().is_empty() {
        format!("MCP {server} \u{b7} {tool} call complete")
    } else {
        truncate_chars(text.trim(), 160)
    };
    if is_error {
        return Err(ToolError {
            message: format!("mcp tool returned an error: {}", text.trim()),
            summary,
            output: Some(output),
        });
    }
    Ok(ToolOutput::new(summary, output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_configs() {
        let stdio = ServerConfig {
            name: "files".into(),
            transport: "stdio".into(),
            command: "mcp-files".into(),
            ..ServerConfig::default()
        };
        assert!(stdio.validate().is_ok());
        assert!(
            ServerConfig {
                name: "a b".into(),
                ..stdio.clone()
            }
            .validate()
            .is_err()
        );
        assert!(
            ServerConfig {
                command: String::new(),
                ..stdio.clone()
            }
            .validate()
            .is_err()
        );
        assert!(
            ServerConfig {
                transport: "ws".into(),
                ..stdio
            }
            .validate()
            .is_err()
        );
        assert!(is_mcp_tool("files__read"));
        assert!(!is_mcp_tool("document_read"));
    }

    #[tokio::test]
    async fn stores_configs_in_toml() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let manager = Manager::new(Some(dir.path().join(CONFIG_FILE)));
        let config = ServerConfig {
            name: "remote".into(),
            transport: "streamable_http".into(),
            url: "https://example.com/mcp".into(),
            enabled: false,
            ..ServerConfig::default()
        };
        manager
            .upsert(config.clone())
            .await
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(manager.configs().unwrap_or_default(), vec![config]);
        assert_eq!(manager.statuses().await.len(), 1);
        assert_eq!(manager.delete("remote").await, Ok(true));
        assert!(manager.configs().unwrap_or_default().is_empty());
    }
}
