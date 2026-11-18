// Copied from kition-sdk crates/kition-kits/src/tools/model.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The object-model tools (architecture section 13): `<prefix>_query` reads objects by id or by a
//! field path from the root, and `<prefix>_batch` runs a `model/batch` (KitObjectModel 1.0,
//! kition-sdk `docs/platform/reference/object-model.md`). Their argument schemas are generated from what the kit's
//! `model.describe` answers, once Kition has seen it; before that they take any type and field.
//!
//! Both go where the other kit tools go: to the open kit editor through the Kit AI bridge (its
//! `model/describe` and `model/batch`, Kit UI protocol section 7a), or to the kit's headless
//! executable (`model.describe`, `model.batch`). Both honour draft mode and read-only documents.

use serde_json::{Map, Value, json};

use super::errors::{ErrorCode, KitToolError};
use super::receipts::Source;
use super::{
    Action, BASIS, DraftAt, KitToolOutput, KitToolResult, KitToolSpec, basis_property, draft_at, draft_property, kit_path, live, path_property,
    reads_headless_draft, short, tool_name,
};
use crate::bridge::LiveDocument;
use crate::drafts;
use crate::manager::{Caller, DocumentView, KitDefinition, KitManager};

/// How many objects one `<prefix>_query` answers at most.
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;
/// How long the type listing in a tool description may grow.
const DESCRIPTION_TYPES: usize = 1600;

/// The operations of a batch, as `kition_kdm::batch` takes them.
pub const OPS: [&str; 16] = [
    "create",
    "set",
    "delete",
    "text.insert",
    "text.delete",
    "text.set",
    "text.mark",
    "text.unmark",
    "list.insert",
    "list.move",
    "list.remove",
    "map.set",
    "map.delete",
    "tree.insert",
    "tree.move",
    "command",
];

/// What every batch the agent sends records (standard A11): the agent, for the person who runs
/// it (the principal, `local`, stays the person: the edit is attributed to them), labelled with
/// the agent's own name on this server (its connection's principal). The renderer names the
/// person when it knows them. Every batch on the agent's connection sends it, reads included: a
/// kit process refuses one without it there (Kit Process Protocol, section 1).
pub(super) fn agent_origin() -> Value {
    json!({ "kind": "agent", "principal": "local", "label": super::current_agent().unwrap_or_else(|| "Agent".to_owned()) })
}

/// The kit's types, the root type first and the others by name, so the tools read the same
/// whatever order the JSON map keeps.
fn ordered_types(described: &Value) -> Vec<(&String, &Value)> {
    let Some(types) = described.get("types").and_then(Value::as_object) else {
        return Vec::new();
    };
    let root = described["root"].as_str().unwrap_or_default();
    let mut ordered: Vec<(&String, &Value)> = types.iter().collect();
    ordered.sort_by(|(a, _), (b, _)| (a.as_str() != root, a.as_str()).cmp(&(b.as_str() != root, b.as_str())));
    ordered
}

/// The type names (the root first) and every field name the kit's schema has, sorted.
fn names(described: &Value) -> (Vec<String>, Vec<String>) {
    let types = ordered_types(described);
    let mut fields: Vec<String> =
        types.iter().filter_map(|(_, ty)| ty.get("fields").and_then(Value::as_object)).flat_map(|fields| fields.keys().cloned()).collect();
    fields.sort_unstable();
    fields.dedup();
    (types.iter().map(|(name, _)| (*name).clone()).collect(), fields)
}

/// Whether the kit's schema names its objects by tool ids (KitObjectModel OM9): a type declares
/// `toolId`.
pub fn declares_tool_ids(described: &Value) -> bool {
    described.get("types").and_then(Value::as_object).is_some_and(|types| types.values().any(|ty| ty.get("toolId").is_some_and(Value::is_object)))
}

/// How a type's objects are named (KitObjectModel OM9): `frame:<number>`, after the parent's id
/// (`<Frame id>/cell:<number>`) when the type names one; `None` for a type without `toolId`.
fn id_form(ty: &Value) -> Option<String> {
    let tool = ty.get("toolId").filter(|tool| tool.is_object())?;
    let own = format!("{}<{}>", tool["prefix"].as_str().unwrap_or_default(), tool["field"].as_str().unwrap_or("id"));
    Some(match tool["parent"].as_str() {
        Some(parent) => format!("<{parent} id>/{own}"),
        None => own,
    })
}

/// How many of an enum's values a type listing shows before it counts them.
const LISTED_VALUES: usize = 8;

/// The types as one line each (`describe: true`, and a tool description when `limit` is given):
/// `Slide { shapes: list of Shape, notes: text (text.* ops, not set), layout: ref to Layout, … }`.
/// Fields a batch cannot `set` say so: read-only ones (OM8), and text written with text ops. Where
/// the kit names objects by tool ids (OM9), each type says how its ids read: `(ids frame:<number>)`,
/// or `(object ids)`.
fn type_listing(described: &Value, limit: Option<usize>) -> String {
    let root = described["root"].as_str().unwrap_or_default();
    let tool_ids = declares_tool_ids(described);
    let mut out = String::new();
    for (name, ty) in ordered_types(described) {
        let fields: Vec<String> = ty
            .get("fields")
            .and_then(Value::as_object)
            .map(|fields| fields.iter().map(|(field, def)| format!("{field}: {}", field_line(def))).collect())
            .unwrap_or_default();
        let mut marker = String::new();
        if name == root {
            marker.push_str(" (root)");
        }
        if ty["readOnly"] == true {
            marker.push_str(" (read-only)");
        } else if let Some(when) = read_only_when(ty) {
            marker.push_str(&format!(" (read-only when {} is {})", when.0, when.1.join(" or ")));
        }
        match id_form(ty) {
            Some(form) => marker.push_str(&format!(" (ids {form})")),
            None if tool_ids => marker.push_str(" (object ids)"),
            None => {}
        }
        let line = format!("{name}{marker} {{ {} }}; ", fields.join(", "));
        if limit.is_some_and(|limit| out.len() + line.len() > limit) {
            out.push('…');
            break;
        }
        out.push_str(&line);
    }
    out.trim_end().to_owned()
}

/// A field of the kit's schema in a type listing: its kind, what it names, and how it is written.
fn field_line(def: &Value) -> String {
    let kind = def["kind"].as_str().unwrap_or("json");
    let mut line = match (kind, def["of"].as_str()) {
        ("ref", Some(of)) => format!("ref to {of}"),
        ("text", _) => "text (text.* ops, not set)".to_owned(),
        ("enum", _) => {
            let values: Vec<&str> = def["values"].as_array().map(|values| values.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            if values.len() > LISTED_VALUES {
                format!("enum {}|… ({} values)", values[..LISTED_VALUES].join("|"), values.len())
            } else {
                format!("enum {}", values.join("|"))
            }
        }
        (kind, Some(of)) => format!("{kind} of {of}"),
        (kind, None) => kind.to_owned(),
    };
    if def["readOnly"] == true {
        line.push_str(", read-only");
    }
    line
}

/// A type's `readOnlyWhen` (OM8): its enum field and the values that make an object read-only.
fn read_only_when(ty: &Value) -> Option<(&str, Vec<&str>)> {
    let when = ty.get("readOnlyWhen")?;
    let values = when["values"].as_array()?.iter().filter_map(Value::as_str).collect();
    Some((when["field"].as_str()?, values))
}

/// The batch operations that change a container field (`x-kdm-ops`); a register has none and is
/// written with `set`.
fn container_ops(def: &Value) -> Option<Vec<&'static str>> {
    match def["kind"].as_str()? {
        "text" if def.get("marks").is_some() => Some(vec!["text.insert", "text.delete", "text.set", "text.mark", "text.unmark"]),
        "text" => Some(vec!["text.insert", "text.delete", "text.set"]),
        "list" => Some(vec!["list.insert", "list.move", "list.remove"]),
        "tree" => Some(vec!["tree.insert", "tree.move"]),
        "map" => Some(vec!["map.set", "map.delete"]),
        _ => None,
    }
}

