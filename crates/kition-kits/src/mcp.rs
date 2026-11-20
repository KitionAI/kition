// Copied from kition-sdk crates/kition-kits/src/mcp.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Kit tools as a Model Context Protocol server, so any harness can use Kition's kits: DeepSeek
//! Harness through its `dsh-mcp-client` plugin (Kition platform D1), and other MCP clients.
//! The tools are `kition_kits::tools`, the same ones Kition's agent uses, including live editing
//! through the Kit AI bridge when the file is open in a kit editor.
//!
//! Every installed kit's objects are also MCP resources (`resources.rs`): `kit://<document>/describe`
//! (its object model) and `kit://<document>/objects/<id>`, `<document>` being the file's
//! workspace path as one percent-encoded segment.
//!
//! Two transports carry the same messages: Streamable HTTP on the running runtime
//! (`POST /v1/mcp/kits`, loopback only like the rest of the API) and stdio (`kition-kits-mcp`,
//! for when no Kition is running; it uses the headless kits).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use base64::Engine as _;
use kition_kit_host::client::RequestControl;
use kition_kit_process_protocol::types::ProgressParams;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

use crate::manager::KitManager;
use crate::resources;
use crate::tools;

/// MCP revisions this server speaks, newest first.
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// The version `serverInfo` reports (KHP A34: a kit's server reports its manifest's version):
/// the kit's when the server serves one kit, this server's own when it serves several or none,
/// since `serverInfo` has one version and each kit's is in its manifest (K20).
fn server_version(kits: &KitManager) -> String {
    let installed: Vec<&str> = kits.statuses().into_iter().filter(|status| status.installed).map(|status| status.id).collect();
    match installed.as_slice() {
        [only] => kits.definitions().find(|kit| kit.id == *only).map_or_else(|| env!("CARGO_PKG_VERSION").to_owned(), |kit| kit.version.to_owned()),
        _ => env!("CARGO_PKG_VERSION").to_owned(),
    }
}

/// The server's instructions, from the installed kits' manifests: what they edit, then how the
/// tools work. Drafts are named only for the kits that keep them (`agent.drafts`, KHP spec/agent.md section 8).
#[cfg(test)]
fn instructions(kits: &KitManager) -> String {
    instructions_with(kits, false)
}

