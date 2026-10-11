# Harness Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Kition's hand-written agent loop with a harness built on the
DeepSeek Harness contracts, so that every pane and every kit plugs into the
agent through one provider seam instead of each feature having its own agent
scheme.

**Architecture:** A new Rust crate, `kition-harness`, holds the core: an
append-only session event log with DeepSeek Harness event names, a turn and
step driver that derives every model request from that log, a tool registry in
the `defineTool` shape with a pre-execute and post-execute policy pipeline, a
model seam over `kition-ai`, and a provider seam through which documents,
tables, whiteboard, design, workflows, and kits contribute prompt sections and
tools. `kition-agent` moves onto the harness behind a flag, pane by pane, then
the old loop is removed. Kition stays Rust; DeepSeek Harness conformance is by
contract, not by embedding its Node runtime (decision of 2026-10-11 in the Kit
Standard roadmap).

**Tech Stack:** Rust 2024 (workspace `rust-version = 1.94`), tokio, serde,
`jsonschema` 0.58, rusqlite via `kition-store`, `kition-ai` for model wires
(OpenAI-compatible including DeepSeek, Responses, Anthropic).

**Normative sources:**

- Kition Kit Standard 1.0 draft, `docs/standard.md` in the private
  `KitionAI/kition-sdk` repository: AI contract A1 to A10, harness
  conformance D1 to D4. Its `docs/roadmap.md` phases 3 to 5 are delivered by
  phases D to G below.
- DeepSeek Harness `0.2.1-alpha.2`, commit `d7432673`
  (`github.com/deepseek-ai/deepseek-harness`): `docs/architecture.md` (turn
  flow, "model-visible means logged"), `docs/agent-lifecycle.md`,
  `docs/tool-execution-pipeline.md`, `packages/core/tools/src/schema.ts`
  (`ParameterSchemaSpec`, `defineTool`), `packages/core/session/src/known-event-types.ts`,
  `packages/sdk/protocol/README.md` (SDK methods). Standard D4 requires
  pinning this version; every phase targets it until the pin is changed on
  purpose.

---

## 1. Why

What the agent does today (`crates/kition-agent`):

| Area | Today | Problem |
| --- | --- | --- |
| Loop | `turn.rs` `run_loop`: one hand-written loop, at most 16 model calls, recovery prompts inlined | No turn/step structure, no extension points |
| Record | Rows in `agent_messages`, `agent_tool_calls`, `agent_events`; model history rebuilt from `agent_messages` only | What the model saw cannot be reconstructed; replay and resume are approximate |
| Tools | `tools/mod.rs` `dispatch`: a 45-arm `match` on names; metadata in `catalog.json`; stage and label tables by name | Adding a feature means editing four places |
| Panes | `prompts.rs` has one hard-coded paragraph per pane; whiteboard and design use custom `whiteboard_patch` and `design_patch` stream frames | Every pane is a special case |
| Kits | `tools/kits.rs`: `photo_inspect`, `photo_commands`, `photo_run`, hard-coded and headless only | Contradicts standard A3, A7: per-kit tools from manifests, live edits in the open editor |
| UI | NDJSON frames shaped per feature | The panel cannot render a new tool without new code |

## 2. Target architecture

```text
                    kition-agent (HTTP routes, NDJSON adapter, legacy tools)
                                   |
                                   v
 +-------------------------------- kition-harness ---------------------------------+
 | Provider seam: documents | tables | whiteboard | design | workflow | kit.* | MCP  |
 |        -> prompt sections + ToolDefs (defineTool shape)                          |
 |                                                                                  |
 | Driver: turn/start -> step/start -> system/message -> user/message               |
 |         -> derive request from log -> Llm seam -> assistant/message              |
 |         -> tool/call -> Pipeline (pre: allow|deny|ask) -> body -> post           |
 |         -> tool/result -> step/end ... -> turn/end                               |
 |                                                                                  |
 | SessionLog (append-only; MemoryLog, SqliteLog)    Live sink (stream, status)     |
 +----------------------------------------------------------------------------------+
            |                                      |
     kition-ai Engine                     Kit AI bridge (phase E) -> open editor worker
                                                   \-> headless kit (kition-kits)
```

Rules carried over from DeepSeek Harness:

1. **Model-visible means logged.** Every input the model sees is a session
   event first; the request is derived from the log (`derive_messages`).
2. **Durable vs live.** Session events are durable facts. Streamed text and
   running status are live only and never needed for replay.
3. **Seams, not special cases.** A provider supplies prompt sections and
   tools; the driver never names a pane or a kit.
4. **One tool shape.** Name, description, `ParameterSchemaSpec` parameters,
   canonical output schema, pure `render`, optional pure `presentation_meta`.
   Arguments and output are validated.

Rules carried over from Kition that must survive the rewrite: loopback-only
API, workspace confinement, per-segment exec policy and shell approval, SMTP
password redaction in logged inputs, `web_fetch` public-address checks.

## 3. Phases

Each phase ends with `pnpm check:desktop`, `python3 scripts/check-i18n.py`,
and `pnpm test:table:e2e` passing. Phase A is specified task by task below.
Phases B to G each get their own task-level plan, written when the phase starts
against the code as it is then.

| Phase | Deliverable | Exit criteria |
| --- | --- | --- |
| A | `kition-harness` crate: events, schemas, tools, pipeline, log (memory and SQLite), model seam, provider seam, driver | Crate tests pass; event names checked against the pinned dsh list |
| B | `kition-agent` runs on the harness behind `KITION_AGENT_HARNESS=1`: legacy tools wrapped as a provider, NDJSON adapter, shell approval resume, hosted web search and image calls, the unresolved-write recovery as a turn-stopping hook | With the flag on, the agent e2e specs and `cargo test -p kition-agent` pass unchanged |
| C | Pane providers replace `prompts.rs` pane paragraphs; whiteboard and design patches become tools whose `presentation_meta` carries the patch; tool families rewritten natively in the `defineTool` shape | No pane name appears in the driver or in `tools/mod.rs`; custom patch frames removed |
| D | Kit provider from `kit.json` manifests: `<prefix>_inspect`, `<prefix>_commands`, `<prefix>_run` (A3) and schema-backed command tools (A1, A2, A6) filtered by `agent.include` and `agent.exclude`; replaces `photo_*`; headless `kit-film` | Photo, Film, Vector each expose A3 tools; tool schemas validate; agent edits a fixture per kit |
| E | Kit AI bridge (A7 to A10): `kit/documents`, `kit/tools`, `kit/call`, `kit/preview`, `kit.changed` between runtime and renderer; calls go to the open editor's worker, else headless; agent edits marked in undo history | Agent edit appears live in an open editor and undoes as one step, in Chromium and WebKit e2e and in the real desktop client |
| F | Renderer reads session events: an events endpoint plus the live stream, cards from `presentation_meta`; `contracts/runtime/agent-session-events.schema.json`; old tables become read-only history; flag removed and `turn.rs` deleted | Panel renders any new tool with no new code; old sessions still open |
| G | DeepSeek Harness SDK protocol server (D2: `initialize`, `session/prompt`, `session/wait`, `shutdown`, `session.event`, `session.status`) projecting events to the exact dsh `SessionEvent` shape; `@kition/dsh-kits` bundle in `KitionAI/kition-sdk` (D1); ACP endpoint (D3); conformance report with the pin (D4) | The dsh TypeScript SDK client at the pinned version drives a Kition session in a test |

Design decisions to make at the start of the named phase (not before):

- **E:** the back channel from runtime to renderer. Candidates: a long-lived
  NDJSON `GET /v1/kits/bridge` the renderer holds open and answers on, or a
  loopback WebSocket. Both must keep the loopback `Host` check.
- **G:** whether the SDK server is a stdio subcommand that relays to the
  running runtime over loopback, or a separate in-process listener. The dsh
  clients spawn a process and speak stdio, which favors the subcommand.

## 4. Phase A file structure

```text
crates/kition-harness/
  Cargo.toml
  src/lib.rs          module list, re-exports, DSH_TARGET pin
  src/events.rs       ContentBlock, EventBody (dsh names), SessionEvent, TurnEndReason
  src/schema.rs       ParameterSchemaSpec / ValueSchemaSpec -> JSON Schema; validation
  src/cancel.rs       Cancel: cooperative cancellation
  src/tool.rs         ToolDef (defineTool shape), builder, Settled, ToolRegistry, tool_name
  src/log.rs          SessionLog trait, MemoryLog, SqliteLog
  src/derive.rs       derive_messages: model history from the log
  src/llm.rs          Llm seam, LlmRequest, LlmReply, EngineLlm
  src/policy.rs       Decision, CallInfo, Policy, Pipeline, WritePermission
  src/provider.rs     TurnScene, Provider, Assembly, assemble
  src/driver.rs       Driver, TurnInput, Live, run_turn
  src/testing.rs      ScriptedLlm and helpers for this and later crates
  tests/driver.rs     end-to-end turn tests with ScriptedLlm and MemoryLog
crates/kition-store/schema/main.sql   + agent_session_events table and index
Cargo.toml                            + kition-harness workspace dependency
```

The crate depends on `kition-ai`, `kition-core`, and `kition-store` only. It
must not depend on `kition-agent` or `kition-kits`; those depend on it.

Workspace clippy denies `unwrap_used` and `expect_used` in all targets,
including tests. Tests use `.unwrap_or_else(|error| panic!("{error}"))`.

---

### Task 1: Crate scaffold and session events

**Files:**
- Create: `crates/kition-harness/Cargo.toml`
- Create: `crates/kition-harness/src/lib.rs`
- Create: `crates/kition-harness/src/events.rs`
- Modify: `Cargo.toml` (workspace dependencies, after `kition-kits`)

