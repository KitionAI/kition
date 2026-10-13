//! The document bridge: the agent's edits to a Markdown document that a renderer window has
//! open go through that window's document session, so they show at once as the agent's edit and
//! the session saves them, instead of arriving later as an external change to the file.
//!
//! It shares the Kit AI bridge's stream (`bridge.rs`). The window announces the documents it has
//! open with a `documents.open` notification (`{ paths }`, the whole list each time); the runtime
//! asks it with two requests:
//!
//! - `document/read { path }` answers `{ open: true, content }`, the live text including unsaved
//!   edits, or `{ open: false }`;
//! - `document/apply { path, content, tool, turnId? }` answers `{ applied: true, content }`, the
//!   file content after the session saved, or `{ applied: false, reason }`.
//!
//! A window that does not answer in time, closes, or refuses leaves the edit to the caller, which
//! writes the file as before.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::bridge::{Bridge, normalize};

/// How long a window has to report a document's live text.
pub const DOCUMENT_READ_TIMEOUT: Duration = Duration::from_secs(3);
/// How long a window has to apply and save the agent's edit.
pub const DOCUMENT_APPLY_TIMEOUT: Duration = Duration::from_secs(10);

/// `document/apply`: the whole new text of a document, for the session to apply as its
/// difference.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentApply {
    /// Workspace-relative, `/`-separated.
    pub path: String,
    pub content: String,
    /// The agent tool that made the edit, such as `document_write` or `apply_patch`.
    pub tool: String,
    /// The agent turn the edit belongs to, when the caller knows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

