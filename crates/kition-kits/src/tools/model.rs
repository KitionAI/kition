//! The object-model tools (architecture section 13): `<prefix>_query` reads objects by id or by a
//! field path from the root, and `<prefix>_batch` runs a `model/batch` (KitObjectModel 1.0,
//! Kit Standard `spec/reference/object-model.md`). Their argument schemas are generated from what the kit's
//! `model.describe` answers, once Kition has seen it; before that they take any type and field.
//!
//! Both go where the other kit tools go: to the open kit editor through the Kit AI bridge (its
//! `model/describe` and `model/batch`, Kit UI protocol section 7a), or to the kit's headless
//! executable (`model.describe`, `model.batch`). Both honour draft mode and read-only documents.

use serde_json::{Map, Value, json};

use super::errors::{ErrorCode, KitToolError};
use super::{
    Action, DraftAt, KitToolOutput, KitToolResult, KitToolSpec, draft_at, draft_property, kit_path,
    live, path_property, reads_headless_draft, short, tool_name,
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
/// it. The renderer names the person when it knows them.
fn agent_origin() -> Value {
    json!({ "kind": "agent", "principal": "local", "label": "Agent" })
}

/// The type names and every field name the kit's schema has, sorted.
fn names(described: &Value) -> (Vec<String>, Vec<String>) {
    let Some(types) = described.get("types").and_then(Value::as_object) else {
        return (Vec::new(), Vec::new());
    };
    let mut fields: Vec<String> = types
        .values()
        .filter_map(|ty| ty.get("fields").and_then(Value::as_object))
        .flat_map(|fields| fields.keys().cloned())
        .collect();
    fields.sort_unstable();
    fields.dedup();
    (types.keys().cloned().collect(), fields)
}

/// The types as one line each, for a tool description: `Slide { shapes: list of Shape, … }`.
fn type_listing(described: &Value) -> String {
    let Some(types) = described.get("types").and_then(Value::as_object) else {
        return String::new();
    };
    let root = described["root"].as_str().unwrap_or_default();
    let mut out = String::new();
    for (name, ty) in types {
        let fields: Vec<String> = ty
            .get("fields")
            .and_then(Value::as_object)
            .map(|fields| {
                fields
                    .iter()
                    .map(|(field, def)| {
                        let kind = def["kind"].as_str().unwrap_or("json");
                        match def["of"].as_str() {
                            Some(of) => format!("{field}: {kind} of {of}"),
                            None => format!("{field}: {kind}"),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let marker = if name == root { " (root)" } else { "" };
        let line = format!("{name}{marker} {{ {} }}; ", fields.join(", "));
        if out.len() + line.len() > DESCRIPTION_TYPES {
            out.push('…');
            break;
        }
        out.push_str(&line);
    }
    out.trim_end().to_owned()
}

/// A field of the kit's schema as JSON Schema.
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
        "ref" => json!({ "type": "string", "description": format!("The id of a {of}.") }),
        "text" if def.get("marks").is_some() => json!({
            "description": "Text: a string to replace it, or runs `{ text, marks }` as read.",
        }),
        "text" => json!({ "type": "string" }),
        "list" => json!({
            "type": "array",
            "items": { "type": "string" },
            "description": format!("Ids of {of} objects, in order (edit with list.* ops)."),
        }),
        "tree" => json!({
            "type": "array",
            "items": { "type": "object", "properties": { "object": { "type": "string" }, "parent": { "type": ["string", "null"] } } },
            "description": format!("{of} objects as a tree, in pre-order (edit with tree.* ops)."),
        }),
        "map" => {
            json!({ "type": "object", "description": "String keys to values (edit with map.* ops)." })
        }
        _ => json!({}),
    };
    if def["optional"] == true {
        schema["description"] = json!(format!(
            "{} Optional.",
            schema["description"].as_str().unwrap_or_default()
        ));
    }
    schema
}

/// The kit's schema (`model.describe`) as JSON Schema: one definition per type, with its fields.
pub fn describe_schema(described: &Value) -> Value {
    let types = described
        .get("types")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let defs: Map<String, Value> = types
        .iter()
        .map(|(name, ty)| {
            let properties: Map<String, Value> = ty
                .get("fields")
                .and_then(Value::as_object)
                .map(|fields| {
                    fields
                        .iter()
                        .map(|(field, def)| (field.clone(), field_schema(def)))
                        .collect()
                })
                .unwrap_or_default();
            (
                name.clone(),
                json!({ "type": "object", "properties": properties, "additionalProperties": false }),
            )
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
    let listing = described.map(type_listing).unwrap_or_default();
    let types = if listing.is_empty() {
        "Call it with `describe: true` first to learn the document's object types and fields."
            .to_owned()
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
                "objects": { "type": "array", "items": { "type": "string" }, "description": "Object ids to read; `root` is the document's root object. Defaults to the root." },
                "follow": { "type": "string", "description": "A field path from the first object (the root by default): field names, and list or tree positions, joined with dots. Reads the objects it ends at." },
                "fields": string_list("Only these fields of each object. Defaults to all.", &fields),
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "description": format!("At most this many objects. Defaults to {DEFAULT_LIMIT}.") },
                "describe": { "type": "boolean", "description": "Also answer the kit's object types (model.describe) and their JSON Schema." },
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
    let mut type_property =
        json!({ "type": "string", "description": "`create`: the new object's type." });
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
            "Edit a {noun} in {name} through its object model: one model/batch of `ops`, run in order as one undoable step (each run of ops between commands is one transaction; nothing changes when an op fails), then `load` reads objects back. Ops: create {{type, fields?, ref?: \"$name\", in?: \"<target>.<field>\", at?, parent?}}, set {{target, field, value}}, delete {{target}}, text.insert {{target, field, index, text}}, text.delete {{target, field, index, count}}, text.set {{target, field, text}}, text.mark/text.unmark {{target, field, start, end, key, value?}}, list.insert {{target, field, item, index?}}, list.move {{target, field, from, to}}, list.remove {{target, field, index}}, map.set/map.delete {{target, field, key, value?}}, tree.insert/tree.move {{target, field, item, parent?}}, command {{id, params?}}. A target is `root`, an object id from {}, or a `$name` bound by an earlier create. Saves the file unless `save` is false; with `draft`, edits your draft instead (never saved). Failures answer `error.code` and the op's `index`. Low level: `text.set` here replaces the text together with its formatting, and created objects get default styles; for ordinary edits prefer the kit's commands (its commands and run tools), which keep formatting.",
            tool_name(kit, Action::Query)
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
                            "target": { "type": "string", "description": "`root`, an object id, or a `$name`." },
                            "type": type_property,
                            "field": field_property,
                            "value": { "description": "The value to set." },
                            "fields": { "type": "object", "description": "`create`: the new object's fields." },
                            "ref": { "type": "string", "description": "`create`: a `$name` later ops use for the new object." },
                            "in": { "type": "string", "description": "`create`: the list or tree to add it to, as `<target>.<field>`." },
                            "item": { "type": "string" },
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
                            "target": { "type": "string" },
                            "fields": string_list("Only these fields.", &fields)
                        },
                        "required": ["target"]
                    },
                    "description": "Objects to read after the ops."
                },
                "save": { "type": "boolean", "description": "Save the file after the batch. Defaults to true; a draft is never saved." },
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
                kits.bridge()
                    .call(document, "batch", arguments)
                    .await
                    .map_err(KitToolError::from_bridge)
            }
            Self::Headless(view) | Self::HeadlessDraft(view) => {
                let numeric = numeric_target(&request);
                let params = request.as_object().cloned().unwrap_or_default();
                kits.model(
                    Caller::Agent,
                    view.kit_id,
                    &view.document_id,
                    "model.batch",
                    params,
                )
                .await
                .map_err(|error| {
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

    async fn describe(
        &self,
        kits: &KitManager,
        kit: &KitDefinition,
    ) -> Result<Value, KitToolError> {
        let described = match self {
            Self::Live { document, draft } => kits
                .bridge()
                .call(document, "describe", json!({ "draft": draft }))
                .await
                .map_err(KitToolError::from_bridge)?,
            Self::Headless(view) | Self::HeadlessDraft(view) => {
                kits.model(
                    Caller::Agent,
                    view.kit_id,
                    &view.document_id,
                    "model.describe",
                    Map::new(),
                )
                .await?
            }
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

/// A kit that serves no object model answers "method not found": say so as `unsupported`.
fn unsupported(kit: &KitDefinition, error: KitToolError) -> KitToolError {
    let lower = error.message.to_lowercase();
    if lower.contains("not found") && lower.contains("method")
        || lower.contains("no object model")
        || lower.contains("does not answer the object model")
    {
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
async fn read_target(
    kits: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    draft: bool,
    explicit: bool,
) -> Result<Target, KitToolError> {
    if reads_headless_draft(kits, kit, path, draft, explicit).await {
        let id = drafts::document(kits, kit, path, false).await?;
        return Ok(Target::HeadlessDraft(
            kits.document(Caller::Agent, kit.id, &id).await?,
        ));
    }
    let open = live(kits, kit, path).await;
    if draft && explicit {
        return Ok(match draft_at(kits, kit, path, false).await? {
            DraftAt::Editor(document) => Target::Live {
                document,
                draft: true,
            },
            DraftAt::Headless(id) => {
                Target::HeadlessDraft(kits.document(Caller::Agent, kit.id, &id).await?)
            }
        });
    }
    if let Some(document) = open {
        return Ok(Target::Live {
            document,
            draft: false,
        });
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
                Value::Object(entry) => entry
                    .get("object")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

async fn load(
    kits: &KitManager,
    target: &Target,
    entries: Vec<Value>,
) -> Result<Vec<Value>, KitToolError> {
    let answer = target
        .batch(
            kits,
            json!({ "origin": agent_origin(), "ops": [], "load": entries }),
        )
        .await?;
    Ok(answer["loaded"].as_array().cloned().unwrap_or_default())
}

/// Follows `path` (`slides.0.shapes`) from `start`; answers the ids it ends at.
async fn follow(
    kits: &KitManager,
    target: &Target,
    start: String,
    path: &str,
) -> Result<Vec<String>, KitToolError> {
    let mut current = vec![start];
    for segment in path
        .split('.')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
    {
        if let Ok(position) = segment.parse::<usize>() {
            let picked = current.get(position).cloned().ok_or_else(|| {
                KitToolError::new(
                    ErrorCode::NOT_FOUND,
                    format!(
                        "`{path}`: there is no item {position} (there are {})",
                        current.len()
                    ),
                )
            })?;
            current = vec![picked];
            continue;
        }
        let [object] = current.as_slice() else {
            return Err(KitToolError::invalid(format!(
                "`{path}`: `{segment}` follows {} objects; pick one by position first, for example `{segment}` after `.0`",
                current.len()
            )));
        };
        let loaded = load(
            kits,
            target,
            vec![json!({ "target": object, "fields": [segment] })],
        )
        .await?;
        let value = loaded
            .first()
            .map(|object| object["fields"][segment].clone())
            .unwrap_or(Value::Null);
        current = ids_of(&value).ok_or_else(|| {
            KitToolError::invalid(format!(
                "`{path}`: `{segment}` is not a list, a tree, or a ref, so it names no objects"
            ))
        })?;
    }
    Ok(current)
}

pub(super) async fn query(
    kits: &KitManager,
    kit: &'static KitDefinition,
    input: &Value,
    draft: bool,
) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let explicit = input.get("draft").and_then(Value::as_bool) == Some(true);
    let target = read_target(kits, kit, &path, draft, explicit).await?;
    let mut objects: Vec<String> = match input.get("objects") {
        None | Some(Value::Null) => vec!["root".to_owned()],
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| KitToolError::invalid("`objects` lists object ids"))
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(KitToolError::invalid("`objects` lists object ids")),
    };
    if objects.is_empty() {
        objects.push("root".to_owned());
    }
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .and_then(|limit| usize::try_from(limit).ok())
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);
    let fields = match input.get("fields") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Array(names)) if names.iter().all(Value::is_string) => {
            Value::Array(names.clone())
        }
        Some(_) => return Err(KitToolError::invalid("`fields` lists field names")),
    };
    if let Some(path_of_fields) = input
        .get("follow")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        let start = objects.swap_remove(0);
        objects = follow(kits, &target, start, path_of_fields)
            .await
            .map_err(|error| unsupported(kit, error))?;
    }
    let total = objects.len();
    let entries: Vec<Value> = objects
        .iter()
        .take(limit)
        .map(|id| json!({ "target": id, "fields": fields }))
        .collect();
    let loaded = load(kits, &target, entries)
        .await
        .map_err(|error| unsupported(kit, error))?;
    let mut output = json!({ "objects": loaded, "total": total });
    if total > limit {
        output["truncated"] = Value::Bool(true);
    }
    if input.get("describe").and_then(Value::as_bool) == Some(true) {
        let described = target
            .describe(kits, kit)
            .await
            .map_err(|error| unsupported(kit, error))?;
        output["schema"] = describe_schema(&described);
        output["describe"] = described;
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
        format!(
            "Read {shown} of {total} objects of {} `{path}`; raise `limit` or narrow `follow` for the rest.",
            target.label()
        )
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
fn numeric_target(request: &Value) -> Option<String> {
    request.get("ops")?.as_array()?.iter().find_map(|op| match op.get("target")? {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) => Some(s.clone()),
        _ => None,
    })
}

pub(super) async fn batch(
    kits: &KitManager,
    kit: &'static KitDefinition,
    input: &Value,
    draft: bool,
) -> KitToolResult {
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
            return Err(KitToolError::invalid(
                "`load` is an array of `{ target, fields? }`",
            ));
        }
    };
    if ops.is_empty() && loads.is_empty() {
        return Err(KitToolError::invalid(format!(
            "`ops` is empty: give at least one operation (to only read, use {})",
            tool_name(kit, Action::Query)
        )));
    }
    let writes = !ops.is_empty();
    let target = if draft {
        match draft_at(kits, kit, &path, true).await? {
            DraftAt::Editor(document) => Target::Live {
                document,
                draft: true,
            },
            DraftAt::Headless(id) => {
                Target::HeadlessDraft(kits.document(Caller::Agent, kit.id, &id).await?)
            }
        }
    } else if let Some(document) = live(kits, kit, &path).await {
        Target::Live {
            document,
            draft: false,
        }
    } else {
        Target::Headless(kits.open(Caller::Agent, &path).await?)
    };
    if writes && target.read_only() {
        return Err(KitToolError::new(
            ErrorCode::READ_ONLY,
            format!("`{path}` is open read-only: it cannot be edited"),
        ));
    }
    let save = !draft && input.get("save").and_then(Value::as_bool) != Some(false);
    let mut request = json!({ "origin": agent_origin(), "ops": ops, "load": loads });
    if let Target::Live { draft: false, .. } = &target {
        request["save"] = Value::Bool(save && writes);
    }
    let mut answer = target
        .batch(kits, request)
        .await
        .map_err(|error| unsupported(kit, error))
        .map_err(|error| match error.index {
            Some(index) => error.context(&format!("op {index}: ")),
            None => error,
        })?;
    if let Some(fields) = answer.as_object_mut() {
        fields.remove("version");
    }
    match &target {
        Target::Headless(view) => {
            let mut view = kits
                .document(Caller::Agent, view.kit_id, &view.document_id)
                .await?;
            if save && writes && view.dirty {
                view = kits
                    .save(Caller::Agent, view.kit_id, &view.document_id)
                    .await
                    .map_err(|error| {
                        KitToolError::from(error)
                            .context("the batch was applied but saving failed: ")
                    })?;
            }
            answer["saved"] = Value::Bool(save && writes && !view.dirty);
            answer["document"] = json!({ "path": view.path, "summary": view.summary, "dirty": view.dirty, "canUndo": view.can_undo });
        }
        Target::HeadlessDraft(view) => {
            if writes {
                drafts::persist(kits, kit, &path, &view.document_id).await?;
            }
            let view = kits
                .document(Caller::Agent, view.kit_id, &view.document_id)
                .await?;
            answer["draft"] = Value::Bool(true);
            answer["saved"] = Value::Bool(false);
            answer["document"] = json!({ "path": path, "summary": view.summary, "dirty": view.dirty, "canUndo": view.can_undo });
        }
        Target::Live { draft, .. } => {
            answer["live"] = Value::Bool(true);
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
        Target::Live { .. } => format!(
            "Ran {ran} operations on `{path}` in its open {} editor ({}).",
            short(kit),
            if answer["saved"] == true {
                "saved"
            } else {
                "not saved"
            }
        ),
        Target::Headless(_) => format!(
            "Ran {ran} operations on `{path}` ({}).",
            if answer["saved"] == true {
                "saved"
            } else {
                "not saved"
            }
        ),
    };
    Ok(KitToolOutput::new(summary, answer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::KITS;

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
        KITS.iter()
            .find(|kit| kit.id == "kit.slide")
            .unwrap_or_else(|| panic!("kit.slide is a kit"))
    }

    #[test]
    fn query_and_batch_take_their_enums_from_the_kits_schema() {
        let generic = query_spec(slide(), None);
        assert_eq!(generic.name, "slide_query");
        assert!(
            generic.description.contains("describe: true"),
            "{}",
            generic.description
        );
        assert!(
            generic.input_schema["properties"]["fields"]["items"]
                .get("enum")
                .is_none()
        );
        let known = query_spec(slide(), Some(&described()));
        assert_eq!(
            known.input_schema["properties"]["fields"]["items"]["enum"],
            json!(["layout", "name", "notes", "slides", "title"])
        );
        assert!(
            known
                .description
                .contains("SlideFile (root) { slides: list of Slide, title: string }"),
            "{}",
            known.description
        );
        let batch = batch_spec(slide(), Some(&described()));
        assert!(batch.writes && !known.writes);
        let item = &batch.input_schema["properties"]["ops"]["items"]["properties"];
        assert_eq!(item["type"]["enum"], json!(["SlideFile", "Slide"]));
        assert_eq!(item["op"]["enum"].as_array().map(Vec::len), Some(OPS.len()));
        assert_eq!(batch.input_schema["required"], json!(["path", "ops"]));
    }

    #[test]
    fn the_described_types_become_json_schema() {
        let schema = describe_schema(&described());
        let slide = &schema["$defs"]["Slide"]["properties"];
        assert_eq!(
            slide["layout"],
            json!({ "type": "string", "enum": ["title", "blank"] })
        );
        assert_eq!(slide["name"]["type"], "string");
        assert_eq!(
            schema["$defs"]["SlideFile"]["properties"]["slides"]["items"]["type"],
            "string"
        );
        assert!(
            slide["notes"]["description"]
                .as_str()
                .unwrap_or_default()
                .ends_with("Optional.")
        );
    }

    #[test]
    fn fields_name_the_ids_they_hold() {
        assert_eq!(
            ids_of(&json!(["a", "b"])),
            Some(vec!["a".to_owned(), "b".to_owned()])
        );
        assert_eq!(ids_of(&json!("r")), Some(vec!["r".to_owned()]));
        assert_eq!(
            ids_of(
                &json!([{ "object": "n1", "parent": null }, { "object": "n2", "parent": "n1" }])
            ),
            Some(vec!["n1".to_owned(), "n2".to_owned()])
        );
        assert_eq!(ids_of(&json!(3)), None);
    }
}
