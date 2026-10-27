//! Kit documents as MCP resources (architecture section 13): a harness reads a document's object
//! model (`kit://<document>/describe`) and its objects (`kit://<document>/objects/<id>`, `root`
//! for the root object) without calling a tool. `<document>` is the file's workspace path as one
//! percent-encoded URI segment (`kit://slides%2FLaunch.kslide/objects/root`). Reads go where
//! `<prefix>_query` goes: the open kit editor, else the headless kit; never the agent's draft.

use serde_json::{Value, json};

use crate::manager::KitManager;
use crate::tools::{self, Action, ErrorCode, KitToolError};

/// MCP's "resource not found" error code.
pub const NOT_FOUND: i64 = -32002;

const MIME: &str = "application/json";

/// What a `kit://` URI names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KitResource {
    Describe { path: String },
    Object { path: String, id: String },
}

fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        if byte == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(byte);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

impl KitResource {
    pub fn uri(&self) -> String {
        match self {
            Self::Describe { path } => format!("kit://{}/describe", encode(path)),
            Self::Object { path, id } => format!("kit://{}/objects/{}", encode(path), encode(id)),
        }
    }

    pub fn parse(uri: &str) -> Option<Self> {
        let rest = uri.strip_prefix("kit://")?;
        let (document, tail) = rest.split_once('/')?;
        let path = decode(document).filter(|path| !path.is_empty())?;
        if tail == "describe" {
            return Some(Self::Describe { path });
        }
        let raw = tail
            .strip_prefix("objects/")
            .filter(|raw| !raw.contains('/'))?;
        let id = decode(raw).filter(|id| !id.is_empty())?;
        Some(Self::Object { path, id })
    }
}

/// The documents open now (in kit editors and in the headless kits): each one's object model and
/// root object.
pub async fn list(kits: &KitManager) -> Value {
    let mut open: Vec<String> = kits
        .bridge()
        .documents()
        .await
        .into_iter()
        .map(|document| document.path)
        .collect();
    open.extend(kits.open_files().await.into_iter().map(|(_, path)| path));
    open.sort_unstable();
    open.dedup();
    let resources: Vec<Value> = open
        .into_iter()
        .filter(|path| kits.kit_for_path(path).is_some())
        .flat_map(|path| {
            let describe = KitResource::Describe { path: path.clone() };
            let root = KitResource::Object {
                path: path.clone(),
                id: "root".into(),
            };
            [
                json!({ "uri": describe.uri(), "name": format!("{path} object model"), "description": format!("The object types and fields of `{path}` (model.describe)."), "mimeType": MIME }),
                json!({ "uri": root.uri(), "name": format!("{path} root object"), "description": format!("The root object of `{path}`."), "mimeType": MIME }),
            ]
        })
        .collect();
    json!({ "resources": resources })
}

pub fn templates() -> Value {
    json!({ "resourceTemplates": [
        {
            "uriTemplate": "kit://{document}/objects/{id}",
            "name": "Kit document object",
            "description": "One object of a kit document: its id, type, and fields. `document` is the file's workspace path, percent-encoded as one segment; `id` is an object id or `root`.",
            "mimeType": MIME,
        },
        {
            "uriTemplate": "kit://{document}/describe",
            "name": "Kit document object model",
            "description": "A kit document's object types and fields (model.describe) and their JSON Schema.",
            "mimeType": MIME,
        },
    ] })
}

/// The contents of one `kit://` resource.
pub async fn read(kits: &KitManager, uri: &str) -> Result<Vec<Value>, KitToolError> {
    let resource = KitResource::parse(uri).ok_or_else(|| {
        KitToolError::invalid(format!(
            "`{uri}` is not a kit resource: kit://<document>/describe or kit://<document>/objects/<id>"
        ))
    })?;
    let path = match &resource {
        KitResource::Describe { path } | KitResource::Object { path, .. } => path.clone(),
    };
    let kit = kits
        .kit_for_path(&path)
        .ok_or_else(|| KitToolError::invalid(format!("no kit opens `{path}`")))?;
    let query = tools::tool_name(kit, Action::Query);
    let (arguments, pick): (Value, fn(Value) -> Option<Value>) = match &resource {
        KitResource::Describe { .. } => (
            json!({ "path": path, "limit": 1, "describe": "*", "draft": false }),
            |output| {
                Some(
                    json!({ "describe": output.get("describe")?, "schema": output.get("schema")? }),
                )
            },
        ),
        KitResource::Object { id, .. } => (
            json!({ "path": path, "objects": [id], "draft": false }),
            |output| output["objects"].as_array()?.first().cloned(),
        ),
    };
    let output = tools::call(kits, &query, &arguments)
        .await
        .ok_or_else(|| KitToolError::invalid(format!("`{query}` is not a kit tool")))??
        .output;
    let value = pick(output)
        .ok_or_else(|| KitToolError::new(ErrorCode::NOT_FOUND, format!("`{uri}` names nothing")))?;
    Ok(vec![
        json!({ "uri": uri, "mimeType": MIME, "text": value.to_string() }),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uris_round_trip() {
        let object = KitResource::Object {
            path: "talks/Q3 review.kslide".into(),
            id: "0193a/x".into(),
        };
        let uri = object.uri();
        assert_eq!(uri, "kit://talks%2FQ3%20review.kslide/objects/0193a%2Fx");
        assert_eq!(KitResource::parse(&uri), Some(object));
        assert_eq!(
            KitResource::parse("kit://a.kvector/describe"),
            Some(KitResource::Describe {
                path: "a.kvector".into()
            })
        );
        for bad in [
            "kit://a.kvector",
            "kit:///describe",
            "kit://a.kvector/objects/",
            "kit://a.kvector/objects/a/b",
            "file:///a.kvector",
            "kit://%zz/describe",
        ] {
            assert_eq!(KitResource::parse(bad), None, "{bad}");
        }
    }
}