/// A field of the kit's schema as JSON Schema, in its standard vocabulary (`type`, `enum`,
/// `readOnly`) and two annotations of the object model (`docs/platform/sets/object-model.md`
/// OM1a): `x-kdm-ref`, the type of the object whose id a string holds, and `x-kdm-ops`, the batch
/// operations that change a container field, which `set` does not take.
fn field_schema(def: &Value) -> Value {
    let of = def["of"].as_str().unwrap_or("object");
    let mut schema = match def["kind"].as_str().unwrap_or("json") {
        "string" => json!({ "type": "string" }),
        "number" => json!({ "type": "number" }),
        "integer" => json!({ "type": "integer" }),
        "boolean" => json!({ "type": "boolean" }),
        "enum" => json!({ "type": "string", "enum": def["values"].clone() }),
        "blob" => json!({
            "type": "object",
            "properties": { "hash": { "type": "string" }, "mime": { "type": "string" }, "size": { "type": "integer" } },
        }),
        "ref" => json!({
            "type": "string",
            "x-kdm-ref": of,
            "description": format!("The id of a `{of}`: another object of the document, which must exist."),
        }),
        "text" if def.get("marks").is_some() => json!({
            "description": "Text, read as runs `{ insert, attributes? }`: change it with text.insert, text.delete, text.set, text.mark or text.unmark, not with `set`.",
        }),
        "text" => json!({
            "type": "string",
            "description": "Text: change it with text.insert, text.delete or text.set, not with `set`.",
        }),
        "list" => json!({
            "type": "array",
            "items": { "type": "string", "x-kdm-ref": of },
            "description": format!("Ids of {of} objects, in order (edit with list.* ops)."),
        }),
        "tree" => json!({
            "type": "array",
            "items": { "type": "object", "properties": { "object": { "type": "string", "x-kdm-ref": of }, "parent": { "type": ["string", "null"], "x-kdm-ref": of } } },
            "description": format!("{of} objects as a tree, in pre-order (edit with tree.* ops)."),
        }),
        "map" => {
            json!({ "type": "object", "description": "String keys to values (edit with map.* ops)." })
        }
        _ => json!({}),
    };
    for keyword in ["minimum", "maximum", "multipleOf"] {
        if let Some(value) = def.get(keyword).filter(|value| value.is_number()) {
            schema[keyword] = value.clone();
        }
    }
    if matches!(def["kind"].as_str(), Some("json" | "map"))
        && let Some(members) = def["members"].as_object().filter(|members| !members.is_empty())
    {
        for (path, limits) in members {
            member_schema(&mut schema, path, limits);
        }
    }
    if let Some(ops) = container_ops(def) {
        schema["x-kdm-ops"] = json!(ops);
    }
    if def["readOnly"] == true {
        schema["readOnly"] = Value::Bool(true);
        append(&mut schema, "Read-only: the kit keeps it, and a batch that writes it fails with `read-only`.");
    }
    if def["optional"] == true {
        append(&mut schema, "Optional.");
    }
    schema
}

fn member_schema(schema: &mut Value, path: &str, limits: &Value) {
    if path.is_empty() {
        schema["type"] = if limits["nullable"] == true { json!(["number", "array", "object", "null"]) } else { json!(["number", "array", "object"]) };
        for keyword in ["minimum", "maximum", "multipleOf"] {
            if let Some(value) = limits.get(keyword) {
                schema[keyword] = value.clone();
            }
        }
        return;
    }
    let end = path.find(['.', '[']).unwrap_or(path.len());
    if end > 0 {
        if &path[..end] == "*" {
            if schema.get("additionalProperties").is_none() {
                schema["additionalProperties"] = json!({});
            }
            member_schema(&mut schema["additionalProperties"], &path[end..], limits);
            return;
        }
        if schema.get("properties").is_none() {
            schema["properties"] = json!({});
        }
        let child = &mut schema["properties"][&path[..end]];
        if child.is_null() {
            *child = json!({});
        }
        member_schema(child, &path[end..], limits);
    } else if let Some(rest) = path.strip_prefix("[]") {
        if schema.get("items").is_none() {
            schema["items"] = json!({});
        }
        member_schema(&mut schema["items"], rest, limits);
    } else if let Some(rest) = path.strip_prefix('.') {
        member_schema(schema, rest, limits);
    }
}

/// Adds a sentence to a schema's `description`.
fn append(schema: &mut Value, sentence: &str) {
    let description = match schema["description"].as_str() {
        Some(text) if !text.is_empty() => format!("{text} {sentence}"),
        _ => sentence.to_owned(),
    };
    schema["description"] = json!(description);
}

/// The kit's schema (`model.describe`) as JSON Schema: one definition per type, with its fields,
/// marked as `field_schema` says; a read-only type is `readOnly`, and one read-only by an enum's
/// value (`readOnlyWhen`, OM8) says so in its description.
pub fn describe_schema(described: &Value) -> Value {
    let types = described.get("types").and_then(Value::as_object).cloned().unwrap_or_default();
    let tool_ids = declares_tool_ids(described);
    let defs: Map<String, Value> = types
        .iter()
        .map(|(name, ty)| {
            let properties: Map<String, Value> = ty
                .get("fields")
                .and_then(Value::as_object)
                .map(|fields| fields.iter().map(|(field, def)| (field.clone(), field_schema(def))).collect())
                .unwrap_or_default();
            let mut schema = json!({ "type": "object", "properties": properties, "additionalProperties": false });
            if ty["readOnly"] == true {
                schema["readOnly"] = Value::Bool(true);
                append(&mut schema, "Read-only: only the kit makes and changes these objects; a batch that writes one fails with `read-only`.");
            } else if let Some((field, values)) = read_only_when(ty) {
                let values: Vec<String> = values.iter().map(|value| format!("`{value}`")).collect();
                append(&mut schema, &format!("Read-only when `{field}` is {}: only the kit changes such an object.", values.join(" or ")));
            }
            // How the type's objects are named (OM9): `x-kdm-id` is the type's `toolId`.
            match id_form(ty) {
                Some(form) => {
                    schema["x-kdm-id"] = ty["toolId"].clone();
                    append(
                        &mut schema,
                        &format!("Its id is `{form}`, as the kit's other tools write it; an object the kit has not numbered yet answers its object id."),
                    );
                }
                None if tool_ids => append(&mut schema, "Its id is its object id."),
                None => {}
            }
            (name.clone(), schema)
        })
        .collect();
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "description": format!("The object types of {} documents, from model.describe.", described["kit"].as_str().unwrap_or("this kit's")),
        "$defs": defs,
    })
}

