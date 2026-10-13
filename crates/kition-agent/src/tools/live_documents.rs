//! Agent edits to Markdown documents that a renderer window has open go through that window's
//! document session over the document bridge (`kition_kits::document_bridge`): the person sees
//! the edit at once as the agent's, and the session saves it. A document no window has open, or
//! whose window does not answer in time or refuses, is written as a file (atomically); an open
//! session then merges it as an external change.

use std::time::Duration;

use kition_kits::document_bridge::{DOCUMENT_APPLY_TIMEOUT, DOCUMENT_READ_TIMEOUT};
use kition_kits::{Bridge, DocumentApplied, DocumentApply};
use serde_json::{Value, json};

use crate::run::Run;
use crate::workspace;

/// Whether a window may have `path` open as a live Markdown document.
pub fn is_live_candidate(path: &str) -> bool {
    matches!(
        workspace::extension(path).as_deref(),
        Some("md" | "markdown")
    )
}

/// How an edit reached a document.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Delivery {
    /// Applied in the window that has the document open.
    pub live: bool,
    /// Why an edit to an open document was written to the file instead.
    pub fallback: Option<String>,
}

impl Delivery {
    pub fn file(fallback: Option<String>) -> Self {
        Self {
            live: false,
            fallback,
        }
    }

    /// Adds `live` (and `fallback`, when there is one) to a tool's output.
    pub fn record(&self, output: &mut Value) {
        output["live"] = json!(self.live);
        if let Some(reason) = &self.fallback {
            output["fallback"] = json!(reason);
        }
    }

    /// The tool summary's note, such as ` (applied live in the open editor)`.
    pub fn note(&self) -> String {
        match (&self.fallback, self.live) {
            (_, true) => " (applied live in the open editor)".to_owned(),
            (Some(reason), false) => format!(" (written to the file: {reason})"),
            (None, false) => String::new(),
        }
    }
}

/// The renderer windows' open documents, as one agent turn reaches them.
pub struct LiveDocuments<'a> {
    bridge: Option<&'a Bridge>,
    read_timeout: Duration,
    apply_timeout: Duration,
}

impl<'a> LiveDocuments<'a> {
    pub fn of(run: &'a Run) -> Self {
        Self::new(run.agent.kits().map(|kits| kits.bridge().as_ref()))
    }

    pub fn new(bridge: Option<&'a Bridge>) -> Self {
        Self {
            bridge,
            read_timeout: DOCUMENT_READ_TIMEOUT,
            apply_timeout: DOCUMENT_APPLY_TIMEOUT,
        }
    }

    #[cfg(test)]
    pub fn with_timeouts(mut self, read: Duration, apply: Duration) -> Self {
        self.read_timeout = read;
        self.apply_timeout = apply;
        self
    }

    /// The window that has the Markdown document `relative` open.
    pub fn window(&self, relative: &str) -> Option<u64> {
        if !is_live_candidate(relative) {
            return None;
        }
        self.bridge?.document_window(relative)
    }

    /// The live text of `relative` in `window`, unsaved edits included; `None` when the window
    /// no longer has it open or does not answer in time.
    pub async fn read(&self, window: u64, relative: &str) -> Option<String> {
        let bridge = self.bridge?;
        match bridge
            .read_document(window, relative, self.read_timeout)
            .await
        {
            Ok(text) => text,
            Err(error) => {
                tracing::info!(path = relative, %error, "reading a live document failed; using the file");
                None
            }
        }
    }

    /// Asks `window` to apply `content` to its open `relative` and save it: the file content
    /// after the save, or why it did not.
    pub async fn apply(
        &self,
        window: u64,
        relative: &str,
        content: &str,
        tool: &str,
    ) -> Result<String, String> {
        let bridge = self.bridge.ok_or("no editor window is connected")?;
        let edit = DocumentApply {
            path: relative.to_owned(),
            content: content.to_owned(),
            tool: tool.to_owned(),
            turn_id: None,
        };
        let outcome = match bridge
            .apply_document(window, &edit, self.apply_timeout)
            .await
        {
            Ok(DocumentApplied {
                applied: true,
                content: Some(saved),
                ..
            }) => return Ok(saved),
            Ok(DocumentApplied { reason, .. }) => {
                reason.unwrap_or_else(|| "the editor did not apply the edit".to_owned())
            }
            Err(error) => error,
        };
        tracing::info!(path = relative, reason = %outcome, "a live document edit fell back to the file");
        Err(outcome)
    }