/// [`instructions`] of a server in draft mode or not (`--drafts`): in draft mode, the kits that keep
/// no drafts are named, since their edits are refused unless a call says `draft: false` (KHP A12).
fn instructions_with(kits: &KitManager, draft_mode: bool) -> String {
    let installed: Vec<&str> = kits.statuses().into_iter().filter(|status| status.installed).map(|status| status.id).collect();
    let served: Vec<_> = kits.definitions().filter(|kit| installed.contains(&kit.id)).collect();
    let nouns: Vec<String> = served.iter().map(|kit| format!("{} ({}, `{}_*`)", kit.agent.noun, kit.agent.formats, kit.agent.prefix)).collect();
    let edits = if nouns.is_empty() { "no kit is installed".to_owned() } else { nouns.join("; ") };
    let drafting: Vec<String> = served.iter().filter(|kit| kit.agent.drafts).map(|kit| format!("`{}_*`", kit.agent.prefix)).collect();
    const DRAFTS: &str = "`draft: true` (the default when the server runs with `--drafts`), edits go to your draft of the file and leave the file alone; call `<kit>_draft_ready` when it is done: the person reviews, merges, or discards it, never you.";
    let mut drafts = if drafting.is_empty() {
        String::new()
    } else if drafting.len() == served.len() {
        format!(" With {DRAFTS}")
    } else {
        format!(" Kits with drafts ({}): with {DRAFTS}", drafting.join(", "))
    };
    let direct: Vec<String> = served.iter().filter(|kit| !kit.agent.drafts).map(|kit| format!("`{}_*`", kit.agent.prefix)).collect();
    if draft_mode && !direct.is_empty() {
        drafts.push_str(&format!(
            " This server makes the agent's edits drafts, and {} keep no drafts: their edits are refused (`unsupported`) unless a call says `draft: false`, which edits the file itself; do that only when the person wants it.",
            direct.join(", ")
        ));
    }
    let mut later = String::new();
    if let Some(supply) = kits.supply() {
        let waiting: Vec<String> =
            supply.available().into_iter().filter(|kit| !installed.contains(&kit.id)).map(|kit| format!("{} ({})", kit.name, kit.agent.formats)).collect();
        if !waiting.is_empty() && supply.installs() {
            later = format!(
                " Kits installed when you first use a file of theirs (through `kit_inspect`), after which their own tools appear: {}.",
                waiting.join("; ")
            );
        } else if !waiting.is_empty() {
            later = format!(" Kits that are not installed, which the person installs with `kition kit install <kit>`: {}.", waiting.join("; "));
        } else if let Some(reason) = supply.unavailable() {
            later = format!(" Kits that are not installed cannot be installed now: {reason}");
        }
    }
    format!(
        "Kition kits edit workspace files that are not text: {edits}.{later} For a file, call its kit's `<kit>_inspect` first, find commands with `<kit>_commands`, then edit with `<kit>_run`; check the preview it returns. Kits with an object model also offer `<kit>_query` (read objects by id or by following fields from the root) and `<kit>_batch` (edit them in one model/batch), and their objects as `kit://` resources. After editing, call `<kit>_check` to list what the kit finds wrong with the file (each diagnostic has a stable `code`, a `severity`, a `target`, and maybe a `fix` command) and fix the errors. Failed calls answer `error.code` (for example `not-found`, `read-only`, `unknown-command`) and `error.index`. Answers on a file carry `revision`: pass the latest one as `basis` on your next call on it, and the answer lists what others changed since (`others`); a write refused with `conflict` ran nothing because others deleted, moved or changed what it acts on: look at `others` and `conflicts`, then decide again.{drafts} A file open in Kition is edited live in its editor."
    )
}

fn response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn error_with(id: &Value, code: i64, message: &str, data: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message, "data": data } })
}

fn tool_list(kits: &KitManager) -> Value {
    let tools: Vec<Value> = tools::offered(kits)
        .into_iter()
        .map(|spec| {
            let mut tool = json!({
                "name": spec.name,
                "title": tools::label(&spec.name),
                "description": spec.description,
                "inputSchema": spec.input_schema,
                "annotations": { "readOnlyHint": !spec.writes, "destructiveHint": false, "openWorldHint": false },
            });
            // What the tool answers as structured content (KHP A1, A18).
            if let Some(output) = tools::schemas::tool_output_schema(&spec.name) {
                tool["outputSchema"] = output;
            }
            tool
        })
        .collect();
    json!({ "tools": tools })
}

/// A tool answer as MCP content: the summary and output as text, the output as structured
/// content, and each preview as an image. A failure keeps its message and what was done, and
/// answers its structured error (`{ code, message, index?, retryable? }`) as `error` in the
/// structured content.
fn tool_result(outcome: tools::KitToolResult) -> Value {
    match outcome {
        Ok(output) => {
            let mut content = vec![json!({ "type": "text", "text": format!("{}\n{}", output.summary, output.output) })];
            for preview in &output.previews {
                content.push(json!({ "type": "text", "text": preview.caption }));
                content.push(json!({ "type": "image", "mimeType": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(&preview.png) }));
            }
            let structured = if output.output.is_object() { output.output } else { json!({ "value": output.output }) };
            json!({ "content": content, "structuredContent": structured, "isError": false })
        }
        Err(failure) => {
            let error = failure.to_json();
            let text = match &failure.output {
                Some(output) => format!("{}\nerror: {error}\n{output}", failure.message),
                None => format!("{}\nerror: {error}", failure.message),
            };
            json!({ "content": [{ "type": "text", "text": text }], "structuredContent": failure.structured(), "isError": true })
        }
    }
}

