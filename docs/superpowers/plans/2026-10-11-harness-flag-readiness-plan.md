# Harness Flag Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps that keep `KITION_AGENT_HARNESS=1` from being turned on
outside development: bounded history, carry-over of sessions that started
without the flag, an explicit error for a second turn while one is running, and
a stop that does not wait for a long tool.

**Architecture:** History bounding is a pure event filter in `kition-harness`,
applied by the driver before deriving a request. Carry-over, the busy check,
and cancel-aware tool calls live in `kition-agent` (`harness_turn.rs`,
`session.rs`). Provider-agnostic throughout.

**Tech Stack:** Rust (`kition-harness`, `kition-agent`).

**Base:** `feat/kit-photo-tab` at or after `3c53dc25`. Do not edit
`crates/kition-agent/src/tools/kits.rs` or `tools/mod.rs` (owned by the kit
line). Build with `CARGO_INCREMENTAL=0`.

---

### Task 1: Bound the history a request carries

**Files:**
- Create: `crates/kition-harness/src/history.rs`
- Modify: `crates/kition-harness/src/lib.rs`, `crates/kition-harness/src/driver.rs`

The original loop sends the last 16 user and assistant messages as plain text.
The harness sends every turn in full. Rule: the last `full_turns` turns (the
current one included) are sent in full; older turns contribute only their
user messages and their assistant text replies (no tool calls or results), at
most `older_messages` of them, newest kept. System messages are always kept
(derivation uses the newest). Events logged before the first `turn/start`
(carried-over messages, Task 2) count as older.

- [ ] **Step 1: Write the failing tests** (`history.rs`)

```rust
//! Which logged events a request carries: recent turns in full, older turns
//! as plain conversation, like the original loop's last 16 messages.

use crate::events::{EventBody, SessionEvent};

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::events::{ContentBlock, LoggedCall, TurnEndReason};

    fn at(seq: u64, body: EventBody) -> SessionEvent {
        SessionEvent { seq, at: 0, body }
    }

    fn turn(seq: &mut u64, number: u32, text: &str) -> Vec<SessionEvent> {
        let mut next = |body| {
            *seq += 1;
            at(*seq, body)
        };
        vec![
            next(EventBody::TurnStart { turn: number }),
            next(EventBody::UserMessage { content: vec![ContentBlock::text(format!("ask {text}"))] }),
            next(EventBody::AssistantMessage {
                content: String::new(),
                tool_calls: vec![LoggedCall { call_id: format!("c{number}"), name: "read".into(), arguments: json!({}) }],
                stop_reason: "tool_use".into(),
                model: "m".into(),
                raw_items: Vec::new(),
            }),
            next(EventBody::ToolCall { call_id: format!("c{number}"), name: "read".into(), arguments: json!({}) }),
            next(EventBody::ToolResult {
                call_id: format!("c{number}"),
                name: "read".into(),
                value: json!({}),
                content: vec![ContentBlock::text("data")],
                is_error: false,
                meta: None,
            }),
            next(EventBody::AssistantMessage {
                content: format!("answer {text}"),
                tool_calls: Vec::new(),
                stop_reason: "stop".into(),
                model: "m".into(),
                raw_items: Vec::new(),
            }),
            next(EventBody::TurnEnd { turn: number, reason: TurnEndReason::Completed, error: String::new() }),
        ]
    }

    #[test]
    fn older_turns_keep_only_their_conversation() {
        let mut seq = 0;
        let mut events = vec![at(0, EventBody::SystemMessage { content: "sys".into() })];
        for number in 1..=4 {
            events.extend(turn(&mut seq, number, &number.to_string()));
        }
        let kept = bound_history(&events, HistoryBudget { full_turns: 2, older_messages: 16 });
        let kinds: Vec<&str> = kept.iter().map(|event| event.body.kind()).collect();
        assert_eq!(kinds.iter().filter(|kind| **kind == "tool/result").count(), 2);
        assert_eq!(kinds.iter().filter(|kind| **kind == "turn/start").count(), 2);
        assert_eq!(kinds[0], "system/message");
        let texts: Vec<String> = kept
            .iter()
            .filter_map(|event| match &event.body {
                EventBody::AssistantMessage { content, tool_calls, .. } if tool_calls.is_empty() => Some(content.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, ["answer 1", "answer 2", "answer 3", "answer 4"]);
    }

    #[test]
    fn older_conversation_is_capped_newest_first() {
        let mut seq = 0;
        let mut events = Vec::new();
        for number in 1..=10 {
            events.extend(turn(&mut seq, number, &number.to_string()));
        }
        let kept = bound_history(&events, HistoryBudget { full_turns: 1, older_messages: 4 });
        let older_users: Vec<String> = kept
            .iter()
            .take_while(|event| !matches!(event.body, EventBody::TurnStart { turn: 10 }))
            .filter_map(|event| match &event.body {
                EventBody::UserMessage { content } => match &content[0] {
                    ContentBlock::Text { text } => Some(text.clone()),
                    ContentBlock::Image { .. } => None,
                },
                _ => None,
            })
            .collect();
        assert_eq!(older_users, ["ask 8", "ask 9"]);
    }

    #[test]
    fn events_before_any_turn_count_as_older() {
        let events = vec![
            at(1, EventBody::UserMessage { content: vec![ContentBlock::text("carried")] }),
            at(2, EventBody::AssistantMessage {
                content: "carried reply".into(),
                tool_calls: Vec::new(),
                stop_reason: String::new(),
                model: String::new(),
                raw_items: Vec::new(),
            }),
            at(3, EventBody::TurnStart { turn: 1 }),
        ];
        assert_eq!(bound_history(&events, HistoryBudget { full_turns: 1, older_messages: 1 }).len(), 2);
    }
}
```