- [ ] **Step 1: Create the manifest**

`crates/kition-harness/Cargo.toml`:

```toml
[package]
name = "kition-harness"
description = "The agent harness: session event log, turn and step driver, tools and their pipeline, and the provider seam."
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish.workspace = true

[lints]
workspace = true

[dependencies]
kition-ai = { workspace = true }
kition-core = { workspace = true }
kition-store = { workspace = true }

futures = { workspace = true }
jsonschema = { workspace = true }
rusqlite = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
```

In the root `Cargo.toml`, under `[workspace.dependencies]` after the
`kition-kits` line, add:

```toml
kition-harness = { path = "crates/kition-harness" }
```

- [ ] **Step 2: Write `lib.rs` with only the events module**

```rust
//! The agent harness: an append-only session log, a turn and step driver that
//! derives every model request from that log, tools in the DeepSeek Harness
//! `defineTool` shape with a policy pipeline, and the provider seam through
//! which panes and kits contribute to a turn.

pub mod events;

/// The DeepSeek Harness release whose contracts this crate follows (Kit
/// Standard D4). Change it only together with a conformance re-run.
pub const DSH_TARGET: &str = "0.2.1-alpha.2 (d7432673)";
```

- [ ] **Step 3: Write the failing test in `events.rs`**

```rust
//! Durable session events, named after DeepSeek Harness's (`turn/start`,
//! `tool/call`, ...). Model-visible means logged: every model request is
//! derived from these events.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn events_use_dsh_names_and_camel_case() {
        let event = SessionEvent {
            seq: 3,
            at: 10,
            body: EventBody::ToolCall {
                call_id: "c1".into(),
                name: "echo".into(),
                arguments: json!({ "text": "hi" }),
            },
        };
        let wire = serde_json::to_value(&event).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            wire,
            json!({ "seq": 3, "at": 10, "type": "tool/call", "callId": "c1", "name": "echo", "arguments": { "text": "hi" } })
        );
        let back: SessionEvent = serde_json::from_value(wire).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(back, event);
        assert_eq!(back.body.kind(), "tool/call");
    }

    #[test]
    fn turn_end_reason_is_kebab_case() {
        let body = EventBody::TurnEnd { turn: 1, reason: TurnEndReason::AwaitingApproval, error: String::new() };
        let wire = serde_json::to_value(&body).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(wire, serde_json::json!({ "type": "turn/end", "turn": 1, "reason": "awaiting-approval" }));
    }
}
```

- [ ] **Step 4: Run it to see it fail**

Run: `cargo test -p kition-harness events`
Expected: compile errors, `SessionEvent`, `EventBody`, `TurnEndReason` not found.

- [ ] **Step 5: Implement the types above the test module**

```rust
/// One piece of user, tool, or context content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContentBlock {
    Text { text: String },
    /// An image the model sees, as a `data:` URL or a workspace URL.
    Image { url: String },
}

impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }
}

/// Why a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnEndReason {
    Completed,
    Cancelled,
    Failed,
    AwaitingApproval,
    StepLimit,
}

/// A tool call as the model asked for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedCall {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
}

/// The payload of one durable event; `type` carries the DeepSeek Harness name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum EventBody {
    #[serde(rename = "turn/start")]
    TurnStart { turn: u32 },
    #[serde(rename = "turn/end")]
    TurnEnd {
        turn: u32,
        reason: TurnEndReason,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        error: String,
    },
    #[serde(rename = "step/start")]
    StepStart { turn: u32, step: u32 },
    #[serde(rename = "step/end")]
    StepEnd { turn: u32, step: u32 },
    #[serde(rename = "system/message")]
    SystemMessage { content: String },
    #[serde(rename = "user/message")]
    UserMessage { content: Vec<ContentBlock> },
    #[serde(rename = "assistant/message")]
    AssistantMessage {
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<LoggedCall>,
        #[serde(default)]
        stop_reason: String,
        #[serde(default)]
        model: String,
        /// Provider-native items replayed verbatim on the Responses wire.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        raw_items: Vec<Value>,
    },
    /// A model call that settled without a message: failed or cancelled.
    #[serde(rename = "assistant/attempt")]
    AssistantAttempt { error: String },
    #[serde(rename = "tool/call")]
    ToolCall { call_id: String, name: String, arguments: Value },
    #[serde(rename = "tool/result")]
    ToolResult {
        call_id: String,
        name: String,
        /// The canonical output value (standard A4); `null` on failure.
        value: Value,
        /// What the model sees.
        content: Vec<ContentBlock>,
        is_error: bool,
        /// Display-only data derived from arguments and value.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    #[serde(rename = "approval/asked")]
    ApprovalAsked { call_id: String, reason: String },
}

impl EventBody {
    /// Every event name this crate writes, for the conformance check.
    pub const KINDS: &[&str] = &[
        "turn/start",
        "turn/end",
        "step/start",
        "step/end",
        "system/message",
        "user/message",
        "assistant/message",
        "assistant/attempt",
        "tool/call",
        "tool/result",
        "approval/asked",
    ];

    pub fn kind(&self) -> &'static str {
        match self {
            Self::TurnStart { .. } => "turn/start",
            Self::TurnEnd { .. } => "turn/end",
            Self::StepStart { .. } => "step/start",
            Self::StepEnd { .. } => "step/end",
            Self::SystemMessage { .. } => "system/message",
            Self::UserMessage { .. } => "user/message",
            Self::AssistantMessage { .. } => "assistant/message",
            Self::AssistantAttempt { .. } => "assistant/attempt",
            Self::ToolCall { .. } => "tool/call",
            Self::ToolResult { .. } => "tool/result",
            Self::ApprovalAsked { .. } => "approval/asked",
        }
    }
}

/// One appended event: its position in the session, its time, its payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionEvent {
    pub seq: u64,
    /// Unix milliseconds.
    pub at: i64,
    #[serde(flatten)]
    pub body: EventBody,
}
```

- [ ] **Step 6: Run the tests**

Run: `cargo test -p kition-harness events`
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml Cargo.lock crates/kition-harness
git commit -m "Add the kition-harness crate with DeepSeek Harness session events"
```

### Task 2: Parameter schemas

**Files:**
- Create: `crates/kition-harness/src/schema.rs`
- Modify: `crates/kition-harness/src/lib.rs` (add `pub mod schema;`)

- [ ] **Step 1: Write the failing tests**

`schema.rs`, test module only for now:

```rust
//! DeepSeek Harness `ParameterSchemaSpec` and `ValueSchemaSpec` compiled to
//! JSON Schema, and argument validation (Kit Standard A5).

use serde_json::{Map, Value, json};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_required_nested_json_and_one_of() {
        let spec = json!({
            "path": { "type": "string", "required": true, "description": "Workspace path" },
            "steps": { "type": "array", "items": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "command": { "type": "string", "required": true },
                    "params": { "type": "json" }
                }
            } },
            "mode": { "oneOf": [ { "type": "string", "enum": ["fast"] }, { "type": "null" } ] }
        });
        let schema = parameters_to_json_schema(&spec).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], json!(["path"]));
        assert_eq!(schema["properties"]["path"], json!({ "type": "string", "description": "Workspace path" }));
        let item = &schema["properties"]["steps"]["items"];
        assert_eq!(item["required"], json!(["command"]));
        assert_eq!(item["additionalProperties"], json!(false));
        assert_eq!(item["properties"]["params"], json!({}));
        assert_eq!(schema["properties"]["mode"]["oneOf"][1], json!({ "type": "null" }));
        assert!(violations(&schema, &json!({ "path": "a.psd" })).is_empty());
        assert!(!violations(&schema, &json!({ "steps": [] })).is_empty());
        assert!(!violations(&schema, &json!({ "path": "a", "steps": [{ "params": {} }] })).is_empty());
    }

    #[test]
    fn rejects_what_dsh_rejects() {
        let open = value_to_json_schema(&json!({ "type": "object" })).err().unwrap_or_default();
        assert!(open.contains("additionalProperties"), "{open}");
        let required = parameters_to_json_schema(&json!({ "x": { "type": "string", "required": false } }))
            .err()
            .unwrap_or_default();
        assert!(required.contains("required"), "{required}");
        let one = value_to_json_schema(&json!({ "oneOf": [ { "type": "null" } ] })).err().unwrap_or_default();
        assert!(one.contains("two branches"), "{one}");
        let stray = value_to_json_schema(&json!({ "type": "string", "items": {} })).err().unwrap_or_default();
        assert!(stray.contains("not allowed"), "{stray}");
    }
}
```

Add `pub mod schema;` to `lib.rs`.

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p kition-harness schema`
Expected: compile errors, `parameters_to_json_schema`, `value_to_json_schema`, `violations` not found.

- [ ] **Step 3: Implement above the test module**

