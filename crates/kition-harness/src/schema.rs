//! DeepSeek Harness `ParameterSchemaSpec` and `ValueSchemaSpec` compiled to
//! JSON Schema, and argument validation (Kit Standard A5).

use serde_json::{Map, Value, json};

const ANNOTATIONS: &[&str] = &["description", "title", "default", "examples"];

/// Compiles a `ParameterSchemaSpec` (named properties, each a `ValueSchemaSpec`
/// with an optional `required: true`) into the open, object-rooted JSON Schema
/// a model provider receives.
pub fn parameters_to_json_schema(spec: &Value) -> Result<Value, String> {
    let map = spec
        .as_object()
        .ok_or("parameters must be an object of named properties")?;
    let (properties, required) = property_map(map, "parameters")?;
    let mut schema = json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    Ok(schema)
}

/// Compiles one `ValueSchemaSpec`, such as a tool's output schema.
pub fn value_to_json_schema(spec: &Value) -> Result<Value, String> {
    compile(spec, "schema", false)
}

/// Path-qualified violations of `schema` by `instance`; empty means valid.
pub fn violations(schema: &Value, instance: &Value) -> Vec<String> {
    match jsonschema::validator_for(schema) {
        Ok(validator) => validator
            .iter_errors(instance)
            .take(8)
            .map(|error| format!("{error} at `{}`", error.instance_path()))
            .collect(),
        Err(error) => vec![format!("invalid schema: {error}")],
    }
}

fn property_map(
    map: &Map<String, Value>,
    path: &str,
) -> Result<(Map<String, Value>, Vec<String>), String> {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for (name, property) in map {
        let at = format!("{path}.{name}");
        if let Some(flag) = property.get("required") {
            if flag != &Value::Bool(true) {
                return Err(format!("{at}.required must be true when present"));
            }
            required.push(name.clone());
        }
        properties.insert(name.clone(), compile(property, &at, true)?);
    }
    Ok((properties, required))
}

fn compile(spec: &Value, path: &str, allow_required: bool) -> Result<Value, String> {
    let object = spec
        .as_object()
        .ok_or_else(|| format!("{path} must be an object"))?;
    let mut out = Map::new();
    for key in ANNOTATIONS {
        if let Some(value) = object.get(*key) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    if let Some(branches) = object.get("oneOf") {
        let branches = branches
            .as_array()
            .filter(|branches| branches.len() >= 2)
            .ok_or_else(|| format!("{path}.oneOf needs at least two branches"))?;
        let compiled = branches
            .iter()
            .enumerate()
            .map(|(index, branch)| compile(branch, &format!("{path}.oneOf[{index}]"), false))
            .collect::<Result<Vec<_>, _>>()?;
        out.insert("oneOf".into(), Value::Array(compiled));
        return Ok(Value::Object(out));
    }
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{path}.type is missing"))?;
    for key in object.keys() {
        let allowed = ANNOTATIONS.contains(&key.as_str())
            || (allow_required && key == "required")
            || matches!(
                (kind, key.as_str()),
                (_, "type")
                    | (
                        "string" | "number" | "integer" | "boolean" | "null",
                        "enum" | "const"
                    )
                    | ("array", "items")
                    | ("object", "properties" | "additionalProperties")
            );
        if !allowed {
            return Err(format!("{path}.{key} is not allowed for type `{kind}`"));
        }
    }
    match kind {
        "json" => {}
        "string" | "number" | "integer" | "boolean" | "null" => {
            out.insert("type".into(), json!(kind));
            for key in ["enum", "const"] {
                if let Some(value) = object.get(key) {
                    out.insert(key.into(), value.clone());
                }
            }
        }
        "array" => {
            out.insert("type".into(), json!("array"));
            if let Some(items) = object.get("items") {
                out.insert(
                    "items".into(),
                    compile(items, &format!("{path}.items"), false)?,
                );
            }
        }
        "object" => {
            let open = object
                .get("additionalProperties")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    format!("{path}.additionalProperties must be set to true or false")
                })?;
            let (properties, required) = match object.get("properties") {
                Some(Value::Object(map)) => property_map(map, &format!("{path}.properties"))?,
                Some(_) => return Err(format!("{path}.properties must be an object")),
                None => (Map::new(), Vec::new()),
            };
            out.insert("type".into(), json!("object"));
            out.insert("properties".into(), Value::Object(properties));
            if !required.is_empty() {
                out.insert("required".into(), json!(required));
            }
            out.insert("additionalProperties".into(), json!(open));
        }
        other => {
            return Err(format!(
                "{path}.type `{other}` is not a ValueSchemaSpec type"
            ));
        }
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_required_nested_json_and_one_of() {
        let spec = json!({
            "path": { "type": "string", "required": true, "description": "Workspace path" },
            "steps": { "type": "array", "items": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "command": { "type": "string", "required": true },
                    "params": { "type": "json" }
                }
            } },
            "mode": { "oneOf": [ { "type": "string", "enum": ["fast"] }, { "type": "null" } ] }
        });
        let schema = parameters_to_json_schema(&spec).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], json!(["path"]));
        assert_eq!(
            schema["properties"]["path"],
            json!({ "type": "string", "description": "Workspace path" })
        );
        let item = &schema["properties"]["steps"]["items"];
        assert_eq!(item["required"], json!(["command"]));
        assert_eq!(item["additionalProperties"], json!(false));
        assert_eq!(item["properties"]["params"], json!({}));
        assert_eq!(
            schema["properties"]["mode"]["oneOf"][1],
            json!({ "type": "null" })
        );
        assert!(violations(&schema, &json!({ "path": "a.psd" })).is_empty());
        assert!(!violations(&schema, &json!({ "steps": [] })).is_empty());
        assert!(
            !violations(
                &schema,
                &json!({ "path": "a", "steps": [{ "params": {} }] })
            )
            .is_empty()
        );
    }

    #[test]
    fn rejects_what_dsh_rejects() {
        let open = value_to_json_schema(&json!({ "type": "object" }))
            .err()
            .unwrap_or_default();
        assert!(open.contains("additionalProperties"), "{open}");
        let required =
            parameters_to_json_schema(&json!({ "x": { "type": "string", "required": false } }))
                .err()
                .unwrap_or_default();
        assert!(required.contains("required"), "{required}");
        let one = value_to_json_schema(&json!({ "oneOf": [ { "type": "null" } ] }))
            .err()
            .unwrap_or_default();
        assert!(one.contains("two branches"), "{one}");
        let stray = value_to_json_schema(&json!({ "type": "string", "items": {} }))
            .err()
            .unwrap_or_default();
        assert!(stray.contains("not allowed"), "{stray}");
    }
}
