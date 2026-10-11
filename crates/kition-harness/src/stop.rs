//! Turn-ending rules and recovery prompts built on tool metadata, ported from
//! Kition's original loop (DeepSeek Harness `agent/turn-stopping` and
//! post-execute `additionalContexts`).

use crate::events::{ContentBlock, EventBody, SessionEvent};
use crate::policy::{CallInfo, Policy};
use crate::tool::{Settled, ToolRegistry};

/// Decides, when the model stops calling tools, whether the turn may end.
pub trait StopCheck: Send + Sync {
    /// `turn_events` are this turn's events so far. `Some` fails the turn
    /// with that message.
    fn check(&self, turn_events: &[SessionEvent], tools: &ToolRegistry) -> Option<String>;
}

/// A turn whose most recent workspace-changing call failed may not end as
/// completed.
pub struct UnresolvedWrites;

impl StopCheck for UnresolvedWrites {
    fn check(&self, turn_events: &[SessionEvent], tools: &ToolRegistry) -> Option<String> {
        let mut unresolved = None;
        for event in turn_events {
            if let EventBody::ToolResult {
                name,
                is_error,
                content,
                ..
            } = &event.body
                && tools.get(name).is_some_and(|tool| tool.writes)
            {
                unresolved = is_error.then(|| {
                    let message = content
                        .iter()
                        .find_map(|block| match block {
                            ContentBlock::Text { text } => Some(text.clone()),
                            ContentBlock::Image { .. } => None,
                        })
                        .unwrap_or_default();
                    format!("agent did not recover from failed workspace tool {name}: {message}")
                });
            }
        }
        unresolved
    }
}

/// After a failed call, tells the model the task is not complete and how to
/// recover. The original loop recovers after every failed tool result,
/// including one the model asked for that is not registered this turn, so
/// `post_missing` carries the same text.
pub struct RecoveryPrompt;

impl RecoveryPrompt {
    fn recover(name: &str, settled: &mut Settled) {
        let failure = settled
            .content
            .iter()
            .find_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                ContentBlock::Image { .. } => None,
            })
            .unwrap_or("the tool failed");
        settled.context.push(ContentBlock::text(
            [
                "[tool recovery required] The previous tool call failed and the user's task is not complete.".to_owned(),
                format!("Failed tool: {name}"),
                format!("Failure: {failure}"),
                "Inspect the latest state and recover now. For a failed apply_patch, reread the target and retry with a smaller exact patch or use document_write for a whole-document rewrite. Do not return an empty response or claim completion while the write is unresolved.".to_owned(),
            ]
            .join("\n"),
        ));
    }
}

impl Policy for RecoveryPrompt {
    fn post_execute(&self, call: &CallInfo<'_>, settled: &mut Settled) {
        if !settled.is_error {
            return;
        }
        Self::recover(&call.tool.name, settled);
    }

    fn post_missing(&self, call_name: &str, settled: &mut Settled) {
        Self::recover(call_name, settled);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::tool::{ToolDef, define};

    fn tool(name: &str, writes: bool) -> ToolDef {
        let builder = define(name, "t").execute(|_, _| async { Ok(Value::Null) });
        let builder = if writes { builder.writes() } else { builder };
        builder.build().unwrap_or_else(|error| panic!("{error}"))
    }

    fn result(seq: u64, name: &str, is_error: bool) -> SessionEvent {
        SessionEvent {
            seq,
            at: 0,
            body: EventBody::ToolResult {
                call_id: format!("c{seq}"),
                name: name.into(),
                value: Value::Null,
                content: vec![ContentBlock::text("x")],
                is_error,
                meta: None,
            },
        }
    }

    #[test]
    fn a_failed_last_write_stops_the_turn_and_a_later_success_clears_it() {
        let mut tools = ToolRegistry::default();
        tools
            .register(tool("write", true))
            .unwrap_or_else(|error| panic!("{error}"));
        tools
            .register(tool("read", false))
            .unwrap_or_else(|error| panic!("{error}"));
        let check = UnresolvedWrites;
        let failed = [result(1, "write", true), result(2, "read", false)];
        assert!(
            check
                .check(&failed, &tools)
                .is_some_and(|error| error.contains("write"))
        );
        let recovered = [result(1, "write", true), result(2, "write", false)];
        assert_eq!(check.check(&recovered, &tools), None);
        assert_eq!(check.check(&[result(1, "read", true)], &tools), None);
    }

    #[test]
    fn failed_calls_get_a_recovery_prompt() {
        let args = json!({});
        let write = tool("write", true);
        let call = CallInfo {
            session: "s",
            call_id: "c",
            tool: &write,
            arguments: &args,
        };
        let mut settled = Settled::error("disk full", None);
        RecoveryPrompt.post_execute(&call, &mut settled);
        let ContentBlock::Text { text } = &settled.context[0] else {
            panic!("expected text")
        };
        assert!(text.starts_with("[tool recovery required]"), "{text}");
        assert!(text.contains("Failed tool: write"), "{text}");
        let mut ok = Settled {
            value: Value::Null,
            content: Vec::new(),
            is_error: false,
            meta: None,
            context: Vec::new(),
        };
        RecoveryPrompt.post_execute(&call, &mut ok);
        assert!(ok.context.is_empty());
    }

    #[test]
    fn a_missing_tool_gets_the_same_recovery_prompt() {
        let mut settled = Settled::error("tool `ghost` is not available in this turn", None);
        RecoveryPrompt.post_missing("ghost", &mut settled);
        let ContentBlock::Text { text } = &settled.context[0] else {
            panic!("expected text")
        };
        assert!(text.starts_with("[tool recovery required]"), "{text}");
        assert!(text.contains("Failed tool: ghost"), "{text}");
    }
}