```rust
const ANNOTATIONS: &[&str] = &["description", "title", "default", "examples"];

/// Compiles a `ParameterSchemaSpec` (named properties, each a `ValueSchemaSpec`
/// with an optional `required: true`) into the open, object-rooted JSON Schema
/// a model provider receives.
pub fn parameters_to_json_schema(spec: &Value) -> Result<Value, String> {
    let map = spec
        .as_object()
        .ok_or("parameters must be an object of named properties")?;
    let (properties, required) = property_map(map, "parameters")?;
    let mut schema = json!({ "type": "object", "properties": properties });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    Ok(schema)
}

/// Compiles one `ValueSchemaSpec`, such as a tool's output schema.
pub fn value_to_json_schema(spec: &Value) -> Result<Value, String> {
    compile(spec, "schema", false)
}

/// Path-qualified violations of `schema` by `instance`; empty means valid.
pub fn violations(schema: &Value, instance: &Value) -> Vec<String> {
    match jsonschema::validator_for(schema) {
        Ok(validator) => validator
            .iter_errors(instance)
            .take(8)
            .map(|error| format!("{error} at `{}`", error.instance_path()))
            .collect(),
        Err(error) => vec![format!("invalid schema: {error}")],
    }
}

fn property_map(map: &Map<String, Value>, path: &str) -> Result<(Map<String, Value>, Vec<String>), String> {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for (name, property) in map {
        let at = format!("{path}.{name}");
        if let Some(flag) = property.get("required") {
            if flag != &Value::Bool(true) {
                return Err(format!("{at}.required must be true when present"));
            }
            required.push(name.clone());
        }
        properties.insert(name.clone(), compile(property, &at, true)?);
    }
    Ok((properties, required))
}

fn compile(spec: &Value, path: &str, allow_required: bool) -> Result<Value, String> {
    let object = spec
        .as_object()
        .ok_or_else(|| format!("{path} must be an object"))?;
    let mut out = Map::new();
    for key in ANNOTATIONS {
        if let Some(value) = object.get(*key) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    if let Some(branches) = object.get("oneOf") {
        let branches = branches
            .as_array()
            .filter(|branches| branches.len() >= 2)
            .ok_or_else(|| format!("{path}.oneOf needs at least two branches"))?;
        let compiled = branches
            .iter()
            .enumerate()
            .map(|(index, branch)| compile(branch, &format!("{path}.oneOf[{index}]"), false))
            .collect::<Result<Vec<_>, _>>()?;
        out.insert("oneOf".into(), Value::Array(compiled));
        return Ok(Value::Object(out));
    }
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{path}.type is missing"))?;
    for key in object.keys() {
        let allowed = ANNOTATIONS.contains(&key.as_str())
            || (allow_required && key == "required")
            || matches!(
                (kind, key.as_str()),
                (_, "type")
                    | ("string" | "number" | "integer" | "boolean" | "null", "enum" | "const")
                    | ("array", "items")
                    | ("object", "properties" | "additionalProperties")
            );
        if !allowed {
            return Err(format!("{path}.{key} is not allowed for type `{kind}`"));
        }
    }
    match kind {
        "json" => {}
        "string" | "number" | "integer" | "boolean" | "null" => {
            out.insert("type".into(), json!(kind));
            for key in ["enum", "const"] {
                if let Some(value) = object.get(key) {
                    out.insert(key.into(), value.clone());
                }
            }
        }
        "array" => {
            out.insert("type".into(), json!("array"));
            if let Some(items) = object.get("items") {
                out.insert("items".into(), compile(items, &format!("{path}.items"), false)?);
            }
        }
        "object" => {
            let open = object
                .get("additionalProperties")
                .and_then(Value::as_bool)
                .ok_or_else(|| format!("{path}.additionalProperties must be set to true or false"))?;
            let (properties, required) = match object.get("properties") {
                Some(Value::Object(map)) => property_map(map, &format!("{path}.properties"))?,
                Some(_) => return Err(format!("{path}.properties must be an object")),
                None => (Map::new(), Vec::new()),
            };
            out.insert("type".into(), json!("object"));
            out.insert("properties".into(), Value::Object(properties));
            if !required.is_empty() {
                out.insert("required".into(), json!(required));
            }
            out.insert("additionalProperties".into(), json!(open));
        }
        other => return Err(format!("{path}.type `{other}` is not a ValueSchemaSpec type")),
    }
    Ok(Value::Object(out))
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p kition-harness schema`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-harness
git commit -m "Compile DeepSeek Harness parameter schemas to JSON Schema in the harness"
```

### Task 3: Cancellation

**Files:**
- Create: `crates/kition-harness/src/cancel.rs`
- Modify: `crates/kition-harness/src/lib.rs` (add `pub mod cancel;`)

- [ ] **Step 1: Write the failing test**

```rust
//! Cooperative cancellation shared by the driver, the model call, and tools.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_wakes_waiters_and_sticks() {
        let cancel = Cancel::default();
        let waiter = cancel.clone();
        let task = tokio::spawn(async move { waiter.cancelled().await });
        tokio::task::yield_now().await;
        cancel.cancel();
        task.await.unwrap_or_else(|error| panic!("{error}"));
        assert!(cancel.is_cancelled());
        cancel.cancelled().await;
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p kition-harness cancel`
Expected: compile error, `Cancel` not found.

- [ ] **Step 3: Implement**

```rust
/// A cancellation flag that can be awaited. Cheap to clone.
#[derive(Clone, Default)]
pub struct Cancel {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Cancel {
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once [`Self::cancel`] has been called.
    pub async fn cancelled(&self) {
        loop {
            // Created before the check: `notify_waiters` wakes futures that
            // exist at the time of the call, even if not yet polled.
            let notified = self.inner.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}
```

- [ ] **Step 4: Run the test**

Run: `cargo test -p kition-harness cancel`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-harness
git commit -m "Add cooperative cancellation to the harness"
```

### Task 4: Tools in the `defineTool` shape

**Files:**
- Create: `crates/kition-harness/src/tool.rs`
- Modify: `crates/kition-harness/src/lib.rs` (add `pub mod tool;`)

- [ ] **Step 1: Write the failing tests**

```rust
//! Tools in the DeepSeek Harness `defineTool` shape (Kit Standard A1): a name,
//! a description, a parameter schema, a canonical output schema with a pure
//! render, an optional pure presentation projection, and the body.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;

use futures::future::BoxFuture;
use kition_ai::engine::ToolSpec;
use serde_json::{Value, json};

use crate::cancel::Cancel;
use crate::events::ContentBlock;
use crate::schema;

#[cfg(test)]
mod tests {
    use super::*;

    fn echo() -> ToolDef {
        define("echo", "Echo text")
            .parameters(json!({ "text": { "type": "string", "required": true } }))
            .output(json!({
                "type": "object", "additionalProperties": false,
                "properties": { "text": { "type": "string", "required": true } }
            }))
            .execute(|args, _cx| async move { Ok(json!({ "text": args["text"] })) })
            .render(|_args, value| vec![ContentBlock::text(value["text"].as_str().unwrap_or_default())])
            .presentation_meta(|args, _value| json!({ "title": format!("Echo {}", args["text"]) }))
            .build()
            .unwrap_or_else(|error| panic!("{error}"))
    }

    fn cx() -> ToolContext {
        ToolContext { session_id: "s".into(), call_id: "c".into(), cancel: Cancel::default() }
    }

    #[tokio::test]
    async fn validates_runs_and_renders() {
        let settled = echo().run(json!({ "text": "hi" }), cx()).await;
        assert!(!settled.is_error);
        assert_eq!(settled.value, json!({ "text": "hi" }));
        assert_eq!(settled.content, vec![ContentBlock::text("hi")]);
        assert_eq!(settled.meta, Some(json!({ "title": "Echo \"hi\"" })));
        let bad = echo().run(json!({}), cx()).await;
        assert!(bad.is_error);
        assert!(matches!(&bad.content[0], ContentBlock::Text { text } if text.starts_with("invalid arguments")));
    }

    #[tokio::test]
    async fn output_outside_its_schema_is_an_error() {
        let liar = define("liar", "Returns the wrong shape")
            .output(json!({ "type": "string" }))
            .execute(|_, _| async { Ok(json!(42)) })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(liar.run(json!({}), cx()).await.is_error);
    }

    #[test]
    fn names_are_provider_safe_and_unique() {
        assert_eq!(tool_name("film", "timeline.razor"), "film_timeline_razor");
        let mut registry = ToolRegistry::default();
        assert!(registry.register(echo()).is_ok());
        assert!(registry.register(echo()).is_err());
        assert_eq!(registry.specs()[0].name, "echo");
        assert!(define("bad.name", "x").execute(|_, _| async { Ok(Value::Null) }).build().is_err());
        assert!(define("no_body", "x").build().is_err());
    }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p kition-harness tool`
Expected: compile errors, `define`, `ToolDef`, `ToolContext`, `ToolRegistry`, `tool_name` not found.

- [ ] **Step 3: Implement above the test module**

```rust
/// What a tool body knows about its call.
pub struct ToolContext {
    pub session_id: String,
    pub call_id: String,
    pub cancel: Cancel,
}

/// A failed body: the message the model sees, plus optional partial output.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolFailure {
    pub message: String,
    pub output: Option<Value>,
}

impl<T: Into<String>> From<T> for ToolFailure {
    fn from(message: T) -> Self {
        Self { message: message.into(), output: None }
    }
}

pub type ToolFuture = BoxFuture<'static, Result<Value, ToolFailure>>;
type Execute = Arc<dyn Fn(Value, ToolContext) -> ToolFuture + Send + Sync>;
type Render = Arc<dyn Fn(&Value, &Value) -> Vec<ContentBlock> + Send + Sync>;
type Present = Arc<dyn Fn(&Value, &Value) -> Value + Send + Sync>;

/// A registered tool. Cheap to clone.
#[derive(Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// The compiled JSON Schema sent to the model.
    pub parameters: Value,
    /// The compiled schema every successful value must satisfy.
    pub output_schema: Value,
    /// Whether the tool changes the workspace; policies gate these.
    pub writes: bool,
    execute: Execute,
    render: Render,
    presentation_meta: Option<Present>,
}

/// The settled outcome of one call: the canonical value, what the model sees,
/// and display-only data.
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    pub value: Value,
    pub content: Vec<ContentBlock>,
    pub is_error: bool,
    pub meta: Option<Value>,
}

impl Settled {
    pub fn error(message: impl Into<String>, output: Option<Value>) -> Self {
        Self {
            value: output.unwrap_or(Value::Null),
            content: vec![ContentBlock::text(message)],
            is_error: true,
            meta: None,
        }
    }
}

/// Starts a tool definition.
pub fn define(name: &str, description: &str) -> ToolBuilder {
    ToolBuilder {
        name: name.to_owned(),
        description: description.to_owned(),
        parameters: json!({}),
        output: json!({ "type": "json" }),
        writes: false,
        execute: None,
        render: None,
        presentation_meta: None,
    }
}

pub struct ToolBuilder {
    name: String,
    description: String,
    parameters: Value,
    output: Value,
    writes: bool,
    execute: Option<Execute>,
    render: Option<Render>,
    presentation_meta: Option<Present>,
}

impl ToolBuilder {
    /// A `ParameterSchemaSpec`.
    pub fn parameters(mut self, spec: Value) -> Self {
        self.parameters = spec;
        self
    }

    /// A `ValueSchemaSpec` for the canonical output; defaults to `json`.
    pub fn output(mut self, spec: Value) -> Self {
        self.output = spec;
        self
    }

    pub fn writes(mut self) -> Self {
        self.writes = true;
        self
    }

    pub fn execute<F, Fut>(mut self, body: F) -> Self
    where
        F: Fn(Value, ToolContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, ToolFailure>> + Send + 'static,
    {
        self.execute = Some(Arc::new(move |args: Value, cx: ToolContext| -> ToolFuture {
            Box::pin(body(args, cx))
        }));
        self
    }

    /// Pure projection of arguments and value to model content.
    pub fn render(mut self, render: impl Fn(&Value, &Value) -> Vec<ContentBlock> + Send + Sync + 'static) -> Self {
        self.render = Some(Arc::new(render));
        self
    }

    /// Pure projection of arguments and value to display-only data.
    pub fn presentation_meta(mut self, present: impl Fn(&Value, &Value) -> Value + Send + Sync + 'static) -> Self {
        self.presentation_meta = Some(Arc::new(present));
        self
    }

    pub fn build(self) -> Result<ToolDef, String> {
        if !valid_name(&self.name) {
            return Err(format!("tool name `{}` must be 1 to 64 characters of [A-Za-z0-9_]", self.name));
        }
        let parameters = schema::parameters_to_json_schema(&self.parameters)
            .map_err(|error| format!("{}: {error}", self.name))?;
        let output_schema = schema::value_to_json_schema(&self.output)
            .map_err(|error| format!("{}: {error}", self.name))?;
        let execute = self
            .execute
            .ok_or_else(|| format!("{}: no execute body", self.name))?;
        let render: Render = match self.render {
            Some(render) => render,
            None => Arc::new(|_args: &Value, value: &Value| vec![ContentBlock::text(value.to_string())]),
        };
        Ok(ToolDef {
            name: self.name,
            description: self.description,
            parameters,
            output_schema,
            writes: self.writes,
            execute,
            render,
            presentation_meta: self.presentation_meta,
        })
    }
}

/// A tool name valid in every provider's tool namespace (Kit Standard A2).
pub fn tool_name(prefix: &str, command: &str) -> String {
    format!("{prefix}_{command}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect()
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl ToolDef {
    pub fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name.clone(),
            description: self.description.clone(),
            input_schema: Some(self.parameters.clone()),
        }
    }

    /// Validates the arguments, runs the body, checks the value against the
    /// output schema, and renders it. Never panics; failures are `Settled` errors.
    pub async fn run(&self, args: Value, cx: ToolContext) -> Settled {
        let problems = schema::violations(&self.parameters, &args);
        if !problems.is_empty() {
            return Settled::error(format!("invalid arguments: {}", problems.join("; ")), None);
        }
        match (self.execute)(args.clone(), cx).await {
            Err(failure) => Settled::error(failure.message, failure.output),
            Ok(value) => {
                let problems = schema::violations(&self.output_schema, &value);
                if !problems.is_empty() {
                    return Settled::error(
                        format!("{} returned output outside its schema: {}", self.name, problems.join("; ")),
                        None,
                    );
                }
                Settled {
                    content: (self.render)(&args, &value),
                    meta: self.presentation_meta.as_ref().map(|present| present(&args, &value)),
                    value,
                    is_error: false,
                }
            }
        }
    }
}

/// Tools by name. A second registration of a name is refused.
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, ToolDef>,
}

impl ToolRegistry {
    pub fn register(&mut self, tool: ToolDef) -> Result<(), String> {
        if self.tools.contains_key(&tool.name) {
            return Err(format!("tool `{}` is already registered", tool.name));
        }
        self.tools.insert(tool.name.clone(), tool);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<&ToolDef> {
        self.tools.get(name)
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools.values().map(ToolDef::spec).collect()
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p kition-harness tool`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-harness
git commit -m "Define harness tools in the DeepSeek Harness defineTool shape"
```

### Task 5: The session log and derived model history

**Files:**
- Create: `crates/kition-harness/src/log.rs`
- Create: `crates/kition-harness/src/derive.rs`
- Modify: `crates/kition-harness/src/lib.rs` (add `pub mod derive;` and `pub mod log;`)

- [ ] **Step 1: Write the failing tests**

`log.rs`:

```rust
//! The append-only session log. Sessions are keyed by a string such as
//! `agent:42`, so the harness does not depend on any one table.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use kition_core::now_millis;

use crate::events::{EventBody, SessionEvent};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_log_numbers_events_per_session() {
        let log = MemoryLog::default();
        let first = log.append("a", EventBody::TurnStart { turn: 1 }).unwrap_or_else(|error| panic!("{error}"));
        let second = log.append("a", EventBody::StepStart { turn: 1, step: 1 }).unwrap_or_else(|error| panic!("{error}"));
        let other = log.append("b", EventBody::TurnStart { turn: 1 }).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!((first.seq, second.seq, other.seq), (1, 2, 1));
        let events = log.read("a").unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(events.iter().map(|event| event.body.kind()).collect::<Vec<_>>(), ["turn/start", "step/start"]);
        assert!(log.read("missing").unwrap_or_else(|error| panic!("{error}")).is_empty());
    }
}
```

`derive.rs`:

```rust
//! Model history derived from the session log (DeepSeek Harness
//! `deriveMessages`). Lifecycle events and failed attempts are not model
//! history; the newest system message leads.

use kition_ai::engine::{Message, MessagePart, ToolCall};

use crate::events::{ContentBlock, EventBody, SessionEvent};

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::events::LoggedCall;

