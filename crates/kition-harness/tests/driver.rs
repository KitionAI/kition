//! End-to-end turns with a scripted model and an in-memory log.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::future::BoxFuture;
use kition_harness::cancel::Cancel;
use kition_harness::driver::{Driver, Live, TurnInput};
use kition_harness::events::{ContentBlock, EventBody, SessionEvent, TurnEndReason};
use kition_harness::llm::{ChunkSink, Llm, LlmReply, LlmRequest};
use kition_harness::log::{MemoryLog, SessionLog};
use kition_harness::policy::{CallInfo, Decision, Pipeline, Policy, WritePermission};
use kition_harness::testing::{ScriptedLlm, call};
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
    assert!(live.contains(&Live::AssistantText {
        delta: "done".into()
    }));
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
        _on_text: ChunkSink,
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
    let input = TurnInput {
        session: "s".into(),
        system: "You are Kition.".into(),
        tools: ToolRegistry::default(),
        user: vec![ContentBlock::text("go")],
        cancel: cancel.clone(),
        live: Arc::new(|_event: Live| {}),
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
    let cancel = Cancel::default();
    let cancel_for_tool = cancel.clone();
    let canceller = define("canceller", "Cancels the turn from inside its body")
        .execute(move |_args, _cx| {
            let cancel = cancel_for_tool.clone();
            async move {
                cancel.cancel();
                Ok(json!({}))
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
    };
    let reason = setup
        .driver(Pipeline::default())
        .run_turn(input)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Cancelled);
    assert!(!ran.load(Ordering::SeqCst));
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
    let llm = Arc::new(ScriptedLlm::new(vec![LlmReply::calls(vec![
        call("c1", "ask", json!({})),
        call("c2", "ask", json!({})),
    ])]));
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
        .register(ask)
        .unwrap_or_else(|error| panic!("{error}"));
    let input = TurnInput {
        session: "s".into(),
        system: "sys".into(),
        tools,
        user: vec![ContentBlock::text("go")],
        cancel: Cancel::default(),
        live: Arc::new(|_: Live| {}),
    };
    let reason = Driver::new(log.clone(), llm)
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
