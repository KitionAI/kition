//! The pipeline around a tool body (DeepSeek Harness `tools/pre-execute` and
//! `tools/post-execute`): policies allow, deny, or ask before a call, and may
//! adjust a settled result after it.

use std::sync::Arc;

use serde_json::Value;

use crate::tool::{Settled, ToolDef};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// The body does not run; the model sees the reason as an error result.
    Deny(String),
    /// The person must approve; the turn pauses.
    Ask(String),
}

/// One pending call as policies see it.
pub struct CallInfo<'a> {
    pub session: &'a str,
    pub call_id: &'a str,
    pub tool: &'a ToolDef,
    pub arguments: &'a Value,
}

pub trait Policy: Send + Sync {
    fn pre_execute(&self, _call: &CallInfo<'_>) -> Decision {
        Decision::Allow
    }

    fn post_execute(&self, _call: &CallInfo<'_>, _settled: &mut Settled) {}
}

/// Denies tools that change the workspace when the session may not write.
pub struct WritePermission {
    pub may_write: bool,
}

impl Policy for WritePermission {
    fn pre_execute(&self, call: &CallInfo<'_>) -> Decision {
        if call.tool.writes && !self.may_write {
            Decision::Deny(format!(
                "{} changes the workspace, and this session is read-only",
                call.tool.name
            ))
        } else {
            Decision::Allow
        }
    }
}

/// Policies in order. Before a call every policy runs: a `Deny` from any
/// policy outranks everything else, otherwise the first `Ask` wins,
/// otherwise `Allow`. After a call every policy's `post_execute` runs in
/// order.
#[derive(Clone, Default)]
pub struct Pipeline {
    policies: Vec<Arc<dyn Policy>>,
}

impl std::fmt::Debug for Pipeline {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Pipeline")
            .field("policies", &self.policies.len())
            .finish()
    }
}

impl Pipeline {
    pub fn with(mut self, policy: impl Policy + 'static) -> Self {
        self.policies.push(Arc::new(policy));
        self
    }

    pub fn decide(&self, call: &CallInfo<'_>) -> Decision {
        let mut ask = None;
        for policy in &self.policies {
            match policy.pre_execute(call) {
                Decision::Allow => {}
                deny @ Decision::Deny(_) => return deny,
                asked @ Decision::Ask(_) => {
                    ask.get_or_insert(asked);
                }
            }
        }
        ask.unwrap_or(Decision::Allow)
    }

    pub fn settle(&self, call: &CallInfo<'_>, settled: &mut Settled) {
        for policy in &self.policies {
            policy.post_execute(call, settled);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::events::ContentBlock;
    use crate::tool::define;

    fn tool(writes: bool) -> ToolDef {
        let builder = define("t", "test").execute(|_, _| async { Ok(Value::Null) });
        let builder = if writes { builder.writes() } else { builder };
        builder.build().unwrap_or_else(|error| panic!("{error}"))
    }

    struct AskForAll;
    impl Policy for AskForAll {
        fn pre_execute(&self, _call: &CallInfo<'_>) -> Decision {
            Decision::Ask("confirm".into())
        }
    }

    struct Redact;
    impl Policy for Redact {
        fn post_execute(&self, _call: &CallInfo<'_>, settled: &mut Settled) {
            settled.content = vec![ContentBlock::text("[redacted]")];
        }
    }

    #[test]
    fn deny_and_ask_decisions_and_post_settle_in_order() {
        let args = json!({});
        let writer = tool(true);
        let call = CallInfo {
            session: "s",
            call_id: "c",
            tool: &writer,
            arguments: &args,
        };
        let read_only = Pipeline::default()
            .with(WritePermission { may_write: false })
            .with(AskForAll);
        assert!(
            matches!(read_only.decide(&call), Decision::Deny(reason) if reason.contains("read-only"))
        );
        let writable = Pipeline::default()
            .with(WritePermission { may_write: true })
            .with(AskForAll);
        assert_eq!(writable.decide(&call), Decision::Ask("confirm".into()));
        let reader = tool(false);
        let call = CallInfo {
            session: "s",
            call_id: "c",
            tool: &reader,
            arguments: &args,
        };
        assert_eq!(
            Pipeline::default()
                .with(WritePermission { may_write: false })
                .decide(&call),
            Decision::Allow
        );
        let mut settled = Settled {
            value: Value::Null,
            content: Vec::new(),
            is_error: false,
            meta: None,
        };
        Pipeline::default().with(Redact).settle(&call, &mut settled);
        assert_eq!(settled.content, vec![ContentBlock::text("[redacted]")]);
    }

    #[test]
    fn a_deny_from_any_policy_outranks_an_earlier_ask() {
        let args = json!({});
        let writer = tool(true);
        let call = CallInfo {
            session: "s",
            call_id: "c",
            tool: &writer,
            arguments: &args,
        };
        let pipeline = Pipeline::default()
            .with(AskForAll)
            .with(WritePermission { may_write: false });
        assert!(
            matches!(pipeline.decide(&call), Decision::Deny(reason) if reason.contains("read-only"))
        );
        let reader = tool(false);
        let call = CallInfo {
            session: "s",
            call_id: "c",
            tool: &reader,
            arguments: &args,
        };
        let pipeline = Pipeline::default()
            .with(AskForAll)
            .with(WritePermission { may_write: false });
        assert_eq!(pipeline.decide(&call), Decision::Ask("confirm".into()));
    }

    #[test]
    fn debug_shows_the_policy_count_not_the_policies_themselves() {
        let pipeline = Pipeline::default()
            .with(AskForAll)
            .with(WritePermission { may_write: true });
        assert_eq!(format!("{pipeline:?}"), "Pipeline { policies: 2 }");
    }
}
