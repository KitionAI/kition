// Copied from kition-sdk crates/kition-kit-host/tests/launch_environment.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! regressions/issue-kit-launch-environment: a kit process does not get the host's current
//! folder, home, temporary folder or environment (Kit Process Protocol section 3; KHP A29, §10.6). Before,
//! `KitProcess::launch` passed them all through, so an engine's by-path write landed in the
//! person's real folders, such as auto-saves in the current folder, templates in
//! `~/Documents`, or print output in `$TMPDIR`.
//!
//! Needs the mock kit built (`cargo build -p kition-kit-mock`); skipped locally with a note without it, required in CI.

use std::path::{Path, PathBuf};

use kition_kit_host::protocol::types::{ClientInfo, InitializeParams, Role};
use kition_kit_host::{KitProcess, LaunchOptions, PROTOCOL_VERSION};
use serde_json::{Value, json};

mod common;

/// Runs the mock's `probe.environment` as the host.
async fn probe(process: &KitProcess) -> Value {
    let client = process.connect().await.unwrap();
    let params = InitializeParams {
        protocol_version: PROTOCOL_VERSION,
        token: process.token().to_owned(),
        role: Role::Host,
        client: ClientInfo { name: "launch-test".into(), version: "0".into() },
        locale: None,
        appearance: None,
        host_services: Vec::new(),
    };
    client.initialize(&params).await.unwrap();
    let execute = json!({ "documentId": "none", "command": "probe.environment", "params": {}, "origin": "user" });
    let answer = client.request("commands.execute", execute, None).await.unwrap();
    answer["result"].clone()
}

fn inside(path: &Value, folder: &Path) -> bool {
    path.as_str().is_some_and(|path| Path::new(path).starts_with(folder))
}

#[tokio::test]
async fn a_kit_gets_none_of_the_hosts_folders_or_environment() {
    let Some(mock) = common::workspace_binary("kition-kit-mock") else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let host_cwd = std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
    let base = std::env::temp_dir().join(format!("kit-launch-env-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let mut options = LaunchOptions::new(&mock);
    options.private_base = Some(base.clone());
    options.env.push(("KITION_KIT_MOCK_NOTE".into(), "given".into()));
    let mut process = KitProcess::launch(options).await.unwrap();
    let private = std::fs::canonicalize(process.private_dir()).unwrap();
    assert!(private.starts_with(std::fs::canonicalize(&base).unwrap()), "{}", private.display());
    let found = probe(&process).await;
    let cwd = PathBuf::from(found["cwd"].as_str().unwrap());
    assert_ne!(std::fs::canonicalize(&cwd).unwrap(), host_cwd, "the kit runs in a folder of its own: {found}");
    let real_home = std::env::var_os("HOME").map(PathBuf::from);
    assert_ne!(found["env"]["HOME"].as_str().map(PathBuf::from), real_home, "nor the person's home: {found}");
    let variables: Vec<&str> = found["variables"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    for inherited in ["PATH", "CARGO_PKG_NAME", "CARGO_MANIFEST_DIR", "USER"] {
        assert!(!variables.contains(&inherited), "{inherited} reached the kit: {variables:?}");
    }
    assert_eq!((found["env"]["LANG"].as_str(), found["env"]["LC_ALL"].as_str(), found["env"]["TZ"].as_str()), (Some("C.UTF-8"), Some("C.UTF-8"), Some("UTC")));
    // Its current folder, home and temporary folder are the private folder's, and what it wrote
    // by path landed there.
    assert_eq!(std::fs::canonicalize(&cwd).unwrap(), private.join("work"));
    for folder in ["HOME", "TMPDIR", "XDG_CONFIG_HOME"] {
        assert!(inside(&found["env"][folder], &private), "{folder}: {found}");
    }
    // KHP A58: the private runtime folder is one folder, whichever variable the kit reads.
    for folder in ["TMPDIR", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "TEMP", "TMP"] {
        assert_eq!(found["env"][folder].as_str().map(PathBuf::from), Some(private.join("tmp")), "{folder}: {found}");
    }
    let wrote: Vec<&Value> = found["wrote"].as_array().unwrap().iter().collect();
    assert_eq!(wrote.len(), 3, "{found}");
    assert!(wrote.iter().all(|path| inside(path, &private)), "{found}");
    assert!(variables.contains(&"KITION_KIT_MOCK_NOTE"), "the host's own extras pass: {variables:?}");
    process.kill().await;
    drop(process);
    // Nothing the kit wrote is left behind, in the host's folder or the private one.
    assert!(!host_cwd.join("probe-cwd.txt").exists());
    assert!(!private.exists(), "the private folder goes with the process");
    assert_eq!(std::fs::read_dir(&base).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(base);
}
