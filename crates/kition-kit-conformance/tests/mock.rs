//! The mock kit (`kition-kit-mock`) passes the conformance suite, and each injected fault makes
//! exactly the check that guards it fail. The mock is built with the workspace (`cargo test
//! --workspace`, or `cargo build -p kition-kit-mock`); when it is missing the tests say so and pass.

use std::path::PathBuf;

use kition_kit_conformance::{Fixture, Options, Outcome, Report, run};
use serde_json::{Map, Value, json};

/// The mock kit's executable beside this test's (`target/<profile>/kition-kit-mock`).
fn mock() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe
        .parent()?
        .parent()?
        .join(format!("kition-kit-mock{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

fn options(executable: PathBuf, fault: Option<&str>) -> Options {
    let Value::Object(edit_params) = json!({ "text": " world" }) else {
        unreachable!()
    };
    Options {
        executable,
        manifest: Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../kition-kit-mock/kit.json"),
        ),
        fixture: Fixture {
            file_name: "fixture.mocktext".into(),
            contents: b"hello".to_vec(),
            edit_command: "text.append".into(),
            edit_params,
        },
        env: fault
            .map(|fault| vec![("KITION_KIT_MOCK_FAULT".into(), fault.into())])
            .unwrap_or_default(),
    }
}

async fn report(fault: Option<&str>) -> Option<Report> {
    let Some(executable) = mock() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return None;
    };
    let report = run(&options(executable, fault)).await;
    println!("{}", report.render());
    Some(report)
}

fn failed(report: &Report) -> Vec<&'static str> {
    report
        .checks
        .iter()
        .filter(|check| check.outcome != Outcome::Passed)
        .map(|check| check.id)
        .collect()
}

#[tokio::test]
async fn mock_kit_passes_every_check() {
    let Some(report) = report(None).await else {
        return;
    };
    assert!(report.passed(), "{}", report.render());
    assert_eq!(report.checks.len(), kition_kit_conformance::CHECKS.len());
}

#[tokio::test]
async fn output_after_ready_fails_quiet_stdout() {
    let Some(report) = report(Some("stdout-after-ready")).await else {
        return;
    };
    assert_eq!(failed(&report), vec!["quiet-stdout"]);
}

#[tokio::test]
async fn ignoring_the_token_fails_wrong_token() {
    let Some(report) = report(Some("ignore-token")).await else {
        return;
    };
    assert!(
        failed(&report).contains(&"wrong-token"),
        "{}",
        report.render()
    );
}

#[tokio::test]
async fn a_missing_command_fails_commands() {
    let Some(executable) = mock() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let mut options = options(executable, None);
    options.fixture.edit_command = "text.missing".into();
    options.fixture.edit_params = Map::new();
    let report = run(&options).await;
    assert!(
        matches!(report.outcome("commands"), Some(Outcome::Failed(_))),
        "{}",
        report.render()
    );
    assert!(matches!(
        report.outcome("round-trip"),
        Some(Outcome::Skipped(_))
    ));
    assert_eq!(report.outcome("shutdown"), Some(&Outcome::Passed));
}
