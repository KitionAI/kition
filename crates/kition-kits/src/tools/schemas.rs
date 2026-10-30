// Copied from kition-sdk crates/kition-kits/src/tools/schemas.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The kit tools' argument and result schemas, as published in
//! `contracts/kit/mcp-tools.schema.json` and printed by `kition-kits-mcp --schemas`: every tool
//! of a kit, named by its `<prefix>`, with the arguments `tools/list` offers (built from a generic
//! kit, so the object-model fields take any type before the kit's `model.describe` is known) and
//! the structured content a call answers. A failed call answers its error as `error` beside what
//! it had done.

use serde_json::{Value, json};

use super::errors::ErrorCode;
use super::{Action, specs_described};
use crate::manager::{KitAgent, KitDefinition};

/// A kit with placeholders for what each kit names: its tools' arguments are every kit's.
static GENERIC: KitDefinition = KitDefinition {
    id: "kit.<kit>",
    name: "<Kit>",
    extensions: &[],
    creates: &[],
    base_name: "Untitled <kit>",
    exports: &[],
    executable: None,
    version: "<version>",
    manifest: "{}",
    agent: KitAgent {
        prefix: "<prefix>",
        drafts: true,
        object_model: true,
        noun: "document",
        formats: "<formats>",
        reports: "the document",
        covers: "the kit's commands",
        queries: "`<keywords>`",
        command: "<command>",
        render: None,
        export: None,
    },
};

/// The error a failed call answers (KHP A18).
fn error_schema() -> Value {
    let codes: Vec<&str> = ErrorCode::ALL.iter().map(|code| code.as_str()).collect();
    json!({
        "type": "object",
        "properties": {
            "code": { "type": "string", "enum": codes },
            "message": { "type": "string" },
            "index": { "type": "integer", "minimum": 0, "description": "The failing step or operation." },
            "retryable": { "type": "boolean" }
        },
        "required": ["code", "message"]
    })
}

/// The document as `<prefix>_inspect`, `_run`, and `_batch` describe it.
fn document_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": ["string", "null"], "description": "The file's workspace path." },
            "summary": { "type": "string", "description": "One line on the document." },
            "dirty": { "type": "boolean", "description": "It has unsaved changes." },
            "canUndo": { "type": "boolean" },
            "canRedo": { "type": "boolean" },
            "details": { "description": "What the kit reports about the document." },
            "draft": { "type": "boolean", "description": "This is the agent's draft of the file." }
        }
    })
}

/// Where the call ran: `live` in the file's open editor, `draft` on the agent's draft.
fn place() -> [(&'static str, Value); 2] {
    [
        ("live", json!({ "type": "boolean", "description": "Edited or read in the file's open editor." })),
        ("draft", json!({ "type": "boolean", "description": "Edited or read the agent's draft, not the file." })),
    ]
}

fn object(properties: Value, required: &[&str]) -> Value {
    let mut properties = properties;
    for (name, schema) in place() {
        properties[name] = schema;
    }
    properties["error"] = json!({ "$ref": "#/$defs/error" });
    json!({ "type": "object", "properties": properties, "required": required })
}

fn diagnostic_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "code": { "type": "string", "description": "Stable `<kit>.<name>`." },
            "severity": { "type": "string", "enum": ["error", "warning", "info"] },
            "target": {
                "type": "object",
                "properties": {
                    "objectId": { "type": "string" },
                    "path": { "type": "string" },
                    "page": { "type": "integer", "minimum": 1 },
                    "slide": { "type": "integer", "minimum": 1 },
                    "sheet": { "type": "string" },
                    "cell": { "type": "string" }
                },
                "description": "Empty for the whole document."
            },
            "message": { "type": "string" },
            "fix": {
                "type": "object",
                "properties": { "command": { "type": "string" }, "params": { "type": "object" } },
                "required": ["command"],
                "description": "A command for `<prefix>_run` that may fix it; never run by the host itself."
            }
        },
        "required": ["code", "severity", "target", "message"]
    })
}