    /// Writes the whole `content` of `relative`: through the window that has it open, else
    /// with `write_file`.
    pub async fn write(
        &self,
        relative: &str,
        content: &str,
        tool: &str,
        write_file: impl FnOnce() -> Result<(), String>,
    ) -> Result<Delivery, String> {
        let mut fallback = None;
        if let Some(window) = self.window(relative) {
            match self.apply(window, relative, content, tool).await {
                Ok(_) => {
                    return Ok(Delivery {
                        live: true,
                        fallback: None,
                    });
                }
                Err(reason) => fallback = Some(reason),
            }
        }
        write_file()?;
        Ok(Delivery::file(fallback))
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::sync::{Arc, Mutex, PoisonError};
    use std::time::Duration;

    use kition_kits::Bridge;
    use serde_json::{Value, json};

    /// A renderer window with `path` open: `document/read` answers `live_text`, and
    /// `document/apply` answers `apply` after `delay`. Returns the `document/apply` params it got.
    pub fn window(
        bridge: &Arc<Bridge>,
        path: &str,
        live_text: &'static str,
        apply: Value,
        delay: Duration,
    ) -> Arc<Mutex<Vec<Value>>> {
        let (session, mut rx) = bridge.connect();
        bridge
            .receive(
                session,
                &json!({ "method": "documents.open", "params": { "paths": [path] } }),
            )
            .unwrap_or_else(|err| panic!("{err}"));
        let received = Arc::new(Mutex::new(Vec::new()));
        let (bridge, log) = (bridge.clone(), received.clone());
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let Some(id) = message["id"].as_u64() else {
                    continue;
                };
                let result = match message["method"].as_str() {
                    Some("document/read") => json!({ "open": true, "content": live_text }),
                    _ => {
                        log.lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .push(message["params"].clone());
                        tokio::time::sleep(delay).await;
                        apply.clone()
                    }
                };
                let _ = bridge.receive(session, &json!({ "id": id, "result": result }));
            }
        });
        received
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::testing::window;
    use super::*;

    #[tokio::test]
    async fn writes_go_live_or_fall_back_to_the_file() {
        let bridge = Arc::new(Bridge::default());
        let live = LiveDocuments::new(Some(&bridge))
            .with_timeouts(Duration::from_millis(50), Duration::from_millis(50));
        let mut written = Vec::new();

        // No window has it open: the file.
        let delivery = live
            .write("a.md", "x", "document_write", || {
                written.push("a.md");
                Ok(())
            })
            .await;
        assert_eq!(delivery, Ok(Delivery::file(None)));

        let applied = json!({ "applied": true, "content": "x" });
        let a = window(&bridge, "a.md", "", applied.clone(), Duration::ZERO);
        window(
            &bridge,
            "b.md",
            "",
            json!({ "applied": false, "reason": "conflict" }),
            Duration::ZERO,
        );
        window(
            &bridge,
            "slow.md",
            "",
            applied.clone(),
            Duration::from_millis(500),
        );
        window(&bridge, "c.txt", "", applied, Duration::ZERO);

        let delivery = live
            .write("a.md", "x", "document_write", || {
                written.push("a.md (live)");
                Ok(())
            })
            .await;
        assert_eq!(
            delivery,
            Ok(Delivery {
                live: true,
                fallback: None
            })
        );
        let delivery = live
            .write("b.md", "x", "document_write", || {
                written.push("b.md");
                Ok(())
            })
            .await;
        assert_eq!(delivery, Ok(Delivery::file(Some("conflict".into()))));
        let delivery = live
            .write("slow.md", "x", "document_write", || {
                written.push("slow.md");
                Ok(())
            })
            .await;
        assert_eq!(
            delivery,
            Ok(Delivery::file(Some(
                "the editor did not answer `document/apply` in time".into()
            )))
        );
        let delivery = live
            .write("c.txt", "x", "document_write", || {
                written.push("c.txt");
                Ok(())
            })
            .await;
        assert_eq!(
            delivery,
            Ok(Delivery::file(None)),
            "only Markdown goes live"
        );
        assert_eq!(written, ["a.md", "b.md", "slow.md", "c.txt"]);
        assert_eq!(
            *a.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
            [json!({ "path": "a.md", "content": "x", "tool": "document_write" })]
        );
    }

    #[tokio::test]
    async fn without_a_bridge_everything_is_a_file() {
        let live = LiveDocuments::new(None);
        assert_eq!(live.window("a.md"), None);
        assert_eq!(live.read(1, "a.md").await, None);
        assert!(live.apply(1, "a.md", "x", "document_write").await.is_err());
    }

    #[test]
    fn records_how_an_edit_was_delivered() {
        let mut output = json!({ "path": "a.md" });
        Delivery::file(Some("conflict".into())).record(&mut output);
        assert_eq!(
            output,
            json!({ "path": "a.md", "live": false, "fallback": "conflict" })
        );
        assert_eq!(
            Delivery {
                live: true,
                fallback: None
            }
            .note(),
            " (applied live in the open editor)"
        );
        assert_eq!(Delivery::default().note(), "");
    }
}
