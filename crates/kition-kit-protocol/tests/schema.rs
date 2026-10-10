//! Every type serializes to JSON that the contract schemas accept, and the
//! schemas' own example shapes deserialize back into the types.

use std::collections::BTreeMap;

use kition_kit_protocol::error::{ErrorData, ErrorReason};
use kition_kit_protocol::index::{Asset, KitEntry, KitIndex, KitVersion};
use kition_kit_protocol::launch::Surface;
use kition_kit_protocol::manifest::KitManifest;
use kition_kit_protocol::types::*;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

const PROTOCOL: &str = include_str!("../../../contracts/kit/kit-protocol.schema.json");
const MANIFEST: &str = include_str!("../../../contracts/kit/kit-manifest.schema.json");
const INDEX: &str = include_str!("../../../contracts/kit/kit-index.schema.json");

fn parse(schema: &str) -> Value {
    serde_json::from_str(schema).unwrap_or_else(|err| panic!("{err}"))
}

fn check(schema: &Value, instance: &Value) {
    let validator = jsonschema::validator_for(schema).unwrap_or_else(|err| panic!("{err}"));
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|error| format!("{} at {}", error, error.instance_path()))
        .collect();
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
            client: ClientInfo {
                name: "Kition".into(),
                version: "0.2.0".into(),
            },
            locale: Some("zh-CN".into()),
            appearance: Some(Appearance::Light),
            reserved_shortcuts: vec![Shortcut {
                key: "k".into(),
                code: "KeyK".into(),
                modifiers: vec![Modifier::Meta],
            }],
            workspace_roots: vec!["file:///tmp/workspace".into()],
        },
    );
    round_trip(
        "initializeParams",
        &InitializeParams {
            protocol_version: 1,
            token: TOKEN.into(),
            role: Role::Agent,
            client: ClientInfo {
                name: "Kition agent".into(),
                version: "0.2.0".into(),
            },
            locale: None,
            appearance: None,
            reserved_shortcuts: Vec::new(),
            workspace_roots: Vec::new(),
        },
    );
    round_trip(
        "initializeResult",
        &InitializeResult {
            protocol_version: 1,
            kit: KitInfo {
                id: "kit.photo".into(),
                version: "0.1.0".into(),
            },
            capabilities: Capabilities {
                surfaces: vec![Surface::Window, Surface::Headless],
                embedding_mechanisms: vec![Mechanism::OverlayWindow],
                formats: Formats {
                    open: vec!["psd".into()],
                    save: vec!["psd".into()],
                    export: vec!["png".into()],
                },
                features: vec!["view.describe".into()],
            },
        },
    );
    round_trip(
        "setPreferencesParams",
        &SetPreferencesParams {
            locale: Some("en-US".into()),
            appearance: Some(Appearance::Dark),
        },
    );
    round_trip("cancelRequestParams", &CancelRequestParams { id: 4.into() });
    round_trip("emptyResult", &Empty {});
}

#[test]
fn document_shapes_match_the_schema() {
    round_trip("documentState", &state());
    round_trip(
        "documentState",
        &DocumentState {
            uri: None,
            ..state()
        },
    );
    round_trip(
        "documentOpenParams",
        &DocumentOpenParams {
            uri: "file:///tmp/new.psd".into(),
            read_only: Some(false),
            create: Some(CreateDocument {
                format: "psd".into(),
                options: Some(Map::from_iter([("width".into(), json!(1920))])),
            }),
        },
    );
    round_trip(
        "documentListResult",
        &DocumentListResult {
            documents: vec![state()],
        },
    );
    round_trip(
        "documentRefParams",
        &DocumentRef {
            document_id: "d1".into(),
        },
    );
    round_trip(
        "documentSaveAsParams",
        &DocumentSaveAsParams {
            document_id: "d1".into(),
            uri: "file:///tmp/b.psd".into(),
            format: Some("psd".into()),
        },
    );
    round_trip(
        "documentExportParams",
        &DocumentExportParams {
            document_id: "d1".into(),
            uri: "file:///tmp/b.png".into(),
            format: "png".into(),
            options: None,
        },
    );
    round_trip(
        "documentUriResult",
        &DocumentUriResult {
            uri: "file:///tmp/b.png".into(),
        },
    );
    round_trip(
        "documentCloseParams",
        &DocumentCloseParams {
            document_id: "d1".into(),
            discard_changes: Some(true),
        },
    );
    round_trip(
        "documentDidSaveParams",
        &DocumentDidSaveParams {
            document_id: "d1".into(),
            uri: "file:///tmp/a.psd".into(),
        },
    );
}