Add `pub mod history;` to `lib.rs`.

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-harness history`
Expected: compile errors (`bound_history`, `HistoryBudget` not found).

- [ ] **Step 3: Implement above the tests**

```rust
/// How much history a request carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryBudget {
    /// The newest turns sent in full, the current turn included.
    pub full_turns: usize,
    /// At most this many user messages and assistant text replies from
    /// older turns, newest kept.
    pub older_messages: usize,
}

impl Default for HistoryBudget {
    fn default() -> Self {
        Self { full_turns: 3, older_messages: 16 }
    }
}

/// The events a request is derived from under `budget`.
pub fn bound_history(events: &[SessionEvent], budget: HistoryBudget) -> Vec<SessionEvent> {
    let starts: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| matches!(event.body, EventBody::TurnStart { .. }))
        .map(|(index, _)| index)
        .collect();
    let full_from = if budget.full_turns == 0 || starts.len() < budget.full_turns {
        starts.first().copied().unwrap_or(events.len())
    } else {
        starts[starts.len() - budget.full_turns]
    };
    let (older, recent) = events.split_at(full_from);
    let conversation: Vec<&SessionEvent> = older
        .iter()
        .filter(|event| match &event.body {
            EventBody::UserMessage { .. } => true,
            EventBody::AssistantMessage { tool_calls, content, .. } => tool_calls.is_empty() && !content.is_empty(),
            _ => false,
        })
        .collect();
    let skip = conversation.len().saturating_sub(budget.older_messages);
    let mut kept: Vec<SessionEvent> = older
        .iter()
        .filter(|event| matches!(event.body, EventBody::SystemMessage { .. }))
        .cloned()
        .collect();
    kept.extend(conversation.into_iter().skip(skip).cloned());
    kept.sort_by_key(|event| event.seq);
    kept.extend(recent.iter().cloned());
    kept
}
```

Note: `full_turns == 0` would drop the current turn; the budget treats it as
"everything since the first turn". The sort by `seq` restores log order after
merging system messages with the conversation; carried-over events (Task 2)
have increasing `seq` from the log, so order is preserved.

- [ ] **Step 4: Apply it in the driver**

Add `pub history: crate::history::HistoryBudget` to `Driver` (default in
`new`, shown in its `Debug`), and where the driver derives a request, derive
from `bound_history(&events, self.history)` instead of `&events`. Add a driver
test: three completed scripted turns with a tool call each and
`driver.history = HistoryBudget { full_turns: 1, older_messages: 16 }`; the
fourth turn's request has no `tool` role messages from turns 1 to 3.

- [ ] **Step 5: Run, lint, commit**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-harness && CARGO_INCREMENTAL=0 cargo clippy -p kition-harness --all-targets -- -D warnings`

```bash
git add crates/kition-harness
git commit -m "Bound the history a harness request carries"
```

### Task 2: Carry over sessions that started without the flag

**Files:**
- Modify: `crates/kition-agent/src/harness_turn.rs`

On the first harness turn of a session whose harness log is empty, append the
session's previous user and assistant messages (the original loop's last 16,
`table_plan` blocks stripped, the triggering message excluded) as
`user/message` and `assistant/message` events, before the driver runs. They are
model-visible, so they are logged.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn an_empty_log_is_seeded_with_the_previous_conversation() {
        let log = MemoryLog::default();
        let history = vec![
            ("user".to_owned(), "first".to_owned()),
            ("assistant".to_owned(), "reply".to_owned()),
            ("tool".to_owned(), "ignored".to_owned()),
        ];
        seed(&log, "agent:7", &history).unwrap_or_else(|error| panic!("{error}"));
        let kinds: Vec<&str> = log.read("agent:7").unwrap_or_else(|error| panic!("{error}")).iter().map(|e| e.body.kind()).collect();
        assert_eq!(kinds, ["user/message", "assistant/message"]);
        seed(&log, "agent:7", &history).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(log.read("agent:7").unwrap_or_else(|error| panic!("{error}")).len(), 2, "a non-empty log is left alone");
    }