/// The window's answer to `document/apply`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub struct DocumentApplied {
    pub applied: bool,
    /// The file content after the session saved (when applied).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Why the window did not apply it, such as `not-open`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Bridge {
    /// The window that has the text document `path` open: the newest, if several do.
    pub fn document_window(&self, path: &str) -> Option<u64> {
        self.window_with_document(&normalize(path))
    }

    /// The live text of `path` in `window`, unsaved edits included; `None` when the window no
    /// longer has it open.
    pub async fn read_document(
        &self,
        window: u64,
        path: &str,
        timeout: Duration,
    ) -> Result<Option<String>, String> {
        let answer = self
            .request(
                window,
                "document/read",
                json!({ "path": normalize(path) }),
                timeout,
            )
            .await?;
        if answer.get("open").and_then(Value::as_bool) != Some(true) {
            return Ok(None);
        }
        answer
            .get("content")
            .and_then(Value::as_str)
            .map(|content| Some(content.to_owned()))
            .ok_or_else(|| "the editor's answer had no content".to_owned())
    }

    /// Asks `window` to apply `edit` to its open document and save it.
    pub async fn apply_document(
        &self,
        window: u64,
        edit: &DocumentApply,
        timeout: Duration,
    ) -> Result<DocumentApplied, String> {
        let params = DocumentApply {
            path: normalize(&edit.path),
            ..edit.clone()
        };
        let answer = self
            .request(window, "document/apply", json!(params), timeout)
            .await?;
        let applied: DocumentApplied =
            serde_json::from_value(answer).map_err(|error| error.to_string())?;
        if applied.applied && applied.content.is_none() {
            return Err("the editor applied the edit but did not report the saved content".into());
        }
        Ok(applied)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    /// A window with `paths` open that answers like the real one; `delay` slows its answers.
    fn window(bridge: &Arc<Bridge>, paths: &[&str], text: &'static str, delay: Duration) -> u64 {
        let (session, mut rx) = bridge.connect();
        bridge
            .receive(
                session,
                &json!({ "jsonrpc": "2.0", "method": "documents.open", "params": { "paths": paths } }),
            )
            .unwrap_or_else(|err| panic!("{err}"));
        let bridge = bridge.clone();
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let Some(id) = message["id"].as_u64() else {
                    continue;
                };
                tokio::time::sleep(delay).await;
                let params = &message["params"];
                let result = match message["method"].as_str() {
                    Some("document/read") => json!({ "open": true, "content": text }),
                    Some("document/apply") if params["content"] == "refuse" => {
                        json!({ "applied": false, "reason": "conflict" })
                    }
                    Some("document/apply") => {
                        json!({ "applied": true, "content": format!("{}|{}", params["content"].as_str().unwrap_or_default(), params["tool"].as_str().unwrap_or_default()) })
                    }
                    _ => continue,
                };
                let _ = bridge.receive(
                    session,
                    &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                );
            }
        });
        session
    }

    fn edit(path: &str, content: &str) -> DocumentApply {
        DocumentApply {
            path: path.into(),
            content: content.into(),
            tool: "document_write".into(),
            turn_id: None,
        }
    }

    #[tokio::test]
    async fn edits_reach_the_window_that_has_the_document_open() {
        let bridge = Arc::new(Bridge::default());
        assert_eq!(bridge.document_window("Notes/a.md"), None);
        window(&bridge, &["Other.md"], "other", Duration::ZERO);
        let second = window(&bridge, &["/Notes/a.md"], "live text", Duration::ZERO);
        assert_eq!(bridge.document_window("./Notes/a.md"), Some(second));
        assert_eq!(
            bridge
                .read_document(second, "Notes/a.md", DOCUMENT_READ_TIMEOUT)
                .await,
            Ok(Some("live text".to_owned()))
        );
        assert_eq!(
            bridge
                .apply_document(second, &edit("Notes/a.md", "new"), DOCUMENT_APPLY_TIMEOUT)
                .await,
            Ok(DocumentApplied {
                applied: true,
                content: Some("new|document_write".into()),
                reason: None
            })
        );
        assert_eq!(
            bridge
                .apply_document(
                    second,
                    &edit("Notes/a.md", "refuse"),
                    DOCUMENT_APPLY_TIMEOUT
                )
                .await,
            Ok(DocumentApplied {
                applied: false,
                content: None,
                reason: Some("conflict".into())
            })
        );
    }

    #[tokio::test]
    async fn the_newest_announcement_replaces_the_window_list() {
        let bridge = Arc::new(Bridge::default());
        let first = window(&bridge, &["a.md", "b.md"], "", Duration::ZERO);
        let second = window(&bridge, &["a.md"], "", Duration::ZERO);
        assert_eq!(bridge.document_window("a.md"), Some(second));
        assert_eq!(bridge.document_window("b.md"), Some(first));
        bridge
            .receive(
                first,
                &json!({ "jsonrpc": "2.0", "method": "documents.open", "params": { "paths": [] } }),
            )
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(bridge.document_window("b.md"), None);
        bridge.disconnect(second);
        assert_eq!(bridge.document_window("a.md"), None);
        assert!(
            bridge
                .receive(
                    first,
                    &json!({ "jsonrpc": "2.0", "method": "documents.open", "params": {} })
                )
                .is_err(),
            "an announcement needs its paths"
        );
    }

    #[tokio::test]
    async fn a_slow_or_closed_window_fails_the_request() {
        let bridge = Arc::new(Bridge::default());
        let slow = window(&bridge, &["a.md"], "", Duration::from_millis(300));
        let outcome = bridge
            .apply_document(slow, &edit("a.md", "x"), Duration::from_millis(30))
            .await;
        assert_eq!(
            outcome,
            Err("the editor did not answer `document/apply` in time".into())
        );
        bridge.disconnect(slow);
        assert_eq!(
            bridge
                .read_document(slow, "a.md", Duration::from_millis(30))
                .await,
            Err("the editor window closed".into())
        );
    }

    #[tokio::test]
    async fn a_document_the_window_closed_reads_as_not_open() {
        let bridge = Arc::new(Bridge::default());
        let (session, mut rx) = bridge.connect();
        let answering = bridge.clone();
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                if let Some(id) = message["id"].as_u64() {
                    let result = match message["method"].as_str() {
                        Some("document/read") => json!({ "open": false }),
                        _ => json!({ "applied": true }),
                    };
                    let _ = answering.receive(
                        session,
                        &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    );
                }
            }
        });
        assert_eq!(
            bridge
                .read_document(session, "a.md", DOCUMENT_READ_TIMEOUT)
                .await,
            Ok(None)
        );
        assert!(
            bridge
                .apply_document(session, &edit("a.md", "x"), DOCUMENT_APPLY_TIMEOUT)
                .await
                .is_err(),
            "an applied edit must report the saved content"
        );
    }
}