/// Handles one JSON-RPC message; answers requests, and nothing for notifications.
pub async fn handle(kits: &KitManager, message: &Value) -> Option<Value> {
    handle_with(kits, message, tools::CallOptions::default()).await
}

/// One MCP connection: the agent it is, named on `initialize` from the client's name and a
/// suffix drawn for the connection, so two connections of one client are two agents. Before
/// `initialize`, or without a client name, it is `agent-` and the suffix. Its requests in flight
/// are its own: a request id or a cancellation of one connection never meets another's.
#[derive(Debug, Default)]
pub struct Session {
    agent: std::sync::OnceLock<String>,
    /// The agent's suffix, when the transport fixes it ([`Session::for_connection`]).
    suffix: Option<String>,
    requests: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    notifications: Option<mpsc::Sender<Value>>,
}

impl Session {
    /// A transport forwards these JSON-RPC notifications to its MCP client (stdio or SSE).
    pub fn with_notifications(notifications: mpsc::Sender<Value>) -> Self {
        Self { notifications: Some(notifications), ..Self::default() }
    }

    /// The connection a stateless transport tells apart by the id its client sends with every
    /// message (`Kition-Mcp-Connection` over HTTP): the agent's suffix comes from the id, so a
    /// connection that names itself again after the server restarted is the same agent.
    pub fn for_connection(id: &str) -> Self {
        use sha2::{Digest, Sha256};
        const DIGITS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
        let digest = Sha256::digest(id.as_bytes());
        let suffix = digest.iter().take(4).map(|byte| char::from(DIGITS[usize::from(*byte) % DIGITS.len()])).collect();
        Self { suffix: Some(suffix), ..Self::default() }
    }

    /// One message of a transport that does not tell its clients apart (a plain HTTP client of
    /// `POST /mcp/kits`): the process's agent, as [`handle`] answers, with requests in flight of
    /// its own, so its request id never collides with another client's and nobody else's
    /// `notifications/cancelled` reaches it.
    pub fn single_message() -> Self {
        Self { agent: std::sync::OnceLock::from(tools::process_agent().to_owned()), ..Self::default() }
    }

    fn suffix(&self) -> String {
        self.suffix.clone().unwrap_or_else(tools::suffix)
    }

    /// The connection's agent.
    pub fn agent(&self) -> &str {
        self.agent.get_or_init(|| format!("agent-{}", self.suffix()))
    }
}

/// The agent name a client's `clientInfo.name` gives: lower-case letters and digits, other
/// characters as `-`, at most 24 characters; `agent` when it gives none.
fn agent_name(client: &str) -> String {
    let mut name = String::new();
    for c in client.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            name.push(c);
        } else if !name.ends_with('-') && !name.is_empty() {
            name.push('-');
        }
    }
    let name: String = name.trim_end_matches('-').chars().take(24).collect();
    let name = name.trim_end_matches('-');
    if name.is_empty() { "agent".to_owned() } else { name.to_owned() }
}

/// The session of a server that does not tell its connections apart: the process's agent.
fn process_session() -> &'static Session {
    static SESSION: std::sync::OnceLock<Session> = std::sync::OnceLock::new();
    SESSION.get_or_init(|| Session { agent: std::sync::OnceLock::from(tools::process_agent().to_owned()), ..Session::default() })
}

struct Registered {
    requests: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    key: String,
    cancelled: watch::Receiver<bool>,
}

struct CallAbort<'a> {
    control: &'a RequestControl,
    complete: bool,
}

impl Drop for CallAbort<'_> {
    fn drop(&mut self) {
        if !self.complete {
            let _ = self.control.abort();
        }
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner).remove(&self.key);
    }
}