fn string_list(description: &str, values: &[String]) -> Value {
    let mut items = json!({ "type": "string" });
    if !values.is_empty() {
        items["enum"] = json!(values);
    }
    json!({ "type": "array", "items": items, "description": description })
}

/// `<prefix>_query`, with argument enums from the kit's schema when it is known.
pub fn query_spec(kit: &'static KitDefinition, described: Option<&Value>) -> KitToolSpec {
    let (name, noun) = (kit.name, kit.agent.noun);
    let (_, fields) = described.map(names).unwrap_or_default();
    let listing = described.map(|described| type_listing(described, Some(DESCRIPTION_TYPES))).unwrap_or_default();
    let types = if listing.is_empty() {
        "Call it with `describe: true` first to learn the document's object types and fields.".to_owned()
    } else {
        format!("Types: {listing}")
    };
    KitToolSpec {
        name: tool_name(kit, Action::Query),
        description: format!(
            "Read a {noun}'s objects in {name} from its object model: by id (`objects`, `root` for the document itself), or by following fields from the root (`follow`, for example `slides` or `slides.0.shapes`). Answers each object's id, type, and fields (all, or those in `fields`). Use the ids with {}. Low level: to find what to edit, the inspect tool with a `target` is usually enough. {types}",
            tool_name(kit, Action::Batch)
        ),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": path_property(kit),
                "objects": { "type": "array", "items": { "type": ["string", "integer"] }, "description": "Object ids to read (an integer tool id as the number the answers show, or its digits); `root` is the document's root object. Defaults to the root." },
                "follow": { "type": "string", "description": "A field path from the first object (the root by default): field names, and list or tree positions, joined with dots. Reads the objects it ends at." },
                "fields": string_list("Only these fields of each object. Defaults to all.", &fields),
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "description": format!("At most this many objects. Defaults to {DEFAULT_LIMIT}.") },
                "describe": { "type": ["boolean", "string"], "description": "true: also answer the kit's object types and their fields, one line each; a type name or a comma-separated list: those types in full; \"*\": every type in full and their JSON Schema." },
                "basis": basis_property(),
                "draft": draft_property()
            },
            "required": ["path"]
        }),
        writes: false,
    }
}

/// `<prefix>_batch`, with argument enums from the kit's schema when it is known.
pub fn batch_spec(kit: &'static KitDefinition, described: Option<&Value>) -> KitToolSpec {
    let (name, noun) = (kit.name, kit.agent.noun);
    let (types, fields) = described.map(names).unwrap_or_default();
    let mut type_property = json!({ "type": "string", "description": "`create`: the new object's type." });
    if !types.is_empty() {
        type_property["enum"] = json!(types);
    }
    let mut field_property = json!({ "type": "string", "description": "The field an op edits." });
    if !fields.is_empty() {
        field_property["enum"] = json!(fields);
    }
    KitToolSpec {
        name: tool_name(kit, Action::Batch),
        description: format!(
            "Edit a {noun} in {name} through its object model: one model/batch of `ops`, run in order as one undoable step (nothing changes when an op fails: a `command` op among other ops is taken back when a later op fails, and refused before anything runs where only undo could take it back, a file open in its editor or with unsaved edits; run commands with {} then), then `load` reads objects back. Ops: create {{type, fields?, ref?: \"$name\", in?: \"<target>.<field>\", at?, parent?}}, set {{target, field, value}}, delete {{target}}, text.insert {{target, field, index, text}}, text.delete {{target, field, index, count}}, text.set {{target, field, text}}, text.mark/text.unmark {{target, field, start, end, key, value?}}, list.insert {{target, field, item, index?}}, list.move {{target, field, from, to}}, list.remove {{target, field, index}}, map.set/map.delete {{target, field, key, value?}}, tree.insert/tree.move {{target, field, item, parent?}}, command {{id, params?}}. A target is `root`, an object id from {}, or a `$name` bound by an earlier create. Saves the file unless `save` is false; with `draft`, edits your draft instead (never saved). Failures answer `error.code` and the op's `index`. {} {BASIS} Low level: `text.set` here replaces the text together with its formatting, and created objects get default styles; for ordinary edits prefer the kit's commands (its commands and run tools), which keep formatting.",
            tool_name(kit, Action::Run),
            tool_name(kit, Action::Query),
            super::receipts::DESCRIBED
        ),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": path_property(kit),
                "ops": {
                    "type": "array",
                    "maxItems": 200,
                    "items": {
                        "type": "object",
                        "properties": {
                            "op": { "type": "string", "enum": OPS },
                            "target": { "type": ["string", "integer"], "description": "`root`, an object id (an integer tool id as a number or its digits), or a `$name`." },
                            "type": type_property,
                            "field": field_property,
                            "value": { "description": "The value to set." },
                            "fields": { "type": "object", "description": "`create`: the new object's fields." },
                            "ref": { "type": "string", "description": "`create`: a `$name` later ops use for the new object." },
                            "in": { "type": "string", "description": "`create`: the list or tree to add it to, as `<target>.<field>`." },
                            "item": { "type": ["string", "integer"] },
                            "id": { "type": "string", "description": "`command`: the command id." },
                            "params": { "type": "object", "description": "`command`: its parameters." }
                        },
                        "required": ["op"]
                    }
                },
                "load": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "target": { "type": ["string", "integer"] },
                            "fields": string_list("Only these fields.", &fields)
                        },
                        "required": ["target"]
                    },
                    "description": "Objects to read after the ops."
                },
                "save": { "type": "boolean", "description": "Save the file after the batch. Defaults to true; a draft is never saved." },
                "changes": super::receipts::input_properties()[0].1.clone(),
                "check": super::receipts::input_properties()[1].1.clone(),
                "basis": basis_property(),
                "draft": draft_property()
            },
            "required": ["path", "ops"]
        }),
        writes: true,
    }
}

/// Where a call's object model is: the open editor (on its draft, or not), the headless kit's
/// draft (`drafts.rs`), or the headless kit's file.
enum Target {
    Live { document: LiveDocument, draft: bool },
    HeadlessDraft(DocumentView),
    Headless(DocumentView),
}

impl Target {
    async fn batch(&self, kits: &KitManager, request: Value) -> Result<Value, KitToolError> {
        match self {
            Self::Live { document, draft } => {
                let mut arguments = request;
                if *draft {
                    arguments["draft"] = Value::Bool(true);
                }
                kits.bridge().call(document, "batch", arguments).await.map_err(KitToolError::from_bridge)
            }
            Self::Headless(view) | Self::HeadlessDraft(view) => {
                // A number is an id of a kit that names objects by its own ids (OM9); for another,
                // it is taken from the inspect tool's `part` (slide and doc).
                let own_ids = numeric_target(&request).is_some() && names_by_tool_ids(kits, view).await;
                let request = if own_ids { request } else { with_refs(kits, view, request).await };
                let numeric = if own_ids { None } else { numeric_target(&request) };
                let params = request.as_object().cloned().unwrap_or_default();
                kits.model(Caller::Agent, view.kit_id, &view.document_id, "model.batch", params).await.map_err(|error| {
                    let mut error = KitToolError::from(error);
                    if let Some(id) = numeric {
                        error.message.push_str(&format!(
                            " (`{id}` looks like an id from the inspect tool's `part`: those are the kit's command ids, \
                             not object-model ids. Edit it with the run tool and a command, for example \
                             text.set {{\"id\": {id}, \"text\": \"...\"}}; find commands with the commands tool.)"
                        ));
                    }
                    error
                })
            }
        }
    }

