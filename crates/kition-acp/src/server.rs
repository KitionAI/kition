//! The ACP server: newline-delimited JSON-RPC 2.0 on a reader and a writer (stdin and stdout for
//! `kition-acp`). Requests run concurrently, so a client can cancel a prompt or answer a
//! permission request while the prompt runs.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};

use crate::PROTOCOL_VERSION;
use crate::runtime::Runtime;
use crate::translate::{Ended, Translator};

const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;
const INTERNAL: i64 = -32603;

/// What every turn the server starts carries.
#[derive(Clone, Debug, Default)]
pub struct Options {
    /// The model of every turn (`runtime_model`, Kition's `RuntimeModel` JSON). Kition's renderer
    /// keeps the person's model settings, so an ACP client's agent names its model here.
    pub model: Option<Value>,
    /// How the agent edits kit documents: `live` (the default) or `draft`.
    pub kit_edit_mode: String,
}

/// One ACP session: Kition's agent session, and how to stop its running prompt.
struct Session {
    kition: String,
    cancel: Option<watch::Sender<bool>>,
}

struct Shared<R> {
    runtime: Arc<R>,
    options: Options,
    out: mpsc::UnboundedSender<Value>,
    sessions: Mutex<HashMap<String, Session>>,
    /// Requests this server sent the client (`session/request_permission`), by id.
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next: AtomicU64,
}

type Failure = (i64, String);

impl<R: Runtime> Shared<R> {
    fn send(&self, message: Value) {
        let _ = self.out.send(message);
    }

    fn update(&self, session: &str, update: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": session, "update": update } }));
    }

    /// Sends the client a request and waits for its answer (`None`: cancelled or gone).
    async fn ask(
        &self,
        method: &str,
        params: Value,
        cancel: &mut watch::Receiver<bool>,
    ) -> Option<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, tx);
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        tokio::select! {
            answer = rx => answer.ok(),
            _ = cancel.changed() => {
                self.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
                None
            }
        }
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    async fn handle(self: Arc<Self>, method: &str, params: Value) -> Result<Value, Failure> {
        match method {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "agentCapabilities": {
                    "loadSession": false,
                    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
                    "mcpCapabilities": { "http": false, "sse": false },
                },
                "authMethods": [],
                "agentInfo": { "name": "kition", "title": "Kition", "version": env!("CARGO_PKG_VERSION") },
            })),
            "authenticate" => Ok(json!({})),
            "session/new" => {
                let cwd = params["cwd"].as_str().unwrap_or_default();
                let folder = std::path::Path::new(cwd)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .filter(|name| !name.is_empty());
                let title = folder.map_or_else(
                    || "Editor session".to_owned(),
                    |name| format!("Editor session in {name}"),
                );
                let kition = self
                    .runtime
                    .new_session(title)
                    .await
                    .map_err(|error| (INTERNAL, error))?;
                let id = format!("kition-{kition}");
                self.sessions().insert(
                    id.clone(),
                    Session {
                        kition,
                        cancel: None,
                    },
                );
                Ok(json!({ "sessionId": id }))
            }
            "session/prompt" => self.prompt(&params).await,
            other => Err((
                METHOD_NOT_FOUND,
                format!("`{other}` is not supported by Kition's ACP server"),
            )),
        }
    }

    fn cancel(&self, params: &Value) {
        let id = params["sessionId"].as_str().unwrap_or_default();
        if let Some(cancel) = self
            .sessions()
            .get(id)
            .and_then(|session| session.cancel.as_ref())
        {
            let _ = cancel.send(true);
        }
    }

    fn base_request(&self, content: String) -> Value {
        let mut request = json!({
            "content": content,
            "kit_edit_mode": if self.options.kit_edit_mode == "draft" { "draft" } else { "live" },
        });
        if let Some(model) = &self.options.model {
            request["runtime_model"] = model.clone();
        }
        request
    }

    async fn prompt(self: Arc<Self>, params: &Value) -> Result<Value, Failure> {
        let id = params["sessionId"].as_str().unwrap_or_default().to_owned();
        let content = prompt_text(&params["prompt"])
            .ok_or((INVALID_PARAMS, "the prompt has no text".to_owned()))?;
        let (cancel_tx, mut cancel) = watch::channel(false);
        let kition = {
            let mut sessions = self.sessions();
            let session = sessions
                .get_mut(&id)
                .ok_or_else(|| (INVALID_PARAMS, format!("no session `{id}`")))?;
            if session.cancel.is_some() {
                return Err((
                    INVALID_PARAMS,
                    format!("session `{id}` is already answering a prompt"),
                ));
            }
            session.cancel = Some(cancel_tx);
            session.kition.clone()
        };
        let outcome = self
            .run_turns(&id, &kition, self.base_request(content), &mut cancel)
            .await;
        if let Some(session) = self.sessions().get_mut(&id) {
            session.cancel = None;
        }
        outcome
    }

    /// Runs the prompt's turn, and the turns that resume it after each approval.
    async fn run_turns(
        &self,
        id: &str,
        kition: &str,
        mut request: Value,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Value, Failure> {
        let cancelled = Ok(json!({ "stopReason": "cancelled" }));
        loop {
            let (lines, mut rx) = mpsc::unbounded_channel();
            let mut turn = Translator::default();
            let mut run = self
                .runtime
                .prompt(kition.to_owned(), request.clone(), lines);
            let mut finished = false;
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.changed() => return cancelled,
                    line = rx.recv() => match line {
                        Some(line) => {
                            for update in turn.line(&line) {
                                self.update(id, update);
                            }
                        }
                        None => break,
                    },
                    done = &mut run, if !finished => {
                        finished = true;
                        done.map_err(|error| (INTERNAL, error))?;
                    }
                }
            }
            match turn.ended().cloned() {
                Some(Ended::Stop(reason)) => return Ok(json!({ "stopReason": reason })),
                Some(Ended::Failed(error)) => return Err((INTERNAL, error)),
                None => {
                    return Err((
                        INTERNAL,
                        "the agent's turn ended without an outcome".to_owned(),
                    ));
                }
                Some(Ended::Approval {
                    call_id,
                    tool,
                    reason,
                }) => {
                    let mut tool_call = turn.tool_call(&call_id, &tool);
                    if !reason.is_empty() {
                        tool_call["content"] = json!([{ "type": "content", "content": { "type": "text", "text": reason } }]);
                    }
                    let options = json!([
                        { "optionId": "allow_once", "name": "Allow", "kind": "allow_once" },
                        { "optionId": "allow_always", "name": "Always allow", "kind": "allow_always" },
                        { "optionId": "deny", "name": "Deny", "kind": "reject_once" },
                    ]);
                    let Some(answer) = self
                        .ask(
                            "session/request_permission",
                            json!({ "sessionId": id, "toolCall": tool_call, "options": options }),
                            cancel,
                        )
                        .await
                    else {
                        return cancelled;
                    };
                    let outcome = &answer["result"]["outcome"];
                    let decision = match (outcome["outcome"].as_str(), outcome["optionId"].as_str())
                    {
                        (
                            Some("selected"),
                            Some(option @ ("allow_once" | "allow_always" | "deny")),
                        ) => option,
                        _ => return cancelled,
                    };
                    let said = if decision == "deny" {
                        "The person denied the command."
                    } else {
                        "The person allowed the command."
                    };
                    request = self.base_request(said.to_owned());
                    request["hide_user_message"] = Value::Bool(true);
                    request["shell_approval"] = json!({ "call_id": call_id, "decision": decision });
                }
            }
        }
    }
}