/// Register in the reader before spawning a request, so an immediately following cancellation
/// cannot overtake registration. Ids are scoped to the MCP session.
fn register(session: &Session, message: &Value) -> Result<Option<Registered>, Value> {
    if message["method"] == "notifications/cancelled" {
        if let Some(id) = message["params"].get("requestId")
            && let Some(sender) = session.requests.lock().unwrap_or_else(PoisonError::into_inner).get(&id.to_string())
        {
            let _ = sender.send(true);
        }
        return Ok(None);
    }
    let Some(id) = message.get("id") else { return Ok(None) };
    let key = id.to_string();
    let mut requests = session.requests.lock().unwrap_or_else(PoisonError::into_inner);
    if requests.contains_key(&key) {
        return Err(error(id, -32600, "request id is already in flight"));
    }
    let (sender, cancelled) = watch::channel(false);
    requests.insert(key.clone(), sender);
    Ok(Some(Registered { requests: Arc::clone(&session.requests), key, cancelled }))
}

fn progress_message(token: &Value, progress: &ProgressParams, sequence: u64) -> Value {
    let fraction = if progress.done { Some(1.0) } else { progress.fraction };
    let message = match fraction.filter(|fraction| fraction.is_finite()) {
        Some(fraction) => format!("{} ({:.0}%)", progress.title, fraction.clamp(0.0, 1.0) * 100.0),
        None => progress.title.clone(),
    };
    // A tool may issue several kit requests, each starting its fraction again. A monotonically
    // increasing event count is the MCP progress value; the kit's fraction stays in the message.
    json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": {
        "progressToken": token, "progress": sequence, "message": message,
    } })
}

fn message_key(kits: &KitManager, message: &Value) -> Option<String> {
    if message["method"] == "resources/read" {
        let resource = resources::KitResource::parse(message["params"]["uri"].as_str()?)?;
        let path = match resource {
            resources::KitResource::Describe { path } | resources::KitResource::Object { path, .. } => path,
        };
        kits.document_key(&json!({ "path": path }))
    } else {
        kits.document_key(&message["params"]["arguments"])
    }
}

/// [`handle`] with the server's call options: `draft` makes the agent's edits drafts unless a
/// call says `draft: false` (`kition-kits-mcp --drafts`); the guard and `--require-basis`.
/// Every call is the process's agent ([`tools::process_agent`]); a transport that tells its
/// connections apart calls [`handle_in`].
pub async fn handle_with(kits: &KitManager, message: &Value, options: tools::CallOptions) -> Option<Value> {
    handle_in(kits, process_session(), message, options).await
}

/// [`handle_with`] on the connection `session`: its `initialize` names the connection's agent
/// from the client's name, and its tool calls are that agent's.
pub async fn handle_in(kits: &KitManager, session: &Session, message: &Value, options: tools::CallOptions) -> Option<Value> {
    match register(session, message) {
        Ok(Some(registered)) => handle_registered(kits, session, message, options, registered, None).await,
        Ok(None) => None,
        Err(answer) => Some(answer),
    }
}

async fn handle_registered(
    kits: &KitManager,
    session: &Session,
    message: &Value,
    options: tools::CallOptions,
    registered: Registered,
    admission: Option<(String, crate::control::Ticket)>,
) -> Option<Value> {
    let mut admission = admission.or_else(|| {
        message_key(kits, message).map(|key| {
            let ticket = kits.inner.documents.reserve(&key);
            (key, ticket)
        })
    });
    let (progress_tx, mut progress_rx) = mpsc::channel(64);
    let token = message["params"]["_meta"].get("progressToken").filter(|token| token.is_string() || token.is_number());
    let control = RequestControl::new(registered.cancelled.clone(), token.map(|_| progress_tx));
    let mut abort = CallAbort { control: &control, complete: false };
    let work = async {
        if let Some((key, ticket)) = &mut admission {
            ticket.enter().await;
            crate::control::DOCUMENT.scope(key.clone(), handle_inner(kits, session, message, options)).await
        } else {
            handle_inner(kits, session, message, options).await
        }
    };
    let mut work = Box::pin(control.scope(work));
    let mut cancelled = registered.cancelled.clone();
    let mut sequence = 0;
    loop {
        tokio::select! {
            biased;
            _ = async { cancelled.wait_for(|cancelled| *cancelled).await.map(|_| ()) } => {
                // Drop the kit request first: its guard sends $/cancelRequest. Keep the outer
                // admission ticket until the used workers have been stopped and reaped.
                drop(work);
                let stopping = control.abort();
                abort.complete = true;
                for stopped in stopping { let _ = stopped.await; }
                return Some(error(&message["id"], -32800, "request cancelled"));
            }
            Some(progress) = progress_rx.recv() => {
                sequence += 1;
                if let (Some(token), Some(notifications)) = (token, &session.notifications) {
                    let _ = notifications.try_send(progress_message(token, &progress, sequence));
                }
            }
            answer = &mut work => { abort.complete = true; return answer; }
        }
    }
}

