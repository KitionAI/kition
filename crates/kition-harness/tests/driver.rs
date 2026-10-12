//! End-to-end turns with a scripted model and an in-memory log.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::future::BoxFuture;
use kition_harness::cancel::Cancel;
use kition_harness::driver::{
    AssistantStreamFrame, Driver, Live, StreamOutcome, TurnInput, append_live, fail_turn, next_turn,
};
use kition_harness::events::{
    ContentBlock, EventBody, MessageSource, PresentedFile, SessionEvent, TodoItem, TodoStatus,
    TurnEndReason,
};
use kition_harness::history::HistoryBudget;
use kition_harness::llm::{HostedCall, Llm, LlmReply, LlmRequest, LlmSink, RetryInfo, StreamChunk};
use kition_harness::log::{MemoryLog, SessionLog};
use kition_harness::policy::{CallInfo, Decision, Pipeline, Policy, WritePermission};
use kition_harness::testing::{ScriptedCall, ScriptedLlm, call};
use kition_harness::tool::{ToolDef, ToolRegistry, define};
use serde_json::json;
use tokio::sync::Notify;

fn echo(ran: Arc<AtomicBool>) -> ToolDef {
    define("echo", "Echo text")
        .parameters(json!({ "text": { "type": "string", "required": true } }))
        .writes()
        .execute(move |args, _cx| {
            let ran = ran.clone();
            async move {
                ran.store(true, Ordering::SeqCst);
                Ok(json!({ "text": args["text"] }))
            }
        })
        .render(|_args, value| {
            vec![ContentBlock::text(
                value["text"].as_str().unwrap_or_default(),
            )]
        })
        .build()
        .unwrap_or_else(|error| panic!("{error}"))
}

struct Setup {
    log: Arc<MemoryLog>,
    llm: Arc<ScriptedLlm>,
    ran: Arc<AtomicBool>,
    live: Arc<Mutex<Vec<Live>>>,
}

fn setup(replies: Vec<LlmReply>) -> Setup {
    Setup {
        log: Arc::new(MemoryLog::default()),
        llm: Arc::new(ScriptedLlm::new(replies)),
        ran: Arc::new(AtomicBool::new(false)),
        live: Arc::new(Mutex::new(Vec::new())),
    }
}

impl Setup {
    fn driver(&self, pipeline: Pipeline) -> Driver {
        let mut driver = Driver::new(self.log.clone(), self.llm.clone());
        driver.pipeline = pipeline;
        driver
    }

    fn input(&self, text: &str, cancel: Cancel) -> TurnInput {
        let mut tools = ToolRegistry::default();
        tools
            .register(echo(self.ran.clone()))
            .unwrap_or_else(|error| panic!("{error}"));
        let live = self.live.clone();
        TurnInput {
            session: "s".into(),
            system: "You are Kition.".into(),
            tools,
            user: vec![ContentBlock::text(text)],
            cancel,
            live: Arc::new(move |event: Live| {
                live.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(event)
            }),
            model: None,
            source: MessageSource::user(),
            preset: None,
            stream_revision: Arc::default(),
        }
    }

    fn kinds(&self) -> Vec<&'static str> {
        self.log
            .read("s")
            .unwrap_or_else(|error| panic!("{error}"))
            .iter()
            .map(|event| event.body.kind())
            .collect()
    }
}

