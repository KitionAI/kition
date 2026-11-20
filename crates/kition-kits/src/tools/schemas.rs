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
    views: &[],
    creates: &[],
    base_name: "Untitled <kit>",
    exports: &[],
    executable: None,
    protocol: None,
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
        parts: None,
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

/// A position in a change set: where a list or tree holds an object.
fn position_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "parent": { "type": ["string", "integer"], "description": "The object whose list or tree holds it (in a tree, the parent node's object, or the tree's owner for a root node); a number for a kit whose tool ids are whole numbers." },
            "field": { "type": "string" },
            "index": { "type": "integer", "minimum": 0, "description": "Among its siblings, counted from 0." }
        },
        "required": ["parent", "field", "index"]
    })
}

/// What a write changed (KDM `Replica::changes_since`), by the ids the tools use.
fn changes_schema() -> Value {
    let place = json!({ "anyOf": [position_schema(), { "type": "null" }] });
    let counts = json!({ "type": "integer", "minimum": 0 });
    let id =
        json!({ "type": ["string", "integer"], "description": "A tool id; a whole number for a kit whose tool ids are numbers (as its commands take them)." });
    json!({
        "type": ["object", "null"],
        "description": "What the call changed, objects named by the ids the inspect and query tools use (tool ids where the kit declares them), each list ordered by id. A value is given as it is, except a text over 80 characters (`{ excerpt, length }`) and a blob after value (`{ size }`); blob before values keep `{ hash, mime, size, name? }`. A list or tree field's change is told by `moved`, `created` and `deleted`. `null` when the kit cannot say (`changesUnavailable` says why); left out with `changes: false`.",
        "properties": {
            "created": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": id.clone(),
                        "type": { "type": "string" },
                        "fields": { "type": "array", "items": { "type": "string" }, "description": "The fields holding a value." },
                        "values": { "type": "object", "description": "Each of them but list and tree fields, by name." },
                        "at": position_schema()
                    },
                    "required": ["id", "type", "fields"]
                }
            },
            "changed": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": id.clone(),
                        "type": { "type": "string" },
                        "fields": { "type": "array", "items": { "type": "string" }, "description": "The fields that changed." },
                        "edits": {
                            "type": "array",
                            "items": { "type": "object", "properties": { "field": { "type": "string" }, "before": {}, "after": {} }, "required": ["field"] },
                            "description": "Each changed field but list and tree fields. Before and after values are optional when unavailable or intentionally omitted, including large derived values; an omitted value is not null."
                        }
                    },
                    "required": ["id", "type", "fields"]
                }
            },
            "moved": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": { "id": id.clone(), "type": { "type": "string" }, "from": place.clone(), "to": place },
                    "required": ["id", "type", "from", "to"]
                },
                "description": "Objects whose place in a list or tree changed (also in `changed` when their fields did)."
            },
            "deleted": {
                "type": "array",
                "items": { "type": "object", "properties": { "id": id.clone(), "type": { "type": "string" }, "fields": { "type": "array" }, "at": position_schema() }, "required": ["id", "type"] },
                "description": "Objects removed, each with `at`, where a list or tree held it before."
            },
            "footprint": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "parent": { "type": ["string", "integer"] },
                        "field": { "type": "string" },
                        "from": { "type": "integer", "minimum": 0, "description": "The first object's index in the list, after the change." },
                        "count": { "type": "integer", "minimum": 1 },
                        "shift": {
                            "type": "object",
                            "properties": { "field": { "type": "string" }, "by": { "type": ["number", "string"], "description": "after - before; a string for whole numbers written as strings." } }
                        },
                        "ids": { "type": "array", "items": id.clone(), "description": "Objects stated by their ids: each had only `edits` changed, each field by its `by`." },
                        "edits": {
                            "type": "array",
                            "items": { "type": "object", "properties": { "field": { "type": "string" }, "by": { "type": ["number", "string"] } }, "required": ["field", "by"] }
                        }
                    }
                },
                "description": "A shift of many objects stated once: the `count` objects of `parent`'s list `field` from index `from` (as the list is after the change) had only `shift.field` changed, each by `shift.by`; or the objects `ids` had only `edits` changed, each field by its `by`. They are in no other list. Pass `changes: \"all\"` to have each listed."
            },
            "truncated": {
                "type": "object",
                "properties": { "created": counts.clone(), "changed": counts.clone(), "moved": counts.clone(), "deleted": counts },
                "description": "The lists were cut to 50 objects in all: how many of each were left out. Pass `changes: \"all\"` for every one."
            }
        }
    })
}