async fn handle_inner(kits: &KitManager, session: &Session, message: &Value, options: tools::CallOptions) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str)?;
    let id = message.get("id")?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => {
            if let Some(client) = params["clientInfo"]["name"].as_str() {
                let _ = session.agent.set(format!("{}-{}", agent_name(client), session.suffix()));
            }
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
            let version = PROTOCOL_VERSIONS.iter().find(|known| **known == asked).copied().unwrap_or(PROTOCOL_VERSIONS[0]);
            response(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {
                        "tools": { "listChanged": kits.supply().is_some() },
                        "resources": { "subscribe": false, "listChanged": false },
                    },
                    "serverInfo": { "name": "kition-kits", "title": "Kition kits", "version": server_version(kits) },
                    "instructions": instructions_with(kits, options.draft),
                }),
            )
        }
        "ping" => response(id, json!({})),
        "tools/list" => response(id, tool_list(kits)),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(error(id, -32602, "tools/call needs a `name`"));
            };
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if !tools::offered(kits).iter().any(|spec| spec.name == name) {
                return Some(error(id, -32602, &format!("unknown tool `{name}`")));
            }
            if let Err(failure) = install_on_demand(kits, session, name, &arguments).await {
                return Some(response(id, tool_result(Err(failure))));
            }
            match tools::call_as(kits, name, &arguments, options, session.agent()).await {
                Some(outcome) => response(id, tool_result(outcome)),
                None => error(id, -32602, &format!("unknown tool `{name}`")),
            }
        }
        "resources/list" => response(id, resources::list(kits).await),
        "resources/templates/list" => response(id, resources::templates()),
        "resources/read" => {
            let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                return Some(error(id, -32602, "resources/read needs a `uri`"));
            };
            match resources::read(kits, uri).await {
                Ok(contents) => response(id, json!({ "contents": contents })),
                Err(failure) => error_with(id, resources::NOT_FOUND, &failure.message, json!({ "uri": uri, "error": failure.to_json() })),
            }
        }
        other => error(id, -32601, &format!("method `{other}` is not supported")),
    })
}