    fn at(seq: u64, body: EventBody) -> SessionEvent {
        SessionEvent { seq, at: 0, body }
    }

    #[test]
    fn derives_history_with_tool_images_after_the_results() {
        let events = vec![
            at(1, EventBody::TurnStart { turn: 1 }),
            at(2, EventBody::StepStart { turn: 1, step: 1 }),
            at(3, EventBody::SystemMessage { content: "old".into() }),
            at(4, EventBody::SystemMessage { content: "You are Kition.".into() }),
            at(5, EventBody::UserMessage { content: vec![ContentBlock::text("Brighten it")] }),
            at(6, EventBody::AssistantAttempt { error: "timeout".into() }),
            at(7, EventBody::AssistantMessage {
                content: String::new(),
                tool_calls: vec![LoggedCall { call_id: "c1".into(), name: "photo_run".into(), arguments: json!({ "path": "a.psd" }) }],
                stop_reason: "tool_use".into(),
                model: "m".into(),
                raw_items: Vec::new(),
            }),
            at(8, EventBody::ToolCall { call_id: "c1".into(), name: "photo_run".into(), arguments: json!({ "path": "a.psd" }) }),
            at(9, EventBody::ToolResult {
                call_id: "c1".into(),
                name: "photo_run".into(),
                value: json!({}),
                content: vec![ContentBlock::text("Ran 1 command"), ContentBlock::Image { url: "data:image/png;base64,AA==".into() }],
                is_error: false,
                meta: None,
            }),
            at(10, EventBody::StepEnd { turn: 1, step: 1 }),
            at(11, EventBody::AssistantMessage {
                content: "Done.".into(),
                tool_calls: Vec::new(),
                stop_reason: "stop".into(),
                model: "m".into(),
                raw_items: Vec::new(),
            }),
        ];
        let messages = derive_messages(&events);
        let roles: Vec<&str> = messages.iter().map(|message| message.role.as_str()).collect();
        assert_eq!(roles, ["system", "user", "assistant", "tool", "user", "assistant"]);
        assert_eq!(messages[0].content, "You are Kition.");
        assert_eq!(messages[2].tool_calls[0].input, r#"{"path":"a.psd"}"#);
        assert_eq!(messages[3].tool_call_id, "c1");
        assert_eq!(messages[3].content, "Ran 1 command");
        assert_eq!(messages[4].parts[0].kind, "image_url");
    }
}
```

Add `pub mod derive;` and `pub mod log;` to `lib.rs`.

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p kition-harness log derive`
Expected: compile errors, `MemoryLog`, `SessionLog`, `derive_messages` not found.

- [ ] **Step 3: Implement the log above its test module**

```rust
/// Where session events live. Appends are ordered per session.
pub trait SessionLog: Send + Sync {
    /// Appends one event and returns it with its sequence number and time.
    fn append(&self, session: &str, body: EventBody) -> Result<SessionEvent, String>;
    /// Every event of the session in order; empty for an unknown session.
    fn read(&self, session: &str) -> Result<Vec<SessionEvent>, String>;
}

/// A log in memory, for tests and short-lived sessions.
#[derive(Default)]
pub struct MemoryLog {
    sessions: Mutex<HashMap<String, Vec<SessionEvent>>>,
}

impl SessionLog for MemoryLog {
    fn append(&self, session: &str, body: EventBody) -> Result<SessionEvent, String> {
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        let events = sessions.entry(session.to_owned()).or_default();
        let event = SessionEvent { seq: events.len() as u64 + 1, at: now_millis(), body };
        events.push(event.clone());
        Ok(event)
    }

    fn read(&self, session: &str) -> Result<Vec<SessionEvent>, String> {
        let sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        Ok(sessions.get(session).cloned().unwrap_or_default())
    }
}
```

If `now_millis()` returns a type other than `i64`, convert with `.into()` or
adjust `SessionEvent::at`; check `crates/kition-core/src/time.rs` first.

- [ ] **Step 4: Implement `derive_messages` above its test module**

```rust
/// The messages a model request carries, rebuilt from the log. Images in
/// tool results follow all results of their step as one user message, so
/// tool messages stay adjacent to the assistant message that called them.
pub fn derive_messages(events: &[SessionEvent]) -> Vec<Message> {
    let mut system = String::new();
    let mut history = Vec::new();
    let mut pending_images: Vec<MessagePart> = Vec::new();
    for event in events {
        let flush = !matches!(event.body, EventBody::ToolResult { .. } | EventBody::ToolCall { .. });
        if flush && !pending_images.is_empty() {
            history.push(Message {
                role: "user".into(),
                parts: std::mem::take(&mut pending_images),
                ..Message::default()
            });
        }
        match &event.body {
            EventBody::SystemMessage { content } => system.clone_from(content),
            EventBody::UserMessage { content } => history.push(user_message(content)),
            EventBody::AssistantMessage { content, tool_calls, raw_items, .. } => {
                if content.is_empty() && tool_calls.is_empty() {
                    continue;
                }
                history.push(Message {
                    role: "assistant".into(),
                    content: content.clone(),
                    tool_calls: tool_calls
                        .iter()
                        .map(|call| ToolCall {
                            id: call.call_id.clone(),
                            name: call.name.clone(),
                            input: call.arguments.to_string(),
                        })
                        .collect(),
                    raw_items: raw_items.clone(),
                    ..Message::default()
                });
            }
            EventBody::ToolResult { call_id, name, content, .. } => {
                let (text, images) = split(content);
                history.push(Message {
                    role: "tool".into(),
                    name: name.clone(),
                    tool_call_id: call_id.clone(),
                    content: text,
                    ..Message::default()
                });
                pending_images.extend(images);
            }
            _ => {}
        }
    }
    if !pending_images.is_empty() {
        history.push(Message { role: "user".into(), parts: pending_images, ..Message::default() });
    }
    if !system.is_empty() {
        history.insert(0, Message::new("system", system));
    }
    history
}

fn user_message(content: &[ContentBlock]) -> Message {
    let (text, images) = split(content);
    if images.is_empty() {
        return Message::new("user", text);
    }
    let mut parts = Vec::new();
    if !text.is_empty() {
        parts.push(MessagePart { kind: "text".into(), text, ..MessagePart::default() });
    }
    parts.extend(images);
    Message { role: "user".into(), parts, ..Message::default() }
}

fn split(content: &[ContentBlock]) -> (String, Vec<MessagePart>) {
    let mut texts = Vec::new();
    let mut images = Vec::new();
    for block in content {
        match block {
            ContentBlock::Text { text } => texts.push(text.as_str()),
            ContentBlock::Image { url } => images.push(MessagePart {
                kind: "image_url".into(),
                image_url: url.clone(),
                ..MessagePart::default()
            }),
        }
    }
    (texts.join("\n"), images)
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test -p kition-harness log derive`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add crates/kition-harness
git commit -m "Add the harness session log and derive model history from it"
```

### Task 6: The SQLite session log

**Files:**
- Modify: `crates/kition-store/schema/main.sql` (append after the `agent_subagents` table)
- Modify: `crates/kition-harness/src/log.rs`

The store creates missing tables and indexes at startup from `main.sql`
(`crates/kition-store/src/migrate.rs`), so no migration code is needed.

- [ ] **Step 1: Add the table**

Append to `crates/kition-store/schema/main.sql`, after the `agent_subagents`
statements:

```sql
CREATE TABLE `agent_session_events` (`id` integer PRIMARY KEY AUTOINCREMENT,`session_key` text NOT NULL,`seq` integer NOT NULL,`event_type` text NOT NULL,`body` JSON NOT NULL,`created_at` integer NOT NULL);
CREATE UNIQUE INDEX `idx_agent_session_events_session_seq` ON `agent_session_events`(`session_key`,`seq`);
```

- [ ] **Step 2: Write the failing test** (add to the `tests` module in `log.rs`)

```rust
    #[test]
    fn sqlite_log_round_trips_events() {
        let db = kition_store::Db::open_in_memory().unwrap_or_else(|error| panic!("{error}"));
        let log = SqliteLog::new(db);
        log.append("agent:1", EventBody::TurnStart { turn: 1 }).unwrap_or_else(|error| panic!("{error}"));
        let body = EventBody::UserMessage { content: vec![crate::events::ContentBlock::text("hi")] };
        let appended = log.append("agent:1", body.clone()).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(appended.seq, 2);
        let events = log.read("agent:1").unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].body, body);
        assert!(log.read("agent:2").unwrap_or_else(|error| panic!("{error}")).is_empty());
    }