/// What a successful call of `action` answers as structured content (failures add `error`).
pub fn output_schema(action: Action) -> Value {
    match action {
        Action::Inspect => {
            let mut schema = document_schema();
            schema["properties"]["document"] = json!({ "$ref": "#/$defs/document", "description": "The document, when its open editor answered." });
            for (name, place) in place() {
                schema["properties"][name] = place;
            }
            schema["properties"]["error"] = json!({ "$ref": "#/$defs/error" });
            schema
        }
        Action::Commands => object(
            json!({
                "commands": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "title": { "type": "string" },
                            "description": { "type": ["string", "null"] },
                            "enabled": { "type": "boolean" },
                            "mutates": { "type": "boolean" }
                        },
                        "required": ["id"]
                    }
                },
                "total": { "type": "integer", "description": "How many matched; at most 40 are listed." }
            }),
            &[],
        ),
        Action::Run => object(
            json!({
                "completed": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "command": { "type": "string" }, "changed": { "type": "boolean" }, "result": {} },
                        "required": ["command"]
                    },
                    "description": "The steps that ran, in order; on failure, those before the failing one."
                },
                "saved": { "type": "boolean" },
                "document": { "$ref": "#/$defs/document" }
            }),
            &[],
        ),
        Action::DraftReady | Action::DraftReopen => object(
            json!({
                "path": { "type": "string" },
                "state": { "type": "string", "enum": ["open", "ready"] }
            }),
            &[],
        ),
        Action::Query => object(
            json!({
                "objects": { "type": "array", "items": { "type": "object", "description": "An object as `{ id, type, fields }` read with the fields asked for." } },
                "total": { "type": "integer" },
                "truncated": { "type": "boolean", "description": "More objects matched than `limit`." },
                "schema": { "description": "With `describe`: the object types as JSON Schema." },
                "describe": { "description": "With `describe`: what the kit's `model.describe` answered." }
            }),
            &[],
        ),
        Action::Batch => object(
            json!({
                "results": { "type": "array", "description": "One result per operation (KitObjectModel 1.0 `model/batch`)." },
                "loaded": { "type": "array", "description": "The objects `load` asked for." },
                "saved": { "type": "boolean" },
                "document": { "$ref": "#/$defs/document" }
            }),
            &[],
        ),
        Action::Check => object(
            json!({
                "diagnostics": { "type": "array", "items": { "$ref": "#/$defs/diagnostic" }, "description": "Errors first." }
            }),
            &["diagnostics"],
        ),
        Action::Export => object(
            json!({
                "files": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "The new file's workspace path." },
                            "version": { "type": "string", "description": "The SHA-256 of the file written." },
                            "created": { "type": "boolean" }
                        },
                        "required": ["path", "version", "created"]
                    },
                    "description": "The files written (KHP A30)."
                },
                "format": { "type": "string" },
                "bytes": { "type": "integer", "minimum": 0 }
            }),
            &["files"],
        ),
        Action::Create => object(
            json!({
                "files": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "path": { "type": "string", "description": "The new file's workspace path." }, "created": { "type": "boolean" } },
                        "required": ["path", "created"]
                    },
                    "description": "The files written (KHP A30)."
                },
                "document": { "$ref": "#/$defs/document" }
            }),
            &["files"],
        ),
    }
}

/// The MCP `outputSchema` of the kit tool `name` (`<prefix>_<action>` or a unified
/// `kit_<action>`): what a call answers as structured content, self-contained with its `$defs`.
/// It accepts the success result and, beside it, a failure's (`error`, with what was done), as
/// KHP A18 asks; `None` for a name that is no kit tool.
pub fn tool_output_schema(name: &str) -> Option<Value> {
    let action = Action::ALL.into_iter().find(|action| name.strip_suffix(action.suffix()).is_some_and(|rest| rest.ends_with('_')))?;
    let failed = json!({ "type": "object", "properties": { "error": { "$ref": "#/$defs/error" } }, "required": ["error"] });
    Some(json!({
        "type": "object",
        "anyOf": [output_schema(action), failed],
        "$defs": {
            "error": error_schema(),
            "document": document_schema(),
            "diagnostic": diagnostic_schema(),
        }
    }))
}

