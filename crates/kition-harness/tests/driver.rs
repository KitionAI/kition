//! End-to-end turns with a scripted model and an in-memory log.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use kition_harness::cancel::Cancel;
use kition_harness::driver::{Driver, Live, TurnInput};
use kition_harness::events::{ContentBlock, EventBody, TurnEndReason};
use kition_harness::llm::LlmReply;
use kition_harness::log::{MemoryLog, SessionLog};
use kition_harness::policy::{CallInfo, Decision, Pipeline, Policy, WritePermission};
use kition_harness::testing::{ScriptedLlm, call};
use kition_harness::tool::{ToolDef, ToolRegistry, define};
use serde_json::json;

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
