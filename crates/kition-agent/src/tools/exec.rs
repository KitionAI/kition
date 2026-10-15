//! `exec_command`: one-shot commands in the workspace, gated by the
//! execution policy. Commands the policy does not allow pause the turn
//! until the user approves or denies them.

use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::execpolicy::{self, Decision, Rule};
use crate::run::{
    Agent, Run, ToolError, ToolOutput, ToolResult, int_field, string_list, text_field,
    truncate_chars,
};
use kition_harness::events::{EventBody, SessionEvent, TurnEndReason};

const DEFAULT_TIMEOUT_MS: i64 = 30_000;
const MAX_TIMEOUT_MS: i64 = 120_000;
const MAX_COMMAND_LEN: usize = 4000;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

pub const ALLOW_ONCE: &str = "allow_once";
pub const ALLOW_ALWAYS: &str = "allow_always";
pub const DENY: &str = "deny";

fn shell_of(input: &Value) -> Result<Option<String>, String> {
    match text_field(input, "shell").as_str() {
        "" => Ok(None),
        shell @ ("bash" | "sh") => Ok(Some(shell.to_owned())),
        _ => Err("shell must be bash or sh".into()),
    }
}

fn spawn(
    argv: &[String],
    shell: Option<&str>,
    cwd: &std::path::Path,
) -> std::io::Result<tokio::process::Child> {
    let mut command = match shell {
        Some(shell) if cfg!(windows) => {
            let _ = shell;
            let mut command = tokio::process::Command::new("cmd");
            command.arg("/C").arg(argv.join(" "));
            command
        }
        Some(shell) => {
            let mut command = tokio::process::Command::new(format!("/bin/{shell}"));
            command.arg("-c").arg(argv.join(" "));
            command
        }
        None => {
            let mut command = tokio::process::Command::new(&argv[0]);
            command.args(&argv[1..]);
            command
        }
    };
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
}

/// Copies a pipe into the shared buffer, keeping at most the cap.
fn drain(
    pipe: Option<impl tokio::io::AsyncRead + Unpin + Send + 'static>,
    buffer: Arc<Mutex<Vec<u8>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let Some(mut pipe) = pipe else { return };
        let mut chunk = [0_u8; 16 * 1024];
        while let Ok(read) = pipe.read(&mut chunk).await {
            if read == 0 {
                break;
            }
            let mut buffer = buffer.lock().unwrap_or_else(PoisonError::into_inner);
            let room = MAX_OUTPUT_BYTES.saturating_sub(buffer.len());
            buffer.extend_from_slice(&chunk[..read.min(room)]);
        }
    })
}

/// The pending approval; `exec_shape` presents it as the
/// `agent-shell-approval.schema.json#/$defs/request` meta.
fn approval_output(argv: &[String], shell: bool, reason: &str) -> Value {
    let suggested = execpolicy::suggested_prefix(argv, shell);
    let mut output = json!({
        "command": argv.join(" "),
        "decision": "prompt",
        "reason": reason,
        "requires": "approval",
    });
    if !suggested.is_empty() {
        output["suggested"] = json!({ "prefix": suggested, "decision": "allow" });
    }
    output
}

