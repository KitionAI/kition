// Copied from kition-sdk crates/kition-kits/tests/bundle_launch.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! kition-sdk#4: `kition-kits-mcp` started as the SDK guide and `--help` say, from an unpacked SDK
//! bundle (`kits/<kit>/kit.json`, `bin/<platform>/`), offers the kits' tools; a kit whose
//! executable cannot be found is named on stderr, not served as no tools at all. The mock kit stands
//! in for Kition Vector.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing the test says so and passes.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use kition_kits::definitions::bundle_platform;
use serde_json::{Value, json};

fn mock_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.parent()?.join("kition-kit-mock");
    path.is_file().then_some(path)
}

/// A bundle as `tools/sdk-bundle.mjs` lays it out, with `kition-kits-mcp` in its `bin/<platform>/`
/// and, unless `without_kit`, the vector kit's executable beside it.
fn bundle(dir: &Path, mock: &Path, without_kit: bool) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let root = dir.join("kition-sdk");
    let bin = root.join("bin").join(bundle_platform());
    std::fs::create_dir_all(root.join("kits/vector")).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    let manifest = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kits/vector.json")).unwrap();
    std::fs::write(root.join("kits/vector/kit.json"), manifest).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_kition-kits-mcp"), bin.join("kition-kits-mcp")).unwrap();
    if !without_kit {
        let executable = bin.join("kition-vector");
        std::fs::write(&executable, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.vector:kvector:vector exec '{}' \"$@\"\n", mock.display())).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    root
}

/// Starts the server as `args` from the bundle's root and answers its tool names and its stderr.
fn tools(root: &Path, program: &Path, args: &[&str]) -> (Vec<String>, String) {
    let workspace = root.parent().unwrap().join("work");
    std::fs::create_dir_all(&workspace).unwrap();
    let mut child = Command::new(program)
        .args(["--workspace", &workspace.display().to_string()])
        .args(args)
        .current_dir(root)
        // Not on the PATH: the bundle alone must be enough.
        .env("PATH", "/usr/bin:/bin")
        .env_remove("KITION_KIT_VECTOR_BINARY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for message in [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "0" } } }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    ] {
        writeln!(stdin, "{message}").unwrap();
    }
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let listed = loop {
        let answer: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        if answer["id"] == 2 {
            break answer;
        }
    };
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    let names = listed["result"]["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str().map(str::to_owned)).collect();
    (names, String::from_utf8_lossy(&output.stderr).into_owned())
}

#[test]
fn every_documented_launch_from_a_bundle_offers_the_kits_tools() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = bundle(dir.path(), &mock, false);
    let bundled = root.join("bin").join(bundle_platform()).join("kition-kits-mcp");
    let kit = format!("bin/{}/kition-vector", bundle_platform());
    let elsewhere = PathBuf::from(env!("CARGO_BIN_EXE_kition-kits-mcp"));
    for (program, args) in [
        // docs/sdk/agent.md and --help: the bundle's kits folder.
        (&bundled, vec!["--kits-dir", "kits"]),
        // --help: an executable; its kit.json is the bundle's.
        (&bundled, vec!["--kit", kit.as_str()]),
        // A server built elsewhere, given the bundle's kits folder: its bin/<platform>/ beside it.
        (&elsewhere, vec!["--kits-dir", "kits"]),
    ] {
        let (names, stderr) = tools(&root, program, &args);
        assert!(names.iter().any(|name| name.starts_with("vector_")), "{} {args:?}: {names:?}\n{stderr}", program.display());
    }
}

#[test]
fn a_kit_without_its_executable_is_named_on_stderr() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = bundle(dir.path(), &mock, true);
    let bundled = root.join("bin").join(bundle_platform()).join("kition-kits-mcp");
    let (names, stderr) = tools(&root, &bundled, &["--kits-dir", "kits"]);
    assert!(!names.iter().any(|name| name.starts_with("vector_")), "{names:?}");
    assert!(stderr.contains("kit.vector (Vector) has no executable: no kition-vector"), "{stderr}");
    let listed = Command::new(&bundled).args(["--list-kits", "--kits-dir", "kits"]).current_dir(&root).env("PATH", "/usr/bin:/bin").output().unwrap();
    let listed: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(listed["kits"][0]["installed"], false);
    assert!(listed["kits"][0]["reason"].as_str().unwrap().contains("KITION_KIT_VECTOR_BINARY"), "{listed}");
}
