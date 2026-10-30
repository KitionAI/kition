// Copied from kition-sdk crates/kition-kit-protocol/tests/schema.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Every type serializes to JSON that the contract schemas accept, and the
//! schemas' own example shapes deserialize back into the types.

use kition_kit_protocol::error::{ErrorData, ErrorReason};
use kition_kit_protocol::launch::Surface;
use kition_kit_protocol::types::*;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

const PROTOCOL: &str = include_str!("../../../contracts/kit/kit-protocol.schema.json");

fn parse(schema: &str) -> Value {
    serde_json::from_str(schema).unwrap_or_else(|err| panic!("{err}"))
}

fn check(schema: &Value, instance: &Value) {
    let validator = jsonschema::validator_for(schema).unwrap_or_else(|err| panic!("{err}"));
    let errors: Vec<String> = validator.iter_errors(instance).map(|error| format!("{} at {}", error, error.instance_path())).collect();
    assert!(errors.is_empty(), "{instance}\n{}", errors.join("\n"));
}

/// Validates against one `$defs` entry of the protocol schema by pointing
/// the root at it.
fn check_def(def: &str, instance: &Value) {
    let mut schema = parse(PROTOCOL);
    assert!(schema["$defs"].get(def).is_some(), "no $defs/{def}");
    schema["$ref"] = Value::from(format!("#/$defs/{def}"));
    check(&schema, instance);
}

/// Serializes, validates, and checks that deserializing gives the value back.
fn round_trip<T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(def: &str, value: &T) {
    let json = serde_json::to_value(value).unwrap_or_else(|err| panic!("{err}"));
    check_def(def, &json);
    let back: T = serde_json::from_value(json).unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(&back, value);
}

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn state() -> DocumentState {
    DocumentState {
        document_id: "d1".into(),
        uri: Some("file:///tmp/a.psd".into()),
        title: "a.psd".into(),
        format: "psd".into(),
        read_only: false,
        dirty: true,
        can_undo: true,
        can_redo: false,
    }
}

#[test]
fn lifecycle_shapes_match_the_schema() {
    round_trip(
        "initializeParams",
        &InitializeParams {
            protocol_version: 1,
            token: TOKEN.into(),
            role: Role::Host,
            client: ClientInfo { name: "Kition".into(), version: "0.2.0".into() },
            locale: Some("zh-CN".into()),
            appearance: Some(Appearance::Light),
            workspace_roots: vec!["file:///tmp/workspace".into()],
        },
    );
    round_trip(
        "initializeParams",
        &InitializeParams {
            protocol_version: 1,
            token: TOKEN.into(),
            role: Role::Agent,
            client: ClientInfo { name: "Kition agent".into(), version: "0.2.0".into() },
            locale: None,
            appearance: None,
            workspace_roots: Vec::new(),
        },
    );
    round_trip(
        "initializeResult",
        &InitializeResult {
            protocol_version: 1,
            kit: KitInfo { id: "kit.photo".into(), version: "0.1.0".into() },
            capabilities: Capabilities {
                surfaces: vec![Surface::Headless],
                formats: Formats { open: vec!["psd".into()], save: vec!["psd".into()], export: vec!["png".into()] },
                features: vec!["view.describe".into()],
            },
        },
    );
    round_trip("setPreferencesParams", &SetPreferencesParams { locale: Some("en-US".into()), appearance: Some(Appearance::Dark) });
    round_trip("cancelRequestParams", &CancelRequestParams { id: 4.into() });
    round_trip("emptyResult", &Empty {});
}

#[test]
fn document_shapes_match_the_schema() {
    round_trip("documentState", &state());
    round_trip("documentState", &DocumentState { uri: None, ..state() });
    round_trip(
        "documentOpenParams",
        &DocumentOpenParams {
            uri: "file:///tmp/new.psd".into(),
            read_only: Some(false),
            create: Some(CreateDocument { format: "psd".into(), options: Some(Map::from_iter([("width".into(), json!(1920))])) }),
        },
    );
    round_trip("documentListResult", &DocumentListResult { documents: vec![state()] });
    round_trip("documentRefParams", &DocumentRef { document_id: "d1".into() });
    round_trip("documentSaveAsParams", &DocumentSaveAsParams { document_id: "d1".into(), uri: "file:///tmp/b.psd".into(), format: Some("psd".into()) });
    round_trip(
        "documentExportParams",
        &DocumentExportParams { document_id: "d1".into(), uri: "file:///tmp/b.png".into(), format: "png".into(), options: None },
    );
    round_trip("documentUriResult", &DocumentUriResult { uri: "file:///tmp/b.png".into() });
    round_trip("documentCloseParams", &DocumentCloseParams { document_id: "d1".into(), discard_changes: Some(true) });
    round_trip("documentDidSaveParams", &DocumentDidSaveParams { document_id: "d1".into(), uri: "file:///tmp/a.psd".into() });
}