pub async fn exec_command(run: &Run, input: &Value) -> ToolResult {
    let argv = string_list(input, "cmd");
    if argv.is_empty() {
        return Err("cmd is required and must contain at least one element".into());
    }
    let shell = shell_of(input)?;
    let command = argv.join(" ");
    if command.len() > MAX_COMMAND_LEN {
        return Err("command is too long".into());
    }
    if let Some(pattern) = execpolicy::blocked_pattern(&command) {
        return Err(format!("command blocked by safety policy: {pattern}").into());
    }
    if !run.consume_approval(&command) {
        let evaluation = run.agent.policy().evaluate(&argv, shell.is_some());
        match evaluation.decision {
            Decision::Allow => {}
            Decision::Forbidden => {
                return Err(ToolError {
                    message: format!("command blocked by policy: {}", evaluation.reason),
                    output: Some(json!({
                        "command": command,
                        "decision": "forbidden",
                        "reason": evaluation.reason,
                    })),
                    ..ToolError::default()
                });
            }
            Decision::Prompt => {
                return Ok(ToolOutput {
                    interrupt: Some("await_shell_approval"),
                    ..ToolOutput::new(
                        format!("Awaiting user approval for `{command}`"),
                        approval_output(&argv, shell.is_some(), &evaluation.reason),
                    )
                });
            }
        }
    }
    let timeout = match int_field(input, "yield_time_ms") {
        n if n <= 0 => DEFAULT_TIMEOUT_MS,
        n => n.min(MAX_TIMEOUT_MS),
    };
    let cwd = run.workspace().root().to_path_buf();
    std::fs::create_dir_all(&cwd).map_err(|error| error.to_string())?;
    let started = Instant::now();
    let mut child = spawn(&argv, shell.as_deref(), &cwd)
        .map_err(|error| format!("failed to start command: {error}"))?;
    let output = Arc::new(Mutex::new(Vec::new()));
    let readers = [
        drain(child.stdout.take(), output.clone()),
        drain(child.stderr.take(), output.clone()),
    ];
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        () = tokio::time::sleep(Duration::from_millis(timeout as u64)) => None,
        () = run.emitter.closed() => None,
    };
    if status.is_none() {
        let _ = child.kill().await;
    }
    for reader in readers {
        let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;
    }
    let text = String::from_utf8_lossy(&output.lock().unwrap_or_else(PoisonError::into_inner))
        .into_owned();
    let done = status.is_some();
    let exit_code = status.and_then(|status| status.code()).unwrap_or(-1);
    let mut result = json!({
        "cmd": argv,
        "cwd": cwd.to_string_lossy(),
        "output": text,
        "done": done,
        "duration_ms": started.elapsed().as_millis() as u64,
    });
    if done {
        result["exit_code"] = json!(exit_code);
    }
    let justification = text_field(input, "justification");
    if !justification.is_empty() {
        result["justification"] = json!(justification);
    }
    let trimmed = truncate_chars(&text, 4000);
    let summary = match (done, exit_code) {
        (true, 0) => format!("Command completed: `{command}`\n\n{trimmed}"),
        (true, code) => format!("Command exited with code {code}: `{command}`\n\n{trimmed}"),
        (false, _) => format!("Command timed out and was stopped: `{command}`\n\n{trimmed}"),
    };
    if done && exit_code == 0 {
        Ok(ToolOutput::new(summary, result))
    } else {
        Err(ToolError {
            message: if done {
                format!("command exited with code {exit_code}")
            } else {
                "command timed out".into()
            },
            summary,
            output: Some(result),
        })
    }
}

/// The user's answer to a pending command approval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approval {
    pub call_id: String,
    pub decision: String,
    pub command: String,
}

/// A command that waits for the user, read from the session log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub id: String,
    pub command: String,
    pub suggested_prefix: Vec<String>,
}

const NOT_PENDING: &str = "shell approval request is no longer pending";

/// The approval `call_id` waits for: the latest turn ended
/// `awaiting-approval` after asking about this call, nothing decided it
/// since, and the call's result is an `exec_command` that requires approval.
pub fn pending_approval(events: &[SessionEvent], call_id: &str) -> Result<Pending, String> {
    let ended = events
        .iter()
        .rposition(|event| matches!(event.body, EventBody::TurnEnd { .. }));
    let Some(ended) = ended else {
        return Err("shell approval request was not found".into());
    };
    if !matches!(
        events[ended].body,
        EventBody::TurnEnd {
            reason: TurnEndReason::AwaitingApproval,
            ..
        }
    ) {
        return Err(NOT_PENDING.into());
    }
    let started = events[..ended]
        .iter()
        .rposition(|event| matches!(event.body, EventBody::TurnStart { .. }))
        .unwrap_or(0);
    let turn = &events[started..ended];
    let id = turn
        .iter()
        .find_map(|event| match &event.body {
            EventBody::ApprovalAsked {
                id, call_id: asked, ..
            } if asked == call_id => Some(id.clone()),
            _ => None,
        })
        .ok_or_else(|| "shell approval request was not found".to_owned())?;
    let decided = events[ended..].iter().any(|event| {
        matches!(&event.body, EventBody::ApprovalDecided { id: decided, .. } if *decided == id)
    });
    if decided {
        return Err(NOT_PENDING.into());
    }
    let output = turn
        .iter()
        .find_map(|event| match &event.body {
            EventBody::ToolResult {
                call_id: result,
                name,
                value,
                is_error: false,
                ..
            } if result == call_id => Some((name.clone(), value["output"].clone())),
            _ => None,
        })
        .ok_or_else(|| NOT_PENDING.to_owned())?;
    let (name, output) = output;
    if name != "exec_command" {
        return Err("tool call is not a shell command".into());
    }
    let command = text_field(&output, "command");
    if text_field(&output, "requires") != "approval" || command.is_empty() {
        return Err(NOT_PENDING.into());
    }
    Ok(Pending {
        id,
        command,
        suggested_prefix: string_list(&output["suggested"], "prefix"),
    })
}