/// The receipt every accepted write answers beside its own result.
fn receipt_properties(properties: &mut Value) {
    properties["changes"] = changes_schema();
    properties["changesUnavailable"] = json!({ "type": "string", "description": "Why `changes` is null: the kit has no object model, the document was replaced while the call ran, or the file is open in its editor." });
    revision_properties(properties);
    properties["diagnostics"] = json!({
        "type": "object",
        "description": "The kit's check before and after the call, matched by `code` and `target`: what the call introduced and what it resolved. Left out with `check: false` or when the kit does not check documents.",
        "properties": {
            "new": { "type": "array", "items": { "$ref": "#/$defs/diagnostic" } },
            "resolved": { "type": "array", "items": { "$ref": "#/$defs/diagnostic" } }
        },
        "required": ["new", "resolved"]
    });
}

/// What others changed since a call's `basis`: a change set as a receipt's, merged over the
/// journal's entries by other authors, with who they were.
fn others_schema() -> Value {
    let mut others = changes_schema();
    others["type"] = json!("object");
    others["description"] = json!(
        "What others changed since the call's `basis` (other agents, edits to the file made outside this server), merged into one change set by the ids the tools use, at most 50 objects with `truncated`; left out when nothing."
    );
    others["properties"]["by"] = json!({ "type": "array", "items": { "type": "string" }, "description": "Who: each other agent's name on this server, `outside` for edits to the file." });
    others["properties"]["unknown"] = json!({ "type": "boolean", "description": "Some of it cannot be told object by object (a kit without an object model, a document read again with unsaved edits)." });
    others["properties"]["unnamed"] = json!({
        "type": "object",
        "additionalProperties": { "type": "object", "additionalProperties": { "type": "integer", "minimum": 1 } },
        "description": "Changes, made in the file by another program, of objects no tool id names (a layout, shared media), counted by type and list: `{ \"Media\": { \"changed\": 1 } }`."
    });
    others["properties"]["renumbered"] = json!({
        "type": "string",
        "description": "One line naming the ids another program renumbered in the file: each may now name another object, and what changed in them is not known. A write on one is refused (`unknown`) until an inspect gives the ids as they are now."
    });
    others
}

/// The revision chain's members every call on a document's contents may answer.
fn revision_properties(properties: &mut Value) {
    properties["revision"] = json!({ "type": "string", "maxLength": 12, "description": "The document's state this answer describes, a short opaque token: pass it as `basis` to your next call on the file. Left out of a write of a kit without an object model." });
    properties["others"] = others_schema();
    properties["guardUnavailable"] = json!({ "type": "string", "description": "The call gave `basis`, but the file is open in its editor, where this server does not journal changes: why nothing was checked." });
    properties["conflicts"] = json!({
        "type": "array",
        "description": "With `error.code` `conflict`: what others changed of what the write acts on. Nothing ran.",
        "items": {
            "type": "object",
            "properties": {
                "id": { "type": ["string", "integer"], "description": "The object or part (`slide:3`; a whole number for a kit whose tool ids are numbers); absent when the whole document is concerned." },
                "reason": { "type": "string", "enum": ["deleted", "relocated", "changed", "unknown"], "description": "`deleted`; `relocated` (moved, its index, position fields or part number shifted, or for a step that names its objects by a place, under that place now or there at `basis` and moved by others); `changed` (a field the write replaces, any field of a command's target, or another agent's step at the top of the agents' undo history); `unknown` (inspect again)." },
                "now": { "type": "object", "description": "Where it is now: `{ parent, field, index }` (and `spelled`, its place in the command's index spelling, `\"#2\"`, for a step that named it so) and the fields its kit marks as its position (`start`; one named `parent`, `field` or `index` in `fields`), or a part as `{ \"slide\": n }`." },
                "place": { "type": "object", "description": "For a step that names what it acts on by a place: that place as the step named it (`time`, `part`, the place parameters) and `under`, the objects it names now (`unknown` when the kit cannot say)." }
            },
            "required": ["reason"]
        }
    });
}

/// What a preview drawn by the kit's own render command shows (KHP A39): its answer without the
/// image.
fn preview_schema() -> Value {
    json!({
        "type": "object",
        "description": "What the attached preview shows, as the kit's render command (`agent.render`) answered it beside the image: `width`, `height` and `scale`, and the kit's own members, for a timeline `sequence`, `frames` ([{time, frame, label}], the times the picture shows), `columns` and `rows`. Only for kits with a render command.",
        "properties": {
            "width": { "type": "integer" },
            "height": { "type": "integer" },
            "scale": { "type": "number" },
            "mimeType": { "type": "string" },
            "frames": {
                "type": "array",
                "items": { "type": "object", "properties": { "time": { "type": "number" }, "frame": { "type": "integer" }, "label": { "type": "string" } } }
            }
        }
    })
}

