//! Headless drafts through `kition-kits-mcp`, as an integrator runs them (Kit Standard A12 to
//! A15): with `--drafts`, the agent's edits go to a draft in the workspace's `.kition/drafts/`
//! and leave the file alone; the agent checks the draft and asks for review; the person lists,
//! compares, and merges it with `kition-kits-mcp drafts`, which is refused while the file changed
//! since the draft forked. Merge and discard are never tools.
//!
//! Each kit is tested when its headless executable is found (`KITION_KIT_<KIT>_BINARY`, or a
//! debug build in the sibling kit checkout): Sheet keeps replica drafts, Slides file drafts.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout};

const MCP: &str = env!("CARGO_BIN_EXE_kition-kits-mcp");

struct Case {
    kit: &'static str,
    prefix: &'static str,
    fixture: &'static str,
    step: fn() -> Value,
    mode: &'static str,
}

const CASES: &[Case] = &[
    Case {
        kit: "sheet",
        prefix: "sheet",
        fixture: "Budget.xlsx",
        step: || json!({ "command": "cell.set", "params": { "cell": "C2", "input": "99" } }),
        mode: "replica",
    },
    Case {
        kit: "slide",
        prefix: "slide",
        fixture: "Slides.kitionslide",
        step: || json!({ "command": "shape.insert", "params": { "preset": "ellipse", "rect": [100, 100, 200, 120] } }),
        mode: "file",
    },
];

fn binary(kit: &str) -> Option<PathBuf> {
    let variable = format!("KITION_KIT_{}_BINARY", kit.to_uppercase());
    if let Some(path) = std::env::var_os(variable).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let sibling = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(format!(
            "kition-{kit}/target/debug/kit-{kit}{}",
            std::env::consts::EXE_SUFFIX
        ));
    sibling.is_file().then_some(sibling)
}

