//! The NDJSON frames a streamed agent turn writes to the client.

use std::time::Duration;

use axum::body::Body;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::mpsc;

/// One line of the stream. Empty fields are left out.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Frame {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub delta: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<Value>,
    #[serde(rename = "chat_message", skip_serializing_if = "Option::is_none")]
    pub chat: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whiteboard_patch: Option<Value>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub board_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub design_patch: Option<Value>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub design_path: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub extra_data: Map<String, Value>,
}

impl Frame {
    pub fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            ..Self::default()
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            ..Self::new("error")
        }
    }

    pub fn extra(mut self, key: &str, value: impl Serialize) -> Self {
        self.extra_data.insert(
            key.to_owned(),
            serde_json::to_value(value).unwrap_or(Value::Null),
        );
        self
    }
}

/// Serializes a row (or anything) for a frame field.
pub fn value(row: &impl Serialize) -> Option<Value> {
    serde_json::to_value(row).ok()
}

/// The sending half of a streamed response. Cheap to clone.
#[derive(Clone)]
pub struct Emitter {
    tx: mpsc::UnboundedSender<Bytes>,
}

impl Emitter {
    /// An emitter and the streaming response that carries its frames.
    pub fn channel() -> (Self, Response) {
        let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
        let body = Body::from_stream(futures::stream::unfold(rx, |mut rx| async move {
            rx.recv()
                .await
                .map(|chunk| (Ok::<_, std::convert::Infallible>(chunk), rx))
        }));
        let response = (
            [
                (
                    http::header::CONTENT_TYPE,
                    "application/x-ndjson; charset=utf-8",
                ),
                (http::header::CACHE_CONTROL, "no-cache"),
            ],
            body,
        )
            .into_response();
        (Self { tx }, response)
    }

    /// Writes one frame; false once the client has gone away.
    pub fn send(&self, frame: &Frame) -> bool {
        let Ok(mut line) = serde_json::to_vec(frame) else {
            return !self.tx.is_closed();
        };
        line.push(b'\n');
        self.tx.send(Bytes::from(line)).is_ok()
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }

    /// Resolves when the client disconnects.
    pub async fn closed(&self) {
        self.tx.closed().await
    }

    /// Replays text that was not streamed live, in small paced chunks.
    pub async fn send_text_in_chunks(&self, content: &str) {
        let chars: Vec<char> = content.chars().collect();
        for chunk in chars.chunks(48) {
            let frame = Frame {
                delta: chunk.iter().collect(),
                ..Frame::new("delta")
            };
            if !self.send(&frame) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(8)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt;
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn frames_are_newline_delimited_json() {
        let (emitter, response) = Emitter::channel();
        assert!(emitter.send(&Frame::new("started").extra("turn", 1)));
        assert!(emitter.send(&Frame {
            done: true,
            ..Frame::new("done")
        }));
        drop(emitter);
        let body = response
            .into_body()
            .collect()
            .await
            .map(|body| body.to_bytes())
            .unwrap_or_default();
        let lines: Vec<Value> = String::from_utf8_lossy(&body)
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        assert_eq!(
            lines,
            [
                json!({ "type": "started", "extra_data": { "turn": 1 } }),
                json!({ "type": "done", "done": true }),
            ]
        );
    }
}
