//! The mock kit passes the conformance suite, and each injected fault makes
//! exactly the check that guards it fail.

use std::path::PathBuf;

use kition_kit_conformance::{Fixture, Options, Outcome, Report, run};
use serde_json::{Map, Value, json};

fn options(fault: Option<&str>) -> Options {
    let Value::Object(edit_params) = json!({ "text": " world" }) else {
        unreachable!()
    };
    Options {
        executable: PathBuf::from(env!("CARGO_BIN_EXE_kition-kit-mock")),
        manifest: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("kit.json")),
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

async fn report(fault: Option<&str>) -> Report {
    let report = run(&options(fault)).await;
    println!("{}", report.render());
    report
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
    let report = report(None).await;
    assert!(report.passed(), "{}", report.render());
    assert_eq!(report.checks.len(), kition_kit_conformance::CHECKS.len());
}

#[tokio::test]
async fn output_after_ready_fails_quiet_stdout() {
    let report = report(Some("stdout-after-ready")).await;
    assert_eq!(failed(&report), vec!["quiet-stdout"]);
}

#[tokio::test]
async fn ignoring_the_token_fails_wrong_token() {
    let report = report(Some("ignore-token")).await;
    assert!(
        failed(&report).contains(&"wrong-token"),
        "{}",
        report.render()
    );
}

#[tokio::test]
async fn a_missing_command_fails_commands() {
    let mut options = options(None);
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
