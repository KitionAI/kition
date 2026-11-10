// Copied from kition-sdk crates/kition-kits/src/serve.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! `kition-kits serve`: the Kits Service API, how a host written in any language uses Kition's
//! kits. The host starts one process and speaks newline-delimited JSON-RPC 2.0 on its standard
//! input and output, naming files by workspace paths; this process does everything the Kit Host
//! Protocol asks of a host (launching the kits, serving their `files.*` with handles, staged and
//! atomic writes with version checks, confinement to the workspace) through [`KitManager`], the
//! same host Kition runs. The methods and their shapes are `contracts/kit/kits-service.schema.json`;
//! `docs/sdk/hosts.md` is the guide.
//!
//! Requests are answered as they finish, not in order. When standard input closes, every kit is
//! shut down and the process exits.

use std::sync::Arc;

use kition_kit_protocol::framing::{self, read_frame_async, write_frame_async};
use kition_kit_protocol::types::Origin;
use kition_kit_protocol::{ErrorReason, Message, Response, RpcError};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use tokio::io::BufReader;

use crate::manager::{Caller, KitError, KitManager};

/// The Kits Service API's version, answered by `kits.initialize`.
pub const SERVICE_VERSION: u32 = 1;

/// The error code of a kit that is not installed, could not start, or stopped (`data.reason`
/// `kit_unavailable`); the call may succeed once the kit is installed or on a retry.
pub const KIT_UNAVAILABLE: i64 = -32050;

/// A failure of the kits as the service answers it: the Kit Host Protocol's code and reason when
/// the kit gave one (`file_conflict`, `command_not_found`, …), else the service's own.
pub fn service_error(error: &KitError) -> RpcError {
    let detail = error.to_string();
    let with = |code: i64, reason: &str| RpcError { code, message: reason.replace('_', " "), data: Some(json!({ "reason": reason, "detail": detail })) };
    match error {
        KitError::Kit { reason: Some(reason), errors, .. } => {
            let mut rpc = RpcError::kit_detail(*reason, detail);
            if let Some(Value::Object(data)) = rpc.data.as_mut()
                && !errors.is_empty()
            {
                data.insert("errors".into(), Value::Array(errors.clone()));
            }
            rpc
        }
        KitError::Kit { reason: None, .. } => with(RpcError::INTERNAL_ERROR, "kit_error"),
        KitError::Model { code, index, message } => {
            let mut rpc = RpcError::kit_detail(ErrorReason::InvalidParams, message.clone());
            if let Some(Value::Object(data)) = rpc.data.as_mut() {
                data.insert("model".into(), json!({ "code": code, "index": index, "message": message }));
            }
            rpc
        }
        KitError::NotAllowed(_) => RpcError::kit_detail(ErrorReason::FileNotAllowed, detail),
        KitError::UnknownKit(_) => with(RpcError::INVALID_PARAMS, "unknown_kit"),
        KitError::InvalidPath(_) => with(RpcError::INVALID_PARAMS, "invalid_path"),
        KitError::NoWorkspace => with(RpcError::INVALID_REQUEST, "no_workspace"),
        KitError::NotInstalled { .. } | KitError::Launch { .. } | KitError::Stopped { .. } | KitError::Unavailable(_) => {
            with(KIT_UNAVAILABLE, "kit_unavailable")
        }
    }
}

fn params<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(|error| RpcError::invalid_params(error.to_string()))
}