/// Every kit tool's arguments and results, by tool name with `<prefix>` for the kit's prefix.
pub fn tool_schemas() -> Value {
    let specs = specs_described(&GENERIC, None);
    let mut tools = serde_json::Map::new();
    for (action, spec) in Action::ALL.into_iter().zip(specs) {
        tools.insert(
            spec.name.clone(),
            json!({
                "description": spec.description,
                "writes": spec.writes,
                "input": spec.input_schema,
                "output": output_schema(action),
            }),
        );
    }
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Kition kit tools (KHP agent tools, `<prefix>_*`)",
        "description": "The arguments (`input`) and structured results (`output`) of every kit tool, as kition-kits-mcp and Kition's agent offer them, generated from crates/kition-kits (`kition-kits-mcp --schemas`). `<prefix>` is the kit's `kit.json` agent prefix. A failed call answers `isError: true` and `error` in its structured content, beside what it had done. `<prefix>_query` and `<prefix>_batch` arguments name the kit's object types and fields once the server has seen its `model.describe`.",
        "tools": tools,
        "$defs": {
            "error": error_schema(),
            "document": document_schema(),
            "diagnostic": diagnostic_schema(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where the schemas are published, from the repository's root.
    const PUBLISHED: &str = "contracts/kit/mcp-tools.schema.json";

    #[test]
    fn the_published_schemas_match_the_tools() {
        let path = format!("{}/../../{PUBLISHED}", env!("CARGO_MANIFEST_DIR"));
        let published: Value = std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null);
        assert_eq!(published, tool_schemas(), "{PUBLISHED} is out of date: run `kition-kits-mcp --schemas > {PUBLISHED}`");
    }

    #[test]
    fn every_tool_is_described_and_merge_is_not_a_tool() {
        let schemas = tool_schemas();
        let names: Vec<&String> = schemas["tools"].as_object().map(|tools| tools.keys().collect()).unwrap_or_default();
        assert_eq!(names.len(), Action::ALL.len());
        assert!(names.iter().all(|name| name.starts_with("<prefix>_")));
        assert!(!names.iter().any(|name| name.contains("merge") || name.contains("discard")));
        for tool in schemas["tools"].as_object().into_iter().flatten().map(|(_, tool)| tool) {
            assert_eq!(tool["input"]["properties"]["path"]["type"], "string");
            assert_eq!(tool["output"]["type"], "object");
        }
    }

    #[test]
    fn every_tool_lists_an_output_schema_that_takes_its_result_or_a_failure() {
        for action in Action::ALL {
            for name in [format!("vector_{}", action.suffix()), format!("kit_{}", action.suffix())] {
                let schema = tool_output_schema(&name).unwrap_or_else(|| panic!("{name} has no output schema"));
                assert_eq!(schema["type"], "object", "MCP output schemas are objects");
                let validator = jsonschema::validator_for(&schema).unwrap_or_else(|err| panic!("{name}: {err}"));
                let failed = json!({ "error": { "code": "unsupported", "message": "no" } });
                assert!(validator.is_valid(&failed), "{name} takes a failure");
            }
        }
        let check = tool_output_schema("vector_check").unwrap_or_default();
        let validator = jsonschema::validator_for(&check).unwrap_or_else(|err| panic!("{err}"));
        assert!(validator.is_valid(&json!({ "diagnostics": [] })));
        assert!(!validator.is_valid(&json!({})), "a check answers diagnostics or an error");
        assert!(tool_output_schema("vector_merge").is_none());
        assert!(tool_output_schema("inspect").is_none());
    }
}
