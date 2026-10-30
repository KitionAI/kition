// Copied from kition-sdk crates/kition-kdm/tests/schema.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use kition_kdm::{KdmError, Schema};
use serde_json::json;

mod common;

#[test]
fn parses_the_test_schema() {
    let schema = common::schema();
    assert_eq!(schema.root, "Page");
    assert_eq!(schema.types.len(), 3);
}

#[test]
fn rejects_an_unknown_kdm_version() {
    let error = Schema::parse(r#"{"kdm":2,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{}}}}"#).unwrap_err();
    assert!(matches!(error, KdmError::Schema(message) if message.contains("kdm 2")));
}

#[test]
fn rejects_an_undeclared_root_and_dangling_types() {
    assert!(Schema::parse(r#"{"kdm":1,"kit":"k","schemaVersion":1,"root":"B","types":{"A":{"fields":{}}}}"#).is_err());
    let dangling = r#"{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{"r":{"kind":"ref","of":"Z"}}}}}"#;
    assert!(Schema::parse(dangling).is_err());
}

#[test]
fn rejects_reserved_names_and_empty_enums() {
    let reserved = r#"{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{"$type":{"kind":"string"}}}}}"#;
    assert!(Schema::parse(reserved).is_err());
    let reserved_type = r#"{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{}},"$B":{"fields":{}}}}"#;
    assert!(matches!(Schema::parse(reserved_type), Err(KdmError::Schema(message)) if message.contains("reserved")));
    let empty = r#"{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{"e":{"kind":"enum"}}}}}"#;
    assert!(Schema::parse(empty).is_err());
}

#[test]
fn checks_register_values() {
    let schema = common::schema();
    assert!(schema.check_value("Shape", "x", &json!(1.5)).is_ok());
    assert!(schema.check_value("Shape", "x", &json!("1")).is_err());
    assert!(schema.check_value("Shape", "kind", &json!("ellipse")).is_ok());
    assert!(schema.check_value("Shape", "kind", &json!("star")).is_err());
    assert!(schema.check_value("Shape", "fill", &json!(null)).is_ok());
    assert!(schema.check_value("Shape", "x", &json!(null)).is_err());
    assert!(schema.check_value("Shape", "image", &json!({ "hash": "ab", "mime": "image/png", "size": 3 })).is_ok());
    assert!(schema.check_value("Shape", "image", &json!({ "hash": "ab" })).is_err());
    assert!(schema.check_value("Shape", "label", &json!("text")).is_err());
    assert!(matches!(schema.check_value("Shape", "nope", &json!(1)), Err(KdmError::UnknownField { .. })));
    // What to write instead: the type's fields, and that a field is one name, not a path.
    let unknown = schema.check_value("Shape", "look.line", &json!(1)).unwrap_err().to_string();
    assert!(unknown.contains("its fields:") && unknown.contains("kind") && unknown.contains("one name, not a path"), "{unknown}");
    let container = schema.check_value("Shape", "label", &json!("text")).unwrap_err().to_string();
    assert!(container.contains("text.insert"), "{container}");
}

#[test]
fn integers_must_be_exact_in_every_implementation() {
    let schema = Schema::parse(r#"{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{"n":{"kind":"integer"}}}}}"#).unwrap();
    const SAFE: i64 = 1 << 53;
    for ok in [json!(0), json!(SAFE), json!(-SAFE), json!(-1)] {
        assert!(schema.check_value("A", "n", &ok).is_ok(), "{ok}");
    }
    for bad in [json!(SAFE + 1), json!(-SAFE - 1), json!(i64::MAX), json!(u64::MAX), json!(1.5), json!("1")] {
        assert!(matches!(schema.check_value("A", "n", &bad), Err(KdmError::InvalidValue { .. })), "{bad}");
    }
}

#[test]
fn deserializing_a_schema_checks_it_too() {
    let undeclared_root = r#"{"kdm":1,"kit":"k","schemaVersion":1,"root":"B","types":{"A":{"fields":{}}}}"#;
    assert!(serde_json::from_str::<Schema>(undeclared_root).is_err());
    let valid = r#"{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{}}}}"#;
    assert_eq!(serde_json::from_str::<Schema>(valid).unwrap(), Schema::parse(valid).unwrap());
}

#[test]
fn rejects_of_and_values_on_kinds_that_do_not_take_them() {
    let field = |def: &str| format!(r#"{{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{{"A":{{"fields":{{"f":{def}}}}}}}}}"#);
    assert!(Schema::parse(&field(r#"{"kind":"ref","of":"A"}"#)).is_ok());
    assert!(Schema::parse(&field(r#"{"kind":"enum","values":["x"]}"#)).is_ok());
    for bad in [
        r#"{"kind":"string","of":"A"}"#,
        r#"{"kind":"map","of":"A"}"#,
        r#"{"kind":"text","of":"A"}"#,
        r#"{"kind":"string","values":["x"]}"#,
        r#"{"kind":"ref","of":"A","values":["x"]}"#,
    ] {
        assert!(matches!(Schema::parse(&field(bad)), Err(KdmError::Schema(_))), "{bad}");
    }
}

#[test]
fn integers_beyond_the_exact_range_never_enter_a_document() {
    let schema = Schema::parse(
        r#"{"kdm":1,"kit":"k","schemaVersion":1,"root":"A","types":{"A":{"fields":{
            "n":{"kind":"number"},"j":{"kind":"json"},"b":{"kind":"blob"}}}}}"#,
    )
    .unwrap();
    const SAFE: i64 = 1 << 53;
    let invalid = |field: &str, value: serde_json::Value| matches!(schema.check_value("A", field, &value), Err(KdmError::InvalidValue { .. }));
    // A number field takes whole doubles of any size, and integers within ±2^53.
    for ok in [json!(SAFE), json!(-SAFE), json!(1e16), json!(-1e300), json!(1.5)] {
        assert!(schema.check_value("A", "n", &ok).is_ok(), "{ok}");
    }
    for bad in [json!(SAFE + 1), json!(-SAFE - 1), json!(i64::MAX), json!(u64::MAX)] {
        assert!(invalid("n", bad.clone()), "{bad}");
    }
    // JSON values and blobs are checked at every depth.
    assert!(schema.check_value("A", "j", &json!({ "a": [1, { "b": SAFE }], "c": 1e16 })).is_ok());
    for bad in [json!(SAFE + 1), json!([0, [u64::MAX]]), json!({ "a": { "b": -SAFE - 1 } })] {
        assert!(invalid("j", bad.clone()), "{bad}");
    }
    assert!(schema.check_value("A", "b", &json!({ "hash": "ab", "mime": "x/y", "size": SAFE })).is_ok());
    assert!(invalid("b", json!({ "hash": "ab", "mime": "x/y", "size": SAFE + 1 })));
    assert!(invalid("b", json!({ "hash": "ab", "mime": "x/y", "size": 1, "extra": [u64::MAX] })));
    // Nor do they hold a `__proto__` key, at any depth.
    assert!(invalid("j", json!({ "__proto__": 1 })));
    assert!(invalid("j", json!([{ "a": { "__proto__": [] } }])));
    assert!(invalid("b", json!({ "hash": "ab", "mime": "x/y", "size": 1, "extra": { "__proto__": 1 } })));
}