fn to_value(value: impl serde::Serialize) -> Result<Value, RpcError> {
    serde_json::to_value(value).map_err(|error| RpcError::internal(error.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathParams {
    path: String,
    #[serde(default)]
    options: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentParams {
    kit: String,
    document_id: String,
    #[serde(default)]
    discard_changes: bool,
    #[serde(default)]
    max_size: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAsParams {
    kit: String,
    document_id: String,
    path: String,
    #[serde(default)]
    format: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandsListParams {
    kit: String,
    #[serde(default)]
    document_id: Option<String>,
    #[serde(default)]
    query: Option<String>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ServiceOrigin {
    User,
    Agent,
    System,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteParams {
    kit: String,
    document_id: String,
    command: String,
    #[serde(default)]
    params: Map<String, Value>,
    #[serde(default = "user")]
    origin: ServiceOrigin,
    #[serde(default)]
    origin_label: Option<String>,
}

fn user() -> ServiceOrigin {
    ServiceOrigin::User
}

/// The kits this service knows, with whether each is installed.
fn kits_list(kits: &KitManager) -> Value {
    json!({ "kits": kits.statuses() })
}

/// Answers one request.
pub async fn handle(kits: &KitManager, method: &str, request: Value) -> Result<Value, RpcError> {
    let failed = |error: KitError| service_error(&error);
    match method {
        "kits.initialize" => {
            let mut answer = kits_list(kits);
            answer["serviceVersion"] = json!(SERVICE_VERSION);
            answer["protocolVersion"] = json!(kition_kit_protocol::PROTOCOL_VERSION);
            answer["workspace"] = json!(kits.workspace_dir().is_some());
            Ok(answer)
        }
        "kits.list" => Ok(kits_list(kits)),
        "kits.ping" => Ok(json!({})),
        "documents.open" => {
            let open: PathParams = params(request)?;
            to_value(kits.open(Caller::User, &open.path).await.map_err(failed)?)
        }
        "documents.create" => {
            let create: PathParams = params(request)?;
            to_value(kits.create_at(Caller::User, &create.path, create.options).await.map_err(failed)?)
        }
        "documents.get" => {
            let document: DocumentParams = params(request)?;
            to_value(kits.document(Caller::User, &document.kit, &document.document_id).await.map_err(failed)?)
        }
        "documents.save" => {
            let document: DocumentParams = params(request)?;
            to_value(kits.save(Caller::User, &document.kit, &document.document_id).await.map_err(failed)?)
        }
        "documents.saveAs" => {
            let save: SaveAsParams = params(request)?;
            to_value(kits.save_as(Caller::User, &save.kit, &save.document_id, &save.path, save.format.as_deref()).await.map_err(failed)?)
        }
        "documents.reload" => {
            let document: DocumentParams = params(request)?;
            to_value(kits.reload(&document.kit, &document.document_id).await.map_err(failed)?)
        }
        "documents.changedOnDisk" => {
            let changed: PathParams = params(request)?;
            kits.changed_on_disk(&changed.path).await;
            Ok(json!({}))
        }
        "documents.close" => {
            let document: DocumentParams = params(request)?;
            kits.close(&document.kit, &document.document_id, document.discard_changes).await.map_err(failed)?;
            Ok(json!({}))
        }
        "documents.preview" => {
            let document: DocumentParams = params(request)?;
            let png = kits.preview(&document.kit, &document.document_id, document.max_size.unwrap_or(1024)).await.map_err(failed)?;
            Ok(json!({ "mimeType": "image/png", "data": kition_kit_protocol::base64::encode(&png) }))
        }
        "documents.check" => {
            let document: DocumentParams = params(request)?;
            let answer = kits.check(Caller::User, &document.kit, &document.document_id).await.map_err(failed)?;
            Ok(answer.unwrap_or_else(|| json!({ "diagnostics": [] })))
        }
        "commands.list" => {
            let list: CommandsListParams = params(request)?;
            let commands = kits.commands(Caller::User, &list.kit, list.document_id.as_deref(), list.query.as_deref()).await.map_err(failed)?;
            Ok(json!({ "commands": commands }))
        }
        "commands.execute" => {
            let execute: ExecuteParams = params(request)?;
            let (caller, origin) = match execute.origin {
                ServiceOrigin::User => (Caller::User, Origin::User),
                ServiceOrigin::Agent => (Caller::Agent, Origin::Agent),
                ServiceOrigin::System => (Caller::User, Origin::System),
            };
            let label = execute.origin_label.as_deref();
            to_value(kits.execute_as(caller, origin, label, &execute.kit, &execute.document_id, &execute.command, execute.params).await.map_err(failed)?)
        }
        "model.describe" | "model.batch" => {
            let Value::Object(mut fields) = request else { return Err(RpcError::invalid_params("params is an object")) };
            let kit = fields.remove("kit").and_then(|kit| kit.as_str().map(str::to_owned)).ok_or_else(|| RpcError::invalid_params("`kit` is a kit id"))?;
            let document = fields
                .remove("documentId")
                .and_then(|id| id.as_str().map(str::to_owned))
                .ok_or_else(|| RpcError::invalid_params("`documentId` is a string"))?;
            kits.model(Caller::User, &kit, &document, method, fields).await.map_err(failed)
        }
        // The kits' agent tools, as an MCP server lists and runs them, for a host's own agent.
        "tools.list" | "tools.call" => {
            let mcp = if method == "tools.list" { "tools/list" } else { "tools/call" };
            let answer = crate::mcp::handle(kits, &json!({ "jsonrpc": "2.0", "id": 0, "method": mcp, "params": request })).await;
            match answer {
                Some(answer) if answer.get("error").is_some() => {
                    Err(serde_json::from_value(answer["error"].clone()).unwrap_or_else(|_| RpcError::internal("the tool failed")))
                }
                Some(answer) => Ok(answer["result"].clone()),
                None => Err(RpcError::internal("the tool answered nothing")),
            }
        }
        method => Err(RpcError::method_not_found(method)),
    }
}

/// Serves requests read from `reader` and writes the answers to `writer`, each request in its own
/// task. Ends when `reader` closes, after shutting every kit down.
pub async fn serve<R, W>(kits: KitManager, reader: R, writer: W) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let writer = Arc::new(tokio::sync::Mutex::new(writer));
    let send = |writer: Arc<tokio::sync::Mutex<W>>, message: Value| async move {
        if let Ok(frame) = framing::encode(&message) {
            let mut writer = writer.lock().await;
            let _ = write_frame_async(&mut *writer, &frame).await;
        }
    };
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut running = tokio::task::JoinSet::new();
    loop {
        let frame = match read_frame_async(&mut reader, &mut line).await {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(error) if error.is_recoverable() => {
                send(Arc::clone(&writer), Response { id: None, outcome: Err(RpcError::parse_error()) }.to_value()).await;
                continue;
            }
            Err(error) => return Err(std::io::Error::other(error.to_string())),
        };
        match Message::parse(&frame) {
            Err(reply) => send(Arc::clone(&writer), reply.to_value()).await,
            // A notification or an answer asks for nothing.
            Ok(Message::Notification(_) | Message::Response(_)) => {}
            Ok(Message::Request(request)) => {
                let kits = kits.clone();
                let writer = Arc::clone(&writer);
                running.spawn(async move {
                    let params = request.params.unwrap_or_else(|| Value::Object(Map::new()));
                    let outcome = handle(&kits, &request.method, params).await;
                    send(writer, Response { id: Some(request.id), outcome }.to_value()).await;
                });
            }
        }
    }
    while running.join_next().await.is_some() {}
    kits.shutdown().await;
    Ok(())
}
