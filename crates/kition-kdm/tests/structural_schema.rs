// Copied from kition-sdk crates/kition-kdm/tests/structural_schema.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use kition_kdm::Schema;
use serde_json::json;

#[test]
fn structural_consequence_declarations_require_a_container_actions_and_paths() {
    let schema = json!({"kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Sheet","types":{
        "Sheet":{"fields":{"cells":{"kind":"map","owns":true}}},
        "Cell":{"fields":{"formula":{"kind":"string"},"address":{"kind":"json"}},
            "structuralConsequences":[{"container":"Sheet","on":["create","delete","move","rename"],"fields":["formula","address.row"]}]}
    }});
    assert!(Schema::parse(&schema.to_string()).is_ok());
    for (key, value) in [
        ("container", json!("Missing")),
        ("on", json!(["set"])),
        ("on", json!([])),
        ("fields", json!(["missing"])),
        ("fields", json!(["formula.part"])),
        ("fields", json!([])),
    ] {
        let mut invalid = schema.clone();
        invalid["types"]["Cell"]["structuralConsequences"][0][key] = value;
        assert!(Schema::parse(&invalid.to_string()).is_err(), "{invalid}");
    }
}