```

- [ ] **Step 3: Run it to see it fail**

Run: `cargo test -p kition-harness sqlite_log`
Expected: compile error, `SqliteLog` not found.

- [ ] **Step 4: Implement** (add the two imports to the top of `log.rs`, the rest above the tests)

```rust
use kition_store::Db;
use rusqlite::params;

/// The durable log in the workspace database (`agent_session_events`).
pub struct SqliteLog {
    db: Db,
}

impl SqliteLog {
    pub fn new(db: Db) -> Self {
        Self { db }
    }
}

impl SessionLog for SqliteLog {
    fn append(&self, session: &str, body: EventBody) -> Result<SessionEvent, String> {
        let conn = self.db.conn().map_err(|error| error.to_string())?;
        let text = serde_json::to_string(&body).map_err(|error| error.to_string())?;
        let at = now_millis();
        let seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_session_events WHERE session_key = ?1",
                [session],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        conn.execute(
            "INSERT INTO agent_session_events (session_key, seq, event_type, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session, seq, body.kind(), text, at],
        )
        .map_err(|error| error.to_string())?;
        Ok(SessionEvent { seq: seq as u64, at, body })
    }

    fn read(&self, session: &str) -> Result<Vec<SessionEvent>, String> {
        let conn = self.db.conn().map_err(|error| error.to_string())?;
        let mut statement = conn
            .prepare("SELECT seq, created_at, body FROM agent_session_events WHERE session_key = ?1 ORDER BY seq")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([session], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?))
            })
            .map_err(|error| error.to_string())?;
        let mut events = Vec::new();
        for row in rows {
            let (seq, at, text) = row.map_err(|error| error.to_string())?;
            let body: EventBody = serde_json::from_str(&text)
                .map_err(|error| format!("session `{session}` event {seq}: {error}"))?;
            events.push(SessionEvent { seq: seq as u64, at, body });
        }
        Ok(events)
    }
}
```

- [ ] **Step 5: Run the harness tests and the store tests**

Run: `cargo test -p kition-harness && cargo test -p kition-store`
Expected: all pass (the store's schema tests parse the new statements).

- [ ] **Step 6: Commit**

```bash
git add crates/kition-store/schema/main.sql crates/kition-harness
git commit -m "Store harness session events in agent_session_events"
```

### Task 7: The model seam

**Files:**
- Create: `crates/kition-harness/src/llm.rs`
- Create: `crates/kition-harness/src/testing.rs`
- Modify: `crates/kition-harness/src/lib.rs` (add `pub mod llm;` and `pub mod testing;`)

- [ ] **Step 1: Write the failing test** (in `testing.rs`)

```rust
//! Test doubles for the harness and the crates built on it.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};

use futures::future::BoxFuture;
use serde_json::Value;