/// cases/regressions/issue-command-output: a command may say what it answers (`output`, the
/// engine's `outputSchema` as JSON Schema, KHP A1), as kition-sdk's kit server lists it in
/// `commands.list`; the host keeps it.
#[test]
fn a_command_may_say_what_it_answers() {
    let listed = json!({
        "id": "file.render",
        "title": "Render preview",
        "group": "file",
        "params": { "type": "object" },
        "output": {
            "type": "object",
            "properties": { "png": { "type": "string" } },
            "required": ["png"]
        },
        "mutates": false,
        "enabled": true
    });
    check_def("commandInfo", &listed);
    let command: CommandInfo = serde_json::from_value(listed.clone()).unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(command.output.as_ref(), Some(&listed["output"]));
    round_trip("commandInfo", &command);
}

#[test]
fn command_and_view_shapes_match_the_schema() {
    let command = CommandInfo {
        id: "layer.newAdjustmentLayer.curves".into(),
        title: "Curves".into(),
        description: Some("Adds a curves adjustment layer.".into()),
        group: "adjust".into(),
        params: json!({"type": "object"}),
        output: None,
        mutates: true,
        enabled: true,
        menu: vec!["Image".into(), "Adjustments".into()],
        shortcut: Some("Cmd+M".into()),
    };
    round_trip("commandsListParams", &CommandsListParams { document_id: Some("d1".into()), groups: Some(vec!["adjust".into()]) });
    round_trip("commandsListResult", &CommandsListResult { commands: vec![command] });
    round_trip(
        "commandsExecuteParams",
        &CommandsExecuteParams {
            document_id: "d1".into(),
            command: "layer.new.layer".into(),
            params: Map::from_iter([("name".into(), json!("Ink"))]),
            origin: Origin::Agent,
        },
    );
    round_trip("commandsExecuteResult", &CommandsExecuteResult { changed: true, result: Some(json!({"layer": 3})) });
    round_trip(
        "commandsDidChangeEnabledParams",
        &CommandsDidChangeEnabledParams { document_id: "d1".into(), enabled: vec!["edit.undo".into()], disabled: Vec::new() },
    );
    round_trip("viewScreenshotParams", &ViewScreenshotParams { document_id: "d1".into(), scope: ScreenshotScope::Canvas, max_size: Some(1024) });
    round_trip("image", &Image::png(1, 1, "iVBORw0KGgo=".into()));
    round_trip("viewDescribeResult", &ViewDescribeResult { summary: "2 layers".into(), state: Map::from_iter([("layers".into(), json!([]))]) });
}

#[test]
fn notification_shapes_match_the_schema() {
    round_trip(
        "progressParams",
        &ProgressParams { token: kition_kit_protocol::RequestId::String("job-1".into()), title: "Rendering".into(), fraction: Some(0.5), done: false },
    );
    round_trip("logParams", &LogParams { level: LogLevel::Warn, message: "slow GPU".into() });
}

#[test]
fn error_data_matches_the_schema() {
    for reason in ErrorReason::ALL {
        round_trip("errorData", &ErrorData { reason, detail: Some("detail".into()), errors: None });
    }
}

#[test]
fn schema_rejects_what_the_types_must_not_produce() {
    // A guard that check_def is not vacuous.
    let mut bad = serde_json::to_value(state()).unwrap_or_else(|err| panic!("{err}"));
    bad["uri"] = json!("https://example.com/a.psd");
    let mut schema = parse(PROTOCOL);
    schema["$ref"] = json!("#/$defs/documentState");
    let validator = jsonschema::validator_for(&schema).unwrap_or_else(|err| panic!("{err}"));
    assert!(!validator.is_valid(&bad));
}