fn with_revision(mut properties: Value) -> Value {
    revision_properties(&mut properties);
    properties
}

fn with_receipt(mut properties: Value) -> Value {
    receipt_properties(&mut properties);
    properties
}

/// What a successful call of `action` answers as structured content (failures add `error`).
pub fn output_schema(action: Action) -> Value {
    match action {
        Action::Inspect => {
            let mut schema = document_schema();
            schema["properties"]["document"] = json!({ "$ref": "#/$defs/document", "description": "The document, when its open editor answered." });
            schema["properties"]["preview"] = preview_schema();
            revision_properties(&mut schema["properties"]);
            schema["properties"]["interface"] = json!({ "type": "string", "description": "The protocol, the kit and its version the tools speak for this file (`khp/1 kit.slide@1.4.0`); the MCP server's `serverInfo.version` is the kit's." });
            schema["properties"]["changedOutside"] = json!({ "type": "object", "description": "Without `basis`: the file changed outside your calls since your last one (`path`, `was`, `now`); the next write is refused once." });
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
            with_receipt(json!({
                "completed": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "command": { "type": "string" }, "changed": { "type": "boolean" }, "result": {}, "truncated": { "type": "object", "description": "The result was cut to fit: `shown` of `total` items (of `field` when the result is an object)." } },
                        "required": ["command"]
                    },
                    "description": "The steps that ran, in order. On failure it is empty: a run is atomic (KHP A53), and the steps before the failing one are in `rolledBack`; only when they could not be rolled back are they here. `changed` is there only when false (the step changed nothing), `result` only when the command answered one."
                },
                "rolledBack": {
                    "type": "array",
                    "items": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] },
                    "description": "On failure: the steps that ran before the failing one and were undone, so the document is as it was before the call and nothing was saved (KHP A53)."
                },
                "saved": { "type": "boolean" },
                "closed": { "type": "boolean", "description": "A successful terminal close; no document view, save, restore or preview follows it." },
                "notRun": { "type": "integer", "minimum": 0, "description": "Remaining steps after a terminal close." },
                "document": { "$ref": "#/$defs/document" },
                "preview": preview_schema(),
                "previewError": { "$ref": "#/$defs/error", "description": "The preview could not be drawn; the run went as `completed` says." }
            })),
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
            with_revision(json!({
                "objects": { "type": "array", "items": { "type": "object", "description": "An object as `{ id, type, fields }` read with the fields asked for." } },
                "total": { "type": "integer" },
                "truncated": { "type": "boolean", "description": "More objects matched than `limit`." },
                "schema": { "description": "With `describe`: the object types as JSON Schema." },
                "describe": { "description": "With `describe`: what the kit's `model.describe` answered." }
            })),
            &[],
        ),
        Action::Batch => object(
            with_receipt(json!({
                "results": { "type": "array", "description": "One result per operation (KitObjectModel 1.0 `model/batch`)." },
                "loaded": { "type": "array", "description": "The objects `load` asked for." },
                "saved": { "type": "boolean" },
                "document": { "$ref": "#/$defs/document" }
            })),
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
        for tool in ["vector_run", "vector_batch"] {
            let schema = tool_output_schema(tool).unwrap_or_default();
            let validator = jsonschema::validator_for(&schema).unwrap_or_else(|err| panic!("{err}"));
            let receipt = json!({
                "changes": {
                    "created": [{ "id": "frame:3", "type": "Frame", "fields": ["name"], "values": { "name": "Three" }, "at": { "parent": "doc", "field": "frames", "index": 2 } }],
                    "changed": [{ "id": "doc", "type": "Doc", "fields": ["frames"], "edits": [] }],
                    "moved": [{ "id": "frame:1", "type": "Frame", "from": { "parent": "doc", "field": "frames", "index": 0 }, "to": null }],
                    "deleted": [{ "id": "frame:2", "type": "Frame", "fields": [] }],
                    "truncated": { "created": 0, "changed": 0, "moved": 0, "deleted": 3 }
                },
                "revision": "AAE=",
                "diagnostics": { "new": [{ "code": "k.todo", "severity": "warning", "target": {}, "message": "a" }], "resolved": [] }
            });
            assert!(validator.is_valid(&receipt), "{tool} takes a receipt");
            assert!(validator.is_valid(&json!({ "changes": null, "changesUnavailable": "no object model" })), "{tool} takes no change set");
            assert!(!validator.is_valid(&json!({ "changes": { "moved": [{ "id": "x" }] } })), "{tool}: a move says from and to");
        }
        assert!(tool_output_schema("vector_merge").is_none());
        assert!(tool_output_schema("inspect").is_none());
    }
}