    async fn describe(&self, kits: &KitManager, kit: &KitDefinition) -> Result<Value, KitToolError> {
        let described = match self {
            Self::Live { document, draft } => kits.bridge().call(document, "describe", json!({ "draft": draft })).await.map_err(KitToolError::from_bridge)?,
            Self::Headless(view) | Self::HeadlessDraft(view) => kits.model(Caller::Agent, view.kit_id, &view.document_id, "model.describe", Map::new()).await?,
        };
        kits.remember_described(kit.id, &described);
        Ok(described)
    }

    fn read_only(&self) -> bool {
        matches!(self, Self::Headless(view) if view.read_only)
    }

    fn label(&self) -> &'static str {
        match self {
            Self::Live { draft: true, .. } | Self::HeadlessDraft(_) => "your draft of",
            Self::Live { .. } => "the open editor of",
            Self::Headless(_) => "",
        }
    }
}

/// Whether the document's kit names objects by tool ids (OM9), from what it last described, or
/// from its `model.describe` when it has not described itself yet.
async fn names_by_tool_ids(kits: &KitManager, view: &DocumentView) -> bool {
    if let Some(described) = kits.described(view.kit_id) {
        return declares_tool_ids(&described);
    }
    match kits.model(Caller::Agent, view.kit_id, &view.document_id, "model.describe", Map::new()).await {
        Ok(described) => {
            kits.remember_described(view.kit_id, &described);
            declares_tool_ids(&described)
        }
        Err(_) => false,
    }
}

/// A kit that serves no object model answers "method not found": say so as `unsupported`.
/// An object id that names nothing: says what object ids are and how to query them. A kit
/// that names objects by its own ids (OM9) needs no such hint: the refusal lists the ids meant.
fn object_hint(kit: &KitDefinition, tool_ids: bool, mut error: KitToolError) -> KitToolError {
    if error.code == ErrorCode::NOT_FOUND && !tool_ids {
        error.message.push_str(&format!(
            ". Object ids are the `id`s {} answers, not command ids such as a layer number: query \
             without `objects` for the root, and pass `follow` (a field name) to reach its children",
            tool_name(kit, Action::Query)
        ));
    }
    error
}

/// An operation refused as `read-only` (a field or an object the kit keeps, OM8): says where such
/// fields are marked and what changes them instead (KHP A48).
fn read_only_hint(kit: &KitDefinition, mut error: KitToolError) -> KitToolError {
    if error.code == ErrorCode::READ_ONLY && error.index.is_some() {
        error.message.push_str(&format!(
            ". Leave it out of the batch: {} with `describe` marks what the kit keeps `readOnly`; if the kit can change it, one of its commands does ({}, then {})",
            tool_name(kit, Action::Query),
            tool_name(kit, Action::Commands),
            tool_name(kit, Action::Run)
        ));
    }
    error
}

fn unsupported(kit: &KitDefinition, error: KitToolError) -> KitToolError {
    let lower = error.message.to_lowercase();
    if lower.contains("not found") && lower.contains("method") || lower.contains("no object model") || lower.contains("does not answer the object model") {
        return KitToolError::new(
            ErrorCode::Unsupported,
            format!(
                "{} does not serve an object model for this file ({}); use {} and {} instead.",
                kit.name,
                error.message,
                tool_name(kit, Action::Commands),
                tool_name(kit, Action::Run)
            ),
        );
    }
    error
}

/// The target of a read: the draft when asked (an explicit `draft: true` needs it), else the
/// open editor, else the headless kit.
async fn read_target(kits: &KitManager, kit: &'static KitDefinition, path: &str, draft: bool, explicit: bool) -> Result<Target, KitToolError> {
    if reads_headless_draft(kits, kit, path, draft, explicit).await {
        let id = drafts::document(kits, kit, path, false).await?;
        return Ok(Target::HeadlessDraft(kits.document(Caller::Agent, kit.id, &id).await?));
    }
    let open = live(kits, kit, path).await;
    if draft && explicit {
        return Ok(match draft_at(kits, kit, path, false).await? {
            DraftAt::Editor(document) => Target::Live { document, draft: true },
            DraftAt::Headless(id) => Target::HeadlessDraft(kits.document(Caller::Agent, kit.id, &id).await?),
        });
    }
    if let Some(document) = open {
        return Ok(Target::Live { document, draft: false });
    }
    Ok(Target::Headless(kits.open(Caller::Agent, path).await?))
}

