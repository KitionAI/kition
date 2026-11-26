// Copied from kition-sdk crates/kition-kdm/src/projection.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A read view of kit-computed objects. Nothing in this module writes the replica.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::batch::{BatchError, BatchErrorCode};
use crate::{FieldKind, ObjectId, Replica, Schema};

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectedObject {
    pub id: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub fields: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<ProjectedPlace>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectedPlace {
    pub parent: String,
    pub field: String,
    #[serde(default)]
    pub index: usize,
    /// Parent object within the same projected tree; absent for a tree root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
}

pub struct View {
    pub state: Value,
    pub objects: BTreeMap<String, ProjectedObject>,
}

pub struct Routed {
    pub command: String,
    pub params: Value,
    pub creates: Option<String>,
}

fn member<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

/// Translate a projected edit into the kit's declared command. Paths are read structurally.
pub fn route(schema: &Schema, view: &View, root: &str, operation: &Value) -> Result<Option<Routed>, BatchError> {
    let mut op = operation.clone();
    let mut name = member(&op, "op").as_str().unwrap_or_default().to_owned();
    let target = member(&op, "target").as_str().unwrap_or_default();
    let target = if target == "root" { root } else { target }.to_owned();
    let mut ty = view.objects.get(&target).map(|object| object.ty.clone());
    if name == "create" {
        ty = member(&op, "type").as_str().filter(|ty| schema.types.get(*ty).is_some_and(|def| def.projected)).map(str::to_owned);
    } else if (ty.is_none() || name == "set" || name.starts_with("list.") || name.starts_with("tree."))
        && let Some(object) = member(&view.state, "objects").get(&target)
        && let Some(parent_ty) = member(object, "$type").as_str()
        && let Some(field) = member(&op, "field").as_str()
        && let Some(def) = schema.types.get(parent_ty).and_then(|def| def.fields.get(field))
        && let Some(projected_type) = def.of.as_ref().filter(|ty| schema.types.get(*ty).is_some_and(|def| def.projected))
    {
        if def.read_only || schema.type_def(parent_ty).is_ok_and(|def| def.object_read_only(|field| object.get(field).cloned())) {
            return Err(BatchError::new(BatchErrorCode::ReadOnly, None, "the projected container is read-only"));
        }
        ty = Some(projected_type.clone());
        let index = member(&op, if name == "list.move" { "from" } else { "index" }).as_u64();
        let item = op
            .get("item")
            .cloned()
            .or_else(|| op.get("node").cloned())
            .or_else(|| (def.kind == FieldKind::Ref).then(|| op.get("value").cloned()).flatten())
            .or_else(|| index.and_then(|index| member(object, field).get(index as usize).cloned()));
        if let Some(item) = item {
            let destination = json!(format!("{target}.{field}"));
            let op = op.as_object_mut().ok_or_else(|| invalid("an operation is an object"))?;
            op.insert("in".into(), destination);
            op.insert("target".into(), item);
            if def.kind == FieldKind::Ref && name == "set" {
                name = "ref.set".into();
                op.insert("op".into(), json!(name));
                op.remove("field");
            }
        }
    }
    let Some(ty) = ty else { return Ok(None) };
    if let Some(destination) = member(&op, "in").as_str() {
        let (parent, field) = destination.rsplit_once('.').ok_or_else(|| invalid("a projected destination names parent.field"))?;
        let parent = if parent == "root" { root } else { parent };
        let object = member(&view.state, "objects").get(parent).ok_or_else(|| invalid("projected destination is unavailable"))?;
        let parent_def =
            member(object, "$type").as_str().and_then(|ty| schema.types.get(ty)).ok_or_else(|| invalid("projected destination type is unavailable"))?;
        let field_def = parent_def
            .fields
            .get(field)
            .filter(|def| (matches!(def.kind, FieldKind::List | FieldKind::Tree) || def.kind == FieldKind::Ref && def.owns) && def.of.as_deref() == Some(&ty))
            .ok_or_else(|| invalid("projected destination must own the object's type"))?;
        if field_def.read_only || parent_def.object_read_only(|field| object.get(field).cloned()) {
            return Err(BatchError::new(BatchErrorCode::ReadOnly, None, "the projected container is read-only"));
        }
    }
    let def = schema.type_def(&ty).map_err(|error| invalid(error.to_string()))?;
    let field = member(&op, "field").as_str();
    let subject = member(&op, "target").as_str().unwrap_or(&target);
    if def.object_read_only(|field| member(&view.state, "objects").get(subject).and_then(|object| object.get(field)).cloned())
        || field.and_then(|field| def.fields.get(field)).is_some_and(|field| field.read_only)
    {
        return Err(BatchError::new(BatchErrorCode::ReadOnly, None, format!("projected `{ty}` is read-only")));
    }
    if name == "set" {
        let field = field.ok_or_else(|| invalid("a projected set needs a field"))?;
        schema.check_value(&ty, field, member(&op, "value")).map_err(|error| invalid(error.to_string()))?;
    }
    let keyed = field.map(|field| format!("{name}.{field}"));
    let mapping = keyed
        .as_ref()
        .and_then(|key| def.projected_ops.get(key))
        .or_else(|| def.projected_ops.get(&name))
        .ok_or_else(|| BatchError::new(BatchErrorCode::ReadOnly, None, format!("no projected command mapping for `{ty}.{name}`")))?;
    let mut params = Map::new();
    for (parameter, path) in &mapping.params {
        if let Some(value) = path.split('.').try_fold(&op, |value, key| match value {
            Value::Array(items) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
            _ => value.get(key),
        }) {
            params.insert(parameter.clone(), value.clone());
        }
    }
    Ok(Some(Routed { command: mapping.command.clone(), params: json!(params), creates: (name == "create").then_some(ty) }))
}

fn invalid(message: impl Into<String>) -> BatchError {
    BatchError::new(BatchErrorCode::InvalidValue, None, message)
}

fn virtual_container(schema: &Schema, field: &crate::FieldDef) -> bool {
    (matches!(field.kind, FieldKind::List | FieldKind::Tree) || field.kind == FieldKind::Ref && field.owns)
        && field.of.as_ref().and_then(|ty| schema.types.get(ty)).is_some_and(|def| def.projected)
}

type Siblings = BTreeMap<Option<String>, Vec<(usize, String)>>;

fn projected_tree(groups: &Siblings, parent: Option<String>, seen: &mut BTreeSet<String>, depth: usize) -> Result<Value, BatchError> {
    if depth > 64 {
        return Err(invalid("projected tree exceeds depth limit"));
    }
    let mut tree = Vec::new();
    for (_, id) in groups.get(&parent).into_iter().flatten() {
        if !seen.insert(id.clone()) {
            return Err(invalid("projected placements contain a cycle"));
        }
        tree.push(json!({"object":id,"children":projected_tree(groups,Some(id.clone()),seen,depth+1)?}));
    }
    Ok(json!(tree))
}

pub fn declared(schema: &Schema) -> bool {
    schema.types.values().any(|def| def.projected)
}

impl View {
    pub fn read(replica: &Replica, projected: Vec<ProjectedObject>) -> Result<Self, BatchError> {
        let names = replica.tool_ids();
        let mut state = names.show_json(&replica.state_json().map_err(|error| invalid(error.to_string()))?);
        let schema = replica.schema();
        let stored = state.get_mut("objects").and_then(Value::as_object_mut).ok_or_else(|| invalid("missing model objects"))?;
        let mut objects = BTreeMap::new();
        for object in projected {
            if object.id.is_empty() || object.id == "root" || object.id.starts_with('$') || stored.contains_key(&object.id) || objects.contains_key(&object.id)
            {
                return Err(invalid(format!("projected id `{}` is reserved, duplicated or shadows a stored object", object.id)));
            }
            let def = schema.types.get(&object.ty).filter(|def| def.projected).ok_or_else(|| invalid(format!("`{}` is not a projected type", object.ty)))?;
            for (field, value) in &object.fields {
                let field_def = def.fields.get(field).ok_or_else(|| invalid(format!("unknown projected field `{}.{field}`", object.ty)))?;
                let valid = match field_def.kind {
                    FieldKind::Text => value.is_string() || (field_def.has_marks() && value.is_array()),
                    FieldKind::List | FieldKind::Tree => value.is_array(),
                    FieldKind::Map => value.is_object(),
                    _ => schema.check_value(&object.ty, field, value).is_ok(),
                };
                if !valid {
                    return Err(invalid(format!("invalid projected value `{}.{field}`", object.ty)));
                }
            }
            for (field, field_def) in &def.fields {
                if !field_def.optional && !virtual_container(schema, field_def) && !object.fields.contains_key(field) {
                    return Err(invalid(format!("missing projected field `{}.{field}`", object.ty)));
                }
            }
            let mut fields = object.fields.clone();
            fields.insert("$type".into(), json!(object.ty));
            stored.insert(object.id.clone(), json!(fields));
            objects.insert(object.id.clone(), object);
        }
        let mut containers: BTreeMap<(String, String), (FieldKind, Siblings)> = BTreeMap::new();
        for (id, object) in stored.iter() {
            let ty = member(object, "$type").as_str().ok_or_else(|| invalid("model object has no type"))?;
            for (field, def) in &schema.type_def(ty).map_err(|error| invalid(error.to_string()))?.fields {
                if virtual_container(schema, def) {
                    if !member(object, field).is_null() && member(object, field).as_array().is_none_or(|items| !items.is_empty()) {
                        return Err(invalid(format!("`{id}.{field}`: projected membership must come from object placements")));
                    }
                    containers.insert((id.clone(), field.clone()), (def.kind, BTreeMap::new()));
                }
            }
        }
        for object in objects.values() {
            if let Some(at) = &object.at {
                let (kind, groups) = containers
                    .get_mut(&(at.parent.clone(), at.field.clone()))
                    .ok_or_else(|| invalid(format!("`{}` has no projected container `{}.{}`", object.id, at.parent, at.field)))?;
                if at.node.is_some() && *kind != FieldKind::Tree {
                    return Err(invalid("only projected trees take a parent node"));
                }
                if let Some(node) = &at.node {
                    let placement = objects.get(node).and_then(|object| object.at.as_ref()).ok_or_else(|| invalid("projected tree parent is unavailable"))?;
                    if placement.parent != at.parent || placement.field != at.field {
                        return Err(invalid("projected tree parent belongs to another container"));
                    }
                }
                let parent = stored.get(&at.parent).ok_or_else(|| invalid("projected parent is unavailable"))?;
                let parent_ty = member(parent, "$type").as_str().ok_or_else(|| invalid("projected parent has no type"))?;
                if schema.field(parent_ty, &at.field).map_err(|error| invalid(error.to_string()))?.of.as_deref() != Some(&object.ty) {
                    return Err(invalid(format!("projected placement has the wrong type for `{}`", object.id)));
                }
                groups.entry(at.node.clone()).or_default().push((at.index, object.id.clone()));
            }
        }
        for ((parent, field), (kind, mut groups)) in containers {
            for siblings in groups.values_mut() {
                siblings.sort();
                if siblings.iter().enumerate().any(|(index, (at, _))| index != *at) {
                    return Err(invalid(format!("`{parent}.{field}`: projected indexes must be contiguous and unique")));
                }
            }
            let roots = groups.get(&None).cloned().unwrap_or_default();
            let value = match kind {
                FieldKind::Ref => {
                    if roots.len() > 1 {
                        return Err(invalid("a projected owning ref holds at most one object"));
                    }
                    roots.first().map(|(_, id)| json!(id)).unwrap_or(Value::Null)
                }
                FieldKind::Tree => {
                    let mut seen = BTreeSet::new();
                    let tree = projected_tree(&groups, None, &mut seen, 0)?;
                    if seen.len() != groups.values().map(Vec::len).sum::<usize>() {
                        return Err(invalid("projected placements contain an unreachable tree cycle"));
                    }
                    tree
                }
                _ => json!(roots.into_iter().map(|(_, id)| id).collect::<Vec<_>>()),
            };
            let object = stored.get_mut(&parent).and_then(Value::as_object_mut).ok_or_else(|| invalid("projected parent is unavailable"))?;
            object.insert(field, value);
        }
        // A placement cycle cannot describe a document tree or a stable guard premise.
        for object in objects.values() {
            let mut seen = BTreeSet::from([object.id.as_str()]);
            let mut cursor = object;
            while let Some(parent) = cursor.at.as_ref().and_then(|at| objects.get(&at.parent)) {
                if !seen.insert(&parent.id) {
                    return Err(invalid("projected placements contain a cycle"));
                }
                cursor = parent;
            }
        }
        Ok(Self { state, objects })
    }

    pub fn load(&self, root: Option<&ObjectId>, target: &str, fields: Option<&Value>) -> Result<Value, BatchError> {
        let id = if target == "root" { root.map(ToString::to_string).unwrap_or_default() } else { target.to_owned() };
        let object = member(&self.state, "objects").get(&id).ok_or_else(|| BatchError::new(BatchErrorCode::NotFound, None, format!("no object `{target}`")))?;
        let wanted: Vec<_> = match fields {
            None | Some(Value::Null) => {
                object.as_object().into_iter().flatten().filter(|(name, _)| name.as_str() != "$type").map(|(name, _)| name.clone()).collect()
            }
            Some(Value::Array(fields)) => {
                fields.iter().map(|field| field.as_str().map(str::to_owned).ok_or_else(|| invalid("fields lists names"))).collect::<Result<_, _>>()?
            }
            Some(_) => return Err(invalid("fields lists names")),
        };
        let mut loaded = Map::new();
        for field in wanted {
            loaded.insert(field.clone(), object.get(&field).cloned().ok_or_else(|| invalid(format!("unknown field `{field}`")))?);
        }
        let mut answer = Map::from_iter([("id".into(), json!(id)), ("type".into(), member(object, "$type").clone()), ("fields".into(), json!(loaded))]);
        if let Some(object) = self.objects.get(&id) {
            answer.insert("projected".into(), json!(true));
            if let Some(at) = &object.at {
                answer.insert("at".into(), json!(at));
            }
        }
        Ok(json!(answer))
    }
}