/// Installs the kit of the file a unified tool call (`kit_<action>`) names, when the manager has
/// a kit supply and no installed kit opens the file's extension; then tells the client that the
/// tool list changed. A call on a kit that is installed, or without a supply, goes on untouched.
/// A kit that cannot be installed is the call's answer, saying why and what to do.
async fn install_on_demand(kits: &KitManager, session: &Session, name: &str, arguments: &Value) -> Result<(), tools::KitToolError> {
    use tools::{ErrorCode, KitToolError};
    let Some(supply) = kits.supply().cloned() else { return Ok(()) };
    if !name.starts_with("kit_") {
        return Ok(());
    }
    let Some(path) = arguments.get("path").and_then(Value::as_str) else { return Ok(()) };
    let Some(extension) = path.trim().rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).filter(|extension| !extension.contains('/')) else {
        return Err(KitToolError::new(
            ErrorCode::InvalidParams,
            format!("`{path}` has no file extension, so no kit can be chosen for it: name a file with its extension"),
        ));
    };
    let installed = |kits: &KitManager| kits.kit_for_path(path).is_some_and(|kit| kits.statuses().iter().any(|status| status.id == kit.id && status.installed));
    if installed(kits) {
        return Ok(());
    }
    // One install at a time in this process; the store keeps installs by other processes safe.
    static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one = INSTALLING.lock().await;
    if installed(kits) {
        return Ok(());
    }
    let asked = extension.clone();
    let outcome = tokio::task::spawn_blocking(move || supply.install(&asked))
        .await
        .unwrap_or_else(|error| Err(crate::supply::SupplyError::new("failed", format!("installing the kit stopped: {error}"))));
    match outcome {
        Ok(found) => {
            tracing::info!(kit = found.0.id, version = found.0.version, "installed on demand");
            kits.add(found);
            if let Some(notifications) = &session.notifications {
                let _ = notifications.try_send(json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }));
            }
            Ok(())
        }
        Err(failure) => {
            let code = match failure.reason {
                "unknown-type" => ErrorCode::InvalidParams,
                "off" | "protocol" => ErrorCode::NotAllowed,
                _ => ErrorCode::Unavailable,
            };
            let mut error = KitToolError::new(code, failure.message);
            error.retryable = failure.reason == "unavailable";
            Err(error)
        }
    }
}

/// The stdio transport: newline-delimited JSON-RPC on stdin and stdout until stdin closes.
pub async fn serve_stdio(kits: KitManager, options: tools::CallOptions) -> std::io::Result<()> {
    serve(kits, options, tokio::io::stdin(), tokio::io::stdout()).await
}

