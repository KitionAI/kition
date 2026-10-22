//! `kition-kits-mcp` over stdio, as a harness launches it: tools (the object-model ones
//! included), structured error codes, and `kit://` resources, against the mock kit standing in
//! for Kition Vector (`KITION_KIT_MOCK_AS`).
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing the test says so and passes.

use std::path::PathBuf;
use std::process::Stdio;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

fn mock_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?;
    let path = dir.join(format!("kition-kit-mock{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next: u64,
}

impl Server {
    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let message =
            json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params });
        self.stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap_or_else(|err| panic!("{err}"));
        let line = tokio::time::timeout(std::time::Duration::from_secs(30), self.lines.next_line())
            .await
            .unwrap_or_else(|_| panic!("{method} timed out"))
            .unwrap_or_else(|err| panic!("{err}"))
            .unwrap_or_else(|| panic!("the server closed its output"));
        let answer: Value =
            serde_json::from_str(&line).unwrap_or_else(|err| panic!("{err}: {line}"));
        assert_eq!(answer["id"], self.next, "{answer}");
        answer
    }

    async fn notify(&mut self, method: &str) {
        let message = json!({ "jsonrpc": "2.0", "method": method });
        self.stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap_or_else(|err| panic!("{err}"));
    }

    async fn tool(&mut self, name: &str, arguments: Value) -> Value {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await["result"]
            .clone()
    }
}

#[tokio::test]
async fn serves_tools_errors_and_resources_over_stdio() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(workspace.path().join("notes")).unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("notes/Plan.kvector"), "plan")
        .unwrap_or_else(|err| panic!("{err}"));
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_kition-kits-mcp"));
    // Only the stand-in kit is installed.
    for (key, _) in std::env::vars() {
        if key.starts_with("KITION_KIT_") && key.ends_with("_BINARY") {
            command.env_remove(key);
        }
    }
    let mut child = command
        .arg("--workspace")
        .arg(workspace.path())
        .env("KITION_KIT_VECTOR_BINARY", &mock)
        .env("KITION_KIT_MOCK_AS", "kit.vector:kvector")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap_or_else(|err| panic!("{err}"));
    let stdin = child.stdin.take().unwrap_or_else(|| panic!("stdin"));
    let stdout = child.stdout.take().unwrap_or_else(|| panic!("stdout"));
    let mut server = Server {
        child,
        stdin,
        lines: BufReader::new(stdout).lines(),
        next: 0,
    };

    let init = server
        .request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } }))
        .await;
    assert_eq!(
        init["result"]["capabilities"]["resources"]["subscribe"], false,
        "{init}"
    );
    server.notify("notifications/initialized").await;

    let listed = server.request("tools/list", json!({})).await;
    let names: Vec<String> = listed["result"]["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    assert!(
        names.contains(&"vector_query".to_owned()) && names.contains(&"vector_batch".to_owned()),
        "{names:?}"
    );

    let path = "notes/Plan.kvector";
    let queried = server
        .tool("vector_query", json!({ "path": path, "describe": true }))
        .await;
    assert_eq!(queried["isError"], false, "{queried}");
    assert_eq!(
        queried["structuredContent"]["objects"][0]["fields"]["text"],
        "plan"
    );
    let root = queried["structuredContent"]["objects"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();

    // The arguments now come from the kit's schema.
    let listed = server.request("tools/list", json!({})).await;
    let query = listed["result"]["tools"]
        .as_array()
        .and_then(|tools| tools.iter().find(|tool| tool["name"] == "vector_query"))
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        query["inputSchema"]["properties"]["fields"]["items"]["enum"],
        json!(["name", "tags", "text"])
    );

    let edited = server
        .tool(
            "vector_batch",
            json!({ "path": path, "ops": [{ "op": "text.insert", "target": "root", "field": "text", "index": 4, "text": " B" }] }),
        )
        .await;
    assert_eq!(edited["isError"], false, "{edited}");
    assert_eq!(edited["structuredContent"]["saved"], true);
    assert_eq!(
        std::fs::read_to_string(workspace.path().join(path)).unwrap_or_default(),
        "plan B"
    );

    let failed = server
        .tool("vector_batch", json!({ "path": path, "ops": [{ "op": "set", "target": "missing", "field": "name", "value": 1 }] }))
        .await;
    assert_eq!(failed["isError"], true);
    assert_eq!(
        failed["structuredContent"]["error"]["code"], "not-found",
        "{failed}"
    );
    assert_eq!(failed["structuredContent"]["error"]["index"], 0);
    assert!(
        failed["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("not-found")
    );

    // Resources: the open file's object model and objects.
    let templates = server.request("resources/templates/list", json!({})).await;
    assert_eq!(
        templates["result"]["resourceTemplates"]
            .as_array()
            .map(Vec::len),
        Some(2)
    );
    let resources = server.request("resources/list", json!({})).await;
    let uris: Vec<String> = resources["result"]["resources"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["uri"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        uris,
        [
            "kit://notes%2FPlan.kvector/describe",
            "kit://notes%2FPlan.kvector/objects/root"
        ],
        "{resources}"
    );
    let described = server
        .request("resources/read", json!({ "uri": uris[0] }))
        .await;
    let text: Value = serde_json::from_str(
        described["result"]["contents"][0]["text"]
            .as_str()
            .unwrap_or("null"),
    )
    .unwrap_or_default();
    assert_eq!(text["describe"]["root"], "Note", "{described}");
    assert_eq!(
        described["result"]["contents"][0]["mimeType"],
        "application/json"
    );
    let object = server
        .request(
            "resources/read",
            json!({ "uri": format!("kit://notes%2FPlan.kvector/objects/{root}") }),
        )
        .await;
    let text: Value = serde_json::from_str(
        object["result"]["contents"][0]["text"]
            .as_str()
            .unwrap_or("null"),
    )
    .unwrap_or_default();
    assert_eq!(text["fields"]["text"], "plan B", "{object}");
    let missing = server
        .request(
            "resources/read",
            json!({ "uri": "kit://notes%2FPlan.kvector/objects/nothing-here" }),
        )
        .await;
    assert_eq!(missing["error"]["code"], -32002, "{missing}");
    assert_eq!(missing["error"]["data"]["error"]["code"], "not-found");

    drop(server.stdin);
    let status = tokio::time::timeout(std::time::Duration::from_secs(20), server.child.wait())
        .await
        .unwrap_or_else(|_| panic!("the server exits when its input closes"))
        .unwrap_or_else(|err| panic!("{err}"));
    assert!(status.success());
}
