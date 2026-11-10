// Copied from kition-sdk crates/kition-kit-host/src/bin/kit-probe.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! `kit-probe`: what a headless kit tells a host, as one JSON object on stdout, for the kit matrix
//! (`tools/kit-matrix.mjs --dynamic`).
//!
//! ```text
//! kit-probe <kit executable> <workspace folder> [--open <file>] [--check <file>]...
//! ```
//!
//! It launches the kit on the workspace, lists its commands (for the `--open` document when one is
//! given, as an agent sees them with a document open), and runs `document.check` on each `--check`
//! file. Paths are relative to the workspace. A failure is reported in the JSON (`error`), and the
//! exit status is 1 only when the kit cannot be launched or the arguments are wrong.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use kition_kit_host::{HeadlessKit, LaunchOptions};
use serde_json::{Map, Value, json};

const LIMIT: Duration = Duration::from_secs(60);

struct Args {
    executable: PathBuf,
    workspace: PathBuf,
    open: Option<String>,
    check: Vec<String>,
}

fn parse(mut argv: impl Iterator<Item = String>) -> Option<Args> {
    let executable = PathBuf::from(argv.next()?);
    let workspace = PathBuf::from(argv.next()?);
    let (mut open, mut check) = (None, Vec::new());
    while let Some(flag) = argv.next() {
        match flag.as_str() {
            "--open" => open = Some(argv.next()?),
            "--check" => check.push(argv.next()?),
            _ => return None,
        }
    }
    Some(Args { executable, workspace, open, check })
}

async fn open(kit: &HeadlessKit, file: &str) -> Result<String, String> {
    let opened = kit.open(file, true, LIMIT).await.map_err(|error| error.to_string())?;
    opened["documentId"].as_str().map(str::to_owned).ok_or_else(|| format!("document.open answered no documentId: {opened}"))
}

async fn probe(args: Args) -> Result<Value, String> {
    let workspace = std::fs::canonicalize(&args.workspace).map_err(|error| format!("{}: {error}", args.workspace.display()))?;
    let mut options = LaunchOptions::new(&args.executable);
    options.workspace = Some(workspace);
    options.ready_timeout = LIMIT;
    options.initialize_timeout = LIMIT;
    let kit = HeadlessKit::launch(options).await.map_err(|error| format!("launch {}: {error}", args.executable.display()))?;
    let mut out = Map::new();
    out.insert("kit".into(), json!(kit.kit_id()));
    out.insert("version".into(), json!(kit.kit_version()));
    out.insert("capabilities".into(), kit.capabilities().clone());

    let document = match &args.open {
        Some(file) => match open(&kit, file).await {
            Ok(id) => Some(id),
            Err(error) => {
                out.insert("openError".into(), json!(error));
                None
            }
        },
        None => None,
    };
    let listed = kit.request("commands.list", json!({ "documentId": document }), LIMIT).await;
    match listed {
        Ok(answer) => out.insert("commands".into(), answer["commands"].clone()),
        Err(error) => out.insert("commandsError".into(), json!(error.to_string())),
    };

    let mut checks = Map::new();
    for file in &args.check {
        let answer = match open(&kit, file).await {
            Ok(id) => match kit.request("document.check", json!({ "documentId": id }), LIMIT).await {
                Ok(report) => {
                    let codes: Vec<Value> = report["diagnostics"].as_array().map(|list| list.iter().map(|d| d["code"].clone()).collect()).unwrap_or_default();
                    let _ = kit.request("document.close", json!({ "documentId": id, "discardChanges": true }), LIMIT).await;
                    json!({ "codes": codes })
                }
                Err(error) => json!({ "error": error.to_string() }),
            },
            Err(error) => json!({ "error": error }),
        };
        checks.insert(file.clone(), answer);
    }
    out.insert("checks".into(), Value::Object(checks));
    kit.shutdown(Duration::from_secs(5)).await;
    Ok(Value::Object(out))
}

fn main() -> ExitCode {
    let Some(args) = parse(std::env::args().skip(1)) else {
        eprintln!("usage: kit-probe <kit executable> <workspace folder> [--open <file>] [--check <file>]...");
        return ExitCode::from(2);
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("kit-probe: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(probe(args)) {
        Ok(report) => {
            println!("{report}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{}", json!({ "error": error }));
            ExitCode::FAILURE
        }
    }
}