fn sha256(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

struct Server {
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
        let line =
            tokio::time::timeout(std::time::Duration::from_secs(120), self.lines.next_line())
                .await
                .unwrap_or_else(|_| panic!("{method} timed out"))
                .unwrap_or_else(|err| panic!("{err}"))
                .unwrap_or_else(|| panic!("the server closed its output"));
        serde_json::from_str(&line).unwrap_or_else(|err| panic!("{err}: {line}"))
    }

    async fn tool(&mut self, name: &str, arguments: Value) -> Value {
        let answer = self
            .request(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await;
        answer["result"].clone()
    }
}

/// `kition-kits-mcp drafts <args>`: its JSON and whether it succeeded.
async fn drafts(workspace: &Path, kit: (&str, &Path), args: &[&str]) -> (Value, bool) {
    let output = tokio::process::Command::new(MCP)
        .arg("drafts")
        .args(args)
        .arg("--workspace")
        .arg(workspace)
        .arg("--kit")
        .arg(format!("{}={}", kit.0, kit.1.display()))
        .output()
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let text = String::from_utf8_lossy(&output.stdout);
    let json = serde_json::from_str(&text).unwrap_or_else(|err| panic!("{err}: {text}"));
    (json, output.status.success())
}

#[tokio::test]
async fn an_agent_drafts_headless_and_the_person_merges() {
    let mut tested = 0;
    for case in CASES {
        let Some(executable) = binary(case.kit) else {
            eprintln!(
                "skipped {}: build kit-{} or set KITION_KIT_{}_BINARY",
                case.kit,
                case.kit,
                case.kit.to_uppercase()
            );
            continue;
        };
        tested += 1;
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = dir.path();
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(case.fixture);
        let file = workspace.join(case.fixture);
        std::fs::copy(&fixture, &file).unwrap_or_else(|err| panic!("{err}"));
        let original = sha256(&file);

        let mut child = tokio::process::Command::new(MCP)
            .arg("--workspace")
            .arg(workspace)
            .arg("--kit")
            .arg(format!("{}={}", case.kit, executable.display()))
            .arg("--drafts")
            .env_remove("KITION_LICENSE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap_or_else(|err| panic!("{err}"));
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            panic!("no pipes");
        };
        let mut server = Server {
            stdin,
            lines: BufReader::new(stdout).lines(),
            next: 0,
        };
        server
            .request("initialize", json!({ "protocolVersion": "2025-06-18" }))
            .await;
        let listed = server.request("tools/list", json!({})).await;
        let names: Vec<&str> = listed["result"]["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(
            !names
                .iter()
                .any(|name| name.contains("merge") || name.contains("discard")),
            "{names:?}"
        );

        let path = case.fixture;
        let missing = server
            .tool(
                &format!("{}_draft_ready", case.prefix),
                json!({ "path": path }),
            )
            .await;
        assert_eq!(
            missing["structuredContent"]["error"]["code"], "draft-required",
            "{missing}"
        );

        // `--drafts`: an edit without `draft` goes to a draft.
        let ran = server
            .tool(
                &format!("{}_run", case.prefix),
                json!({ "path": path, "steps": [(case.step)()] }),
            )
            .await;
        assert_eq!(ran["isError"], false, "{ran}");
        assert_eq!(ran["structuredContent"]["draft"], true, "{ran}");
        assert_eq!(
            sha256(&file),
            original,
            "the file is unchanged until the person merges"
        );
        let checked = server
            .tool(
                &format!("{}_check", case.prefix),
                json!({ "path": path, "draft": true }),
            )
            .await;
        assert_eq!(checked["isError"], false, "{checked}");
        assert!(
            checked["content"][0]["text"]
                .as_str()
                .unwrap_or_default()
                .contains("your draft"),
            "{checked}"
        );
        let ready = server
            .tool(
                &format!("{}_draft_ready", case.prefix),
                json!({ "path": path }),
            )
            .await;
        assert_eq!(ready["structuredContent"]["state"], "ready", "{ready}");
        drop(server);
        let _ = child.kill().await;

        let kit = (case.kit, executable.as_path());
        let (listed, ok) = drafts(workspace, kit, &["list"]).await;
        assert!(ok, "{listed}");
        assert_eq!(listed["drafts"][0]["path"], path);
        assert_eq!(listed["drafts"][0]["state"], "ready");
        assert_eq!(listed["drafts"][0]["mode"], case.mode);
        assert_eq!(listed["drafts"][0]["stale"], false);

        let (compared, ok) = drafts(workspace, kit, &["compare", path]).await;
        assert!(ok, "{compared}");
        if case.mode == "replica" {
            let listed = |side: &str| {
                compared["diff"][side]
                    .as_array()
                    .is_some_and(|objects| !objects.is_empty())
            };
            assert!(listed("changed") || listed("created"), "{compared}");
        } else {
            assert!(
                compared["diff"].is_null() && compared["diffUnavailable"].is_string(),
                "{compared}"
            );
        }

        // The file changes under the draft: merging would drop that, so it is refused.
        let mut changed = std::fs::read(&file).unwrap_or_default();
        let kept = changed.clone();
        changed.push(b'\n');
        std::fs::write(&file, &changed).unwrap_or_else(|err| panic!("{err}"));
        let (refused, ok) = drafts(workspace, kit, &["merge", path]).await;
        assert!(!ok);
        assert_eq!(refused["error"]["code"], "stale", "{refused}");
        std::fs::write(&file, &kept).unwrap_or_else(|err| panic!("{err}"));

        let (merged, ok) = drafts(workspace, kit, &["merge", path]).await;
        assert!(ok, "{merged}");
        assert_ne!(sha256(&file), original, "the draft is the file now");
        let (listed, _) = drafts(workspace, kit, &["list"]).await;
        assert_eq!(listed["drafts"], json!([]), "a merged draft closes");
        let (gone, ok) = drafts(workspace, kit, &["discard", path]).await;
        assert!(!ok);
        assert_eq!(gone["error"]["code"], "not-found");
    }
    if tested == 0 {
        eprintln!("skipped: no Sheet or Slides executable");
    }
}