/// The ids a loaded field names: a list's items, a ref, a tree's objects.
fn ids_of(value: &Value) -> Option<Vec<String>> {
    match value {
        Value::String(id) => Some(vec![id.clone()]),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(id) => Some(id.clone()),
                Value::Object(entry) => entry.get("object").and_then(Value::as_str).map(str::to_owned),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

async fn load(kits: &KitManager, target: &Target, entries: Vec<Value>) -> Result<Vec<Value>, KitToolError> {
    let answer = target.batch(kits, json!({ "origin": agent_origin(), "ops": [], "load": entries })).await?;
    Ok(answer["loaded"].as_array().cloned().unwrap_or_default())
}

/// Follows `path` (`slides.0.shapes`) from `start`; answers the ids it ends at.
async fn follow(kits: &KitManager, target: &Target, start: String, path: &str) -> Result<Vec<String>, KitToolError> {
    let mut current = vec![start];
    for segment in path.split('.').map(str::trim).filter(|segment| !segment.is_empty()) {
        if let Ok(position) = segment.parse::<usize>() {
            let picked = current
                .get(position)
                .cloned()
                .ok_or_else(|| KitToolError::new(ErrorCode::NOT_FOUND, format!("`{path}`: there is no item {position} (there are {})", current.len())))?;
            current = vec![picked];
            continue;
        }
        let [object] = current.as_slice() else {
            return Err(KitToolError::invalid(format!(
                "`{path}`: `{segment}` follows {} objects; pick one by position first, for example `{segment}` after `.0`",
                current.len()
            )));
        };
        let loaded = load(kits, target, vec![json!({ "target": object, "fields": [segment] })]).await?;
        let value = loaded.first().map(|object| object["fields"][segment].clone()).unwrap_or(Value::Null);
        current =
            ids_of(&value).ok_or_else(|| KitToolError::invalid(format!("`{path}`: `{segment}` is not a list, a tree, or a ref, so it names no objects")))?;
    }
    Ok(current)
}

pub(super) async fn query(kits: &KitManager, kit: &'static KitDefinition, input: &Value, draft: bool) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let explicit = input.get("draft").and_then(Value::as_bool) == Some(true);
    let target = read_target(kits, kit, &path, draft, explicit).await?;
    let mut objects: Vec<String> = match input.get("objects") {
        None | Some(Value::Null) => vec!["root".to_owned()],
        // An integer tool id may be given as the number the answers show.
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(id) => Ok(id.clone()),
                Value::Number(number) if number.is_u64() => Ok(number.to_string()),
                _ => Err(KitToolError::invalid("`objects` lists object ids")),
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(KitToolError::invalid("`objects` lists object ids")),
    };
    if objects.is_empty() {
        objects.push("root".to_owned());
    }
    let limit = input.get("limit").and_then(Value::as_u64).and_then(|limit| usize::try_from(limit).ok()).unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let fields = match input.get("fields") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Array(names)) if names.iter().all(Value::is_string) => Value::Array(names.clone()),
        Some(_) => return Err(KitToolError::invalid("`fields` lists field names")),
    };
    if let Some(path_of_fields) = input.get("follow").and_then(Value::as_str).filter(|text| !text.trim().is_empty()) {
        let start = objects.swap_remove(0);
        objects = follow(kits, &target, start, path_of_fields).await.map_err(|error| unsupported(kit, error))?;
    }
    let total = objects.len();
    let entries: Vec<Value> = objects.iter().take(limit).map(|id| json!({ "target": id, "fields": fields })).collect();
    let tool_ids = kits.described(kit.id).is_some_and(|described| declares_tool_ids(&described));
    let mut loaded = load(kits, &target, entries).await.map_err(|error| object_hint(kit, tool_ids, unsupported(kit, error)))?;
    let described = match kits.described(kit.id) {
        Some(described) => Some(described),
        None => target.describe(kits, kit).await.ok(),
    };
    super::receipts::IdForm::of(described.as_ref()).loaded(&mut loaded);
    let mut output = json!({ "objects": loaded, "total": total });
    if total > limit {
        output["truncated"] = Value::Bool(true);
    }
    // `describe: true`: the types and their fields, one line each; `describe: "Paragraph,Run"`:
    // those types in full; `describe: "*"`: the whole description and its JSON Schema, which the
    // `kit://<document>/describe` resource serves. (The whole description is too large for an
    // agent to read: 117K characters for Word.)
    match input.get("describe") {
        Some(Value::Bool(true)) => {
            let described = target.describe(kits, kit).await.map_err(|error| unsupported(kit, error))?;
            output["types"] = json!(type_listing(&described, None));
            output["describe_more"] = json!("pass describe: \"<Type>[,<Type>]\" for those types in full");
        }
        Some(Value::String(wanted)) if wanted.trim() == "*" => {
            let described = target.describe(kits, kit).await.map_err(|error| unsupported(kit, error))?;
            output["schema"] = describe_schema(&described);
            output["describe"] = described;
        }
        Some(Value::String(wanted)) => {
            let described = target.describe(kits, kit).await.map_err(|error| unsupported(kit, error))?;
            let names: Vec<&str> = wanted.split(',').map(str::trim).filter(|n| !n.is_empty()).collect();
            let known: Vec<&String> = ordered_types(&described).into_iter().map(|(name, _)| name).collect();
            if let Some(unknown) = names.iter().find(|name| !known.iter().any(|known| known == *name)) {
                let known: Vec<&str> = known.iter().map(|name| name.as_str()).collect();
                return Err(KitToolError::new(
                    ErrorCode::NOT_FOUND,
                    format!(
                        "`describe`: {} has no object type `{unknown}`; its types are {} (pass `describe: true` to list them with their fields)",
                        kit.name,
                        known.join(", ")
                    ),
                ));
            }
            let picked: Map<String, Value> = described["types"]
                .as_object()
                .map(|types| types.iter().filter(|(name, _)| names.contains(&name.as_str())).map(|(n, t)| (n.clone(), t.clone())).collect())
                .unwrap_or_default();
            output["describe"] = json!({ "root": described["root"], "types": picked });
        }
        _ => {}
    }
    if let Target::Live { draft, .. } = &target {
        output["live"] = Value::Bool(true);
        if *draft {
            output["draft"] = Value::Bool(true);
        }
    }
    if let Target::HeadlessDraft(_) = &target {
        output["draft"] = Value::Bool(true);
    }
    let shown = loaded_count(&output);
    let summary = if total > shown {
        format!("Read {shown} of {total} objects of {} `{path}`; raise `limit` or narrow `follow` for the rest.", target.label())
    } else {
        format!("Read {shown} objects of {} `{path}`.", target.label())
    };
    Ok(KitToolOutput::new(summary.replace("  ", " "), output))
}

fn loaded_count(output: &Value) -> usize {
    output["objects"].as_array().map_or(0, Vec::len)
}

/// The first op target that is a number or a string of digits: an id an agent took from the
/// inspect tool's `part` (the kit's command ids), which the object model does not know.
/// Numeric targets (ids from the inspect tool) replaced by their object-model ids, through the
/// `ref` the kit's `slide.inspect` or `page.inspect` gives for the part being edited.
async fn with_refs(kits: &KitManager, view: &DocumentView, mut request: Value) -> Value {
    let numeric = |item: &Value| match item.get("target") {
        Some(Value::Number(_)) => true,
        Some(Value::String(s)) => !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()),
        _ => false,
    };
    let any = ["ops", "load"].iter().any(|key| request.get(*key).and_then(Value::as_array).is_some_and(|items| items.iter().any(numeric)));
    if !any {
        return request;
    }
    warm(kits, view).await;
    let mut refs = std::collections::HashMap::new();
    for command in ["slide.inspect", "page.inspect"] {
        if let Ok(executed) = kits.execute(Caller::Agent, view.kit_id, &view.document_id, command, Map::new()).await
            && let Some(result) = executed.result
        {
            collect_refs(&result["shapes"], &mut refs);
            break;
        }
    }
    for key in ["ops", "load"] {
        if let Some(items) = request.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                let id = match item.get("target") {
                    Some(Value::Number(n)) => n.to_string(),
                    Some(Value::String(s)) => s.clone(),
                    _ => continue,
                };
                if let Some(r) = refs.get(&id) {
                    item["target"] = Value::String(r.clone());
                }
            }
        }
    }
    request
}

/// Makes the document's object model (an empty batch), so its objects have ids (`ref`s).
pub(super) async fn warm(kits: &KitManager, view: &DocumentView) {
    let mut params = Map::new();
    params.insert("origin".into(), agent_origin());
    params.insert("ops".into(), json!([]));
    params.insert("load".into(), json!([]));
    let _ = kits.model(Caller::Agent, view.kit_id, &view.document_id, "model.batch", params).await;
}

fn collect_refs(shapes: &Value, refs: &mut std::collections::HashMap<String, String>) {
    for shape in shapes.as_array().into_iter().flatten() {
        if let (Some(id), Some(r)) = (shape.get("id"), shape.get("ref").and_then(Value::as_str)) {
            refs.insert(id.to_string(), r.to_owned());
        }
        collect_refs(&shape["children"], refs);
    }
}

fn numeric_target(request: &Value) -> Option<String> {
    request.get("ops")?.as_array()?.iter().find_map(|op| match op.get("target")? {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) => Some(s.clone()),
        _ => None,
    })
}