/// Checks that `call_id` is the session's pending approval and applies an
/// `allow_always` decision to the policy.
pub async fn resolve_approval(
    agent: &Agent,
    session_id: i64,
    call_id: &str,
    decision: &str,
) -> Result<Approval, String> {
    if ![ALLOW_ONCE, ALLOW_ALWAYS, DENY].contains(&decision) {
        return Err("shell approval decision must be allow_once, allow_always, or deny".into());
    }
    if call_id.is_empty() {
        return Err("shell approval call_id is required".into());
    }
    let events = crate::log::read_session(agent, session_id)
        .await
        .map_err(|_| "failed to verify shell approval state".to_owned())?;
    let pending = pending_approval(&events, call_id)?;
    if decision == ALLOW_ALWAYS {
        let mut prefix = pending.suggested_prefix.clone();
        if prefix.is_empty() {
            prefix = pending
                .command
                .split_whitespace()
                .take(1)
                .map(str::to_owned)
                .collect();
        }
        if prefix.is_empty() {
            return Err("shell approval command could not be converted into a policy rule".into());
        }
        let mut policy = agent.policy_mut();
        policy.add_rule(Rule {
            prefix,
            decision: Decision::Allow,
            justification: "Approved by the user from the Agent command prompt".into(),
        });
        policy
            .save()
            .map_err(|error| format!("failed to persist shell approval: {error}"))?;
    }
    Ok(Approval {
        call_id: call_id.to_owned(),
        decision: decision.to_owned(),
        command: pending.command,
    })
}

#[cfg(test)]
mod tests {
    use kition_harness::events::ApprovalOutcome;

    use super::*;

    fn at(seq: u64, body: EventBody) -> SessionEvent {
        SessionEvent { seq, at: 0, body }
    }

    /// A turn whose `exec_command` call `c1` waits for approval.
    fn paused(tool: &str) -> Vec<SessionEvent> {
        vec![
            at(1, EventBody::TurnStart { turn: 1 }),
            at(
                2,
                EventBody::ToolCall {
                    turn: 1,
                    step: 1,
                    hosted: false,
                    call_id: "c1".into(),
                    name: tool.into(),
                    arguments: json!({ "cmd": ["ls"] }),
                },
            ),
            at(
                3,
                EventBody::ToolResult {
                    turn: 1,
                    step: 1,
                    hosted: false,
                    call_id: "c1".into(),
                    name: tool.into(),
                    value: json!({ "name": tool, "summary": "wait", "output": {
                        "requires": "approval", "command": "ls -la",
                        "suggested": { "prefix": ["ls"] },
                    } }),
                    content: Vec::new(),
                    is_error: false,
                    meta: None,
                },
            ),
            at(
                4,
                EventBody::ApprovalAsked {
                    id: "approval:c1".into(),
                    tool_name: tool.into(),
                    call_id: "c1".into(),
                    reason: String::new(),
                },
            ),
            at(
                5,
                EventBody::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::AwaitingApproval,
                    error: String::new(),
                },
            ),
        ]
    }

    #[test]
    fn a_paused_command_is_pending() {
        assert_eq!(
            pending_approval(&paused("exec_command"), "c1"),
            Ok(Pending {
                id: "approval:c1".into(),
                command: "ls -la".into(),
                suggested_prefix: vec!["ls".into()],
            })
        );
        assert!(pending_approval(&paused("exec_command"), "c2").is_err());
        assert!(pending_approval(&[], "c1").is_err());
    }

    #[test]
    fn a_decided_approval_is_no_longer_pending() {
        let mut events = paused("exec_command");
        events.push(at(
            6,
            EventBody::ApprovalDecided {
                id: "approval:c1".into(),
                outcome: ApprovalOutcome::Rejected,
            },
        ));
        assert_eq!(pending_approval(&events, "c1"), Err(NOT_PENDING.to_owned()));
    }

    #[test]
    fn a_later_turn_ends_the_wait() {
        let mut events = paused("exec_command");
        events.push(at(6, EventBody::TurnStart { turn: 2 }));
        events.push(at(
            7,
            EventBody::TurnEnd {
                turn: 2,
                reason: TurnEndReason::Completed,
                error: String::new(),
            },
        ));
        assert_eq!(pending_approval(&events, "c1"), Err(NOT_PENDING.to_owned()));
    }

    #[test]
    fn only_shell_commands_wait_for_approval() {
        assert_eq!(
            pending_approval(&paused("fs_remove"), "c1"),
            Err("tool call is not a shell command".to_owned())
        );
    }
}