/// The prompt's content blocks as one message: text, resource links, and embedded text
/// resources. `None` when nothing in it is text.
pub fn prompt_text(blocks: &Value) -> Option<String> {
    let parts: Vec<String> = blocks
        .as_array()?
        .iter()
        .filter_map(|block| match block["type"].as_str()? {
            "text" => block["text"].as_str().map(str::to_owned),
            "resource_link" => {
                let uri = block["uri"].as_str()?;
                let name = block["name"].as_str().unwrap_or(uri);
                Some(format!("[{name}]({uri})"))
            }
            "resource" => {
                let resource = &block["resource"];
                let uri = resource["uri"].as_str().unwrap_or_default();
                let text = resource["text"].as_str()?;
                Some(format!("{uri}\n```\n{text}\n```"))
            }
            _ => None,
        })
        .filter(|part| !part.trim().is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

/// Serves ACP on `input` and `output` until `input` ends.
pub async fn serve<R, I, O>(
    runtime: Arc<R>,
    input: I,
    mut output: O,
    options: Options,
) -> std::io::Result<()>
where
    R: Runtime,
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin + Send + 'static,
{
    let (out, mut outgoing) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            if output
                .write_all(format!("{message}\n").as_bytes())
                .await
                .is_err()
                || output.flush().await.is_err()
            {
                break;
            }
        }
    });
    let shared = Arc::new(Shared {
        runtime,
        options,
        out,
        sessions: Mutex::default(),
        pending: Mutex::default(),
        next: AtomicU64::new(0),
    });
    let mut lines = BufReader::new(input).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            shared.send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "not JSON" } }));
            continue;
        };
        let method = message["method"].as_str().map(str::to_owned);
        let id = message.get("id").cloned().filter(|id| !id.is_null());
        match (method, id) {
            (Some(method), Some(id)) => {
                let shared = Arc::clone(&shared);
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                tokio::spawn(async move {
                    let answer = match Arc::clone(&shared).handle(&method, params).await {
                        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                        Err((code, message)) => {
                            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
                        }
                    };
                    shared.send(answer);
                });
            }
            (Some(method), None) => {
                if method == "session/cancel" {
                    shared.cancel(&message["params"]);
                }
            }
            (None, Some(id)) => {
                let waiting = id.as_u64().and_then(|id| {
                    shared
                        .pending
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .remove(&id)
                });
                if let Some(waiting) = waiting {
                    let _ = waiting.send(message);
                }
            }
            (None, None) => {}
        }
    }
    // The client is gone: stop what still runs.
    for session in shared.sessions().values() {
        if let Some(cancel) = &session.cancel {
            let _ = cancel.send(true);
        }
    }
    drop(shared);
    let _ = writer.await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_become_one_message() {
        let prompt = json!([
            { "type": "text", "text": "Retitle the slide file" },
            { "type": "resource_link", "uri": "file:///work/talks/a.pptx", "name": "a.pptx" },
            { "type": "resource", "resource": { "uri": "file:///work/notes.md", "text": "Q3" } },
            { "type": "image", "data": "", "mimeType": "image/png" }
        ]);
        assert_eq!(
            prompt_text(&prompt).as_deref(),
            Some(
                "Retitle the slide file\n\n[a.pptx](file:///work/talks/a.pptx)\n\nfile:///work/notes.md\n```\nQ3\n```"
            )
        );
        assert_eq!(prompt_text(&json!([{ "type": "image" }])), None);
        assert_eq!(prompt_text(&json!("text")), None);
    }
}