pub(super) async fn batch(kits: &KitManager, kit: &'static KitDefinition, input: &Value, draft: bool) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let ops = match input.get("ops") {
        Some(Value::Array(ops)) => ops.clone(),
        None | Some(Value::Null) => Vec::new(),
        Some(_) => return Err(KitToolError::invalid("`ops` is an array of operations")),
    };
    let loads = match input.get("load") {
        Some(Value::Array(loads)) => loads.clone(),
        None | Some(Value::Null) => Vec::new(),
        Some(_) => {
            return Err(KitToolError::invalid("`load` is an array of `{ target, fields? }`"));
        }
    };
    if ops.is_empty() && loads.is_empty() {
        return Err(KitToolError::invalid(format!("`ops` is empty: give at least one operation (to only read, use {})", tool_name(kit, Action::Query))));
    }
    let writes = !ops.is_empty();
    let wanted = super::receipts::wanted(input)?;
    let target = if draft {
        match draft_at(kits, kit, &path, true).await? {
            DraftAt::Editor(document) => Target::Live { document, draft: true },
            DraftAt::Headless(id) => Target::HeadlessDraft(kits.document(Caller::Agent, kit.id, &id).await?),
        }
    } else if let Some(document) = live(kits, kit, &path).await {
        Target::Live { document, draft: false }
    } else {
        Target::Headless(kits.open(Caller::Agent, &path).await?)
    };
    if writes && target.read_only() {
        return Err(KitToolError::new(ErrorCode::READ_ONLY, format!("`{path}` is open read-only: it cannot be edited")));
    }
    // A batch's runs of model operations and its commands are separate changes of the document
    // (KitObjectModel OM4): one that fails after a command ran, or at a command after operations
    // ran, has changed it in part. The tool is one change (KHP A16) and a failed call leaves the
    // document as it was (A18), so such a batch is taken back as a failed `<prefix>_run` is (A53):
    // the headless document is opened again from its file, a headless draft from what was stored.
    // Where only undo could take a command back (an open editor, unsaved edits), it is refused
    // before anything runs.
    let commands = ops.iter().filter(|op| op.get("op").and_then(Value::as_str) == Some("command")).count();
    let mixed = commands > 0 && ops.len() > 1;
    if mixed {
        match &target {
            Target::Live { .. } => return Err(not_atomic(kit, &path, "is open in its editor, where only undo could take the command back", "")),
            Target::Headless(view) if view.dirty => {
                let why = "has unsaved edits, so taking the command back would mean reopening the file and losing them";
                return Err(not_atomic(kit, &path, why, &format!(", or save `{path}` first")));
            }
            Target::Headless(_) | Target::HeadlessDraft(_) => {}
        }
    }
    let save = !draft && input.get("save").and_then(Value::as_bool) != Some(false);
    // An integer tool id may be given as the number the answers show: the object
    // model takes ids as strings.
    let as_text = |entry: &mut Value, keys: &[&str]| {
        for key in keys {
            if let Some(number) = entry.get(*key).filter(|value| value.is_u64()).map(Value::to_string) {
                entry[*key] = Value::String(number);
            }
        }
    };
    // The type of each `create` operation: its result is the new object's id, in that type's form.
    let created: Vec<Option<String>> =
        ops.iter().map(|op| op["type"].as_str().filter(|_| op.get("op").and_then(Value::as_str) == Some("create")).map(str::to_owned)).collect();
    let (mut ops, mut loads) = (ops, loads);
    ops.iter_mut().for_each(|op| as_text(op, &["target", "item", "node", "parent"]));
    loads.iter_mut().for_each(|load| as_text(load, &["target"]));
    let mut request = json!({ "origin": agent_origin(), "ops": ops, "load": loads });
    if let Target::Live { draft: false, .. } = &target {
        request["save"] = Value::Bool(save && writes);
    }
    // What the receipt compares against: the version and the diagnostics before the batch.
    let receipt = match &target {
        Target::Headless(view) | Target::HeadlessDraft(view) if writes => {
            Some(super::receipts::before(kits, kit.name, Source::Kit { kit_id: view.kit_id, document_id: &view.document_id }, wanted).await)
        }
        // An editor that keeps a replica says what the batch changed, as headless (C3b).
        Target::Live { document, draft: false } if writes && document.can("changes") => {
            Some(super::receipts::before(kits, kit.name, Source::Editor(document), wanted).await)
        }
        _ => None,
    };
    let answer = target.batch(kits, request).await.map_err(|error| read_only_hint(kit, unsupported(kit, error))).map_err(|error| match error.index {
        Some(index) => error.context(&format!("op {index}: ")),
        None => error,
    });
    let mut answer = match answer {
        Ok(answer) => answer,
        Err(failure) if mixed => return Err(take_back(kits, kit, &path, &target, failure).await),
        Err(failure) => return Err(failure),
    };
    if let Some(fields) = answer.as_object_mut() {
        fields.remove("version");
    }
    if let Some(results) = answer.get_mut("results").and_then(Value::as_array_mut).filter(|_| created.iter().any(Option::is_some)) {
        let described = kits.described(kit.id);
        super::receipts::IdForm::of(described.as_ref()).results(&created, results);
    }
    if answer.get("loaded").is_some_and(|loaded| loaded.as_array().is_some_and(|loaded| !loaded.is_empty())) {
        let described = match kits.described(kit.id) {
            Some(described) => Some(described),
            None => target.describe(kits, kit).await.ok(),
        };
        if let Some(loaded) = answer.get_mut("loaded").and_then(Value::as_array_mut) {
            super::receipts::IdForm::of(described.as_ref()).loaded(loaded);
        }
    }
    match &target {
        Target::Headless(view) => {
            let mut view = kits.document(Caller::Agent, view.kit_id, &view.document_id).await?;
            if save && writes && view.dirty {
                view = kits
                    .save(Caller::Agent, view.kit_id, &view.document_id)
                    .await
                    .map_err(|error| KitToolError::from(error).context("the batch was applied but saving failed: "))?;
            }
            answer["saved"] = Value::Bool(save && writes && !view.dirty);
            answer["document"] = json!({ "path": view.path, "summary": view.summary, "dirty": view.dirty, "canUndo": view.can_undo });
            if let Some(receipt) = receipt {
                super::receipts::add(kits, kit.name, Source::Kit { kit_id: view.kit_id, document_id: &view.document_id }, receipt, wanted, &mut answer).await;
            }
        }
        Target::HeadlessDraft(view) => {
            if writes {
                drafts::persist(kits, kit, &path, &view.document_id).await?;
            }
            let view = kits.document(Caller::Agent, view.kit_id, &view.document_id).await?;
            answer["draft"] = Value::Bool(true);
            answer["saved"] = Value::Bool(false);
            answer["document"] = json!({ "path": path, "summary": view.summary, "dirty": view.dirty, "canUndo": view.can_undo });
            if let Some(receipt) = receipt {
                super::receipts::add(kits, kit.name, Source::Kit { kit_id: view.kit_id, document_id: &view.document_id }, receipt, wanted, &mut answer).await;
            }
        }
        Target::Live { document, draft } => {
            answer["live"] = Value::Bool(true);
            match receipt {
                Some(receipt) => super::receipts::add(kits, kit.name, Source::Editor(document), receipt, wanted, &mut answer).await,
                None if writes => super::receipts::in_editor(&mut answer, wanted, short(kit)),
                None => {}
            }
            if *draft {
                answer["draft"] = Value::Bool(true);
                answer["saved"] = Value::Bool(false);
            }
        }
    }
    let ran = answer["results"].as_array().map_or(0, Vec::len);
    let summary = match &target {
        Target::Live { draft: true, .. } | Target::HeadlessDraft(_) => format!(
            "Ran {ran} operations on your draft of `{path}`; the document is unchanged until the person merges the draft. Call {} when it is done.",
            tool_name(kit, Action::DraftReady)
        ),
        Target::Live { .. } => {
            format!("Ran {ran} operations on `{path}` in its open {} editor ({}).", short(kit), if answer["saved"] == true { "saved" } else { "not saved" })
        }
        Target::Headless(_) => format!("Ran {ran} operations on `{path}` ({}).", if answer["saved"] == true { "saved" } else { "not saved" }),
    } + &super::receipts::summary(&answer);
    Ok(KitToolOutput::new(summary, answer))
}