use crate::events::LoggedCall;
use crate::llm::{ChunkSink, Llm, LlmReply, LlmRequest};

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[tokio::test]
    async fn scripted_llm_replays_and_records() {
        let llm = ScriptedLlm::new(vec![LlmReply::text("hello")]);
        let seen = Arc::new(Mutex::new(String::new()));
        let sink = seen.clone();
        let on_text: ChunkSink = Arc::new(move |delta: &str| {
            sink.lock().unwrap_or_else(PoisonError::into_inner).push_str(delta);
        });
        let request = LlmRequest { messages: Vec::new(), tools: Vec::new() };
        let reply = llm.call(request, on_text.clone()).await.unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(reply.content, "hello");
        assert_eq!(*seen.lock().unwrap_or_else(PoisonError::into_inner), "hello");
        assert_eq!(llm.requests().len(), 1);
        let request = LlmRequest { messages: Vec::new(), tools: Vec::new() };
        assert!(llm.call(request, on_text).await.is_err());
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cargo test -p kition-harness scripted`
Expected: compile errors, `llm` module and `ScriptedLlm` not found.

- [ ] **Step 3: Implement `llm.rs`**

```rust
//! The model seam: one streamed call. `EngineLlm` adapts Kition's AI engine,
//! which speaks the OpenAI-compatible wire (DeepSeek included), Responses, and
//! Anthropic.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_ai::engine::{Engine, Message, RuntimeModel, StreamEvent, StreamHandler, ToolSpec};
use kition_core::now_millis;
use serde_json::Value;

use crate::events::LoggedCall;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LlmRequest {
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LlmReply {
    pub content: String,
    pub tool_calls: Vec<LoggedCall>,
    pub stop_reason: String,
    pub model: String,
    pub raw_items: Vec<Value>,
}

impl LlmReply {
    pub fn text(content: &str) -> Self {
        Self { content: content.to_owned(), stop_reason: "stop".into(), ..Self::default() }
    }

    pub fn calls(calls: Vec<LoggedCall>) -> Self {
        Self { tool_calls: calls, stop_reason: "tool_use".into(), ..Self::default() }
    }
}

/// Receives streamed assistant text.
pub type ChunkSink = Arc<dyn Fn(&str) + Send + Sync>;

pub trait Llm: Send + Sync {
    fn call(&self, request: LlmRequest, on_text: ChunkSink) -> BoxFuture<'_, Result<LlmReply, String>>;
}

/// Kition's AI engine with one resolved model.
pub struct EngineLlm {
    pub engine: Engine,
    pub model: RuntimeModel,
}

impl Llm for EngineLlm {
    fn call(&self, request: LlmRequest, on_text: ChunkSink) -> BoxFuture<'_, Result<LlmReply, String>> {
        Box::pin(async move {
            let handler: StreamHandler = Arc::new(move |event: StreamEvent| {
                if event.kind == "delta" && !event.delta.is_empty() {
                    on_text(&event.delta);
                }
            });
            let result = self
                .engine
                .chat_with_retry(&request.messages, &request.tools, "", &self.model, Some(handler), None)
                .await
                .map_err(|error| error.to_string())?;
            let stamp = now_millis();
            let tool_calls = result
                .tool_calls
                .iter()
                .enumerate()
                .map(|(index, call)| LoggedCall {
                    call_id: if call.id.trim().is_empty() {
                        format!("call_{stamp}_{index}")
                    } else {
                        call.id.trim().to_owned()
                    },
                    name: call.name.trim().to_owned(),
                    arguments: call.input_value(),
                })
                .collect();
            Ok(LlmReply {
                content: result.content.trim().to_owned(),
                tool_calls,
                stop_reason: result.stop_reason,
                model: result.model,
                raw_items: result.response_items,
            })
        })
    }
}
```

Hosted web search and hosted image generation results
(`ChatResult::hosted_*`) are not carried in phase A; phase B adds them as
`tool/call` and `tool/result` events, as `turn.rs` records them today.

- [ ] **Step 4: Implement `ScriptedLlm` in `testing.rs` above the tests**

```rust
/// A model that answers with fixed replies in order and records requests.
pub struct ScriptedLlm {
    replies: Mutex<VecDeque<LlmReply>>,
    requests: Mutex<Vec<LlmRequest>>,
}

impl ScriptedLlm {
    pub fn new(replies: Vec<LlmReply>) -> Self {
        Self { replies: Mutex::new(replies.into()), requests: Mutex::new(Vec::new()) }
    }

    /// Every request received so far.
    pub fn requests(&self) -> Vec<LlmRequest> {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

impl Llm for ScriptedLlm {
    fn call(&self, request: LlmRequest, on_text: ChunkSink) -> BoxFuture<'_, Result<LlmReply, String>> {
        self.requests.lock().unwrap_or_else(PoisonError::into_inner).push(request);
        let reply = self.replies.lock().unwrap_or_else(PoisonError::into_inner).pop_front();
        Box::pin(async move {
            let reply = reply.ok_or("the scripted model has no more replies")?;
            if !reply.content.is_empty() {
                on_text(&reply.content);
            }
            Ok(reply)
        })
    }
}

/// A tool call for scripted replies.
pub fn call(id: &str, name: &str, arguments: Value) -> LoggedCall {
    LoggedCall { call_id: id.to_owned(), name: name.to_owned(), arguments }
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test -p kition-harness`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add crates/kition-harness
git commit -m "Add the harness model seam over the Kition AI engine"
```

### Task 8: The tool policy pipeline

**Files:**
- Create: `crates/kition-harness/src/policy.rs`
- Modify: `crates/kition-harness/src/lib.rs` (add `pub mod policy;`)

- [ ] **Step 1: Write the failing tests**

```rust
//! The pipeline around a tool body (DeepSeek Harness `tools/pre-execute` and
//! `tools/post-execute`): policies allow, deny, or ask before a call, and may
//! adjust a settled result after it.

use std::sync::Arc;

use serde_json::Value;

use crate::tool::{Settled, ToolDef};

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
    fn first_non_allow_decision_wins_and_post_runs_in_order() {
        let args = json!({});
        let writer = tool(true);
        let call = CallInfo { session: "s", call_id: "c", tool: &writer, arguments: &args };
        let read_only = Pipeline::default().with(WritePermission { may_write: false }).with(AskForAll);
        assert!(matches!(read_only.decide(&call), Decision::Deny(reason) if reason.contains("read-only")));
        let writable = Pipeline::default().with(WritePermission { may_write: true }).with(AskForAll);
        assert_eq!(writable.decide(&call), Decision::Ask("confirm".into()));
        let reader = tool(false);
        let call = CallInfo { session: "s", call_id: "c", tool: &reader, arguments: &args };
        assert_eq!(Pipeline::default().with(WritePermission { may_write: false }).decide(&call), Decision::Allow);
        let mut settled = Settled { value: Value::Null, content: Vec::new(), is_error: false, meta: None };
        Pipeline::default().with(Redact).settle(&call, &mut settled);
        assert_eq!(settled.content, vec![ContentBlock::text("[redacted]")]);
    }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p kition-harness policy`
Expected: compile errors, `Policy`, `Pipeline`, `Decision`, `CallInfo`, `WritePermission` not found.

- [ ] **Step 3: Implement above the tests**

```rust
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

/// Policies in order. Before a call the first decision other than `Allow`
/// wins; after it every policy runs in order.
#[derive(Clone, Default)]
pub struct Pipeline {
    policies: Vec<Arc<dyn Policy>>,
}

impl Pipeline {
    pub fn with(mut self, policy: impl Policy + 'static) -> Self {
        self.policies.push(Arc::new(policy));
        self
    }

    pub fn decide(&self, call: &CallInfo<'_>) -> Decision {
        for policy in &self.policies {
            match policy.pre_execute(call) {
                Decision::Allow => {}
                other => return other,
            }
        }
        Decision::Allow
    }

    pub fn settle(&self, call: &CallInfo<'_>, settled: &mut Settled) {
        for policy in &self.policies {
            policy.post_execute(call, settled);
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p kition-harness policy`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-harness
git commit -m "Add the harness tool policy pipeline"
```

### Task 9: The provider seam

**Files:**
- Create: `crates/kition-harness/src/provider.rs`
- Modify: `crates/kition-harness/src/lib.rs` (add `pub mod provider;`)

- [ ] **Step 1: Write the failing tests**

```rust
//! The provider seam. Every pane and kit contributes to a turn through one
//! interface: prompt sections and tools. The driver never names a pane or a
//! kit (Kit Standard section 2, the capability seam model).

use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::Value;

use crate::tool::{ToolDef, ToolRegistry};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::define;

    struct Fixed {
        id: &'static str,
        pane: &'static str,
        tool: &'static str,
    }

    impl Provider for Fixed {
        fn id(&self) -> &str {
            self.id
        }

        fn applies(&self, scene: &TurnScene) -> bool {
            self.pane.is_empty() || scene.pane == self.pane
        }

        fn prompt(&self, _scene: &TurnScene) -> Vec<String> {
            vec![format!("{} rules", self.id)]
        }

        fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
            Box::pin(async move {
                Ok(vec![define(self.tool, "test").execute(|_, _| async { Ok(Value::Null) }).build()?])
            })
        }
    }

    fn scene(pane: &str) -> TurnScene {
        TurnScene { pane: pane.into(), ..TurnScene::default() }
    }

    #[tokio::test]
    async fn assembles_only_applicable_providers_in_order() {
        let providers: Vec<Arc<dyn Provider>> = vec![
            Arc::new(Fixed { id: "documents", pane: "", tool: "document_read" }),
            Arc::new(Fixed { id: "photo", pane: "photo", tool: "photo_inspect" }),
            Arc::new(Fixed { id: "tables", pane: "table", tool: "data_table_schema" }),
        ];
        let assembly = assemble("Base.", &providers, &scene("photo")).await.unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(assembly.system, "Base.\n\ndocuments rules\n\nphoto rules");
        assert!(assembly.tools.get("photo_inspect").is_some());
        assert!(assembly.tools.get("data_table_schema").is_none());
    }

    #[tokio::test]
    async fn duplicate_tools_name_the_provider() {
        let providers: Vec<Arc<dyn Provider>> = vec![
            Arc::new(Fixed { id: "a", pane: "", tool: "same" }),
            Arc::new(Fixed { id: "b", pane: "", tool: "same" }),
        ];
        let error = assemble("", &providers, &scene("")).await.err().unwrap_or_default();
        assert!(error.starts_with("b:"), "{error}");
    }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p kition-harness provider`
Expected: compile errors, `Provider`, `TurnScene`, `assemble` not found.

- [ ] **Step 3: Implement above the tests**

```rust
/// What the person has in front of them when the turn starts.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnScene {
    /// The pane id, such as `document`, `table`, `whiteboard`, or a kit id.
    pub pane: String,
    /// The workspace-relative path of the open file, if any.
    pub active_path: String,
    /// The person's language, BCP 47.
    pub language: String,
    /// Pane-specific context, such as a whiteboard description.
    pub extra: Value,
}

pub trait Provider: Send + Sync {
    fn id(&self) -> &str;

    /// Whether the provider takes part in a turn with this scene.
    fn applies(&self, _scene: &TurnScene) -> bool {
        true
    }

    /// System prompt sections, in order.
    fn prompt(&self, _scene: &TurnScene) -> Vec<String> {
        Vec::new()
    }

    /// Tools for this turn. Async because kit providers ask the kit.
    fn tools<'a>(&'a self, _scene: &'a TurnScene) -> BoxFuture<'a, Result<Vec<ToolDef>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// The system prompt and tools for one turn.
pub struct Assembly {
    pub system: String,
    pub tools: ToolRegistry,
}

pub async fn assemble(base: &str, providers: &[Arc<dyn Provider>], scene: &TurnScene) -> Result<Assembly, String> {
    let mut sections = vec![base.trim().to_owned()];
    let mut tools = ToolRegistry::default();
    for provider in providers.iter().filter(|provider| provider.applies(scene)) {
        sections.extend(provider.prompt(scene).into_iter().map(|section| section.trim().to_owned()));
        for tool in provider.tools(scene).await.map_err(|error| format!("{}: {error}", provider.id()))? {
            tools.register(tool).map_err(|error| format!("{}: {error}", provider.id()))?;
        }
    }
    let system = sections
        .into_iter()
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(Assembly { system, tools })
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p kition-harness provider`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-harness
git commit -m "Add the harness provider seam"
```

### Task 10: The turn and step driver

**Files:**
- Create: `crates/kition-harness/src/driver.rs`
- Create: `crates/kition-harness/tests/driver.rs`
- Modify: `crates/kition-harness/src/lib.rs` (add `pub mod driver;`)

- [ ] **Step 1: Write the failing integration tests**

`crates/kition-harness/tests/driver.rs`:

```rust
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
        .render(|_args, value| vec![ContentBlock::text(value["text"].as_str().unwrap_or_default())])
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
        tools.register(echo(self.ran.clone())).unwrap_or_else(|error| panic!("{error}"));
        let live = self.live.clone();
        TurnInput {
            session: "s".into(),
            system: "You are Kition.".into(),
            tools,
            user: vec![ContentBlock::text(text)],
            cancel,
            live: Arc::new(move |event: Live| live.lock().unwrap_or_else(PoisonError::into_inner).push(event)),
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
            "turn/start", "step/start", "system/message", "user/message", "assistant/message",
            "tool/call", "tool/result", "step/end", "step/start", "assistant/message", "step/end", "turn/end",
        ]
    );
    let second = &setup.llm.requests()[1];
    let tool = second.messages.iter().find(|message| message.role == "tool").map(|message| message.content.clone());
    assert_eq!(tool.as_deref(), Some("hi"));
    assert_eq!(second.tools[0].name, "echo");
    let live = setup.live.lock().unwrap_or_else(PoisonError::into_inner);
    assert!(live.contains(&Live::AssistantText { delta: "done".into() }));
    assert_eq!(live.first(), Some(&Live::Status { running: true }));
    assert_eq!(live.last(), Some(&Live::Status { running: false }));
}

#[tokio::test]
async fn a_second_turn_keeps_history_and_does_not_relog_the_system_prompt() {
    let setup = setup(vec![LlmReply::text("one"), LlmReply::text("two")]);
    let driver = setup.driver(Pipeline::default());
    driver.run_turn(setup.input("first", Cancel::default())).await.unwrap_or_else(|error| panic!("{error}"));
    driver.run_turn(setup.input("second", Cancel::default())).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(setup.kinds().iter().filter(|kind| **kind == "system/message").count(), 1);
    let roles: Vec<String> = setup.llm.requests()[1].messages.iter().map(|message| message.role.clone()).collect();
    assert_eq!(roles, ["system", "user", "assistant", "user"]);
}

#[tokio::test]
async fn unknown_tools_and_denied_tools_become_error_results() {
    let setup = setup(vec![
        LlmReply::calls(vec![call("c1", "missing", json!({})), call("c2", "echo", json!({ "text": "x" }))]),
        LlmReply::text("sorry"),
    ]);
    let pipeline = Pipeline::default().with(WritePermission { may_write: false });
    setup.driver(pipeline).run_turn(setup.input("go", Cancel::default())).await.unwrap_or_else(|error| panic!("{error}"));
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
    let setup = setup(vec![LlmReply::calls(vec![call("c1", "echo", json!({ "text": "x" }))])]);
    let reason = setup
        .driver(Pipeline::default().with(AskEverything))
        .run_turn(setup.input("go", Cancel::default()))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::AwaitingApproval);
    assert!(!setup.ran.load(Ordering::SeqCst));
    let kinds = setup.kinds();
    assert_eq!(&kinds[kinds.len() - 4..], ["tool/call", "approval/asked", "step/end", "turn/end"]);
}

#[tokio::test]
async fn the_step_limit_ends_a_looping_turn() {
    let looping = (0..3).map(|index| LlmReply::calls(vec![call(&format!("c{index}"), "echo", json!({ "text": "x" }))])).collect();
    let setup = setup(looping);
    let mut driver = setup.driver(Pipeline::default());
    driver.max_steps = 2;
    let reason = driver.run_turn(setup.input("loop", Cancel::default())).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::StepLimit);
    assert_eq!(setup.llm.requests().len(), 2);
}

#[tokio::test]
async fn a_cancelled_turn_ends_without_a_model_call() {
    let setup = setup(vec![LlmReply::text("never")]);
    let cancel = Cancel::default();
    cancel.cancel();
    let reason = setup.driver(Pipeline::default()).run_turn(setup.input("go", cancel)).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Cancelled);
    assert!(setup.llm.requests().is_empty());
    assert_eq!(setup.kinds(), ["turn/start", "turn/end"]);
}

#[tokio::test]
async fn a_model_failure_is_logged_as_an_attempt_and_fails_the_turn() {
    let setup = setup(Vec::new());
    let error = setup.driver(Pipeline::default()).run_turn(setup.input("go", Cancel::default())).await.err().unwrap_or_default();
    assert!(error.contains("no more replies"), "{error}");
    let events = setup.log.read("s").unwrap_or_else(|error| panic!("{error}"));
    assert!(events.iter().any(|event| event.body.kind() == "assistant/attempt"));
    assert!(matches!(
        events.last().map(|event| &event.body),
        Some(EventBody::TurnEnd { reason: TurnEndReason::Failed, .. })
    ));
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p kition-harness --test driver`
Expected: compile errors, `kition_harness::driver` not found.

- [ ] **Step 3: Implement `driver.rs`**

```rust
//! The turn and step driver (DeepSeek Harness `agent-loop`). A turn is steps
//! until the model answers without tools; a step is one model call plus the
//! tools it asked for. Every model-visible input is logged first and the
//! request is derived from the log.

use std::sync::Arc;

use crate::cancel::Cancel;
use crate::derive::derive_messages;
use crate::events::{ContentBlock, EventBody, LoggedCall, SessionEvent, TurnEndReason};
use crate::llm::{ChunkSink, Llm, LlmRequest};
use crate::log::SessionLog;
use crate::policy::{CallInfo, Decision, Pipeline};
use crate::tool::{Settled, ToolContext, ToolRegistry};

pub const MAX_STEPS: u32 = 16;

/// Live updates for the panel: never needed for replay (DeepSeek Harness
/// `agent/*`). Every durable event is also sent live as `Event`.
#[derive(Debug, Clone, PartialEq)]
pub enum Live {
    Status { running: bool },
    AssistantText { delta: String },
    Event(SessionEvent),
}

pub type LiveSink = Arc<dyn Fn(Live) + Send + Sync>;

/// One turn's input. Build `system` and `tools` with `provider::assemble`.
pub struct TurnInput {
    pub session: String,
    pub system: String,
    pub tools: ToolRegistry,
    pub user: Vec<ContentBlock>,
    pub cancel: Cancel,
    pub live: LiveSink,
}

pub struct Driver {
    pub log: Arc<dyn SessionLog>,
    pub llm: Arc<dyn Llm>,
    pub pipeline: Pipeline,
    pub max_steps: u32,
}

impl Driver {
    pub fn new(log: Arc<dyn SessionLog>, llm: Arc<dyn Llm>) -> Self {
        Self { log, llm, pipeline: Pipeline::default(), max_steps: MAX_STEPS }
    }

    /// Runs one turn to its end. A model failure ends the turn as `failed`
    /// and is returned as the error after `turn/end` is logged.
    pub async fn run_turn(&self, input: TurnInput) -> Result<TurnEndReason, String> {
        let turn = self
            .log
            .read(&input.session)?
            .iter()
            .filter(|event| matches!(event.body, EventBody::TurnStart { .. }))
            .count() as u32
            + 1;
        (input.live)(Live::Status { running: true });
        let outcome = match self.append(&input, EventBody::TurnStart { turn }) {
            Ok(_) => self.steps(&input, turn).await,
            Err(error) => Err(error),
        };
        let (reason, error) = match &outcome {
            Ok(reason) => (*reason, String::new()),
            Err(error) => (TurnEndReason::Failed, error.clone()),
        };
        let ended = self.append(&input, EventBody::TurnEnd { turn, reason, error });
        (input.live)(Live::Status { running: false });
        ended?;
        outcome
    }

    fn append(&self, input: &TurnInput, body: EventBody) -> Result<SessionEvent, String> {
        let event = self.log.append(&input.session, body)?;
        (input.live)(Live::Event(event.clone()));
        Ok(event)
    }

    async fn steps(&self, input: &TurnInput, turn: u32) -> Result<TurnEndReason, String> {
        let mut user = Some(input.user.clone());
        for step in 1..=self.max_steps {
            if input.cancel.is_cancelled() {
                return Ok(TurnEndReason::Cancelled);
            }
            self.append(input, EventBody::StepStart { turn, step })?;
            self.reconcile_system(input)?;
            if let Some(content) = user.take() {
                self.append(input, EventBody::UserMessage { content })?;
            }
            let request = LlmRequest {
                messages: derive_messages(&self.log.read(&input.session)?),
                tools: input.tools.specs(),
            };
            let live = input.live.clone();
            let on_text: ChunkSink = Arc::new(move |delta: &str| live(Live::AssistantText { delta: delta.to_owned() }));
            let reply = tokio::select! {
                reply = self.llm.call(request, on_text) => reply,
                () = input.cancel.cancelled() => Err("cancelled".to_owned()),
            };
            let reply = match reply {
                Ok(reply) => reply,
                Err(error) => {
                    self.append(input, EventBody::AssistantAttempt { error: error.clone() })?;
                    self.append(input, EventBody::StepEnd { turn, step })?;
                    return if input.cancel.is_cancelled() { Ok(TurnEndReason::Cancelled) } else { Err(error) };
                }
            };
            self.append(input, EventBody::AssistantMessage {
                content: reply.content.clone(),
                tool_calls: reply.tool_calls.clone(),
                stop_reason: reply.stop_reason,
                model: reply.model,
                raw_items: reply.raw_items,
            })?;
            if reply.tool_calls.is_empty() {
                self.append(input, EventBody::StepEnd { turn, step })?;
                return if reply.content.trim().is_empty() {
                    Err("the model returned no content and no tool calls".into())
                } else {
                    Ok(TurnEndReason::Completed)
                };
            }
            for call in &reply.tool_calls {
                if let Some(reason) = self.run_call(input, call).await? {
                    self.append(input, EventBody::StepEnd { turn, step })?;
                    return Ok(reason);
                }
            }
            self.append(input, EventBody::StepEnd { turn, step })?;
        }
        Ok(TurnEndReason::StepLimit)
    }

    /// Runs one call through the pipeline. `Some` ends the turn.
    async fn run_call(&self, input: &TurnInput, call: &LoggedCall) -> Result<Option<TurnEndReason>, String> {
        self.append(input, EventBody::ToolCall {
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
        })?;
        let Some(tool) = input.tools.get(&call.name) else {
            let missing = Settled::error(format!("tool `{}` is not available in this turn", call.name), None);
            self.record(input, call, missing)?;
            return Ok(None);
        };
        let info = CallInfo { session: &input.session, call_id: &call.call_id, tool, arguments: &call.arguments };
        let mut settled = match self.pipeline.decide(&info) {
            Decision::Allow => {
                let cx = ToolContext {
                    session_id: input.session.clone(),
                    call_id: call.call_id.clone(),
                    cancel: input.cancel.clone(),
                };
                tool.run(call.arguments.clone(), cx).await
            }
            Decision::Deny(reason) => Settled::error(reason, None),
            Decision::Ask(reason) => {
                self.append(input, EventBody::ApprovalAsked { call_id: call.call_id.clone(), reason })?;
                return Ok(Some(TurnEndReason::AwaitingApproval));
            }
        };
        self.pipeline.settle(&info, &mut settled);
        self.record(input, call, settled)?;
        Ok(input.cancel.is_cancelled().then_some(TurnEndReason::Cancelled))
    }

    fn record(&self, input: &TurnInput, call: &LoggedCall, settled: Settled) -> Result<(), String> {
        self.append(input, EventBody::ToolResult {
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            value: settled.value,
            content: settled.content,
            is_error: settled.is_error,
            meta: settled.meta,
        })
        .map(|_| ())
    }

    /// Logs the system prompt only when it differs from the newest logged one.
    fn reconcile_system(&self, input: &TurnInput) -> Result<(), String> {
        let current = self.log.read(&input.session)?.into_iter().rev().find_map(|event| match event.body {
            EventBody::SystemMessage { content } => Some(content),
            _ => None,
        });
        if current.as_deref() != Some(input.system.as_str()) {
            self.append(input, EventBody::SystemMessage { content: input.system.clone() })?;
        }
        Ok(())
    }
}
```

Known phase A limits, handled in phase B: resuming after `approval/asked`
(the pending call needs an `approval/decided` event and then its
`tool/result` before the next model call), hosted tool results, and the
unresolved-write recovery that `turn.rs` adds today.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p kition-harness`
Expected: all unit tests and the 7 driver tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-harness
git commit -m "Add the harness turn and step driver"
```

### Task 11: Conformance guard and the workspace gate

**Files:**
- Modify: `crates/kition-harness/src/lib.rs`

- [ ] **Step 1: Write the failing test** (append to `lib.rs`)

```rust
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
        "step/end",
        "step/start",
        "system/message",
        "tool/call",
        "tool/result",
        "turn/end",
        "turn/start",
        "user/message",
    ];

    #[test]
    fn every_event_name_exists_in_the_pinned_dsh_release() {
        for kind in EventBody::KINDS {
            assert!(DSH_KNOWN.contains(kind), "`{kind}` is not a DeepSeek Harness {} event", super::DSH_TARGET);
        }
    }
}
```

- [ ] **Step 2: Run it**

Run: `cargo test -p kition-harness every_event_name`
Expected: PASS. (If it fails, an event name was invented; rename it to the
dsh name rather than extending the list.)

- [ ] **Step 3: Run the full gates**

```bash
pnpm check:desktop
python3 scripts/check-i18n.py
pnpm test:table:e2e
```

Expected: all exit 0. If Playwright fails every spec with
`ERR_CONNECTION_REFUSED`, unset the proxy variables (`HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`) and run the e2e gate again. If clippy on the CI
toolchain (latest stable) is newer than the local one, also run
`cargo +stable clippy --workspace --all-targets -- -D warnings`.

- [ ] **Step 4: Commit**

```bash
git add crates/kition-harness
git commit -m "Guard harness event names against the pinned DeepSeek Harness release"
```

---

## 5. Phase B outline (detailed plan written when phase A lands)

So the next plan does not start from zero, these are the known pieces:

1. `kition-agent` depends on `kition-harness`. `AgentConfig` gains
   `harness: bool`, set from `KITION_AGENT_HARNESS=1` in the API crate.
2. Session key: `agent:<agent_sessions.id>`. `SqliteLog` over the same `Db`.
3. `LegacyToolsProvider`: for each entry in `catalog.json` that the current
   turn may use, a `ToolDef` whose body calls the existing
   `tools::dispatch` with the turn's `Run`; output schema `json`; `writes`
   from the catalog permission. This gives parity before tools are rewritten.
4. Policies: `WritePermission` from `execution_mode`; an exec policy wrapper
   around `execpolicy.rs` that returns `Ask` for commands needing approval;
   a redaction post-policy replacing `persisted_input`.
5. Approval resume: `Driver::resume(session, call_id, allowed)` logs
   `approval/decided`, runs or denies the pending call, records its
   `tool/result`, then continues the open turn.
6. NDJSON adapter: `Live` and `SessionEvent` mapped to today's frames
   (`model_delta`, `tool_call`, `tool_error`, `event`, `done`) so the renderer
   is unchanged until phase F. Existing `agent_*` rows keep being written by
   the adapter during the transition.
7. Turn-stopping hook for the unresolved-write rule from `turn.rs`: when a
   writing tool's last result is an error and the model stops, inject the
   recovery `user/message` and continue the turn once.
8. Hosted web search and image generation results logged as `tool/call` and
   `tool/result` with `meta.hosted = true`.

Found in phase A reviews and deferred to phase B:

- Approval resume must run before any new turn: `derive_messages` already
  closes a pending call with a synthetic result at `step/end`, so a late real
  `tool/result` would be out of place. Calls after the asked one in the same
  reply were never logged as `tool/call`; resume runs them. Consider making
  repair durable (synthetic `tool/call` and `tool/result` events, as dsh's
  `repair.ts` does) instead of derive-time only.
- Log the streamed text of a cancelled model call as an interrupted
  `assistant/message`, as dsh does.
- Race legacy tool bodies (`spawn_blocking`) against cancellation.
- Serialize turns per session (one driver per session key).
- `SessionLog` and `Policy::pre_execute` are synchronous; move SQLite writes
  off the async workers and make policies async when approvals need lookups.
- `Pipeline::with` takes `impl Policy`; add `Arc<dyn Policy>` for shared
  policies. A provider whose `tools()` fails should not fail every turn.
- Report retry progress (`EngineLlm` passes `on_retry: None`) and carry
  `usage` and `wire_api` in `LlmReply` for token metering.
- Add `agent_session_events` to the workspace mirror tables
  (`crates/kition-workspacestorage/src/state.rs`) and delete a session's
  events when the session is deleted.
- Pass tool-result `is_error` to the Anthropic wire.
- Phase G maps Kition turn-end reasons and payloads onto dsh's exact
  `SessionEvent` shapes; the phase A guard checks names only.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| DeepSeek Harness is a developer preview and may break its contracts | Pin `DSH_TARGET`; the event-name guard and the phase G client test catch drift; move the pin deliberately |
| Two loops during migration | One flag, one adapter; phase F deletes `turn.rs`; no feature lands only in the old loop after phase B |
| Synchronous SQLite appends inside async turns | Appends are single small inserts; if profiling shows stalls, move `SqliteLog` writes to `spawn_blocking` behind the same trait |
| Session log growth with images in tool results | Phase B stores images as workspace files and logs references, matching dsh image offload |
| Kit command catalogs of hundreds of tools | Phase D exposes A3 tools always and command tools only through manifest `include` and `exclude`, as the standard drafts |