#[tokio::test]
async fn a_tool_turn_logs_the_dsh_lifecycle_and_feeds_results_back() {
    let setup = setup(vec![
        LlmReply::calls(vec![call("c1", "echo", json!({ "text": "hi" }))]),
        LlmReply::text("done"),
    ]);
    let reason = setup
        .driver(Pipeline::default())
        .run_turn(setup.input("say hi", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Completed);
    assert_eq!(
        setup.kinds(),
        [
            "turn/start",
            "step/start",
            "system/message",
            "user/message",
            "assistant/message",
            "tool/call",
            "tool/result",
            "step/end",
            "step/start",
            "assistant/message",
            "step/end",
            "turn/end",
        ]
    );
    let second = &setup.llm.requests()[1];
    let tool = second
        .messages
        .iter()
        .find(|message| message.role == "tool")
        .map(|message| message.content.clone());
    assert_eq!(tool.as_deref(), Some("hi"));
    assert_eq!(second.tools[0].name, "echo");
    let live = setup.live.lock().unwrap_or_else(PoisonError::into_inner);
    assert!(live.iter().any(|live| matches!(
        live,
        Live::AssistantStream(AssistantStreamFrame::Chunk {
            chunk: StreamChunk::TextDelta { text, .. },
            ..
        }) if text == "done"
    )));
    assert_eq!(live.first(), Some(&Live::Status { running: true }));
    assert_eq!(live.last(), Some(&Live::Status { running: false }));
}

#[tokio::test]
async fn a_second_turn_keeps_history_and_does_not_relog_the_system_prompt() {
    let setup = setup(vec![LlmReply::text("one"), LlmReply::text("two")]);
    let driver = setup.driver(Pipeline::default());
    driver
        .run_turn(setup.input("first", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    driver
        .run_turn(setup.input("second", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        setup
            .kinds()
            .iter()
            .filter(|kind| **kind == "system/message")
            .count(),
        1
    );
    let roles: Vec<String> = setup.llm.requests()[1]
        .messages
        .iter()
        .map(|message| message.role.clone())
        .collect();
    assert_eq!(roles, ["system", "user", "assistant", "user"]);
}

#[tokio::test]
async fn older_turns_reach_the_model_without_their_tool_traffic() {
    let mut replies = Vec::new();
    for number in 1..=3 {
        replies.push(LlmReply::calls(vec![call(
            &format!("c{number}"),
            "echo",
            json!({ "text": "x" }),
        )]));
        replies.push(LlmReply::text(&format!("answer {number}")));
    }
    replies.push(LlmReply::text("answer 4"));
    let setup = setup(replies);
    let mut driver = setup.driver(Pipeline::default());
    driver.history = HistoryBudget {
        full_turns: 1,
        older_messages: 16,
    };
    for number in 1..=4 {
        let reason = driver
            .run_turn(setup.input(&format!("ask {number}"), Cancel::default()))
            .await
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(reason, TurnEndReason::Completed);
    }
    let requests = setup.llm.requests();
    assert_eq!(requests.len(), 7);
    let fourth = &requests[6];
    assert!(
        fourth.messages.iter().all(|message| message.role != "tool"),
        "{:?}",
        fourth.messages
    );
    let roles: Vec<String> = fourth
        .messages
        .iter()
        .map(|message| message.role.clone())
        .collect();
    assert_eq!(
        roles,
        [
            "system",
            "user",
            "assistant",
            "user",
            "assistant",
            "user",
            "assistant",
            "user"
        ]
    );
    assert!(
        setup
            .kinds()
            .iter()
            .filter(|kind| **kind == "tool/result")
            .count()
            == 3,
        "the log itself keeps everything"
    );
}

#[tokio::test]
async fn unknown_tools_and_denied_tools_become_error_results() {
    let setup = setup(vec![
        LlmReply::calls(vec![
            call("c1", "missing", json!({})),
            call("c2", "echo", json!({ "text": "x" })),
        ]),
        LlmReply::text("sorry"),
    ]);
    let pipeline = Pipeline::default().with(WritePermission { may_write: false });
    setup
        .driver(pipeline)
        .run_turn(setup.input("go", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(!setup.ran.load(Ordering::SeqCst));
    let errors = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .into_iter()
        .filter(|event| matches!(event.body, EventBody::ToolResult { is_error: true, .. }))
        .count();
    assert_eq!(errors, 2);
}

#[tokio::test]
async fn unregistered_tools_get_the_recovery_prompt_too() {
    use kition_harness::stop::RecoveryPrompt;
    let setup = setup(vec![
        LlmReply::calls(vec![call("c1", "missing", json!({}))]),
        LlmReply::text("sorry"),
    ]);
    setup
        .driver(Pipeline::default().with(RecoveryPrompt))
        .run_turn(setup.input("go", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let second = &setup.llm.requests()[1];
    let last = second
        .messages
        .last()
        .map(|message| message.content.clone())
        .unwrap_or_default();
    assert!(last.starts_with("[tool recovery required]"), "{last}");
    assert!(last.contains("Failed tool: missing"), "{last}");
}

struct AskEverything;
impl Policy for AskEverything {
    fn pre_execute(&self, _call: &CallInfo<'_>) -> Decision {
        Decision::Ask("Run echo?".into())
    }
}

#[tokio::test]
async fn ask_pauses_the_turn_for_approval() {
    let setup = setup(vec![LlmReply::calls(vec![call(
        "c1",
        "echo",
        json!({ "text": "x" }),
    )])]);
    let reason = setup
        .driver(Pipeline::default().with(AskEverything))
        .run_turn(setup.input("go", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::AwaitingApproval);
    assert!(!setup.ran.load(Ordering::SeqCst));
    let kinds = setup.kinds();
    assert_eq!(
        &kinds[kinds.len() - 4..],
        ["tool/call", "approval/asked", "step/end", "turn/end"]
    );
    let asked = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .into_iter()
        .find_map(|event| match event.body {
            body @ EventBody::ApprovalAsked { .. } => Some(body),
            _ => None,
        });
    assert_eq!(
        asked,
        Some(EventBody::ApprovalAsked {
            id: "approval:c1".into(),
            tool_name: "echo".into(),
            call_id: "c1".into(),
            reason: "Run echo?".into(),
        })
    );
}

#[tokio::test]
async fn user_messages_name_their_source() {
    use kition_harness::stop::RecoveryPrompt;
    let mut first = LlmReply::calls(vec![call("c1", "missing", json!({}))]);
    first.follow_up = vec![ContentBlock::text("hosted image saved")];
    let setup = setup(vec![first, LlmReply::text("done")]);
    let mut input = setup.input("resume", Cancel::default());
    input.source = MessageSource::new("approval");
    let reason = setup
        .driver(Pipeline::default().with(RecoveryPrompt))
        .run_turn(input)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Completed);
    let sources: Vec<String> = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .into_iter()
        .filter_map(|event| match event.body {
            EventBody::UserMessage { source, .. } => Some(source.kind),
            _ => None,
        })
        .collect();
    assert_eq!(sources, ["approval", "recovery", "tool-follow-up"]);
}

#[test]
fn a_turn_that_cannot_start_is_logged_as_failed() {
    let log = MemoryLog::default();
    log.append("s", EventBody::TurnStart { turn: 1 })
        .unwrap_or_else(|error| panic!("{error}"));
    let live = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let live = live.clone();
        Arc::new(move |event: Live| {
            live.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(event)
        }) as kition_harness::driver::LiveSink
    };
    fail_turn(&log, "s", &sink, "no tools").unwrap_or_else(|error| panic!("{error}"));
    let events = log.read("s").unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(events[1].body, EventBody::TurnStart { turn: 2 });
    assert_eq!(
        events[2].body,
        EventBody::TurnEnd {
            turn: 2,
            reason: TurnEndReason::Failed,
            error: "no tools".into(),
        }
    );
    let live = live.lock().unwrap_or_else(PoisonError::into_inner);
    assert_eq!(live.first(), Some(&Live::Status { running: true }));
    assert_eq!(live.last(), Some(&Live::Status { running: false }));
    assert_eq!(live.len(), 4);
}

#[test]
fn events_appended_outside_a_turn_go_live_and_count_turns() {
    let log = MemoryLog::default();
    let live = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let live = live.clone();
        Arc::new(move |event: Live| {
            live.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(event)
        }) as kition_harness::driver::LiveSink
    };
    assert_eq!(next_turn(&[]), 1);
    let event = append_live(&log, "s", &sink, EventBody::TurnStart { turn: 1 })
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(event.seq, 0);
    assert_eq!(
        live.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_slice(),
        [Live::Event(Box::new(event))]
    );
    let events = log.read("s").unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(next_turn(&events), 2);
}

#[tokio::test]
async fn the_step_limit_ends_a_looping_turn() {
    let looping = (0..3)
        .map(|index| {
            LlmReply::calls(vec![call(
                &format!("c{index}"),
                "echo",
                json!({ "text": "x" }),
            )])
        })
        .collect();
    let setup = setup(looping);
    let mut driver = setup.driver(Pipeline::default());
    driver.max_steps = 2;
    let reason = driver
        .run_turn(setup.input("loop", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::StepLimit);
    assert_eq!(setup.llm.requests().len(), 2);
}

#[tokio::test]
async fn a_cancelled_turn_ends_without_a_model_call() {
    let setup = setup(vec![LlmReply::text("never")]);
    let cancel = Cancel::default();
    cancel.cancel();
    let reason = setup
        .driver(Pipeline::default())
        .run_turn(setup.input("go", cancel))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Cancelled);
    assert!(setup.llm.requests().is_empty());
    assert_eq!(setup.kinds(), ["turn/start", "turn/end"]);
}

#[tokio::test]
async fn a_model_failure_is_logged_as_an_attempt_and_fails_the_turn() {
    let setup = setup(Vec::new());
    let error = setup
        .driver(Pipeline::default())
        .run_turn(setup.input("go", Cancel::default()))
        .await
        .err()
        .unwrap_or_default();
    assert!(error.contains("no more replies"), "{error}");
    let events = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(
        events
            .iter()
            .any(|event| event.body.kind() == "assistant/attempt")
    );
    assert!(matches!(
        events.last().map(|event| &event.body),
        Some(EventBody::TurnEnd {
            reason: TurnEndReason::Failed,
            ..
        })
    ));
}

#[tokio::test]
async fn a_turn_with_no_new_user_content_closes_without_a_step_or_a_model_call() {
    let setup = setup(vec![LlmReply::text("never")]);
    let mut input = setup.input("ignored", Cancel::default());
    input.user = Vec::new();
    let reason = setup
        .driver(Pipeline::default())
        .run_turn(input)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Completed);
    assert_eq!(setup.kinds(), ["turn/start", "turn/end"]);
    assert!(setup.llm.requests().is_empty());
}

#[tokio::test]
async fn a_turn_after_an_awaiting_approval_turn_derives_the_pending_tool_message() {
    let setup = setup(vec![
        LlmReply::calls(vec![call("c1", "echo", json!({ "text": "x" }))]),
        LlmReply::text("ok"),
    ]);
    let driver = setup.driver(Pipeline::default().with(AskEverything));
    let first = driver
        .run_turn(setup.input("go", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(first, TurnEndReason::AwaitingApproval);
    let second = driver
        .run_turn(setup.input("continue", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(second, TurnEndReason::Completed);
    let requests = setup.llm.requests();
    let roles: Vec<&str> = requests[1]
        .messages
        .iter()
        .map(|message| message.role.as_str())
        .collect();
    assert_eq!(roles, ["system", "user", "assistant", "tool", "user"]);
    let tool_message = requests[1]
        .messages
        .iter()
        .find(|message| message.role == "tool")
        .unwrap_or_else(|| panic!("no tool message in the second request"));
    assert_eq!(
        tool_message.content,
        "Error: this call is waiting for the person's approval and has not run."
    );
}

/// A model that never answers: it signals `entered` (with a stored permit,
/// so the test cannot miss it regardless of scheduling) and then waits on a
/// `Notify` nobody ever notifies.
struct BlockingLlm {
    entered: Arc<Notify>,
    gate: Notify,
}

impl BlockingLlm {
    fn new(entered: Arc<Notify>) -> Self {
        Self {
            entered,
            gate: Notify::new(),
        }
    }
}

impl Llm for BlockingLlm {
    fn call(
        &self,
        _request: LlmRequest,
        _sink: LlmSink,
    ) -> BoxFuture<'_, Result<LlmReply, String>> {
        Box::pin(async move {
            self.entered.notify_one();
            self.gate.notified().await;
            Err("unreachable: the gate is never opened".to_owned())
        })
    }
}

#[tokio::test]
async fn cancelling_during_the_model_call_ends_the_turn_as_cancelled() {
    let log = Arc::new(MemoryLog::default());
    let entered = Arc::new(Notify::new());
    let llm = Arc::new(BlockingLlm::new(entered.clone()));
    let driver = Driver::new(log.clone(), llm);
    let cancel = Cancel::default();
    let frames = Arc::new(Mutex::new(Vec::new()));
    let input = TurnInput {
        session: "s".into(),
        system: "You are Kition.".into(),
        tools: ToolRegistry::default(),
        user: vec![ContentBlock::text("go")],
        cancel: cancel.clone(),
        live: {
            let frames = frames.clone();
            Arc::new(move |event: Live| {
                if let Live::AssistantStream(frame) = event {
                    frames
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(frame);
                }
            })
        },
        model: None,
        source: MessageSource::user(),
        preset: None,
        stream_revision: Arc::default(),
    };
    let handle = tokio::spawn(async move { driver.run_turn(input).await });
    entered.notified().await;
    cancel.cancel();
    let reason = handle
        .await
        .unwrap_or_else(|error| panic!("{error}"))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Cancelled);
    let kinds: Vec<&'static str> = log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .iter()
        .map(|event| event.body.kind())
        .collect();
    assert_eq!(
        &kinds[kinds.len() - 3..],
        ["assistant/attempt", "step/end", "turn/end"]
    );
    let attempt_seq = log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .iter()
        .find(|event| event.body.kind() == "assistant/attempt")
        .map(|event| event.seq)
        .unwrap_or_default();
    let frames = frames.lock().unwrap_or_else(PoisonError::into_inner);
    assert_eq!(
        frames.last(),
        Some(&AssistantStreamFrame::End {
            attempt_id: "s#1.1".into(),
            revision: 2,
            index: 0,
            outcome: StreamOutcome::Committed {
                event_type: "assistant/attempt".into(),
                seq: attempt_seq,
            },
        })
    );
}

#[tokio::test]
async fn run_turn_future_is_send() {
    fn assert_send<T: Send>(_: &T) {}

    let setup = setup(vec![LlmReply::text("ok")]);
    let driver = setup.driver(Pipeline::default());
    let future = driver.run_turn(setup.input("go", Cancel::default()));
    assert_send(&future);
    future.await.unwrap_or_else(|error| panic!("{error}"));
}

#[tokio::test]
async fn cancelling_inside_a_tool_body_stops_the_remaining_calls_in_the_step() {
    use kition_harness::stop::RecoveryPrompt;
    let cancel = Cancel::default();
    let cancel_for_tool = cancel.clone();
    // Fails after cancelling, so a `RecoveryPrompt` policy would normally
    // attach a "[tool recovery required]" context: a cancelled step must
    // drop that context rather than log it.
    let canceller = define("canceller", "Cancels the turn from inside its body")
        .execute(move |_args, _cx| {
            let cancel = cancel_for_tool.clone();
            async move {
                cancel.cancel();
                Err("boom".into())
            }
        })
        .build()
        .unwrap_or_else(|error| panic!("{error}"));
    let ran = Arc::new(AtomicBool::new(false));
    let ran_marker = ran.clone();
    let marker = define("marker", "Marks that its body ran")
        .execute(move |_args, _cx| {
            let ran = ran_marker.clone();
            async move {
                ran.store(true, Ordering::SeqCst);
                Ok(json!({}))
            }
        })
        .build()
        .unwrap_or_else(|error| panic!("{error}"));
    let mut tools = ToolRegistry::default();
    tools
        .register(canceller)
        .unwrap_or_else(|error| panic!("{error}"));
    tools
        .register(marker)
        .unwrap_or_else(|error| panic!("{error}"));
    let setup = setup(vec![LlmReply::calls(vec![
        call("c1", "canceller", json!({})),
        call("c2", "marker", json!({})),
    ])]);
    let input = TurnInput {
        session: "s".into(),
        system: "You are Kition.".into(),
        tools,
        user: vec![ContentBlock::text("go")],
        cancel,
        live: Arc::new(|_event: Live| {}),
        model: None,
        source: MessageSource::user(),
        preset: None,
        stream_revision: Arc::default(),
    };
    let reason = setup
        .driver(Pipeline::default().with(RecoveryPrompt))
        .run_turn(input)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Cancelled);
    assert!(!ran.load(Ordering::SeqCst));
    let events = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"));
    let has_recovery_context = events.iter().any(|event| match &event.body {
        EventBody::UserMessage { content, .. } => content.iter().any(|block| {
            matches!(block, ContentBlock::Text { text } if text.starts_with("[tool recovery required]"))
        }),
        _ => false,
    });
    assert!(!has_recovery_context, "{events:?}");
}

/// A `SessionLog` over `MemoryLog` whose `fail_at`-th append (1-indexed,
/// across every call) fails once and then gets out of the way.
struct FlakyLog {
    inner: MemoryLog,
    fail_at: usize,
    count: AtomicUsize,
}

impl FlakyLog {
    fn new(fail_at: usize) -> Self {
        Self {
            inner: MemoryLog::default(),
            fail_at,
            count: AtomicUsize::new(0),
        }
    }
}

impl SessionLog for FlakyLog {
    fn append(&self, session: &str, body: EventBody) -> Result<SessionEvent, String> {
        let count = self.count.fetch_add(1, Ordering::SeqCst) + 1;
        if count == self.fail_at {
            return Err(format!("boom: simulated failure of append #{count}"));
        }
        self.inner.append(session, body)
    }

    fn read(&self, session: &str) -> Result<Vec<SessionEvent>, String> {
        self.inner.read(session)
    }
}

fn flaky_input(fail_at: usize) -> (Arc<FlakyLog>, TurnInput) {
    let log = Arc::new(FlakyLog::new(fail_at));
    let input = TurnInput {
        session: "s".into(),
        system: "You are Kition.".into(),
        tools: ToolRegistry::default(),
        user: vec![ContentBlock::text("go")],
        cancel: Cancel::default(),
        live: Arc::new(|_event: Live| {}),
        model: None,
        source: MessageSource::user(),
        preset: None,
        stream_revision: Arc::default(),
    };
    (log, input)
}

#[tokio::test]
async fn an_append_failure_mid_turn_returns_an_error_without_panicking() {
    let (log, input) = flaky_input(2);
    let llm = Arc::new(ScriptedLlm::new(vec![LlmReply::text("done")]));
    let driver = Driver::new(log, llm);
    let error = driver.run_turn(input).await.err().unwrap_or_default();
    assert!(error.contains("boom"), "{error}");
}

#[tokio::test]
async fn an_assistant_attempt_append_failure_does_not_shadow_the_model_error() {
    // Appends: 1 turn/start, 2 step/start, 3 system/message, 4 user/message,
    // 5 assistant/attempt (fails here), 6 step/end, 7 turn/end.
    let (log, input) = flaky_input(5);
    let llm = Arc::new(ScriptedLlm::new(Vec::new()));
    let driver = Driver::new(log, llm);
    let error = driver.run_turn(input).await.err().unwrap_or_default();
    assert!(error.contains("no more replies"), "{error}");
}

#[tokio::test]
async fn when_the_turn_fails_and_turn_end_also_fails_to_append_the_original_error_wins() {
    let (log, input) = flaky_input(7);
    let llm = Arc::new(ScriptedLlm::new(Vec::new()));
    let driver = Driver::new(log, llm);
    let error = driver.run_turn(input).await.err().unwrap_or_default();
    assert!(error.contains("no more replies"), "{error}");
    assert!(!error.contains("boom"), "{error}");
}

#[tokio::test]
async fn a_paused_tool_records_its_result_and_awaits_approval() {
    let log = Arc::new(MemoryLog::default());
    let llm = Arc::new(ScriptedLlm::new(vec![
        LlmReply::calls(vec![
            call("c1", "ask", json!({})),
            call("c2", "ask", json!({})),
        ]),
        LlmReply::text("ok"),
    ]));
    let ran = Arc::new(AtomicUsize::new(0));
    let counter = ran.clone();
    let ask = define("ask", "Asks")
        .execute(move |_, cx| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                cx.pause.request("Approve the command");
                Ok(json!({ "requires": "approval" }))
            }
        })
        .build()
        .unwrap_or_else(|error| panic!("{error}"));
    let mut tools = ToolRegistry::default();
    tools
        .register(ask.clone())
        .unwrap_or_else(|error| panic!("{error}"));
    let driver = Driver::new(log.clone(), llm.clone());
    let input = TurnInput {
        session: "s".into(),
        system: "sys".into(),
        tools,
        user: vec![ContentBlock::text("go")],
        cancel: Cancel::default(),
        live: Arc::new(|_: Live| {}),
        model: None,
        source: MessageSource::user(),
        preset: None,
        stream_revision: Arc::default(),
    };
    let reason = driver
        .run_turn(input)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::AwaitingApproval);
    assert_eq!(
        ran.load(Ordering::SeqCst),
        1,
        "the second call must not run"
    );
    let kinds: Vec<&str> = log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .iter()
        .map(|e| e.body.kind())
        .collect();
    assert_eq!(
        &kinds[kinds.len() - 5..],
        [
            "tool/call",
            "tool/result",
            "approval/asked",
            "step/end",
            "turn/end"
        ]
    );

    // A second turn: the never-started `c2` call must repair as
    // "not started", not as the stale approval-pending text (fix for the
    // `approval/asked` belonging to the already-resolved `c1`).
    let mut tools_again = ToolRegistry::default();
    tools_again
        .register(ask)
        .unwrap_or_else(|error| panic!("{error}"));
    let second_input = TurnInput {
        session: "s".into(),
        system: "sys".into(),
        tools: tools_again,
        user: vec![ContentBlock::text("continue")],
        cancel: Cancel::default(),
        live: Arc::new(|_: Live| {}),
        model: None,
        source: MessageSource::user(),
        preset: None,
        stream_revision: Arc::default(),
    };
    let second_reason = driver
        .run_turn(second_input)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(second_reason, TurnEndReason::Completed);
    let requests = llm.requests();
    let second_request = requests
        .get(1)
        .unwrap_or_else(|| panic!("no second request"));
    let unstarted = second_request
        .messages
        .iter()
        .find(|message| message.tool_call_id == "c2")
        .unwrap_or_else(|| panic!("no c2 tool message in the second request"));
    assert_eq!(
        unstarted.content,
        "The tool call was interrupted before the Harness recorded it as started. \
         Retry it if it is still needed."
    );
}

#[tokio::test]
async fn a_failed_calls_pause_request_is_discarded_and_the_turn_continues() {
    let log = Arc::new(MemoryLog::default());
    let llm = Arc::new(ScriptedLlm::new(vec![
        LlmReply::calls(vec![call("c1", "ask", json!({}))]),
        LlmReply::text("done"),
    ]));
    let ask = define("ask", "Asks then fails")
        .execute(|_, cx| async move {
            cx.pause.request("Approve the command");
            Err("boom".into())
        })
        .build()
        .unwrap_or_else(|error| panic!("{error}"));
    let mut tools = ToolRegistry::default();
    tools
        .register(ask)
        .unwrap_or_else(|error| panic!("{error}"));
    let input = TurnInput {
        session: "s".into(),
        system: "sys".into(),
        tools,
        user: vec![ContentBlock::text("go")],
        cancel: Cancel::default(),
        live: Arc::new(|_: Live| {}),
        model: None,
        source: MessageSource::user(),
        preset: None,
        stream_revision: Arc::default(),
    };
    let reason = Driver::new(log.clone(), llm)
        .run_turn(input)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Completed);
    let kinds: Vec<&str> = log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .iter()
        .map(|event| event.body.kind())
        .collect();
    assert!(
        !kinds.contains(&"approval/asked"),
        "a failed call's pause request must not reach the log: {kinds:?}"
    );
}

#[tokio::test]
async fn contexts_follow_the_step_and_stop_checks_can_fail_the_turn() {
    use kition_harness::stop::{RecoveryPrompt, UnresolvedWrites};
    let setup = setup(vec![
        LlmReply::calls(vec![call("c1", "echo", json!({}))]),
        LlmReply::text("All done"),
    ]);
    let mut driver = setup.driver(Pipeline::default().with(RecoveryPrompt));
    driver.stop_checks.push(Arc::new(UnresolvedWrites));
    let error = driver
        .run_turn(setup.input("go", Cancel::default()))
        .await
        .err()
        .unwrap_or_default();
    assert!(
        error.contains("did not recover from failed workspace tool echo"),
        "{error}"
    );
    let second = &setup.llm.requests()[1];
    let last = second
        .messages
        .last()
        .map(|message| message.content.clone())
        .unwrap_or_default();
    assert!(last.starts_with("[tool recovery required]"), "{last}");
}

#[tokio::test]
async fn follow_up_content_is_logged_and_keeps_the_turn_going() {
    let mut first = LlmReply::text("Here is a draft image");
    first.follow_up = vec![ContentBlock::Image {
        url: "data:image/png;base64,AA==".into(),
    }];
    let setup = setup(vec![first, LlmReply::text("Done")]);
    let reason = setup
        .driver(Pipeline::default())
        .run_turn(setup.input("draw", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Completed);
    assert_eq!(setup.llm.requests().len(), 2);
    let second = &setup.llm.requests()[1];
    assert_eq!(
        second.messages.last().map(|message| message.parts.len()),
        Some(1)
    );
}

#[tokio::test]
async fn recovery_context_precedes_the_follow_up_message_in_the_same_step() {
    use kition_harness::stop::RecoveryPrompt;
    // `echo` fails validation on `{}` (it requires `text`), so its result
    // is an error and `RecoveryPrompt` attaches a context; the same reply
    // also carries hosted follow-up content. Both are logged after the
    // tool result, context first.
    let mut first = LlmReply::calls(vec![call("c1", "echo", json!({}))]);
    first.follow_up = vec![ContentBlock::Image {
        url: "data:image/png;base64,AA==".into(),
    }];
    let setup = setup(vec![first, LlmReply::text("done")]);
    setup
        .driver(Pipeline::default().with(RecoveryPrompt))
        .run_turn(setup.input("go", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let events = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"));
    let user_messages: Vec<&Vec<ContentBlock>> = events
        .iter()
        .filter_map(|event| match &event.body {
            EventBody::UserMessage { content, .. } => Some(content),
            _ => None,
        })
        .collect();
    // [0] is the turn's own "go" input; [1] is the step's recovery
    // context; [2] is its follow-up image.
    assert_eq!(user_messages.len(), 3, "{user_messages:?}");
    let ContentBlock::Text { text } = &user_messages[1][0] else {
        panic!("expected text, got {:?}", user_messages[1])
    };
    assert!(text.starts_with("[tool recovery required]"), "{text}");
    assert!(
        matches!(&user_messages[2][0], ContentBlock::Image { .. }),
        "{:?}",
        user_messages[2]
    );
}

#[tokio::test]
async fn a_failed_write_is_reported_even_when_the_final_reply_is_empty() {
    use kition_harness::stop::UnresolvedWrites;
    let setup = setup(vec![
        LlmReply::calls(vec![call("c1", "echo", json!({}))]),
        LlmReply::text(""),
    ]);
    let mut driver = setup.driver(Pipeline::default());
    driver.stop_checks.push(Arc::new(UnresolvedWrites));
    let error = driver
        .run_turn(setup.input("go", Cancel::default()))
        .await
        .err()
        .unwrap_or_default();
    assert!(
        error.contains("did not recover from failed workspace tool echo"),
        "{error}"
    );
}

#[tokio::test]
async fn an_empty_model_reply_fails_the_turn() {
    let setup = setup(vec![LlmReply::text("")]);
    let error = setup
        .driver(Pipeline::default())
        .run_turn(setup.input("go", Cancel::default()))
        .await
        .err()
        .unwrap_or_default();
    assert!(error.contains("no content and no tool calls"), "{error}");
    let events = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(matches!(
        events.last().map(|event| &event.body),
        Some(EventBody::TurnEnd {
            reason: TurnEndReason::Failed,
            ..
        })
    ));
}

#[tokio::test]
async fn logged_tool_arguments_go_through_the_tools_projection() {
    let received = Arc::new(Mutex::new(String::new()));
    let seen = received.clone();
    let login = define("login", "Log in")
        .unchecked_parameters(json!({ "type": "object" }))
        .log_arguments(|args| {
            let mut safe = args.clone();
            if safe.get("password").is_some() {
                safe["password"] = json!("[redacted]");
            }
            safe
        })
        .execute(move |args, _cx| {
            let seen = seen.clone();
            async move {
                *seen.lock().unwrap_or_else(PoisonError::into_inner) =
                    args["password"].as_str().unwrap_or_default().to_owned();
                Ok(json!({ "ok": true }))
            }
        })
        .build()
        .unwrap_or_else(|error| panic!("{error}"));
    let setup = setup(vec![
        LlmReply::calls(vec![call(
            "c1",
            "login",
            json!({ "user": "a", "password": "hunter2" }),
        )]),
        LlmReply::text("done"),
    ]);
    let mut input = setup.input("log in", Cancel::default());
    input
        .tools
        .register(login)
        .unwrap_or_else(|error| panic!("{error}"));
    setup
        .driver(Pipeline::default())
        .run_turn(input)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        received
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_str(),
        "hunter2"
    );
    let events = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"));
    let mut logged = Vec::new();
    for event in &events {
        match &event.body {
            EventBody::AssistantMessage { tool_calls, .. } => {
                logged.extend(tool_calls.iter().map(|call| call.arguments.clone()));
            }
            EventBody::ToolCall { arguments, .. } => logged.push(arguments.clone()),
            _ => {}
        }
    }
    assert_eq!(logged.len(), 2);
    for arguments in logged {
        assert_eq!(arguments, json!({ "user": "a", "password": "[redacted]" }));
    }
    let text = format!("{events:?}");
    assert!(!text.contains("hunter2"), "{text}");
}

/// A tool that hands a file to the user and rewrites the todo list, then
/// succeeds or fails.
fn presenter(fail: bool) -> ToolDef {
    define("present", "Presents a file")
        .execute(move |_, cx| async move {
            cx.emit.push(EventBody::DeliverablesPresented {
                turn: 0,
                call_id: String::new(),
                files: vec![
                    PresentedFile {
                        path: "Notes/plan.md".into(),
                        description: "Plan".into(),
                    },
                    PresentedFile {
                        path: String::new(),
                        description: "dropped".into(),
                    },
                ],
            });
            cx.emit.push(EventBody::TodoWrite {
                todos: vec![TodoItem {
                    content: "Write the plan".into(),
                    status: TodoStatus::Completed,
                }],
            });
            if fail {
                Err("disk full".into())
            } else {
                Ok(json!({ "path": "Notes/plan.md" }))
            }
        })
        .build()
        .unwrap_or_else(|error| panic!("{error}"))
}

async fn run_presenter(fail: bool) -> Vec<SessionEvent> {
    let log = Arc::new(MemoryLog::default());
    let llm = Arc::new(ScriptedLlm::new(vec![
        LlmReply::calls(vec![call("c1", "present", json!({}))]),
        LlmReply::text("done"),
    ]));
    let mut tools = ToolRegistry::default();
    tools
        .register(presenter(fail))
        .unwrap_or_else(|error| panic!("{error}"));
    Driver::new(log.clone(), llm)
        .run_turn(TurnInput {
            session: "s".into(),
            system: "sys".into(),
            tools,
            user: vec![ContentBlock::text("go")],
            cancel: Cancel::default(),
            live: Arc::new(|_: Live| {}),
            model: None,
            source: MessageSource::user(),
            preset: None,
            stream_revision: Arc::default(),
        })
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    log.read("s").unwrap_or_else(|error| panic!("{error}"))
}

#[tokio::test]
async fn tool_emits_follow_a_successful_result() {
    let events = run_presenter(false).await;
    let start = events
        .iter()
        .position(|event| event.body.kind() == "tool/result")
        .unwrap_or_else(|| panic!("no tool/result"));
    assert_eq!(
        events[start + 1].body,
        EventBody::DeliverablesPresented {
            turn: 1,
            call_id: "c1".into(),
            files: vec![PresentedFile {
                path: "Notes/plan.md".into(),
                description: "Plan".into(),
            }],
        }
    );
    assert_eq!(events[start + 2].body.kind(), "todo/write");
    assert_eq!(events[start + 3].body.kind(), "step/end");
}

#[tokio::test]
async fn tool_emits_are_dropped_when_the_tool_fails() {
    let kinds: Vec<&str> = run_presenter(true)
        .await
        .iter()
        .map(|event| event.body.kind())
        .collect();
    assert!(kinds.contains(&"tool/result"), "{kinds:?}");
    assert!(!kinds.contains(&"deliverables/presented"), "{kinds:?}");
    assert!(!kinds.contains(&"todo/write"), "{kinds:?}");
}

#[tokio::test]
async fn hosted_calls_follow_the_assistant_message_and_stay_out_of_history() {
    let mut reply = LlmReply::calls(vec![call("c1", "echo", json!({ "text": "hi" }))]);
    reply.hosted = vec![
        HostedCall {
            call_id: "ws_1".into(),
            name: "web_search".into(),
            arguments: json!({ "query": "kition" }),
            value: json!({ "status": "completed" }),
            meta: Some(json!({ "hosted": true })),
            files: Vec::new(),
        },
        HostedCall {
            call_id: "ig_1".into(),
            name: "image_generation".into(),
            arguments: json!({}),
            value: json!({ "path": "Agent/images/1/ig_1.png" }),
            meta: Some(json!({ "hosted": true })),
            files: vec![PresentedFile {
                path: "Agent/images/1/ig_1.png".into(),
                description: String::new(),
            }],
        },
    ];
    let setup = setup(vec![reply, LlmReply::text("done")]);
    setup
        .driver(Pipeline::default())
        .run_turn(setup.input("search", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let kinds = setup.kinds();
    let first = kinds
        .iter()
        .position(|kind| *kind == "assistant/message")
        .unwrap_or_default();
    assert_eq!(
        &kinds[first..first + 8],
        [
            "assistant/message",
            "tool/call",
            "tool/result",
            "tool/call",
            "tool/result",
            "deliverables/presented",
            "tool/call",
            "tool/result",
        ]
    );
    let events = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"));
    let hosted = events.iter().find_map(|event| match &event.body {
        EventBody::ToolResult {
            call_id,
            meta,
            is_error,
            ..
        } if call_id == "ws_1" => Some((meta.clone(), *is_error)),
        _ => None,
    });
    assert_eq!(hosted, Some((Some(json!({ "hosted": true })), false)));
    assert!(events.iter().any(|event| event.body
        == EventBody::DeliverablesPresented {
            turn: 1,
            call_id: "ig_1".into(),
            files: vec![PresentedFile {
                path: "Agent/images/1/ig_1.png".into(),
                description: String::new(),
            }],
        }));
    let history = kition_harness::derive::derive_messages(&events);
    assert!(
        history
            .iter()
            .all(|message| message.tool_call_id != "ws_1" && message.tool_call_id != "ig_1"),
        "{history:?}"
    );
    assert_eq!(
        history
            .iter()
            .filter(|message| message.role == "tool")
            .count(),
        1
    );
}

#[tokio::test]
async fn the_permission_preset_is_logged_when_it_changes() {
    let setup = setup(vec![
        LlmReply::text("one"),
        LlmReply::text("two"),
        LlmReply::text("three"),
    ]);
    let driver = setup.driver(Pipeline::default());
    for preset in ["preview", "preview", "apply"] {
        let mut input = setup.input("go", Cancel::default());
        input.preset = Some(preset.into());
        driver
            .run_turn(input)
            .await
            .unwrap_or_else(|error| panic!("{error}"));
    }
    let presets: Vec<String> = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .into_iter()
        .filter_map(|event| match event.body {
            EventBody::PermissionPreset { preset } => Some(preset),
            _ => None,
        })
        .collect();
    assert_eq!(presets, ["preview", "apply"]);
}

#[tokio::test]
async fn assistant_text_streams_as_dsh_frames_around_the_message() {
    let setup = Setup {
        llm: Arc::new(ScriptedLlm::scripted(vec![ScriptedCall {
            reply: LlmReply::text("Hello"),
            chunks: vec![
                StreamChunk::TextDelta {
                    index: 0,
                    text: "Hel".into(),
                },
                StreamChunk::TextDelta {
                    index: 0,
                    text: "lo".into(),
                },
            ],
            retries: Vec::new(),
        }])),
        ..setup(Vec::new())
    };
    setup
        .driver(Pipeline::default())
        .run_turn(setup.input("hi", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let live = setup.live.lock().unwrap_or_else(PoisonError::into_inner);
    let names: Vec<String> = live
        .iter()
        .map(|live| match live {
            Live::Status { running } => format!("status {running}"),
            Live::Event(event) => event.body.kind().to_owned(),
            Live::AssistantStream(AssistantStreamFrame::Start { .. }) => "start".into(),
            Live::AssistantStream(AssistantStreamFrame::Chunk { .. }) => "chunk".into(),
            Live::AssistantStream(AssistantStreamFrame::End { .. }) => "end".into(),
        })
        .collect();
    assert_eq!(
        names,
        [
            "status true",
            "turn/start",
            "step/start",
            "system/message",
            "user/message",
            "start",
            "chunk",
            "chunk",
            "assistant/message",
            "end",
            "step/end",
            "turn/end",
            "status false",
        ]
    );
    let frames: Vec<&AssistantStreamFrame> = live
        .iter()
        .filter_map(|live| match live {
            Live::AssistantStream(frame) => Some(frame),
            _ => None,
        })
        .collect();
    assert_eq!(
        frames[0],
        &AssistantStreamFrame::Start {
            attempt_id: "s#1.1".into(),
            revision: 1,
            turn: 1,
            step: 1,
        }
    );
    let AssistantStreamFrame::Chunk {
        revision,
        index,
        chunk,
        ..
    } = frames[2]
    else {
        panic!("{:?}", frames[2]);
    };
    assert_eq!((*revision, *index), (3, 1));
    assert_eq!(
        chunk,
        &StreamChunk::TextDelta {
            index: 0,
            text: "lo".into()
        }
    );
    let message_seq = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .iter()
        .find(|event| event.body.kind() == "assistant/message")
        .map(|event| event.seq)
        .unwrap_or_default();
    assert_eq!(
        frames[3],
        &AssistantStreamFrame::End {
            attempt_id: "s#1.1".into(),
            revision: 4,
            index: 2,
            outcome: StreamOutcome::Committed {
                event_type: "assistant/message".into(),
                seq: message_seq,
            },
        }
    );
    let wire = serde_json::to_value(frames[3]).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        wire,
        json!({ "type": "end", "attemptId": "s#1.1", "revision": 4, "index": 2,
            "outcome": { "kind": "committed", "eventType": "assistant/message", "seq": message_seq } })
    );
}

#[tokio::test]
async fn provider_retries_are_logged_as_one_retry_chain() {
    let retry = |retry| RetryInfo {
        retry,
        max_retries: 5,
        delay_ms: 1000,
        code: "server_unavailable".into(),
        message: "busy".into(),
        provider: "openai".into(),
    };
    let setup = Setup {
        llm: Arc::new(ScriptedLlm::scripted(vec![ScriptedCall {
            reply: LlmReply::text("ok"),
            chunks: Vec::new(),
            retries: vec![retry(1), retry(2)],
        }])),
        ..setup(Vec::new())
    };
    setup
        .driver(Pipeline::default())
        .run_turn(setup.input("hi", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let kinds = setup.kinds();
    let user = kinds
        .iter()
        .position(|kind| *kind == "user/message")
        .unwrap_or_default();
    assert_eq!(
        &kinds[user + 1..user + 6],
        [
            "llm/retry",
            "llm/retry-started",
            "llm/retry",
            "llm/retry-started",
            "assistant/message",
        ]
    );
    let events = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"));
    let first = serde_json::to_value(&events[user + 1].body).unwrap_or_default();
    assert_eq!(
        first,
        json!({
            "type": "llm/retry", "retryId": "s#1.1", "turn": 1, "step": 1,
            "provider": "openai", "mode": "normal", "policyKey": "engine", "retry": 1,
            "maxRetries": 5, "delayMs": 1000,
            "failure": { "message": "busy", "code": "server_unavailable" },
        })
    );
    assert_eq!(
        events[user + 4].body,
        EventBody::LlmRetryStarted {
            retry_id: "s#1.1".into(),
            turn: 1,
            step: 1,
            retry: 2,
        }
    );
    let live = setup.live.lock().unwrap_or_else(PoisonError::into_inner);
    assert_eq!(
        live.iter()
            .filter(
                |live| matches!(live, Live::Event(event) if event.body.kind().starts_with("llm/"))
            )
            .count(),
        4,
        "retries go live too"
    );
    drop(live);
    let seqs: Vec<u64> = events.iter().map(|event| event.seq).collect();
    assert!(
        seqs.windows(2).all(|pair| pair[1] == pair[0] + 1),
        "{seqs:?}"
    );
}

#[tokio::test]
async fn stream_revisions_continue_across_the_turns_of_a_session() {
    let setup = setup(vec![LlmReply::text("one"), LlmReply::text("two")]);
    let driver = setup.driver(Pipeline::default());
    let revision = Arc::new(std::sync::atomic::AtomicU64::new(0));
    for text in ["first", "second"] {
        let mut input = setup.input(text, Cancel::default());
        input.stream_revision = revision.clone();
        driver
            .run_turn(input)
            .await
            .unwrap_or_else(|error| panic!("{error}"));
    }
    let live = setup.live.lock().unwrap_or_else(PoisonError::into_inner);
    let revisions: Vec<u64> = live
        .iter()
        .filter_map(|live| match live {
            Live::AssistantStream(
                AssistantStreamFrame::Start { revision, .. }
                | AssistantStreamFrame::Chunk { revision, .. }
                | AssistantStreamFrame::End { revision, .. },
            ) => Some(*revision),
            _ => None,
        })
        .collect();
    assert_eq!(revisions, (1..=6).collect::<Vec<u64>>());
}

/// The turn and step a step-scoped event names, if it is one.
fn scope(body: &EventBody) -> Option<(u32, u32)> {
    match body {
        EventBody::SystemMessage { turn, step, .. }
        | EventBody::AssistantMessage { turn, step, .. }
        | EventBody::AssistantAttempt { turn, step, .. }
        | EventBody::ToolCall { turn, step, .. }
        | EventBody::ToolResult { turn, step, .. } => Some((*turn, *step)),
        _ => None,
    }
}

#[tokio::test]
async fn step_scoped_events_carry_turn_and_step() {
    let mut first = LlmReply::calls(vec![call("c1", "echo", json!({ "text": "hi" }))]);
    first.provider = "gateway".into();
    let mut second = LlmReply::text("done");
    second.provider = "gateway".into();
    let setup = setup(vec![first, second, LlmReply::text("again")]);
    let driver = setup.driver(Pipeline::default());
    for text in ["say hi", "again"] {
        driver
            .run_turn(setup.input(text, Cancel::default()))
            .await
            .unwrap_or_else(|error| panic!("{error}"));
    }
    let events = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"));
    let mut open = None;
    let mut scoped = Vec::new();
    for event in &events {
        if let EventBody::StepStart { turn, step } = event.body {
            open = Some((turn, step));
        }
        if let Some(scope) = scope(&event.body) {
            assert_eq!(Some(scope), open, "{event:?}");
            scoped.push((event.body.kind(), scope));
        }
    }
    assert_eq!(
        scoped,
        [
            ("system/message", (1, 1)),
            ("assistant/message", (1, 1)),
            ("tool/call", (1, 1)),
            ("tool/result", (1, 1)),
            ("assistant/message", (1, 2)),
            ("assistant/message", (2, 1)),
        ]
    );
    let providers: Vec<&str> = events
        .iter()
        .filter_map(|event| match &event.body {
            EventBody::AssistantMessage { provider, .. } => Some(provider.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(providers, ["gateway", "gateway", ""]);
}

#[tokio::test]
async fn hosted_calls_are_marked() {
    let mut reply = LlmReply::calls(vec![call("c1", "echo", json!({ "text": "hi" }))]);
    reply.hosted = vec![HostedCall {
        call_id: "ws_1".into(),
        name: "web_search".into(),
        arguments: json!({ "query": "kition" }),
        value: json!({ "status": "completed" }),
        meta: None,
        files: Vec::new(),
    }];
    let setup = setup(vec![reply, LlmReply::text("done")]);
    setup
        .driver(Pipeline::default())
        .run_turn(setup.input("search", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let marks: Vec<(&'static str, String, bool, (u32, u32))> = setup
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .iter()
        .filter_map(|event| match &event.body {
            EventBody::ToolCall {
                call_id,
                hosted,
                turn,
                step,
                ..
            }
            | EventBody::ToolResult {
                call_id,
                hosted,
                turn,
                step,
                ..
            } => Some((event.body.kind(), call_id.clone(), *hosted, (*turn, *step))),
            _ => None,
        })
        .collect();
    assert_eq!(
        marks,
        [
            ("tool/call", "ws_1".to_owned(), true, (1, 1)),
            ("tool/result", "ws_1".to_owned(), true, (1, 1)),
            ("tool/call", "c1".to_owned(), false, (1, 1)),
            ("tool/result", "c1".to_owned(), false, (1, 1)),
        ]
    );
}

#[tokio::test]
async fn a_cancelled_attempt_is_aborted() {
    let log = Arc::new(MemoryLog::default());
    let entered = Arc::new(Notify::new());
    let driver = Driver::new(log.clone(), Arc::new(BlockingLlm::new(entered.clone())));
    let cancel = Cancel::default();
    let input = TurnInput {
        session: "s".into(),
        system: "You are Kition.".into(),
        tools: ToolRegistry::default(),
        user: vec![ContentBlock::text("go")],
        cancel: cancel.clone(),
        live: Arc::new(|_: Live| {}),
        model: None,
        source: MessageSource::user(),
        preset: None,
        stream_revision: Arc::default(),
    };
    let handle = tokio::spawn(async move { driver.run_turn(input).await });
    entered.notified().await;
    cancel.cancel();
    let _ = handle.await;
    let attempt = log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .into_iter()
        .find_map(|event| match event.body {
            body @ EventBody::AssistantAttempt { .. } => Some(body),
            _ => None,
        });
    assert_eq!(
        attempt,
        Some(EventBody::AssistantAttempt {
            turn: 1,
            step: 1,
            error: "cancelled".into(),
            aborted: true,
        })
    );

    let failed = setup(Vec::new());
    let _ = failed
        .driver(Pipeline::default())
        .run_turn(failed.input("go", Cancel::default()))
        .await;
    let attempt = failed
        .log
        .read("s")
        .unwrap_or_else(|error| panic!("{error}"))
        .into_iter()
        .find_map(|event| match event.body {
            EventBody::AssistantAttempt { aborted, step, .. } => Some((aborted, step)),
            _ => None,
        });
    assert_eq!(attempt, Some((false, 1)), "a model failure is not aborted");
}