/// A batch with a command among other operations that cannot be taken back if it fails part way:
/// refused before anything runs, saying how to make the same edit.
fn not_atomic(kit: &KitDefinition, path: &str, why: &str, or: &str) -> KitToolError {
    KitToolError::new(
        ErrorCode::Unsupported,
        format!(
            "this batch runs a command among other operations, and `{path}` {why}; a batch is one change, so nothing was run. Run the command with {} (its steps are all or nothing) and the other operations in their own {}{}.",
            tool_name(kit, Action::Run),
            tool_name(kit, Action::Batch),
            or
        ),
    )
}

/// Puts the document a failed mixed batch ran on back as it was before the call (KHP A18, as A53
/// for `<prefix>_run`): the headless document is closed without saving and opened again from its
/// file (it had no unsaved edits), a headless draft is opened again from what was stored. The
/// failure says which happened.
async fn take_back(kits: &KitManager, kit: &'static KitDefinition, path: &str, target: &Target, mut failure: KitToolError) -> KitToolError {
    let restored = match target {
        Target::Headless(view) => match kits.close(view.kit_id, &view.document_id, true).await {
            Ok(()) => kits
                .open(Caller::Agent, path)
                .await
                .map(|_| format!("`{path}` is as it was before the call, and nothing was saved"))
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        },
        Target::HeadlessDraft(view) => drafts::reload(kits, kit, path, &view.document_id)
            .await
            .map(|_| format!("your draft of `{path}` is as it was before the call"))
            .map_err(|error| error.message),
        Target::Live { .. } => Err("an open editor's batch is not taken back".to_owned()),
    };
    match restored {
        Ok(state) => failure.message.push_str(&format!(" The operations and commands before it were rolled back: {state}.")),
        Err(reason) => failure.message.push_str(&format!(
            " The operations and commands before it could not be rolled back ({reason}): they stay in `{path}`, unsaved; undo them (`edit.undo`) or look with {}.",
            tool_name(kit, Action::Inspect)
        )),
    }
    failure
}

#[cfg(test)]
mod tests {
    use super::*;

    fn described() -> Value {
        json!({
            "capability": "KitObjectModel 1.0",
            "kit": "kit.slide",
            "schemaVersion": 1,
            "root": "SlideFile",
            "rootId": "p1",
            "types": {
                "SlideFile": { "fields": { "slides": { "kind": "list", "of": "Slide" }, "title": { "kind": "string" } } },
                "Slide": { "fields": { "name": { "kind": "text" }, "layout": { "kind": "enum", "values": ["title", "blank"] }, "notes": { "kind": "map", "optional": true } } }
            }
        })
    }

