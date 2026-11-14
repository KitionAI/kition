// Copied from kition-sdk crates/kition-kit-process-protocol/tests/schema.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Every type serializes to JSON that the contract schemas accept, and the
//! schemas' own example shapes deserialize back into the types.

use kition_kit_process_protocol::error::{ErrorData, ErrorReason};
use kition_kit_process_protocol::launch::Surface;
use kition_kit_process_protocol::types::*;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

const PROTOCOL: &str = include_str!("../../../contracts/kit/kit-process-protocol.schema.json");

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

const HANDLE: &str = "fh_9c1d0123456789abcdef0123456789ab";

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn state() -> DocumentState {
    DocumentState {
        document_id: "d1".into(),
        name: "a.psd".into(),
        title: "a.psd".into(),
        format: "psd".into(),
        read_only: false,
        dirty: true,
        can_undo: true,
        can_redo: false,
        conflict: false,
    }
}

#[test]
fn lifecycle_shapes_match_the_schema() {
    round_trip(
        "initializeParams",
        &InitializeParams {
            protocol_version: 2,
            token: TOKEN.into(),
            role: Role::Host,
            client: ClientInfo { name: "Kition".into(), version: "0.2.0".into() },
            locale: Some("zh-CN".into()),
            appearance: Some(Appearance::Light),
            host_services: vec![HOST_SERVICE_FILES.into(), HOST_SERVICE_FILES_PRINT.into()],
        },
    );
    round_trip(
        "initializeParams",
        &InitializeParams {
            protocol_version: 2,
            token: TOKEN.into(),
            role: Role::Agent,
            client: ClientInfo { name: "Kition agent".into(), version: "0.2.0".into() },
            locale: None,
            appearance: None,
            host_services: Vec::new(),
        },
    );
    round_trip(
        "initializeResult",
        &InitializeResult {
            protocol_version: 2,
            kit: KitInfo { id: "kit.photo".into(), version: "0.1.0".into() },
            capabilities: Capabilities {
                surfaces: vec![Surface::Headless],
                formats: Formats { open: vec!["psd".into()], save: vec!["psd".into()], export: vec!["png".into()] },
                features: vec!["view.describe".into()],
                capabilities: vec![DOCUMENT_TEXT_CAPABILITY.into()],
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
    round_trip("documentState", &DocumentState { read_only: true, dirty: false, ..state() });
    round_trip("documentState", &DocumentState { conflict: true, ..state() });
    round_trip(
        "documentOpenParams",
        &DocumentOpenParams {
            file: HANDLE.into(),
            read_only: Some(false),
            create: Some(CreateDocument { format: "psd".into(), options: Some(Map::from_iter([("width".into(), json!(1920))])) }),
        },
    );
    round_trip("documentListResult", &DocumentListResult { documents: vec![state()] });
    round_trip("documentRefParams", &DocumentRef { document_id: "d1".into() });
    round_trip("documentSaveAsParams", &DocumentSaveAsParams { document_id: "d1".into(), file: HANDLE.into(), format: Some("psd".into()) });
    round_trip("documentExportParams", &DocumentExportParams { document_id: "d1".into(), file: HANDLE.into(), format: "png".into(), options: None });
    round_trip("documentWritten", &DocumentWritten { name: "b.png".into(), version: "\"1791704599-22779\"".into() });
    round_trip("documentCloseParams", &DocumentCloseParams { document_id: "d1".into(), discard_changes: Some(true) });
    round_trip("documentTextParams", &DocumentTextParams { document_id: "d1".into(), limit: Some(DOCUMENT_TEXT_LIMIT) });
    round_trip("documentTextParams", &DocumentTextParams { document_id: "d1".into(), limit: None });
    round_trip(
        "documentTextResult",
        &DocumentTextResult {
            text: "Hello\nworld".into(),
            truncated: false,
            parts: vec![TextPart { label: "Page 1".into(), start: 0, end: 5 }, TextPart { label: "Page 2".into(), start: 6, end: 11 }],
        },
    );
    round_trip("documentTextResult", &DocumentTextResult::default());
    round_trip("documentDidSaveParams", &DocumentDidSaveParams { document_id: "d1".into(), name: "a.psd".into(), version: "v2".into() });
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
        keywords: Vec::new(),
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
            origin_label: None,
        },
    );
    round_trip(
        "commandsExecuteParams",
        &CommandsExecuteParams {
            document_id: "d1".into(),
            command: "links.retarget".into(),
            params: Map::new(),
            origin: Origin::System,
            origin_label: Some("emailsync".into()),
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

/// Section 5.1: what a kit asks its host for, and what the host answers.
#[test]
fn host_service_shapes_match_the_schema() {
    let stat = FileStat {
        handle: HANDLE.into(),
        name: "Q3 report.pdf".into(),
        kind: FileKind::File,
        size: Some(482_113),
        mime: Some("application/pdf".into()),
        version: Some("\"1791704599-22779\"".into()),
        rights: vec![FileRight::Read, FileRight::Write],
    };
    round_trip("fileStat", &stat);
    round_trip("fileStat", &FileStat { version: None, size: None, mime: None, rights: vec![FileRight::Create], ..stat.clone() });
    round_trip("fileRefParams", &FileRef { handle: HANDLE.into() });
    round_trip("filesReadParams", &FilesReadParams { handle: HANDLE.into(), offset: Some(0), length: Some(FILE_CHUNK as u64) });
    round_trip("filesReadResult", &FilesReadResult { data: "R1JJRA==".into(), version: "v1".into(), size: 4 });
    round_trip("filesListResult", &FilesListResult { files: vec![stat] });
    round_trip(
        "filesWriteParams",
        &FilesWriteParams { handle: HANDLE.into(), data: "R1JJRA==".into(), offset: 0, last: Some(true), expected: Some("v1".into()) },
    );
    let chunk = serde_json::to_value(FilesWriteParams { handle: HANDLE.into(), data: String::new(), offset: 0, last: Some(true), expected: None })
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(chunk["final"], true, "the wire name is `final`");
    round_trip("filesWriteResult", &FilesWriteResult { version: Some("v2".into()) });
    round_trip("filesWriteResult", &FilesWriteResult::default());
    round_trip(
        "filesCreateParams",
        &FilesCreateParams { suggested_name: "Out.png".into(), mime: Some("image/png".into()), folder: None, document_id: Some("d1".into()) },
    );
    round_trip("filesResolveParams", &FilesResolveParams { document_id: Some("d1".into()), file: None, link: "../media/a.png".into() });
    round_trip("filesResolveParams", &FilesResolveParams { document_id: None, file: Some(HANDLE.into()), link: "media/a.png".into() });
    round_trip("filesReleaseParams", &FilesReleaseParams { handles: vec![HANDLE.into()] });
}

#[test]
fn notification_shapes_match_the_schema() {
    round_trip(
        "progressParams",
        &ProgressParams { token: kition_kit_process_protocol::RequestId::String("job-1".into()), title: "Rendering".into(), fraction: Some(0.5), done: false },
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
    let validator = |def: &str| {
        let mut schema = parse(PROTOCOL);
        schema["$ref"] = json!(format!("#/$defs/{def}"));
        jsonschema::validator_for(&schema).unwrap_or_else(|err| panic!("{err}"))
    };
    let mut bad = serde_json::to_value(state()).unwrap_or_else(|err| panic!("{err}"));
    bad["name"] = json!("/Users/someone/a.psd");
    assert!(!validator("documentState").is_valid(&bad), "a name is a last segment, never a path");
    // Version 1's shapes are gone: no URI where a handle goes, no workspace roots.
    assert!(!validator("documentOpenParams").is_valid(&json!({ "uri": "file:///tmp/a.psd" })));
    assert!(!validator("documentOpenParams").is_valid(&json!({ "file": "/tmp/a.psd" })));
    let mut init = json!({ "protocolVersion": 2, "token": TOKEN, "role": "host", "client": { "name": "h", "version": "1" } });
    assert!(validator("initializeParams").is_valid(&init));
    init["workspaceRoots"] = json!(["file:///tmp"]);
    assert!(!validator("initializeParams").is_valid(&init));
}
