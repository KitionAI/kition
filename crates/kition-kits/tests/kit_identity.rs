// Copied from kition-sdk crates/kition-kits/tests/kit_identity.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Which kit an executable given at startup is (`--kit`, `KITION_KIT_<KIT>_BINARY`): a kit's
//! executable whose file name no kit.json names is asked (`kit.initialize` reports its kit id),
//! and one that cannot be matched to a kit's manifest stops `kition-kits-mcp` and `kition-kits
//! serve` with an error naming the path, what was expected, and the kits known. Before, a build
//! copied as `kition-other-before` registered no tools and said nothing.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that can skip it say so and pass. CI requires it.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::Value;

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

/// An executable script at `path` running `body`.
fn script(path: &Path, body: &str) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_path_buf()
}

/// The Example fixture manifest written as `<dir>/kit.json`.
fn example_manifest(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::copy(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/example.json"), dir.join("kit.json")).unwrap();
}

/// Runs `program` with `args` and `env`, without the caller's `KITION_KIT_<KIT>_BINARY`.
fn run(program: &str, args: &[&str], env: &[(&str, &Path)]) -> Output {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null());
    for (key, _) in std::env::vars() {
        if key.starts_with("KITION_KIT_") {
            command.env_remove(key);
        }
    }
    for (key, value) in env {
        command.env(key, value);
    }
    command.output().unwrap()
}

/// A program, its arguments, its environment, and what its standard error must name.
type Case<'a> = (&'a str, Vec<&'a str>, Vec<(&'a str, &'a Path)>, Vec<String>);

const MCP: &str = env!("CARGO_BIN_EXE_kition-kits-mcp");

#[test]
fn an_executable_no_kit_json_names_is_asked_which_kit_it_is() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let repo = tempfile::tempdir().unwrap();
    example_manifest(repo.path());
    // A kit repository's build, copied under another name: its kit.json names `kition-example`.
    let before = script(&repo.path().join("target/kition-example-before"), &format!("KITION_KIT_MOCK_AS=kit.example:example exec '{}' \"$@\"", mock.display()));
    for (args, env) in
        [(vec!["--list-kits", "--kit", before.to_str().unwrap()], vec![]), (vec!["--list-kits"], vec![("KITION_KIT_EXAMPLE_BINARY", before.as_path())])]
    {
        let output = run(MCP, &args, &env);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let listed: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(listed["kits"][0]["id"], "kit.example", "{listed}");
        assert_eq!(listed["kits"][0]["executable"], before.display().to_string());
        assert_eq!(listed["kits"][0]["installed"], true);
    }
}

#[test]
fn an_executable_that_is_no_known_kit_stops_the_program() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let kits = dir.path().join("kits");
    example_manifest(&kits.join("example"));
    let workspace = dir.path().join("work");
    std::fs::create_dir_all(&workspace).unwrap();
    let nothing = script(&dir.path().join("elsewhere/kition-nothing"), "exit 3");
    let other = script(&dir.path().join("elsewhere/kition-mock-copy"), &format!("exec '{}' \"$@\"", mock.display()));
    let example =
        script(&dir.path().join("elsewhere/kition-example-copy"), &format!("KITION_KIT_MOCK_AS=kit.example:example exec '{}' \"$@\"", mock.display()));
    let (kits, workspace) = (kits.to_str().unwrap(), workspace.to_str().unwrap());
    let cases: Vec<Case> = vec![
        // Not a kit at all.
        (
            MCP,
            vec!["--list-kits", "--kits-dir", kits, "--kit", nothing.to_str().unwrap()],
            vec![],
            vec![nothing.display().to_string(), "kition-nothing".into(), "kit.initialize".into()],
        ),
        (MCP, vec!["--workspace", workspace, "--kits-dir", kits, "--kit", nothing.to_str().unwrap()], vec![], vec![nothing.display().to_string()]),
        ("serve", vec!["--workspace", workspace, "--kits-dir", kits, "--kit", nothing.to_str().unwrap()], vec![], vec![nothing.display().to_string()]),
        // A kit no kit.json declares.
        (MCP, vec!["--list-kits", "--kits-dir", kits, "--kit", other.to_str().unwrap()], vec![], vec![other.display().to_string(), "kit.mock".into()]),
        // A kit other than the one its variable names.
        (
            MCP,
            vec!["--list-kits", "--kits-dir", kits],
            vec![("KITION_KIT_OTHER_BINARY", example.as_path())],
            vec!["KITION_KIT_OTHER_BINARY".into(), "kit.other".into(), "kit.example".into()],
        ),
    ];
    for (program, args, env, needles) in cases {
        let output = if program == "serve" {
            let mut args = args.clone();
            args.insert(0, "serve");
            run(env!("CARGO_BIN_EXE_kition-kits"), &args, &env)
        } else {
            run(program, &args, &env)
        };
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(2), "{program} {args:?} {env:?}: {stderr}");
        for needle in needles.iter().map(String::as_str).chain(["kit.example (Example)"]) {
            assert!(stderr.contains(needle), "{needle} in {stderr}");
        }
    }
}
