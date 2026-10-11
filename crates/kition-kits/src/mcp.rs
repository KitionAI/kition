//! Kit tools as a Model Context Protocol server, so any harness can use Kition's kits: DeepSeek
//! Harness through its `dsh-mcp-client` plugin (Kition Kit Standard D1), and other MCP clients.
//! The tools are `kition_kits::tools`, the same ones Kition's agent uses, including live editing
//! through the Kit AI bridge when the file is open in a kit editor.
//!
//! Two transports carry the same messages: Streamable HTTP on the running runtime
//! (`POST /v1/mcp/kits`, loopback only like the rest of the API) and stdio (`kition-kits-mcp`,
//! for when no Kition is running; it uses the headless kits).

use base64::Engine as _;
use serde_json::{Value, json};

use crate::manager::KitManager;
use crate::tools;

/// MCP revisions this server speaks, newest first.
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Kition kits edit workspace files that are not text: layered images, video projects, vector drawings, motion graphics, and page layouts. For a file, call its kit's `<kit>_inspect` first, find commands with `<kit>_commands`, then edit with `<kit>_run`; check the preview it returns. A file open in Kition is edited live in its editor.";

fn response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_list(kits: &KitManager) -> Value {
    let tools: Vec<Value> = tools::installed(kits)
        .into_iter()
        .map(|spec| {
            json!({
                "name": spec.name,
                "title": tools::label(&spec.name),
                "description": spec.description,
                "inputSchema": spec.input_schema,
                "annotations": { "readOnlyHint": !spec.writes, "destructiveHint": false, "openWorldHint": false },
            })
        })
        .collect();
    json!({ "tools": tools })
}

/// A tool answer as MCP content: the summary and output as text, the output as structured
/// content, and each preview as an image.
fn tool_result(outcome: tools::KitToolResult) -> Value {
    match outcome {
        Ok(output) => {
            let mut content = vec![
                json!({ "type": "text", "text": format!("{}\n{}", output.summary, output.output) }),
            ];
            for preview in &output.previews {
                content.push(json!({ "type": "text", "text": preview.caption }));
                content.push(json!({ "type": "image", "mimeType": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(&preview.png) }));
            }
            let structured = if output.output.is_object() {
                output.output
            } else {
                json!({ "value": output.output })
            };
            json!({ "content": content, "structuredContent": structured, "isError": false })
        }
        Err(failure) => {
            let text = match &failure.output {
                Some(output) => format!("{}\n{output}", failure.message),
                None => failure.message,
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": true })
        }
    }
}

/// Handles one JSON-RPC message; answers requests, and nothing for notifications.
pub async fn handle(kits: &KitManager, message: &Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str)?;
    let id = message.get("id")?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => {
            let asked = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let version = PROTOCOL_VERSIONS
                .iter()
                .find(|known| **known == asked)
                .copied()
                .unwrap_or(PROTOCOL_VERSIONS[0]);
            response(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "kition-kits", "title": "Kition kits", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => response(id, json!({})),
        "tools/list" => response(id, tool_list(kits)),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(error(id, -32602, "tools/call needs a `name`"));
            };
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if !tools::installed(kits).iter().any(|spec| spec.name == name) {
                return Some(error(id, -32602, &format!("unknown tool `{name}`")));
            }
            match tools::call(kits, name, &arguments).await {
                Some(outcome) => response(id, tool_result(outcome)),
                None => error(id, -32602, &format!("unknown tool `{name}`")),
            }
        }
        other => error(id, -32601, &format!("method `{other}` is not supported")),
    })
}

/// The stdio transport: newline-delimited JSON-RPC on stdin and stdout until stdin closes.
pub async fn serve_stdio(kits: KitManager) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(line) {
            Ok(message) => handle(&kits, &message).await,
            Err(_) => Some(error(&Value::Null, -32700, "not JSON")),
        };
        if let Some(answer) = answer {
            stdout.write_all(format!("{answer}\n").as_bytes()).await?;
            stdout.flush().await?;
        }
    }
    kits.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn speaks_mcp_without_any_kit_installed() {
        let kits = KitManager::new(None, Vec::new());
        let init = handle(&kits, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } })).await.unwrap_or_default();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "kition-kits");
        let newest = handle(&kits, &json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "2099-01-01" } })).await.unwrap_or_default();
        assert_eq!(newest["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
        assert!(
            handle(
                &kits,
                &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
            )
            .await
            .is_none()
        );
        assert_eq!(
            handle(
                &kits,
                &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })
            )
            .await
            .unwrap_or_default()["result"]["tools"],
            json!([])
        );
        let call = handle(&kits, &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "vector_run", "arguments": {} } })).await.unwrap_or_default();
        assert_eq!(
            call["error"]["code"], -32602,
            "kits that are not installed offer no tools"
        );
        let unknown = handle(
            &kits,
            &json!({ "jsonrpc": "2.0", "id": 5, "method": "resources/list" }),
        )
        .await
        .unwrap_or_default();
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn previews_become_images_and_failures_say_what_happened() {
        let ok = tool_result(Ok(tools::KitToolOutput {
            summary: "Opened".into(),
            output: json!({ "path": "a.vectorcraft" }),
            previews: vec![tools::Preview {
                caption: "Preview of `a.vectorcraft`.".into(),
                png: vec![0x89, b'P', b'N', b'G'],
            }],
        }));
        assert_eq!(ok["isError"], false);
        assert_eq!(ok["structuredContent"]["path"], "a.vectorcraft");
        assert_eq!(
            ok["content"][2],
            json!({ "type": "image", "mimeType": "image/png", "data": "iVBORw==" })
        );
        let failed = tool_result(Err(tools::KitToolError {
            message: "step 0 failed".into(),
            output: Some(json!({ "completed": [] })),
        }));
        assert_eq!(failed["isError"], true);
        assert!(
            failed["content"][0]["text"]
                .as_str()
                .unwrap_or_default()
                .contains("completed")
        );
    }
}