    fn slide() -> &'static KitDefinition {
        crate::definitions::fixture_kit("kit.slide")
    }

    #[test]
    fn query_and_batch_take_their_enums_from_the_kits_schema() {
        crate::definitions::fixture_kits();
        let generic = query_spec(slide(), None);
        assert_eq!(generic.name, "slide_query");
        assert!(generic.description.contains("describe: true"), "{}", generic.description);
        assert!(generic.input_schema["properties"]["fields"]["items"].get("enum").is_none());
        let known = query_spec(slide(), Some(&described()));
        assert_eq!(known.input_schema["properties"]["fields"]["items"]["enum"], json!(["layout", "name", "notes", "slides", "title"]));
        assert!(known.description.contains("SlideFile (root) { slides: list of Slide, title: string }"), "{}", known.description);
        let batch = batch_spec(slide(), Some(&described()));
        assert!(batch.writes && !known.writes);
        let item = &batch.input_schema["properties"]["ops"]["items"]["properties"];
        assert_eq!(item["type"]["enum"], json!(["SlideFile", "Slide"]));
        assert_eq!(item["op"]["enum"].as_array().map(Vec::len), Some(OPS.len()));
        assert_eq!(batch.input_schema["required"], json!(["path", "ops"]));
    }

    #[test]
    fn the_described_types_become_json_schema() {
        crate::definitions::fixture_kits();
        let schema = describe_schema(&described());
        let slide = &schema["$defs"]["Slide"]["properties"];
        assert_eq!(slide["layout"], json!({ "type": "string", "enum": ["title", "blank"] }));
        assert_eq!(slide["name"]["type"], "string");
        assert_eq!(schema["$defs"]["SlideFile"]["properties"]["slides"]["items"]["type"], "string");
        assert!(slide["notes"]["description"].as_str().unwrap_or_default().ends_with("Optional."));
    }

    #[test]
    fn described_numeric_limits_reach_json_schema() {
        let described = json!({"root":"Doc","types":{"Doc":{"fields":{
            "count":{"kind":"integer","minimum":0,"maximum":10,"multipleOf":2},
            "value":{"kind":"json","minimum":0,"maximum":1,"multipleOf":0.1},
            "data":{"kind":"json","members":{"roughness":{"minimum":0,"maximum":1,"multipleOf":0.1}}}
        }}}});
        let schema = describe_schema(&described);
        let fields = &schema["$defs"]["Doc"]["properties"];
        assert_eq!(fields["count"], json!({"type":"integer","minimum":0,"maximum":10,"multipleOf":2}));
        assert_eq!(fields["value"], json!({"minimum":0,"maximum":1,"multipleOf":0.1}));
        assert_eq!(fields["data"], json!({"properties":{"roughness":{"type":["number","array","object"],"minimum":0,"maximum":1,"multipleOf":0.1}}}));
        assert!(fields["data"].get("required").is_none(), "constrained members remain optional");
        assert!(fields["data"].get("additionalProperties").is_none(), "other JSON members remain valid");
    }

    #[test]
    fn nested_member_schema_checks_scalar_types_and_permits_containers() {
        let described = json!({"root":"Doc","types":{"Doc":{"fields":{
            "data":{"kind":"json","members":{"motion.shutter":{"minimum":0},"weights[]":{"minimum":0},"layers[].opacity":{"maximum":1}}}
        }}}});
        let schema = describe_schema(&described);
        let validator = jsonschema::validator_for(&schema["$defs"]["Doc"]).unwrap();
        for data in [
            json!({"motion":{"shutter":-1}}),
            json!({"weights":[2,-1,2]}),
            json!({"layers":[{"opacity":2}]}),
            json!({"weights":[2,"auto",null]}),
            json!({"motion":{"shutter":"auto"}}),
        ] {
            assert!(!validator.is_valid(&json!({"data":data})), "{data}");
        }
        for data in [json!([2, 2, 2]), json!({"weights":[2,1,0]}), json!({"motion":{"shutter":{}}})] {
            assert!(validator.is_valid(&json!({"data":data})), "{data}");
        }
    }

    /// A schema with every field kind, a read-only field, a read-only type, and one read-only
    /// when an enum holds a value (KitObjectModel OM8), as `model.describe` answers it.
    fn every_kind() -> Value {
        json!({
            "kit": "kit.slide",
            "root": "Deck",
            "types": {
                "Deck": { "fields": {
                    "title": { "kind": "string" },
                    "count": { "kind": "integer" },
                    "zoom": { "kind": "number", "optional": true },
                    "shown": { "kind": "boolean" },
                    "depth": { "kind": "enum", "values": ["U8", "U16", "F32"] },
                    "extra": { "kind": "json", "optional": true },
                    "image": { "kind": "blob", "optional": true },
                    "handle": { "kind": "string", "optional": true, "readOnly": true },
                    "layout": { "kind": "ref", "of": "Layout" },
                    "notes": { "kind": "text" },
                    "body": { "kind": "text", "marks": ["bold"] },
                    "slides": { "kind": "list", "of": "Layout" },
                    "outline": { "kind": "tree", "of": "Layout" },
                    "cells": { "kind": "map" }
                } },
                "Layout": { "fields": { "name": { "kind": "string" } }, "readOnlyWhen": { "field": "name", "values": ["kept"] } },
                "Kept": { "fields": { "xml": { "kind": "string" } }, "readOnly": true }
            }
        })
    }

    /// The JSON Schema of `describe: "*"` says how each field is written (KHP A16a): read-only
    /// fields and types carry `readOnly`, enums their values, a reference whose objects it names
    /// (`x-kdm-ref`), and a container the operations that change it (`x-kdm-ops`), so a writer
    /// never picks `set` for a text or a field the kit keeps. Before, a read-only field, a ref and
    /// a text all read `{ "type": "string" }` (cad `handle`, note `body`).
    #[test]
    fn the_described_schema_says_how_each_field_is_written() {
        crate::definitions::fixture_kits();
        let schema = describe_schema(&every_kind());
        let deck = &schema["$defs"]["Deck"]["properties"];
        assert_eq!(deck["handle"]["readOnly"], true, "{}", deck["handle"]);
        assert_eq!(deck["handle"]["type"], "string");
        assert!(deck["title"].get("readOnly").is_none());
        assert_eq!(deck["depth"]["enum"], json!(["U8", "U16", "F32"]));
        assert_eq!(deck["layout"]["type"], "string");
        assert_eq!(deck["layout"]["x-kdm-ref"], "Layout", "{}", deck["layout"]);
        assert!(deck["layout"]["description"].as_str().unwrap_or_default().contains("id of a `Layout`"), "{}", deck["layout"]);
        assert_eq!(deck["notes"]["x-kdm-ops"], json!(["text.insert", "text.delete", "text.set"]), "{}", deck["notes"]);
        assert!(deck["notes"]["description"].as_str().unwrap_or_default().contains("not with `set`"), "{}", deck["notes"]);
        assert_eq!(deck["body"]["x-kdm-ops"], json!(["text.insert", "text.delete", "text.set", "text.mark", "text.unmark"]));
        assert_eq!(deck["slides"]["items"]["x-kdm-ref"], "Layout");
        assert_eq!(deck["slides"]["x-kdm-ops"], json!(["list.insert", "list.move", "list.remove"]));
        assert_eq!(deck["outline"]["items"]["properties"]["object"]["x-kdm-ref"], "Layout");
        assert_eq!(deck["outline"]["x-kdm-ops"], json!(["tree.insert", "tree.move"]));
        assert_eq!(deck["cells"]["x-kdm-ops"], json!(["map.set", "map.delete"]));
        for plain in ["title", "count", "zoom", "shown", "depth", "extra", "image", "handle", "layout"] {
            assert!(deck[plain].get("x-kdm-ops").is_none(), "{plain} is set with `set`");
        }
        assert_eq!(schema["$defs"]["Kept"]["readOnly"], true);
        assert!(schema["$defs"]["Deck"].get("readOnly").is_none());
        let layout = schema["$defs"]["Layout"]["description"].as_str().unwrap_or_default();
        assert!(layout.contains("Read-only when `name` is `kept`"), "{layout}");
    }

    /// `describe: true` marks the same, tersely, and lists every type however many there are.
    #[test]
    fn the_type_listing_marks_how_fields_are_written() {
        crate::definitions::fixture_kits();
        let listing = type_listing(&every_kind(), None);
        assert!(listing.starts_with("Deck (root) { "), "{listing}");
        for marked in [
            "handle: string, read-only",
            "depth: enum U8|U16|F32",
            "layout: ref to Layout",
            "notes: text (text.* ops, not set)",
            "slides: list of Layout",
            "Kept (read-only) { xml: string }",
            "Layout (read-only when name is kept) { name: string }",
        ] {
            assert!(listing.contains(marked), "{marked} in {listing}");
        }
        let many = json!({ "root": "A", "types": { "A": { "fields": { "e": { "kind": "enum", "values": (1..=12).map(|n| format!("v{n}")).collect::<Vec<_>>() } } } } });
        assert!(type_listing(&many, None).contains("e: enum v1|v2|v3|v4|v5|v6|v7|v8|… (12 values)"), "{}", type_listing(&many, None));
        let wide: Map<String, Value> = (0..200).map(|n| (format!("Type{n:03}"), json!({ "fields": { "name": { "kind": "string" } } }))).collect();
        let wide = json!({ "root": "Type000", "types": wide });
        let full = type_listing(&wide, None);
        assert!(full.contains("Type199 { name: string }") && !full.contains('…'), "every type is listed");
        assert!(type_listing(&wide, Some(DESCRIPTION_TYPES)).ends_with('…'), "a tool description stays short");
    }

    /// Where a kit names objects by tool ids (KitObjectModel OM9), `describe` says how each type's
    /// ids read, in the listing and the JSON Schema (`x-kdm-id`); a kit without them reads as
    /// before.
    #[test]
    fn describe_says_how_each_types_ids_read() {
        crate::definitions::fixture_kits();
        let described = json!({ "kit": "kit.layout", "root": "Doc", "types": {
            "Doc": { "fields": { "stories": { "kind": "list", "of": "Story" } } },
            "Story": { "fields": { "number": { "kind": "integer", "readOnly": true }, "tables": { "kind": "list", "of": "Table" } }, "toolId": { "field": "number", "prefix": "story:" } },
            "Table": { "fields": { "number": { "kind": "integer", "readOnly": true } }, "toolId": { "field": "number", "prefix": "table:", "parent": "Story" } }
        } });
        assert!(declares_tool_ids(&described) && !declares_tool_ids(&every_kind()));
        let listing = type_listing(&described, None);
        for marked in ["Doc (root) (object ids)", "Story (ids story:<number>)", "Table (ids <Story id>/table:<number>)"] {
            assert!(listing.contains(marked), "{marked} in {listing}");
        }
        let schema = describe_schema(&described);
        assert_eq!(schema["$defs"]["Table"]["x-kdm-id"], json!({ "field": "number", "prefix": "table:", "parent": "Story" }));
        assert!(schema["$defs"]["Doc"]["description"].as_str().unwrap_or_default().contains("Its id is its object id"));
        assert!(!type_listing(&every_kind(), None).contains("ids"), "a kit without tool ids reads as before");
        assert!(describe_schema(&every_kind())["$defs"]["Deck"].get("description").is_none());
    }

    #[test]
    fn fields_name_the_ids_they_hold() {
        crate::definitions::fixture_kits();
        assert_eq!(ids_of(&json!(["a", "b"])), Some(vec!["a".to_owned(), "b".to_owned()]));
        assert_eq!(ids_of(&json!("r")), Some(vec!["r".to_owned()]));
        assert_eq!(ids_of(&json!([{ "object": "n1", "parent": null }, { "object": "n2", "parent": "n1" }])), Some(vec!["n1".to_owned(), "n2".to_owned()]));
        assert_eq!(ids_of(&json!(3)), None);
    }
}
