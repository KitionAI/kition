//! Lenient access to renderer request objects. The bridge has always coerced
//! loosely typed fields, so a number where a string was expected still works.

use serde_json::Value;

#[derive(Clone, Debug, Default)]
pub struct Request(Value);

impl Request {
    pub fn new(value: Option<Value>) -> Self {
        Self(value.unwrap_or(Value::Null))
    }

    fn field(&self, key: &str) -> Option<&Value> {
        self.0.as_object().and_then(|object| object.get(key))
    }

    /// The field as a string; missing, `null`, `false`, and `0` read as empty.
    pub fn str(&self, key: &str) -> String {
        match self.field(key) {
            Some(Value::String(value)) => value.clone(),
            Some(Value::Number(value)) if value.as_f64() != Some(0.0) => value.to_string(),
            Some(Value::Bool(true)) => "true".to_owned(),
            _ => String::new(),
        }
    }

    /// The raw field, for structured values such as objects.
    pub fn value(&self, key: &str) -> Option<&Value> {
        self.field(key)
    }

    pub fn trimmed(&self, key: &str) -> String {
        self.str(key).trim().to_owned()
    }

    /// Whether the renderer sent the key at all, including as `null`.
    pub fn has(&self, key: &str) -> bool {
        self.field(key).is_some()
    }

    /// A string field only when it was sent as a non-empty string.
    pub fn string(&self, key: &str) -> Option<String> {
        match self.field(key) {
            Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
            _ => None,
        }
    }

    /// A field that may be compared exactly, where an empty string differs
    /// from a missing value.
    pub fn exact_string(&self, key: &str) -> Option<String> {
        match self.field(key) {
            Some(Value::String(value)) => Some(value.clone()),
            _ => None,
        }
    }

    pub fn number(&self, key: &str) -> Option<f64> {
        match self.field(key) {
            Some(Value::Number(value)) => value.as_f64(),
            Some(Value::String(value)) => value.trim().parse().ok(),
            _ => None,
        }
    }

    pub fn bool(&self, key: &str) -> bool {
        match self.field(key) {
            Some(Value::Bool(value)) => *value,
            Some(Value::Number(value)) => value.as_f64().is_some_and(|n| n != 0.0),
            Some(Value::String(value)) => !value.is_empty(),
            Some(Value::Array(_) | Value::Object(_)) => true,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn coerces_like_the_renderer_expects() {
        let request = Request::new(Some(json!({
            "path": "a.md",
            "n": 3,
            "zero": 0,
            "nil": null,
            "flag": true,
            "empty": "",
        })));
        assert_eq!(request.str("path"), "a.md");
        assert_eq!(request.str("n"), "3");
        assert_eq!(request.str("zero"), "");
        assert_eq!(request.str("nil"), "");
        assert_eq!(request.str("missing"), "");
        assert!(request.has("nil"));
        assert!(!request.has("missing"));
        assert_eq!(request.string("empty"), None);
        assert_eq!(request.exact_string("empty"), Some(String::new()));
        assert_eq!(request.number("n"), Some(3.0));
        assert!(request.bool("flag"));
        assert!(!Request::new(None).bool("flag"));
    }
}