/// The stdio MCP transport on arbitrary streams, also used by transport tests.
pub async fn serve<R, W>(kits: KitManager, options: tools::CallOptions, reader: R, writer: W) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut lines = BufReader::new(reader).lines();
    let (send, mut outgoing) = mpsc::channel::<Value>(128);
    let session = Arc::new(Session::with_notifications(send.clone()));
    let output = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(message) = outgoing.recv().await {
            writer.write_all(format!("{message}\n").as_bytes()).await?;
            writer.flush().await?;
        }
        Ok::<_, std::io::Error>(())
    });
    let mut running = tokio::task::JoinSet::new();
    let read_result = loop {
        let line = tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => line,
                Ok(None) => break Ok(()),
                Err(error) => break Err(error),
            },
            Some(_) = running.join_next(), if !running.is_empty() => continue,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message = match serde_json::from_str::<Value>(line) {
            Ok(message) => message,
            Err(_) => {
                let _ = send.send(error(&Value::Null, -32700, "not JSON")).await;
                continue;
            }
        };
        match register(&session, &message) {
            Ok(Some(registered)) => {
                let key = message_key(&kits, &message);
                let admission = key.map(|key| {
                    let ticket = kits.inner.documents.reserve(&key);
                    (key, ticket)
                });
                let kits = kits.clone();
                let session = Arc::clone(&session);
                let send = send.clone();
                running.spawn(async move {
                    if let Some(answer) = handle_registered(&kits, &session, &message, options, registered, admission).await {
                        let _ = send.send(answer).await;
                    }
                });
            }
            Ok(None) => {}
            Err(answer) => {
                let _ = send.send(answer).await;
            }
        }
    };
    // EOF is an orderly close: finish accepted work, save state, and stop every kit.
    while running.join_next().await.is_some() {}
    kits.shutdown().await;
    drop(session);
    drop(send);
    let written = output.await.map_err(std::io::Error::other)?;
    read_result.and(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stdio_reads_cancellation_while_a_document_is_queued() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("a.mocktext"), "hello").unwrap();
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), Vec::new());
        let mut blocker = kits.inner.documents.reserve("a.mocktext");
        blocker.enter().await;
        let (client, server) = tokio::io::duplex(8192);
        let (server_read, server_write) = tokio::io::split(server);
        let serving = tokio::spawn(serve(kits, tools::CallOptions::default(), server_read, server_write));
        let (client_read, mut client_write) = tokio::io::split(client);
        for message in [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "test_run", "arguments": { "path": "a.mocktext" } } }),
            json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 1 } }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }),
        ] {
            client_write.write_all(format!("{message}\n").as_bytes()).await.unwrap();
        }
        let mut replies = tokio::io::BufReader::new(client_read).lines();
        let mut seen = HashMap::new();
        for _ in 0..2 {
            let line = tokio::time::timeout(std::time::Duration::from_secs(2), replies.next_line()).await.unwrap().unwrap().unwrap();
            let reply: Value = serde_json::from_str(&line).unwrap();
            seen.insert(reply["id"].as_u64().unwrap(), reply);
        }
        assert_eq!(seen[&1]["error"]["code"], -32800);
        assert_eq!(seen[&2]["result"], json!({}));
        drop(blocker);
        client_write.shutdown().await.unwrap();
        serving.await.unwrap().unwrap();
    }

    #[test]
    fn progress_uses_the_clients_token_and_monotonic_event_counts() {
        let progress = ProgressParams { token: kition_kit_process_protocol::RequestId::Number(5), title: "Rendering".into(), fraction: Some(0.5), done: false };
        let first = progress_message(&json!("client-token"), &progress, 1);
        let next = progress_message(&json!("client-token"), &progress, 2);
        assert_eq!(first["params"]["progressToken"], "client-token");
        assert_eq!(first["params"]["message"], "Rendering (50%)");
        assert_eq!(next["params"]["progress"], 2);
        let session = Session::default();
        let other = Session::default();
        let request = json!({ "id": 5, "method": "ping" });
        let registered = register(&session, &request).unwrap().unwrap();
        let _ = register(&other, &json!({ "method": "notifications/cancelled", "params": { "requestId": 5 } })).unwrap();
        assert!(!*registered.cancelled.borrow());
        let _ = register(&session, &json!({ "method": "notifications/cancelled", "params": { "requestId": 5 } })).unwrap();
        assert!(*registered.cancelled.borrow());
        drop(registered);
        assert!(session.requests.lock().unwrap().is_empty());
    }

    /// A connection a stateless transport tells apart is its own agent, named from its client on
    /// `initialize`, and the same agent when it names itself again (a gateway restarted); a
    /// message of no connection is the process's agent (regressions/issue-mcp-http-connections).
    #[tokio::test]
    async fn connections_are_agents_named_by_their_clients() {
        let kits = KitManager::new(None, Vec::new());
        let init = |name: &str| json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "clientInfo": { "name": name } } });
        let options = tools::CallOptions::default();
        let dsh = Session::for_connection("connection-one-0123456789");
        assert!(handle_in(&kits, &dsh, &init("DeepSeek Harness"), options).await.is_some());
        assert!(dsh.agent().starts_with("deepseek-harness-"), "{}", dsh.agent());
        let restarted = Session::for_connection("connection-one-0123456789");
        handle_in(&kits, &restarted, &init("DeepSeek Harness"), options).await;
        assert_eq!(restarted.agent(), dsh.agent());
        let claude = Session::for_connection("connection-two-0123456789");
        handle_in(&kits, &claude, &init("Claude Code"), options).await;
        assert!(claude.agent().starts_with("claude-code-") && claude.agent() != dsh.agent(), "{}", claude.agent());
        let unnamed = Session::for_connection("connection-one-0123456789");
        assert_eq!(unnamed.agent().strip_prefix("agent-"), dsh.agent().strip_prefix("deepseek-harness-"), "one connection, one suffix");
        let single = Session::single_message();
        handle_in(&kits, &single, &init("Someone Else"), options).await;
        assert_eq!(single.agent(), tools::process_agent());
    }

    #[tokio::test]
    async fn speaks_mcp_without_any_kit_installed() {
        let kits = KitManager::new(None, Vec::new());
        let init = handle(&kits, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } })).await.unwrap_or_default();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "kition-kits");
        let newest = handle(&kits, &json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "2099-01-01" } }))
            .await
            .unwrap_or_default();
        assert_eq!(newest["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
        assert!(handle(&kits, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.is_none());
        assert_eq!(handle(&kits, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })).await.unwrap_or_default()["result"]["tools"], json!([]));
        let call = handle(&kits, &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "vector_run", "arguments": {} } }))
            .await
            .unwrap_or_default();
        assert_eq!(call["error"]["code"], -32602, "kits that are not installed offer no tools");
        let listed = handle(&kits, &json!({ "jsonrpc": "2.0", "id": 5, "method": "resources/list" })).await.unwrap_or_default();
        assert_eq!(listed["result"]["resources"], json!([]), "nothing is open");
        let templates = handle(&kits, &json!({ "jsonrpc": "2.0", "id": 6, "method": "resources/templates/list" })).await.unwrap_or_default();
        assert_eq!(templates["result"]["resourceTemplates"][0]["uriTemplate"], "kit://{document}/objects/{id}");
        let missing =
            handle(&kits, &json!({ "jsonrpc": "2.0", "id": 7, "method": "resources/read", "params": { "uri": "kit://art%2Fa.kvector/objects/root" } }))
                .await
                .unwrap_or_default();
        assert_eq!(missing["error"]["code"], resources::NOT_FOUND);
        assert_eq!(missing["error"]["data"]["error"]["code"], "invalid-params");
        let unknown = handle(&kits, &json!({ "jsonrpc": "2.0", "id": 8, "method": "prompts/list" })).await.unwrap_or_default();
        assert_eq!(unknown["error"]["code"], -32601);
    }

    /// KHP spec/agent.md section 8: the instructions name `<kit>_draft_ready` only for the kits that keep drafts
    /// (`agent.drafts`); they told every agent to call it, even for a kit that offers no such tool.
    #[test]
    fn instructions_name_drafts_only_for_kits_that_keep_them() {
        let binary = tempfile::NamedTempFile::new().unwrap_or_else(|err| panic!("{err}"));
        let fixture = |id: &str| crate::definitions::fixture_kit(id);
        let (design, sheet) = (fixture("kit.design"), fixture("kit.sheet"));
        assert!(!design.agent.drafts && sheet.agent.drafts);
        let serving = |served: &[&'static crate::definitions::KitDefinition]| {
            instructions(&KitManager::new(None, served.iter().map(|kit| (*kit, Some(binary.path().to_path_buf()))).collect()))
        };
        let none = serving(&[design]);
        assert!(!none.contains("draft"), "{none}");
        let all = serving(&[sheet]);
        assert!(all.contains("With `draft: true`") && all.contains("`<kit>_draft_ready`"), "{all}");
        let some = serving(&[design, sheet]);
        assert!(some.contains("Kits with drafts (`sheet_*`): with `draft: true`"), "{some}");
    }

    #[test]
    fn previews_become_images_and_failures_say_what_happened() {
        let ok = tool_result(Ok(tools::KitToolOutput {
            summary: "Opened".into(),
            output: json!({ "path": "a.kvector" }),
            previews: vec![tools::Preview { caption: "Preview of `a.kvector`.".into(), png: vec![0x89, b'P', b'N', b'G'] }],
        }));
        assert_eq!(ok["isError"], false);
        assert_eq!(ok["structuredContent"]["path"], "a.kvector");
        assert_eq!(ok["content"][2], json!({ "type": "image", "mimeType": "image/png", "data": "iVBORw==" }));
        let failed =
            tool_result(Err(tools::KitToolError::new(tools::ErrorCode::COMMAND_FAILED, "step 0 failed").at(Some(0)).with_output(json!({ "completed": [] }))));
        assert_eq!(failed["isError"], true);
        assert_eq!(failed["structuredContent"]["error"], json!({ "code": "command-failed", "message": "step 0 failed", "index": 0 }));
        assert!(failed["content"][0]["text"].as_str().unwrap_or_default().contains("completed"));
    }
}
