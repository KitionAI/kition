//! Request bodies decoded the way the legacy binder did: members are read
//! one by one, a member of the wrong type leaves the default and marks the
//! body invalid, and `required` means "present and non-empty".

use serde_json::{Map, Value};

pub(crate) struct Body {
    root: Map<String, Value>,
    /// The body was not a JSON object, or a member had the wrong type.
    pub invalid: bool,
    /// A required member was missing or empty.
    pub missing: Vec<String>,
}

impl Body {
    pub fn parse(bytes: &[u8]) -> Self {
        match serde_json::from_slice::<Value>(bytes) {
            Ok(Value::Object(root)) => Self {
                root,
                invalid: false,
                missing: Vec::new(),
            },
            Ok(Value::Null) => Self {
                root: Map::new(),
                invalid: false,
                missing: Vec::new(),
            },
            _ => Self {
                root: Map::new(),
                invalid: true,
                missing: Vec::new(),
            },
        }
    }

    fn lookup(&self, path: &str) -> Option<&Value> {
        let mut current = &self.root;
        let mut parts = path.split('.').peekable();
        while let Some(part) = parts.next() {
            let value = current.get(part)?;
            if parts.peek().is_none() {
                return Some(value);
            }
            current = value.as_object()?;
        }
        None
    }

    /// Records a wrong-typed member, or a non-object parent on the path.
    fn check_type(&mut self, path: &str, ok: impl Fn(&Value) -> bool) {
        let mut current = &self.root;
        let parts: Vec<&str> = path.split('.').collect();
        for (index, part) in parts.iter().enumerate() {
            let Some(value) = current.get(*part) else {
                return;
            };
            if value.is_null() {
                return;
            }
            if index + 1 == parts.len() {
                if !ok(value) {
                    self.invalid = true;
                }
                return;
            }
            match value.as_object() {
                Some(object) => current = object,
                None => {
                    self.invalid = true;
                    return;
                }
            }
        }
    }

    pub fn string(&mut self, path: &str) -> String {
        self.check_type(path, Value::is_string);
        self.lookup(path)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    pub fn required(&mut self, path: &str) -> String {
        let value = self.string(path);
        if value.is_empty() {
            self.missing.push(path.to_owned());
        }
        value
    }

    pub fn boolean(&mut self, path: &str) -> bool {
        self.check_type(path, Value::is_boolean);
        self.lookup(path).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn integer(&mut self, path: &str) -> i64 {
        self.check_type(path, |v| v.as_i64().is_some());
        self.lookup(path).and_then(Value::as_i64).unwrap_or(0)
    }

    pub fn strings(&mut self, path: &str) -> Vec<String> {
        self.check_type(path, |v| {
            v.as_array()
                .is_some_and(|items| items.iter().all(|i| i.is_string() || i.is_null()))
        });
        self.lookup(path)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|i| i.as_str().unwrap_or_default().to_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Valid and complete.
    pub fn ok(&self) -> bool {
        !self.invalid && self.missing.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_members_and_records_problems() {
        let mut body = Body::parse(br#"{"a":"x","n":{"b":true,"c":3},"list":["p",null],"bad":1}"#);
        assert_eq!(body.required("a"), "x");
        assert!(body.boolean("n.b"));
        assert_eq!(body.integer("n.c"), 3);
        assert_eq!(body.strings("list"), vec!["p".to_owned(), String::new()]);
        assert!(body.ok());
        assert_eq!(body.required("missing"), "");
        assert_eq!(body.missing, vec!["missing".to_owned()]);
        assert_eq!(body.string("bad"), "");
        assert!(body.invalid);
        assert!(Body::parse(b"[1]").invalid);
        assert!(Body::parse(b"null").ok());
        let mut nested = Body::parse(br#"{"n":"text"}"#);
        nested.string("n.b");
        assert!(nested.invalid);
    }
}
