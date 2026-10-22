//! Validation against the contract schemas in `contracts/kit/`.

use serde_json::Value;

const PROTOCOL: &str = include_str!("../../../contracts/kit/kit-protocol.schema.json");
const MANIFEST: &str = include_str!("../../../contracts/kit/kit-manifest.schema.json");
/// The `kit.json` schema (KHP's manifest plus the Kition kit platform's fields), a copy of
/// `schemas/kit.schema.json` in the kition-sdk repository.
const KIT: &str = include_str!("../../../contracts/kit/kit.schema.json");

pub struct Schemas {
    protocol: Value,
    manifest: Value,
    kit: Value,
}

impl Schemas {
    pub fn load() -> Result<Self, String> {
        let parse = |text: &str| serde_json::from_str(text).map_err(|error| error.to_string());
        Ok(Self {
            protocol: parse(PROTOCOL)?,
            manifest: parse(MANIFEST)?,
            kit: parse(KIT)?,
        })
    }

    /// Validates against one `$defs` entry of the protocol schema.
    pub fn protocol_def(&self, def: &str, instance: &Value) -> Result<(), String> {
        if self.protocol["$defs"].get(def).is_none() {
            return Err(format!("the protocol schema has no $defs/{def}"));
        }
        let mut schema = self.protocol.clone();
        schema["$ref"] = Value::from(format!("#/$defs/{def}"));
        validate(&schema, instance).map_err(|error| format!("{def}: {error}"))
    }

    pub fn manifest(&self, instance: &Value) -> Result<(), String> {
        validate(&self.manifest, instance).map_err(|error| format!("kit.json: {error}"))
    }

    /// A KHP manifest (it has a `khp` version).
    pub fn kit(&self, instance: &Value) -> Result<(), String> {
        validate(&self.kit, instance).map_err(|error| format!("kit.json: {error}"))
    }
}

pub fn validate(schema: &Value, instance: &Value) -> Result<(), String> {
    let validator = jsonschema::validator_for(schema).map_err(|error| error.to_string())?;
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .take(5)
        .map(|error| format!("{error} at `{}`", error.instance_path()))
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Whether `schema` is itself a valid JSON Schema.
pub fn is_valid_schema(schema: &Value) -> Result<(), String> {
    jsonschema::meta::validate(schema).map_err(|error| error.to_string())?;
    jsonschema::validator_for(schema)
        .map(|_| ())
        .map_err(|error| error.to_string())
}
