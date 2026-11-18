// Copied from kition-sdk crates/kition-kits/tests/version_lock.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Version lock-step (host rule H11; Kit Process Protocol section 4): a kit executable whose
//! `kit.initialize` reports a kit version other than the manifest of the package it serves is
//! refused when it starts, with an error naming the executable, both versions, and what to do; the
//! agent's tool call answers `unavailable` (KHP A18) with a message that names the kit (KHP
//! spec/agent.md section 8). Before, only the kit id was checked, and a stale build (an
//! executable older than its kit.json) served its old behaviour silently.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that can skip it say so and pass. CI requires it.
#![cfg(unix)]

use std::path::{Path, PathBuf};

use kition_kits::tools::{self, ErrorCode};
use kition_kits::{Caller, KitError, KitManager};

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

/// The Example fixture manifest as a kit.
fn example() -> &'static kition_kits::KitDefinition {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/example.json");
    let manifest = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{error}"))).unwrap_or_else(|error| panic!("{error}"));
    kition_kits::KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

/// A launcher that starts the mock kit as `kit.example`, reporting kit version `version`.
fn launcher(dir: &Path, mock: &Path, version: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("kition-example");
    std::fs::write(&script, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.example:example KITION_KIT_MOCK_VERSION={version} exec '{}' \"$@\"\n", mock.display()))
        .unwrap_or_else(|error| panic!("{error}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|error| panic!("{error}"));
    script
}

struct Fixture {
    kits: KitManager,
    executable: PathBuf,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

fn fixture(version: impl FnOnce(&str) -> String) -> Option<Fixture> {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return None;
    };
    let bin = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
    let workspace = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
    std::fs::write(workspace.path().join("Note.example"), "hello").unwrap_or_else(|error| panic!("{error}"));
    let kit = example();
    let executable = launcher(bin.path(), &mock, &version(kit.version));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit, Some(executable.clone()))]);
    Some(Fixture { kits, executable, _dirs: (bin, workspace) })
}

#[tokio::test]
async fn an_executable_of_the_manifests_version_starts() {
    let Some(f) = fixture(str::to_owned) else { return };
    let view = f.kits.open(Caller::Agent, "Note.example").await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(view.kit_id, "kit.example");
    match tools::call(&f.kits, "example_inspect", &serde_json::json!({ "path": "Note.example" })).await {
        Some(Ok(_)) => {}
        Some(Err(failure)) => panic!("{failure:?}"),
        None => panic!("example_inspect is not a kit tool"),
    }
}

#[tokio::test]
async fn an_executable_of_another_version_is_refused_with_what_to_do() {
    let Some(f) = fixture(|_| "0.0.1-stale".to_owned()) else { return };
    let manifest = example().version;
    let refused = f.kits.open(Caller::Agent, "Note.example").await.map(|view| view.document_id);
    let Err(error) = refused else { panic!("a stale executable started: {refused:?}") };
    assert!(
        matches!(&error, KitError::VersionMismatch { name: "Example", executable, reported, manifest: wanted }
            if *executable == f.executable && reported == "0.0.1-stale" && *wanted == manifest),
        "{error:?}"
    );
    let message = error.to_string();
    for needle in ["Example", &f.executable.display().to_string(), "0.0.1-stale", manifest, "H11", "Rebuild", "install"] {
        assert!(message.contains(needle), "`{needle}` in {message}");
    }

    // The agent's tool call answers `unavailable`, naming the kit (KHP A18, spec/agent.md section 8).
    let Some(Err(failure)) = tools::call(&f.kits, "example_inspect", &serde_json::json!({ "path": "Note.example" })).await else {
        panic!("example_inspect ran on a stale executable")
    };
    assert_eq!(failure.code, ErrorCode::Unavailable, "{failure:?}");
    for needle in ["Example", "0.0.1-stale", manifest] {
        assert!(failure.message.contains(needle), "`{needle}` in {}", failure.message);
    }
}