```

- [ ] **Step 2: Implement**

```rust
/// Logs a session's earlier conversation the first time it runs on the
/// harness, so turns started without the flag keep their context.
fn seed(log: &dyn SessionLog, key: &str, history: &[(String, String)]) -> Result<(), String> {
    if !log.read(key)?.is_empty() {
        return Ok(());
    }
    for (role, content) in history {
        let body = match role.as_str() {
            "user" => EventBody::UserMessage { content: vec![ContentBlock::text(content.clone())] },
            "assistant" => EventBody::AssistantMessage {
                content: content.clone(),
                tool_calls: Vec::new(),
                stop_reason: String::new(),
                model: String::new(),
                raw_items: Vec::new(),
            },
            _ => continue,
        };
        log.append(key, body)?;
    }
    Ok(())
}
```

In `drive`, after taking the session lock and before building the driver,
load the history the way `session::build_messages` does
(`store::recent_messages(conn, id, user, 17)`, drop the triggering message,
keep the last 16 user/assistant ones, `table_plan::strip_block` on assistant
content) and call `seed` with the `SqliteLog` the driver will use. A seeding
error is logged with `tracing::warn!` and the turn continues.

- [ ] **Step 3: Run, lint, commit**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-agent && CARGO_INCREMENTAL=0 cargo clippy -p kition-agent --all-targets -- -D warnings`

```bash
git add crates/kition-agent
git commit -m "Carry earlier conversation into a session's first harness turn"
```

### Task 3: Refuse a second turn while one is running

**Files:**
- Modify: `crates/kition-agent/src/harness_turn.rs`, `crates/kition-agent/src/session.rs`

- [ ] **Step 1: Write the failing test** (`harness_turn.rs`)

```rust
    #[tokio::test]
    async fn a_running_turn_marks_its_session_busy() {
        assert!(!is_busy(9001));
        let held = session_lock(9001).lock_owned().await;
        assert!(is_busy(9001));
        drop(held);
        assert!(!is_busy(9001));
    }
```

- [ ] **Step 2: Implement**

```rust
/// Whether a harness turn of this session is running.
pub fn is_busy(session_id: i64) -> bool {
    session_lock(session_id).try_lock().is_err()
}
```

In `session::prepare`, after loading the session:

```rust
    if agent.harness() && crate::harness_turn::is_busy(session_id) {
        return Err(AppError::conflict(
            "This session is still answering. Wait for the reply or stop it first.",
        ));
    }
```

In `drive`, replace `lock_owned().await` with `try_lock_owned()`; on failure
(a race between `prepare` and here) send
`Frame::error("This session is still answering. Wait for the reply or stop it first.")`
and return.

- [ ] **Step 3: Run, lint, commit**

```bash
git add crates/kition-agent
git commit -m "Refuse a second harness turn while one is running"
```

### Task 4: Stop without waiting for a long tool

**Files:**
- Modify: `crates/kition-agent/src/harness_turn.rs`

When the person stops a turn, the harness stops waiting for the running tool.
The tool keeps running in the background (its row, events, and files finish
normally, so nothing is left half-written) and its result is discarded.

- [ ] **Step 1: Write the failing test**

```rust
    #[tokio::test]
    async fn a_cancelled_wait_returns_early_and_the_work_finishes_anyway() {
        let cancel = Cancel::default();
        let finished = Arc::new(AtomicBool::new(false));
        let done = finished.clone();
        let work = async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            done.store(true, Ordering::SeqCst);
            7
        };
        let stopper = cancel.clone();
        tokio::spawn(async move { stopper.cancel() });
        assert_eq!(unless_cancelled(work, &cancel).await, None);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(finished.load(Ordering::SeqCst));
        assert_eq!(unless_cancelled(async { 8 }, &Cancel::default()).await, Some(8));
    }
```

- [ ] **Step 2: Implement**

```rust
/// Runs `work` in its own task and waits for it unless the turn is
/// cancelled first; then it keeps running and its result is dropped.
async fn unless_cancelled<T: Send + 'static>(
    work: impl std::future::Future<Output = T> + Send + 'static,
    cancel: &Cancel,
) -> Option<T> {
    let task = tokio::spawn(work);
    tokio::select! {
        result = task => result.ok(),
        () = cancel.cancelled() => None,
    }
}
```

In `legacy_call`, run the tool through it:

```rust
    let (task_run, task_name, raw) = (run.clone(), name.to_owned(), args.to_string());
    let Some(executed) = unless_cancelled(
        async move { tools::execute(&task_run, &task_name, &raw).await },
        &cx.cancel,
    )
    .await
    else {
        return Err(ToolFailure::from(
            "stopped by the user; the tool may still finish in the background",
        ));
    };
```

replacing `let executed = tools::execute(run, name, &args.to_string()).await;`.

- [ ] **Step 3: Run, lint, commit**

```bash
git add crates/kition-agent
git commit -m "Stop harness turns without waiting for a long tool"
```

### Task 5: Gates

- [ ] `CARGO_INCREMENTAL=0 cargo test -p kition-agent --test agent_flow` (6/6)
- [ ] `pnpm check:desktop`, `python3 scripts/check-i18n.py`, and
  `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy pnpm test:table:e2e`
- [ ] Update the "Found in phase B reviews and deferred" list in
  `docs/superpowers/plans/2026-10-11-harness-agent-phase-b-plan.md`: remove the
  four items this plan closes.
