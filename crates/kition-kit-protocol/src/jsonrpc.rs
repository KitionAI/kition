//! JSON-RPC 2.0 envelopes.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::RpcError;

/// A request id: an integer or a string.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
}

impl From<i64> for RequestId {
    fn from(value: i64) -> Self {
        Self::Number(value)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: RequestId,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Notification {
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Response {
    /// `None` only for errors about a message whose id could not be read.
    pub id: Option<RequestId>,
    pub outcome: Result<Value, RpcError>,
}

/// Any message that can travel in either direction.
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    Request(Request),
    Notification(Notification),
    Response(Response),
}

impl Message {
    /// Parses one frame. A failure carries the error response to send back,
    /// with the request id when it could be recovered.
    pub fn parse(frame: &str) -> Result<Self, Box<Response>> {
        let value: Value = serde_json::from_str(frame).map_err(|_| {
            Box::new(Response {
                id: None,
                outcome: Err(RpcError::parse_error()),
            })
        })?;
        Self::from_value(value)
    }

    pub fn from_value(value: Value) -> Result<Self, Box<Response>> {
        let Value::Object(mut object) = value else {
            return Err(invalid(None, "message must be a JSON object"));
        };
        let id = match object.remove("id") {
            None => None,
            Some(id) => match serde_json::from_value::<RequestId>(id) {
                Ok(id) => Some(id),
                Err(_) => return Err(invalid(None, "id must be an integer or a string")),
            },
        };
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(invalid(id, "jsonrpc must be \"2.0\""));
        }
        if let Some(method) = object.remove("method") {
            let Value::String(method) = method else {
                return Err(invalid(id, "method must be a string"));
            };
            let params = object.remove("params");
            if params
                .as_ref()
                .is_some_and(|params| !params.is_object() && !params.is_array())
            {
                return Err(invalid(id, "params must be an object or an array"));
            }
            return Ok(match id {
                Some(id) => Self::Request(Request { id, method, params }),
                None => Self::Notification(Notification { method, params }),
            });
        }
        let outcome = match (object.remove("result"), object.remove("error")) {
            (Some(result), None) => Ok(result),
            (None, Some(error)) => match serde_json::from_value::<RpcError>(error) {
                Ok(error) => Err(error),
                Err(_) => return Err(invalid(id, "error must be a JSON-RPC error object")),
            },
            _ => {
                return Err(invalid(
                    id,
                    "response must have exactly one of result or error",
                ));
            }
        };
        Ok(Self::Response(Response { id, outcome }))
    }

    pub fn to_value(&self) -> Value {
        match self {
            Self::Request(request) => request.to_value(),
            Self::Notification(notification) => notification.to_value(),
            Self::Response(response) => response.to_value(),
        }
    }
}

fn invalid(id: Option<RequestId>, detail: &str) -> Box<Response> {
    Box::new(Response {
        id,
        outcome: Err(RpcError::invalid_request(detail)),
    })
}

fn envelope(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("jsonrpc".into(), Value::from("2.0"));
    for (key, value) in fields {
        object.insert(key.into(), value);
    }
    Value::Object(object)
}

impl Request {
    pub fn to_value(&self) -> Value {
        let mut fields = vec![("id", json!(self.id)), ("method", json!(self.method))];
        if let Some(params) = &self.params {
            fields.push(("params", params.clone()));
        }
        envelope(fields)
    }
}

impl Notification {
    pub fn new(method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            method: method.into(),
            params,
        }
    }

    pub fn to_value(&self) -> Value {
        let mut fields = vec![("method", json!(self.method))];
        if let Some(params) = &self.params {
            fields.push(("params", params.clone()));
        }
        envelope(fields)
    }
}

impl Response {
    pub fn to_value(&self) -> Value {
        let id = ("id", json!(self.id));
        match &self.outcome {
            Ok(result) => envelope([id, ("result", result.clone())]),
            Err(error) => envelope([id, ("error", json!(error))]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(frame: &str) -> Message {
        Message::parse(frame).unwrap_or_else(|err| panic!("{err:?}"))
    }

    #[test]
    fn classifies_messages() {
        assert!(matches!(
            parse(r#"{"jsonrpc":"2.0","id":1,"method":"kit.ping"}"#),
            Message::Request(Request {
                id: RequestId::Number(1),
                ..
            })
        ));
        assert!(matches!(
            parse(r#"{"jsonrpc":"2.0","method":"kit.initialized"}"#),
            Message::Notification(_)
        ));
        assert!(matches!(
            parse(r#"{"jsonrpc":"2.0","id":"a","result":{}}"#),
            Message::Response(Response { outcome: Ok(_), .. })
        ));
        assert!(matches!(
            parse(r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}"#),
            Message::Response(Response {
                outcome: Err(_),
                ..
            })
        ));
    }

    #[test]
    fn null_result_is_a_result() {
        let message = parse(r#"{"jsonrpc":"2.0","id":1,"result":null}"#);
        assert_eq!(
            message,
            Message::Response(Response {
                id: Some(RequestId::Number(1)),
                outcome: Ok(Value::Null)
            })
        );
    }

    #[test]
    fn rejects_malformed_messages_with_the_right_codes() {
        let code = |frame: &str| match Message::parse(frame) {
            Ok(message) => panic!("parsed {message:?}"),
            Err(response) => (response.id.clone(), response.outcome.err().map(|e| e.code)),
        };
        assert_eq!(code("not json"), (None, Some(RpcError::PARSE_ERROR)));
        assert_eq!(code("[]"), (None, Some(RpcError::INVALID_REQUEST)));
        assert_eq!(
            code(r#"{"id":3,"method":"kit.ping"}"#),
            (Some(RequestId::Number(3)), Some(RpcError::INVALID_REQUEST))
        );
        assert_eq!(
            code(r#"{"jsonrpc":"2.0","id":4,"method":"kit.ping","params":1}"#),
            (Some(RequestId::Number(4)), Some(RpcError::INVALID_REQUEST))
        );
        assert_eq!(
            code(r#"{"jsonrpc":"2.0","id":5}"#),
            (Some(RequestId::Number(5)), Some(RpcError::INVALID_REQUEST))
        );
    }

    #[test]
    fn serializes_round_trip() {
        let messages = [
            Message::Request(Request {
                id: RequestId::String("x".into()),
                method: "document.list".into(),
                params: Some(json!({})),
            }),
            Message::Notification(Notification::new("kit.initialized", None)),
            Message::Response(Response {
                id: Some(7.into()),
                outcome: Err(RpcError::method_not_found("nope")),
            }),
        ];
        for message in messages {
            let text = message.to_value().to_string();
            assert_eq!(parse(&text), message);
        }
    }
}
