// Copied from kition-sdk crates/kition-kits/tests/preview_view_unified.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! sdk.agent.preview-view/unified: the unified tools (`kit_*`, `kition-kits-mcp --unified`) pass a
//! preview's view to the kit's render command as `<prefix>_*` does, and document the view members.
//! Its own test binary: the unified tool set is a switch for the whole process.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, the test says so and passes. CI requires it.
#![cfg(unix)]

use kition_kits::tools;
use kition_kits::{KitDefinition, KitManager};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

#[tokio::test]
async fn the_unified_inspect_passes_the_view_to_the_render_command() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    tools::set_unified(true);
    let manifest = json!({
        "khp": "1.0", "id": "kit.unireel", "name": "Kition unireel", "version": "0.0.0",
        "formats": [{ "id": "unireel", "extensions": ["unireel"], "role": "edit" }],
        "agent": { "prefix": "unireel", "tools": "document", "render": "file.render" },
        "headless": { "executable": "kition-kit-mock", "protocol": "kition-kit/1" }
    });
    let kit = KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"));
    let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let script = bin.path().join("kition-unireel-mock.sh");
    std::fs::write(&script, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.unireel:unireel KITION_KIT_MOCK_PARTS=timeline exec '{}' \"$@\"\n", mock.display()))
        .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("a.unireel"), "alpha\nbeta").unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit, Some(script))]);

    let specs = tools::installed(&kits);
    let inspect = specs.iter().find(|spec| spec.name == "kit_inspect").unwrap_or_else(|| panic!("kit_inspect is offered"));
    for member in ["time", "range", "frames", "sequence", "comp"] {
        assert!(inspect.input_schema["properties"]["target"]["properties"].get(member).is_some(), "the view member {member} is documented");
    }
    let run = specs.iter().find(|spec| spec.name == "kit_run").unwrap_or_else(|| panic!("kit_run is offered"));
    assert!(run.input_schema["properties"].get("view").is_some(), "kit_run takes a view for its after-picture");

    let answer =
        match tools::call(&kits, "kit_inspect", &json!({ "path": "a.unireel", "preview": true, "target": { "sequence": 2, "range": [0, 2], "frames": 2 } }))
            .await
        {
            Some(Ok(answer)) => answer,
            Some(Err(error)) => panic!("{}", error.message),
            None => panic!("kit_inspect is a kit tool"),
        };
    assert_eq!(answer.output["preview"]["sequence"], 2, "{}", answer.output);
    let times: Vec<f64> = answer.output["preview"]["frames"].as_array().into_iter().flatten().filter_map(|frame| frame["time"].as_f64()).collect();
    assert_eq!(times, [0.0, 2.0]);
    let refused = match tools::call(&kits, "kit_inspect", &json!({ "path": "a.unireel", "preview": true, "target": { "zoom": 2 } })).await {
        Some(Err(error)) => error,
        _ => panic!("an undeclared view member is refused"),
    };
    assert_eq!(refused.to_json()["code"], "invalid-params", "{}", refused.message);
    kits.shutdown().await;
}