#[test]
fn command_and_view_shapes_match_the_schema() {
    let command = CommandInfo {
        id: "layer.newAdjustmentLayer.curves".into(),
        title: "Curves".into(),
        description: Some("Adds a curves adjustment layer.".into()),
        group: "adjust".into(),
        params: json!({"type": "object"}),
        mutates: true,
        enabled: true,
        menu: vec!["Image".into(), "Adjustments".into()],
        shortcut: Some("Cmd+M".into()),
    };
    round_trip(
        "commandsListParams",
        &CommandsListParams {
            document_id: Some("d1".into()),
            groups: Some(vec!["adjust".into()]),
        },
    );
    round_trip(
        "commandsListResult",
        &CommandsListResult {
            commands: vec![command],
        },
    );
    round_trip(
        "commandsExecuteParams",
        &CommandsExecuteParams {
            document_id: "d1".into(),
            command: "layer.new.layer".into(),
            params: Map::from_iter([("name".into(), json!("Ink"))]),
            origin: Origin::Agent,
        },
    );
    round_trip(
        "commandsExecuteResult",
        &CommandsExecuteResult {
            changed: true,
            result: Some(json!({"layer": 3})),
        },
    );
    round_trip(
        "commandsDidChangeEnabledParams",
        &CommandsDidChangeEnabledParams {
            document_id: "d1".into(),
            enabled: vec!["edit.undo".into()],
            disabled: Vec::new(),
        },
    );
    round_trip(
        "viewScreenshotParams",
        &ViewScreenshotParams {
            document_id: "d1".into(),
            scope: ScreenshotScope::Canvas,
            max_size: Some(1024),
        },
    );
    round_trip("image", &Image::png(1, 1, "iVBORw0KGgo=".into()));
    round_trip(
        "viewDescribeResult",
        &ViewDescribeResult {
            summary: "2 layers".into(),
            state: Map::from_iter([("layers".into(), json!([]))]),
        },
    );
}

#[test]
fn surface_and_notification_shapes_match_the_schema() {
    let bounds = Bounds {
        x: 0.0,
        y: 48.0,
        width: 800.0,
        height: 600.0,
    };
    round_trip(
        "surfaceAttachParams",
        &SurfaceAttachParams {
            mechanism: Mechanism::OverlayWindow,
            parent: Some(SurfaceParent {
                platform: ParentPlatform::Macos,
                handle: "4182".into(),
            }),
            bounds,
            scale_factor: 2.0,
            visible: true,
        },
    );
    round_trip(
        "surfaceAttachParams",
        &SurfaceAttachParams {
            mechanism: Mechanism::TopLevel,
            parent: None,
            bounds,
            scale_factor: 1.0,
            visible: true,
        },
    );
    round_trip(
        "surfaceSetBoundsParams",
        &SurfaceSetBoundsParams {
            bounds,
            scale_factor: 1.5,
        },
    );
    round_trip(
        "surfaceSetVisibleParams",
        &SurfaceSetVisibleParams { visible: false },
    );
    round_trip(
        "surfaceFocusExitParams",
        &SurfaceFocusExitParams {
            direction: FocusDirection::Previous,
        },
    );
    round_trip(
        "shortcut",
        &Shortcut {
            key: "Tab".into(),
            code: "Tab".into(),
            modifiers: vec![Modifier::Ctrl, Modifier::Shift],
        },
    );
    round_trip(
        "progressParams",
        &ProgressParams {
            token: kition_kit_protocol::RequestId::String("job-1".into()),
            title: "Rendering".into(),
            fraction: Some(0.5),
            done: false,
        },
    );
    round_trip(
        "logParams",
        &LogParams {
            level: LogLevel::Warn,
            message: "slow GPU".into(),
        },
    );
}

#[test]
fn error_data_matches_the_schema() {
    for reason in ErrorReason::ALL {
        round_trip(
            "errorData",
            &ErrorData {
                reason,
                detail: Some("detail".into()),
                errors: None,
            },
        );
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

#[test]
fn manifest_round_trips_through_the_schema() {
    let manifest = json!({
        "schemaVersion": 1,
        "id": "kit.photo",
        "name": "Kition Photo",
        "description": "Layered image editing.",
        "version": "0.1.0",
        "publisher": "Kition",
        "kitProtocol": 1,
        "license": "MIT OR Apache-2.0",
        "attribution": [{
            "name": "Upstream photo editor",
            "url": "https://example.com/upstream",
            "license": "MIT OR Apache-2.0",
            "revision": "abc123"
        }],
        "executable": "bin/kit-photo",
        "fileTypes": [{
            "format": "psd",
            "extensions": ["psd", "psb"],
            "mimeTypes": ["image/vnd.adobe.photoshop"],
            "roles": ["editor"],
            "default": true
        }],
        "surfaces": ["embedded", "window", "headless"],
        "embedding": { "macos": ["overlay-window"], "windows": ["child-window"] },
        "permissions": { "network": false },
        "agent": { "toolGroups": [{ "id": "layers", "title": "Layers", "description": "Layer commands." }] }
    });
    check(&parse(MANIFEST), &manifest);
    let parsed: KitManifest =
        serde_json::from_value(manifest.clone()).unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(
        parsed
            .file_type_for_extension("PSB")
            .map(|t| t.format.as_str()),
        Some("psd")
    );
    let back = serde_json::to_value(&parsed).unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(back, manifest);
}

#[test]
fn index_round_trips_through_the_schema() {
    let index = KitIndex {
        schema_version: 1,
        generated_at: "2026-10-10T00:00:00Z".into(),
        kits: vec![KitEntry {
            id: "kit.photo".into(),
            name: "Kition Photo".into(),
            built_in: None,
            versions: vec![KitVersion {
                version: "0.1.0".into(),
                kit_protocol: 1,
                min_host_version: Some("0.3.0".into()),
                release_tag: "v0.1.0".into(),
                assets: BTreeMap::from([(
                    "darwin-arm64".to_owned(),
                    Asset {
                        name: "kit-photo-0.1.0-darwin-arm64.tar.gz".into(),
                        sha256: "ab".repeat(32),
                        size: 70_000_000,
                    },
                )]),
            }],
        }],
    };
    let json = serde_json::to_value(&index).unwrap_or_else(|err| panic!("{err}"));
    check(&parse(INDEX), &json);
    let back: KitIndex = serde_json::from_value(json).unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(back, index);
}
