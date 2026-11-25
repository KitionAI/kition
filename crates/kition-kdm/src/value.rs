// Copied from kition-sdk crates/kition-kdm/src/value.rs by scripts/sync-kit-host.mjs; change it there, not here.
use serde_json::{Map, Value};

/// The canonical JSON form shared by every KDM implementation: keys sorted, and doubles that
/// hold a whole number within ±2^53 written as integers (JavaScript has one number type).
pub(crate) fn canonical(value: Value) -> Value {
    const SAFE: f64 = 9_007_199_254_740_992.0;
    match value {
        Value::Number(number) if !number.is_i64() && !number.is_u64() => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() <= SAFE => Value::from(float as i64),
            _ => Value::Number(number),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        Value::Object(fields) => {
            let mut sorted: Vec<(String, Value)> = fields.into_iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            let mut map = Map::new();
            for (key, value) in sorted {
                map.insert(key, canonical(value));
            }
            Value::Object(map)
        }
        other => other,
    }
}
