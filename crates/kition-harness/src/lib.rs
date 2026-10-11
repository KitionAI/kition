//! The agent harness: an append-only session log, a turn and step driver that
//! derives every model request from that log, tools in the DeepSeek Harness
//! `defineTool` shape with a policy pipeline, and the provider seam through
//! which panes and kits contribute to a turn.

pub mod cancel;
pub mod derive;
pub mod driver;
pub mod events;
pub mod history;
pub mod llm;
pub mod log;
pub mod policy;
pub mod provider;
pub mod schema;
pub mod stop;
pub mod testing;
pub mod tool;

/// The DeepSeek Harness release whose contracts this crate follows (Kit
/// Standard D4). Change it only together with a conformance re-run.
pub const DSH_TARGET: &str = "0.2.1-alpha.2 (d7432673)";

#[cfg(test)]
mod tests {
    use super::events::EventBody;

    /// From `packages/core/session/src/known-event-types.ts` at the pinned
    /// release. A name outside this list would be an invented event.
    const DSH_KNOWN: &[&str] = &[
        "approval/asked",
        "approval/decided",
        "assistant/attempt",
        "assistant/message",
        "deliverables/presented",
        "llm/retry",
        "permission/preset",
        "step/end",
        "step/start",
        "system/message",
        "todo/write",
        "tool/call",
        "tool/result",
        "turn/end",
        "turn/start",
        "user/message",
    ];

    #[test]
    fn every_event_name_exists_in_the_pinned_dsh_release() {
        for kind in EventBody::KINDS {
            assert!(
                DSH_KNOWN.contains(kind),
                "`{kind}` is not a DeepSeek Harness {} event",
                super::DSH_TARGET
            );
        }
    }
}
