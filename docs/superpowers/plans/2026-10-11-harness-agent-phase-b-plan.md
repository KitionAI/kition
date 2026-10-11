# Harness Agent Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DeepSeek work in the agent the way DeepSeek Harness talks to it,
and run Kition's agent turns on `kition-harness` behind
`KITION_AGENT_HARNESS=1` with no visible change to the panel.

**Architecture:** Part 1 (Tasks 1 to 3) fixes the DeepSeek route: DeepSeek's
Anthropic-compatible Messages API, reasoning passed back on later calls, and
reasoning effort sent the way DeepSeek Harness's adapter sends it. Part 2
(Tasks 4 to 7) adds the four harness seams the existing loop handles inline:
tools with an unchecked model schema, a tool that pauses the turn, context
added after tool results plus stop checks, and model follow-up content. Part 3
(Tasks 8 to 10) runs the existing tools, prompts, stream frames, and timeline
events as a harness turn in `kition-agent`, selected by a flag, and proves
parity with the existing end-to-end agent tests run in both modes.

**Tech Stack:** Rust (`kition-ai`, `kition-harness`, `kition-agent`,
`kition-api`), TypeScript (`src/services/desktopSettings.ts`,
`src/services/providerModelCatalog.ts`), vitest.

**Base:** branch `feat/kit-photo-tab` at or after `1d58c7f7` (kit tools are
generated from kit definitions; Phase A harness merged at `5f1ce901`).

**Before starting:** free disk space. A workspace build needs about 10 GB and
the machine had 2.5 GB free when this plan was written. Build with
`CARGO_INCREMENTAL=0`.

---

## Findings this plan is based on

- `kition-ai` has two wires only, `responses` and `anthropic_messages`
  (`crates/kition-ai/src/engine/mod.rs` `dispatch`), and the agent refuses any
  other `wire_api` (`crates/kition-agent/src/session.rs` `drive`).
- The DeepSeek preset in Settings is `https://api.deepseek.com/v1` with the
  default `responses` wire (`src/services/desktopSettings.ts`
  `createProviderConfig`). DeepSeek does not serve the OpenAI Responses API, so
  the agent cannot reach DeepSeek with default settings.
- DeepSeek Harness's DeepSeek adapter (`packages/llm/llm-deepseek/README.md` at
  the pinned `d7432673`) uses `https://api.deepseek.com/anthropic` with the
  Messages API, sends reasoning effort as `output_config.effort`
  (`low`, `high`, `max`) or `thinking: { type: "disabled" }` for `off`, and
  passes reasoning from earlier assistant turns back verbatim.
- Kition's Anthropic wire captures response blocks (`response_items`, including
  `thinking` blocks) but `normalize_messages` never sends them back, and it
  always sends Anthropic's `thinking.budget_tokens`.
- Shell approval is not a resume: the next request carries `shell_approval`
  and a hidden user message, `Run::approved_command` lets the same command run
  once, and the model calls `exec_command` again
  (`crates/kition-agent/tests/agent_flow.rs`
  `commands_outside_the_policy_wait_for_approval`). The harness keeps this:
  the paused call gets its real (pending) result, the turn ends
  `awaiting-approval`, and the next turn is a normal turn.
- `crates/kition-agent/tests/agent_flow.rs` drives full turns against a fake
  Responses provider. Running those tests in harness mode is the parity proof.

## File structure

```text
Part 1
  crates/kition-ai/src/engine/anthropic.rs     thinking passback; reasoning fields per provider
  src/services/desktopSettings.ts              DeepSeek preset and migration to the Messages route
  src/services/desktopSettings.spec.ts         tests for the preset and migration
  src/services/providerModelCatalog.ts         DeepSeek model listing from the API root
  src/services/providerModelCatalog.spec.ts    test for the listing URL
Part 2
  crates/kition-harness/src/tool.rs            unchecked_parameters; hyphen in names; Pause; Settled.context
  crates/kition-harness/src/stop.rs            StopCheck, UnresolvedWrites, RecoveryPrompt (new)
  crates/kition-harness/src/llm.rs             LlmReply.follow_up
  crates/kition-harness/src/driver.rs          pause, contexts, stop checks, follow-up
  crates/kition-harness/tests/driver.rs        tests for the four seams
Part 3
  crates/kition-agent/src/run.rs               AgentConfig.harness, Agent::harness()
  crates/kition-api/src/agent.rs               KITION_AGENT_HARNESS
  crates/kition-agent/src/turn.rs              stream, retry, and hosted helpers made pub(crate)
  crates/kition-agent/src/session.rs           helpers made pub(crate); branch to the harness turn
  crates/kition-agent/src/harness_turn.rs      the harness turn (new)
  crates/kition-agent/src/lib.rs               mod harness_turn
  crates/kition-agent/tests/agent_flow.rs      both tests in both modes
```

---

## Part 1: The DeepSeek route

### Task 1: Pass reasoning back on the Anthropic wire

**Files:**
- Modify: `crates/kition-ai/src/engine/anthropic.rs` (`normalize_messages`, tests)

- [ ] **Step 1: Write the failing test** (add to the `tests` module)

```rust
    #[test]
    fn replays_thinking_blocks_before_text_and_tool_use() {
        let thinking = json!({ "type": "thinking", "thinking": "plan", "signature": "sig" });
        let messages = vec![
            Message::new("user", "go"),
            Message {
                role: "assistant".into(),
                content: "Calling".into(),
                tool_calls: vec![ToolCall { id: "t1".into(), name: "read".into(), input: "{}".into() }],
                raw_items: vec![thinking.clone(), json!({ "type": "text", "text": "Calling" })],
                ..Message::default()
            },
            Message { role: "tool".into(), tool_call_id: "t1".into(), content: "ok".into(), ..Message::default() },
            Message {
                role: "assistant".into(),
                content: "Done".into(),
                raw_items: vec![json!({ "type": "redacted_thinking", "data": "x" })],
                ..Message::default()
            },
        ];
        let (_, items) = normalize_messages(&messages);
        assert_eq!(items[1]["content"][0], thinking);
        assert_eq!(items[1]["content"][1]["type"], "text");
        assert_eq!(items[1]["content"][2]["type"], "tool_use");
        assert_eq!(items[3]["content"][0]["type"], "redacted_thinking");
        assert_eq!(items[3]["content"][1], json!({ "type": "text", "text": "Done" }));
    }
```

- [ ] **Step 2: Run it to see it fail**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-ai replays_thinking`
Expected: FAIL; `items[1]["content"][0]` is the text block.

- [ ] **Step 3: Implement**

Add above `normalize_messages`:

```rust
/// Reasoning blocks from an earlier response, replayed verbatim before the
/// assistant's text and tool calls (DeepSeek and Anthropic thinking).
fn thinking_blocks(message: &Message) -> Vec<Value> {
    message
        .raw_items
        .iter()
        .filter(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("thinking" | "redacted_thinking")
            )
        })
        .cloned()
        .collect()
}
```

In `normalize_messages`, change the assistant-with-tool-calls branch to start
from the thinking blocks:

```rust
        if role == "assistant" && !message.tool_calls.is_empty() {
            let mut blocks = thinking_blocks(message);
```

and before the generic `let role = if role == "user" ...` fallthrough, add:

```rust
        if role == "assistant" {
            let thinking = thinking_blocks(message);
            if !thinking.is_empty() {
                let mut blocks = thinking;
                if !content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": content }));
                }
                out.push(json!({ "role": "assistant", "content": blocks }));
                continue;
            }
        }
```

- [ ] **Step 4: Run the crate tests**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-ai`
Expected: all pass, including `normalizes_messages`.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-ai/src/engine/anthropic.rs
git commit -m "Replay reasoning blocks on the Anthropic Messages wire"
```

### Task 2: Send DeepSeek reasoning effort the DeepSeek way

**Files:**
- Modify: `crates/kition-ai/src/engine/anthropic.rs` (`call`, tests)

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn deepseek_reasoning_uses_output_config_effort() {
        let model = |provider: &str, effort: &str| RuntimeModel {
            provider_type: provider.into(),
            reasoning_effort: effort.into(),
            ..RuntimeModel::default()
        };
        assert_eq!(reasoning_fields(&model("deepseek", "medium")), vec![("output_config", json!({ "effort": "high" }))]);
        assert_eq!(reasoning_fields(&model("deepseek", "low")), vec![("output_config", json!({ "effort": "low" }))]);
        assert_eq!(reasoning_fields(&model("deepseek", "max")), vec![("output_config", json!({ "effort": "max" }))]);
        assert_eq!(reasoning_fields(&model("deepseek", "off")), vec![("thinking", json!({ "type": "disabled" }))]);
        assert!(reasoning_fields(&model("deepseek", "")).is_empty());
        assert_eq!(
            reasoning_fields(&model("anthropic", "high")),
            vec![("thinking", json!({ "type": "enabled", "budget_tokens": 16384 }))]
        );
        assert!(reasoning_fields(&model("anthropic", "off")).is_empty());
    }
```

`RuntimeModel` comes from `super::super::types` in the test module; add it to
the test imports if missing.

- [ ] **Step 2: Run it to see it fail**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-ai deepseek_reasoning`
Expected: compile error, `reasoning_fields` not found.

- [ ] **Step 3: Implement**

Add near `thinking_budget`:

```rust
/// Reasoning request fields. DeepSeek's Messages API takes
/// `output_config.effort` (`low`, `high`, `max`) and `thinking.type =
/// disabled` for off, as DeepSeek Harness's adapter sends them; Anthropic
/// takes a thinking token budget.
pub(crate) fn reasoning_fields(model: &RuntimeModel) -> Vec<(&'static str, Value)> {
    let effort = model.reasoning_effort.trim().to_lowercase();
    if model.provider_type.trim() == "deepseek" {
        return match effort.as_str() {
            "" => Vec::new(),
            "off" | "none" | "minimal" => vec![("thinking", json!({ "type": "disabled" }))],
            "low" => vec![("output_config", json!({ "effort": "low" }))],
            "max" | "xhigh" => vec![("output_config", json!({ "effort": "max" }))],
            _ => vec![("output_config", json!({ "effort": "high" }))],
        };
    }
    if matches!(effort.as_str(), "low" | "medium" | "high") {
        vec![("thinking", json!({ "type": "enabled", "budget_tokens": thinking_budget(&effort) }))]
    } else {
        Vec::new()
    }
}
```

In `call`, replace the block that starts with
`let effort = model.reasoning_effort.trim();` and inserts `"thinking"` with:

```rust
    for (key, value) in reasoning_fields(model) {
        payload.insert(key.into(), value);
    }
```

- [ ] **Step 4: Run the crate tests and clippy**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-ai && CARGO_INCREMENTAL=0 cargo clippy -p kition-ai --all-targets -- -D warnings`
Expected: pass, clean.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-ai/src/engine/anthropic.rs
git commit -m "Send DeepSeek reasoning effort as DeepSeek Harness does"
```

### Task 3: Point the DeepSeek preset at the Messages API

**Files:**
- Modify: `src/services/desktopSettings.ts`
- Modify: `src/services/providerModelCatalog.ts`
- Test: `src/services/desktopSettings.spec.ts`, `src/services/providerModelCatalog.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/services/desktopSettings.spec.ts`:

```ts
describe('DeepSeek provider route', () => {
  it('defaults to the Anthropic-compatible Messages API', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const deepseek = normalizeDesktopSettings({}).providers.deepseek
    expect(deepseek.baseUrl).toBe('https://api.deepseek.com/anthropic')
    expect(deepseek.wireApi).toBe('anthropic_messages')
    expect(deepseek.authScheme).toBe('x-api-key')
  })

  it('moves saved settings from the OpenAI-compatible root to the Messages API', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const saved = normalizeDesktopSettings({
      providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', wireApi: 'responses', authScheme: 'bearer', apiKey: 'sk-test' } },
    } as never).providers.deepseek
    expect(saved.baseUrl).toBe('https://api.deepseek.com/anthropic')
    expect(saved.wireApi).toBe('anthropic_messages')
    expect(saved.authScheme).toBe('x-api-key')
    expect(saved.apiKey).toBe('sk-test')
  })

  it('leaves a custom DeepSeek gateway alone', async () => {
    const { normalizeDesktopSettings } = await import('./desktopSettings')
    const custom = normalizeDesktopSettings({
      providers: { deepseek: { baseUrl: 'https://gateway.example.test/v1', wireApi: 'responses' } },
    } as never).providers.deepseek
    expect(custom.baseUrl).toBe('https://gateway.example.test/v1')
    expect(custom.wireApi).toBe('responses')
  })
})
```

Append to `src/services/providerModelCatalog.spec.ts` (follow the file's
existing mock of `@/api/desktop`; if it mocks `discoverProviderModels` as
`vi.fn`, assert on its arguments):

```ts
it('lists DeepSeek models from the API root, not the Messages path', async () => {
  const settings = normalizeDesktopSettings({
    providers: { deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-test' } },
  } as never)
  vi.mocked(discoverProviderModels).mockResolvedValueOnce({ models: ['deepseek-chat'] } as never)
  await syncProviderModelCatalog(settings, 'deepseek', 'none', false)
  expect(vi.mocked(discoverProviderModels).mock.calls.at(-1)?.[0].base_url).toBe('https://api.deepseek.com')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run --config tooling/vitest.config.ts src/services/desktopSettings.spec.ts src/services/providerModelCatalog.spec.ts`
Expected: the new tests fail (base URL is `https://api.deepseek.com/v1`, wire is `responses`).

- [ ] **Step 3: Implement**

In the `desktopProviderCatalog` entry for `kind: 'deepseek'`:

```ts
    description: 'Connect to DeepSeek through its Anthropic-compatible Messages API using a DeepSeek API Key, the route DeepSeek Harness uses.',
    badge: 'Messages',
    defaultBaseUrl: 'https://api.deepseek.com/anthropic',
```

In `normalizeProviderBaseURL`, give DeepSeek a bare host the Messages path
instead of `/v1`:

```ts
    if (kind === 'deepseek' && (!parsed.pathname || parsed.pathname === '/')) {
      parsed.pathname = '/anthropic'
      return parsed.toString().replace(/\/$/, '')
    }
```

placed before the existing OpenAI-compatible branch, and remove `'deepseek'`
from that branch's kind list.

In `createProviderConfig`:

```ts
  const messages = kind === 'anthropic' || kind === 'deepseek'
  const wireApi: DesktopProviderConfig['wireApi'] = messages ? 'anthropic_messages' : 'responses'
  const authScheme: DesktopProviderConfig['authScheme'] = messages ? 'x-api-key' : 'bearer'
```

Add the migration helper above `normalizeDesktopSettings`:

```ts
/** Saved DeepSeek settings from before the Messages route used the official OpenAI-compatible root. */
function migrateDeepSeekRoute(config: DesktopProviderConfig): DesktopProviderConfig {
  let url: URL
  try {
    url = new URL(config.baseUrl)
  } catch {
    return config
  }
  const official = url.hostname === 'api.deepseek.com' && ['', '/', '/v1'].includes(url.pathname.replace(/\/$/, '') || '/')
  if (!official || config.wireApi === 'anthropic_messages') return config
  return { ...config, baseUrl: 'https://api.deepseek.com/anthropic', wireApi: 'anthropic_messages', authScheme: 'x-api-key' }
}
```

and in `normalizeDesktopSettings`, after the provider loop assigns
`providerMap[descriptor.kind]`, add:

```ts
  providerMap.deepseek = migrateDeepSeekRoute(providerMap.deepseek)
```

In `syncProviderModelCatalog` (`providerModelCatalog.ts`), list DeepSeek models
from the API root:

```ts
  const listingBaseUrl = kind === 'deepseek'
    ? provider.baseUrl.replace(/\/anthropic\/?$/, '')
    : provider.baseUrl
```

and pass `base_url: listingBaseUrl || undefined` to `discoverProviderModels`.

- [ ] **Step 4: Run the tests, typecheck, and i18n check**

Run: `pnpm vitest run --config tooling/vitest.config.ts src/services && pnpm run typecheck && python3 scripts/check-i18n.py`
Expected: pass. If a settings e2e spec asserts the old DeepSeek URL or badge
(`grep -rn "api.deepseek.com" e2e src`), update it to the new values.

- [ ] **Step 5: Verify with a real key (manual, required)**

The DeepSeek Messages API behavior (model names, `output_config`, thinking
replay with tools) cannot be checked by tests. With the user's DeepSeek key in
the real desktop client (`pnpm dev` or the Tauri app, never launched without
the user's go-ahead): sync models, select a DeepSeek model, ask the agent for a
task that calls at least two tools in a row, and confirm there is no 400 and
the reply completes. Record the result in the commit message or report it as a
blocker with the provider's error text.

- [ ] **Step 6: Commit**

```bash
git add src/services/desktopSettings.ts src/services/desktopSettings.spec.ts src/services/providerModelCatalog.ts src/services/providerModelCatalog.spec.ts
git commit -m "Connect DeepSeek through its Anthropic-compatible Messages API"
```

---

## Part 2: Harness seams

### Task 4: Unchecked model schemas, hyphens, and pausing tools

**Files:**
- Modify: `crates/kition-harness/src/tool.rs`

Existing Kition tools carry raw JSON Schemas from `catalog.json` and MCP, and
validate their own input. MCP tool names may contain `-`, which OpenAI and
Anthropic accept. A tool body must be able to pause the turn (shell approval).

- [ ] **Step 1: Write the failing tests** (add to `tool.rs` tests)

```rust
    #[tokio::test]
    async fn unchecked_parameters_are_sent_as_is_and_not_validated() {
        let schema = json!({ "type": "object", "properties": { "n": { "type": "integer" } }, "required": ["n"] });
        let tool = define("legacy-tool", "Legacy")
            .unchecked_parameters(schema.clone())
            .execute(|args, _| async move { Ok(args) })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(tool.spec().input_schema, Some(schema));
        let settled = tool.run(json!({ "n": "not a number" }), cx()).await;
        assert!(!settled.is_error, "{settled:?}");
    }

    #[tokio::test]
    async fn a_body_can_ask_to_pause_the_turn() {
        let tool = define("ask", "Asks")
            .execute(|_, cx| async move {
                cx.pause.request("Run `rm`?");
                Ok(json!({ "requires": "approval" }))
            })
            .build()
            .unwrap_or_else(|error| panic!("{error}"));
        let context = cx();
        let pause = context.pause.clone();
        assert!(!tool.run(json!({}), context).await.is_error);
        assert_eq!(pause.take().as_deref(), Some("Run `rm`?"));
        assert_eq!(pause.take(), None);
    }
```

Update the test helper `cx()` to build `ToolContext { session_id: "s".into(),
call_id: "c".into(), cancel: Cancel::default(), pause: Pause::default() }`.

- [ ] **Step 2: Run them to see them fail**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-harness tool`
Expected: compile errors (`unchecked_parameters`, `Pause` not found).

- [ ] **Step 3: Implement**

Add the pause handle:

```rust
/// Lets a tool body end the turn after its result is recorded, for example
/// to wait for the person's approval. Cheap to clone.
#[derive(Debug, Clone, Default)]
pub struct Pause {
    reason: Arc<std::sync::Mutex<Option<String>>>,
}

impl Pause {
    pub fn request(&self, reason: impl Into<String>) {
        *self.reason.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(reason.into());
    }

    /// The requested reason, once.
    pub fn take(&self) -> Option<String> {
        self.reason.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take()
    }
}
```

Add `pub pause: Pause,` to `ToolContext`.

Add `unchecked: Option<Value>` to `ToolBuilder` (initialized to `None` in
`define`) and:

```rust
    /// A raw JSON Schema sent to the model as is. Arguments are not validated
    /// against it; the body validates its own input. For existing tools whose
    /// schemas predate `ParameterSchemaSpec`.
    pub fn unchecked_parameters(mut self, schema: Value) -> Self {
        self.unchecked = Some(schema);
        self
    }
```

In `build`, compute parameters and their validator as:

```rust
        let (parameters, parameters_validator) = match self.unchecked {
            Some(schema) => (schema, schema::validator(&json!({}))),
            None => {
                let parameters = schema::parameters_to_json_schema(&self.parameters)
                    .map_err(|error| format!("{}: {error}", self.name))?;
                let validator = schema::validator(&parameters);
                (parameters, validator)
            }
        };
        let parameters_validator =
            Arc::new(parameters_validator.map_err(|error| format!("{}: {error}", self.name))?);
```

replacing the previous `parameters` and `parameters_validator` lines.

Allow hyphens in `valid_name` and its error text:

```rust
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
```

(`tool_name` still produces underscores only, per Kit Standard A2.)

- [ ] **Step 4: Run the harness tests and fix the driver's `ToolContext`**

`driver.rs` builds a `ToolContext`; add `pause: Pause::default()` there for
now (Task 5 uses it). Run: `CARGO_INCREMENTAL=0 cargo test -p kition-harness`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-harness
git commit -m "Let harness tools carry raw schemas and pause the turn"
```

### Task 5: The driver ends the turn when a tool pauses

**Files:**
- Modify: `crates/kition-harness/src/driver.rs`
- Test: `crates/kition-harness/tests/driver.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn a_paused_tool_records_its_result_and_awaits_approval() {
    let log = Arc::new(MemoryLog::default());
    let llm = Arc::new(ScriptedLlm::new(vec![LlmReply::calls(vec![
        call("c1", "ask", json!({})),
        call("c2", "ask", json!({})),
    ])]));
    let ran = Arc::new(std::sync::atomic::AtomicUsize::new(0));
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
    tools.register(ask).unwrap_or_else(|error| panic!("{error}"));
    let input = TurnInput {
        session: "s".into(),
        system: "sys".into(),
        tools,
        user: vec![ContentBlock::text("go")],
        cancel: Cancel::default(),
        live: Arc::new(|_: Live| {}),
    };
    let reason = Driver::new(log.clone(), llm).run_turn(input).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::AwaitingApproval);
    assert_eq!(ran.load(Ordering::SeqCst), 1, "the second call must not run");
    let kinds: Vec<&str> = log.read("s").unwrap_or_else(|error| panic!("{error}")).iter().map(|e| e.body.kind()).collect();
    assert_eq!(&kinds[kinds.len() - 5..], ["tool/call", "tool/result", "approval/asked", "step/end", "turn/end"]);
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-harness --test driver a_paused_tool`
Expected: FAIL (the turn continues and asks the model again; the script runs out).

- [ ] **Step 3: Implement**

In `run_call`, create the pause handle before running the body, pass it in the
`ToolContext`, and after `self.record(...)`:

```rust
        if let Some(reason) = pause.take() {
            self.append(input, events, EventBody::ApprovalAsked { call_id: call.call_id.clone(), reason })?;
            return Ok(Some(TurnEndReason::AwaitingApproval));
        }
```

(adapt the `append` call to the signature introduced in phase A, which takes
the turn's local event list).

- [ ] **Step 4: Run the harness tests**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-harness`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-harness
git commit -m "End a harness turn when a tool asks to pause"
```

### Task 6: Recovery context and stop checks

**Files:**
- Modify: `crates/kition-harness/src/tool.rs` (`Settled.context`)
- Create: `crates/kition-harness/src/stop.rs`
- Modify: `crates/kition-harness/src/lib.rs`, `crates/kition-harness/src/driver.rs`
- Test: `crates/kition-harness/src/stop.rs`, `crates/kition-harness/tests/driver.rs`

This ports two rules from `crates/kition-agent/src/turn.rs`: after a failed
tool, a "[tool recovery required]" message reaches the model; and a turn that
stops while its last write failed fails instead of claiming completion.
DeepSeek Harness has the same seams: post-execute `additionalContexts`, and
the `agent/turn-stopping` checkpoint.

- [ ] **Step 1: Add `context` to `Settled`**

In `tool.rs`, add to `Settled`:

```rust
    /// Extra model input from policies, logged as one `user/message` after
    /// all results of the step (DeepSeek Harness `additionalContexts`).
    pub context: Vec<ContentBlock>,
```

and set `context: Vec::new()` in `Settled::error` and in the success branch of
`run`. Fix the struct literals in tests (`policy.rs` test builds a `Settled`).

- [ ] **Step 2: Write the failing tests in `stop.rs`**

```rust
//! Turn-ending rules and recovery prompts built on tool metadata, ported from
//! Kition's original loop (DeepSeek Harness `agent/turn-stopping` and
//! post-execute `additionalContexts`).

use crate::events::{ContentBlock, EventBody, SessionEvent};
use crate::policy::{CallInfo, Policy};
use crate::tool::{Settled, ToolRegistry};

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
        tools.register(tool("write", true)).unwrap_or_else(|error| panic!("{error}"));
        tools.register(tool("read", false)).unwrap_or_else(|error| panic!("{error}"));
        let check = UnresolvedWrites;
        let failed = [result(1, "write", true), result(2, "read", false)];
        assert!(check.check(&failed, &tools).is_some_and(|error| error.contains("write")));
        let recovered = [result(1, "write", true), result(2, "write", false)];
        assert_eq!(check.check(&recovered, &tools), None);
        assert_eq!(check.check(&[result(1, "read", true)], &tools), None);
    }

    #[test]
    fn failed_calls_get_a_recovery_prompt() {
        let args = json!({});
        let write = tool("write", true);
        let call = CallInfo { session: "s", call_id: "c", tool: &write, arguments: &args };
        let mut settled = Settled::error("disk full", None);
        RecoveryPrompt.post_execute(&call, &mut settled);
        let ContentBlock::Text { text } = &settled.context[0] else { panic!("expected text") };
        assert!(text.starts_with("[tool recovery required]"), "{text}");
        assert!(text.contains("Failed tool: write"), "{text}");
        let mut ok = Settled { value: Value::Null, content: Vec::new(), is_error: false, meta: None, context: Vec::new() };
        RecoveryPrompt.post_execute(&call, &mut ok);
        assert!(ok.context.is_empty());
    }
}
```

Add `pub mod stop;` to `lib.rs`.

- [ ] **Step 3: Run them to see them fail**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-harness stop`
Expected: compile errors (`UnresolvedWrites`, `RecoveryPrompt`, `check` not found).

- [ ] **Step 4: Implement above the tests**

```rust
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
            if let EventBody::ToolResult { name, is_error, content, .. } = &event.body
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
/// recover.
pub struct RecoveryPrompt;

impl Policy for RecoveryPrompt {
    fn post_execute(&self, call: &CallInfo<'_>, settled: &mut Settled) {
        if !settled.is_error {
            return;
        }
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
                format!("Failed tool: {}", call.tool.name),
                format!("Failure: {failure}"),
                "Inspect the latest state and recover now. For a failed apply_patch, reread the target and retry with a smaller exact patch or use document_write for a whole-document rewrite. Do not return an empty response or claim completion while the write is unresolved.".to_owned(),
            ]
            .join("\n"),
        ));
    }
}
```

- [ ] **Step 5: Wire them into the driver, test first**

Add to `tests/driver.rs`:

```rust
#[tokio::test]
async fn contexts_follow_the_step_and_stop_checks_can_fail_the_turn() {
    use kition_harness::stop::{RecoveryPrompt, UnresolvedWrites};
    let setup = setup(vec![
        LlmReply::calls(vec![call("c1", "echo", json!({}))]),
        LlmReply::text("All done"),
    ]);
    let mut driver = setup.driver(Pipeline::default().with(RecoveryPrompt));
    driver.stop_checks.push(Arc::new(UnresolvedWrites));
    let error = driver.run_turn(setup.input("go", Cancel::default())).await.err().unwrap_or_default();
    assert!(error.contains("did not recover from failed workspace tool echo"), "{error}");
    let second = &setup.llm.requests()[1];
    let last = second.messages.last().map(|message| message.content.clone()).unwrap_or_default();
    assert!(last.starts_with("[tool recovery required]"), "{last}");
}
```

(`echo` is a writing tool in this file and `{}` lacks its required `text`, so
the call fails validation.)

In `driver.rs`:

- add `pub stop_checks: Vec<Arc<dyn crate::stop::StopCheck>>` to `Driver`
  (empty in `new`, included in its `Debug` as a count);
- make `run_call` return the settled `context` along with the optional end
  reason: `Result<(Option<TurnEndReason>, Vec<ContentBlock>), String>`, taking
  `settled.context` out before `record`;
- in `steps`, collect contexts over the step's calls; after the loop over
  calls (and before `step/end`), if any were collected, append one
  `EventBody::UserMessage { content: contexts }`;
- where the model returned no tool calls, before returning `Completed`, find
  this turn's events (from the last `turn/start` in the local list) and run
  each stop check; the first `Some(message)` returns `Err(message)` after
  `step/end` is logged.

- [ ] **Step 6: Run the harness tests and clippy**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-harness && CARGO_INCREMENTAL=0 cargo clippy -p kition-harness --all-targets -- -D warnings`
Expected: pass, clean.

- [ ] **Step 7: Commit**

```bash
git add crates/kition-harness
git commit -m "Add recovery context and stop checks to the harness driver"
```

### Task 7: Model follow-up content

**Files:**
- Modify: `crates/kition-harness/src/llm.rs`, `crates/kition-harness/src/driver.rs`
- Test: `crates/kition-harness/tests/driver.rs`

Hosted image generation returns images that the original loop feeds back to
the model as a user message, and the loop continues even without tool calls.

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn follow_up_content_is_logged_and_keeps_the_turn_going() {
    let mut first = LlmReply::text("Here is a draft image");
    first.follow_up = vec![ContentBlock::Image { url: "data:image/png;base64,AA==".into() }];
    let setup = setup(vec![first, LlmReply::text("Done")]);
    let reason = setup.driver(Pipeline::default()).run_turn(setup.input("draw", Cancel::default())).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(reason, TurnEndReason::Completed);
    assert_eq!(setup.llm.requests().len(), 2);
    let second = &setup.llm.requests()[1];
    assert_eq!(second.messages.last().map(|message| message.parts.len()), Some(1));
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-harness --test driver follow_up`
Expected: compile error (`follow_up` field missing).

- [ ] **Step 3: Implement**

Add to `LlmReply`:

```rust
    /// Model input produced by the provider call itself (hosted image
    /// results), logged as a `user/message` after the step's tool results.
    pub follow_up: Vec<ContentBlock>,
```

In the driver: treat a reply as finished only if it has no tool calls **and**
no follow-up; after the step's tool calls and contexts, append
`EventBody::UserMessage { content: reply.follow_up }` when it is not empty.

- [ ] **Step 4: Run the harness tests**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-harness`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-harness
git commit -m "Carry model follow-up content through harness turns"
```

---

## Part 3: The agent on the harness

### Task 8: The flag

**Files:**
- Modify: `crates/kition-agent/Cargo.toml` (add `kition-harness = { workspace = true }`)
- Modify: `crates/kition-agent/src/run.rs`
- Modify: `crates/kition-api/src/agent.rs`
- Modify: `crates/kition-agent/tests/agent_flow.rs` (constructor only)

- [ ] **Step 1: Add the field and accessor**

In `AgentConfig`:

```rust
    /// Run turns on `kition-harness` (`KITION_AGENT_HARNESS=1`).
    pub harness: bool,
```

Store it in `Inner` and add:

```rust
    pub fn harness(&self) -> bool {
        self.inner.harness
    }
```

- [ ] **Step 2: Set it from the environment in the API crate**

In `crates/kition-api/src/agent.rs`, where `AgentConfig { ... }` is built:

```rust
        harness: std::env::var("KITION_AGENT_HARNESS").is_ok_and(|value| value.trim() == "1"),
```

- [ ] **Step 3: Update the test constructor**

In `agent_flow.rs`, rename `fn harness()` to `fn app_with(harness_mode: bool)`
and set `harness: harness_mode` in `AgentConfig`; call sites pass `false` for
now. (The local struct named `Harness` stays.)

- [ ] **Step 4: Build and test**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-agent && CARGO_INCREMENTAL=0 cargo check -p kition-api`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-agent crates/kition-api
git commit -m "Add the KITION_AGENT_HARNESS flag"
```

### Task 9: The harness turn

**Files:**
- Modify: `crates/kition-agent/src/turn.rs` (`stream_handler`, `retry_handler`, `record_hosted_searches` become `pub(crate)`)
- Modify: `crates/kition-agent/src/session.rs` (`set_status`, `fail`, `finish`, `await_approval` become `pub(crate)`; the branch below)
- Create: `crates/kition-agent/src/harness_turn.rs`
- Modify: `crates/kition-agent/src/lib.rs` (`mod harness_turn;`)

- [ ] **Step 1: Make the shared helpers reachable**

Change the four functions in `session.rs` and the three in `turn.rs` listed
above from private to `pub(crate)`. No behavior change.

- [ ] **Step 2: Write `harness_turn.rs`**

```rust
//! One agent turn on `kition-harness`: the same prompts, tools, stream
//! frames, and timeline as `turn.rs`, with the session event log as the
//! source of model history. Selected by `KITION_AGENT_HARNESS=1`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::future::BoxFuture;
use kition_ai::engine::{ChatResult, MessagePart, ToolSpec};
use kition_harness::cancel::Cancel;
use kition_harness::driver::{Driver, Live, TurnInput};
use kition_harness::events::{ContentBlock, TurnEndReason};
use kition_harness::llm::{ChunkSink, Llm, LlmReply, LlmRequest, normalize_calls};
use kition_harness::log::SqliteLog;
use kition_harness::policy::Pipeline;
use kition_harness::stop::{RecoveryPrompt, UnresolvedWrites};
use kition_harness::tool::{ToolContext, ToolFailure, ToolRegistry, define};
use serde_json::{Value, json};

use crate::run::{EventInput, Run};
use crate::session;
use crate::store::{self, AgentArtifact, AgentSession};
use crate::tools::{self, images};
use crate::{attachments, prompts, turn};

/// The output of the call that paused the turn, for the approval frames.
type Pending = Arc<Mutex<Option<Value>>>;

fn blocks(parts: &[MessagePart]) -> Vec<ContentBlock> {
    parts
        .iter()
        .filter_map(|part| match part.kind.as_str() {
            "image_url" if !part.image_url.is_empty() => Some(ContentBlock::Image { url: part.image_url.clone() }),
            "text" if !part.text.is_empty() => Some(ContentBlock::text(part.text.clone())),
            _ => None,
        })
        .collect()
}

/// The model seam with the original loop's frames, retry events, and hosted
/// tool handling. Remembers the last result for the final reply.
struct AgentLlm {
    run: Arc<Run>,
    calls: AtomicUsize,
    last: Mutex<Option<(ChatResult, bool)>>,
}

impl Llm for AgentLlm {
    fn call(&self, request: LlmRequest, _on_text: ChunkSink) -> BoxFuture<'_, Result<LlmReply, String>> {
        Box::pin(async move {
            let index = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            let run = &self.run;
            run.event(
                EventInput::new("model.turn.started", "model", "running", "Call AI backend", format!("Requesting model turn {index}"))
                    .data(json!({ "turn": index, "model": run.model.model_name, "wire_api": run.model.wire_api })),
            )
            .await;
            let streamed = Arc::new(AtomicBool::new(false));
            let result = run
                .agent
                .engine()
                .chat_with_retry(
                    &request.messages,
                    &request.tools,
                    "",
                    &run.model,
                    Some(turn::stream_handler(run, index, streamed.clone())),
                    Some(turn::retry_handler(run, index)),
                )
                .await
                .map_err(|error| error.to_string())?;
            turn::record_hosted_searches(run, &result).await;
            let follow_up = blocks(&images::save_hosted_images(run, &result.hosted_image_generation_calls).await);
            run.event(
                EventInput::new(
                    "model.turn.completed",
                    "model",
                    "completed",
                    "AI backend returned",
                    format!("Turn {index} completed with {} tool calls", result.tool_calls.len()),
                )
                .data(json!({
                    "turn": index, "content_chars": result.content.trim().chars().count(),
                    "tool_calls": result.tool_calls.len(), "stop_reason": result.stop_reason,
                })),
            )
            .await;
            let reply = LlmReply {
                content: result.content.trim().to_owned(),
                tool_calls: normalize_calls(&result.tool_calls, &format!("ow_tool_{}_{index}", kition_core::now_millis())),
                stop_reason: result.stop_reason.clone(),
                model: result.model.clone(),
                raw_items: result.response_items.clone(),
                follow_up,
            };
            *self.last.lock().unwrap_or_else(PoisonError::into_inner) = Some((result, streamed.load(Ordering::SeqCst)));
            Ok(reply)
        })
    }
}

/// The existing tools, unchanged, as harness tools. Each call still records
/// its row, timeline events, and frames through `tools::execute`.
fn legacy_tools(run: &Arc<Run>, specs: &[ToolSpec], pending: &Pending) -> Result<ToolRegistry, String> {
    let mut registry = ToolRegistry::default();
    for spec in specs {
        let (run, name, pending) = (run.clone(), spec.name.clone(), pending.clone());
        let schema = spec.input_schema.clone().unwrap_or_else(|| json!({ "type": "object" }));
        let mut builder = define(&spec.name, &spec.description)
            .unchecked_parameters(schema)
            .execute(move |args: Value, cx: ToolContext| {
                let (run, name, pending) = (run.clone(), name.clone(), pending.clone());
                async move { legacy_call(&run, &name, args, &cx, &pending).await }
            })
            .render(|_args, value| {
                let mut content = vec![ContentBlock::text(
                    json!({ "name": value["name"], "summary": value["summary"], "output": value["output"], "failed": false }).to_string(),
                )];
                for url in value["images"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    content.push(ContentBlock::Image { url: url.to_owned() });
                }
                content
            });
        if tools::writes(&spec.name) {
            builder = builder.writes();
        }
        registry.register(builder.build()?)?;
    }
    Ok(registry)
}

async fn legacy_call(run: &Arc<Run>, name: &str, args: Value, cx: &ToolContext, pending: &Pending) -> Result<Value, ToolFailure> {
    let executed = tools::execute(run, name, &args.to_string()).await;
    if executed.interrupt == Some("await_shell_approval") {
        let reason = executed.output["reason"].as_str().unwrap_or("Waiting for the user to approve the command").to_owned();
        *pending.lock().unwrap_or_else(PoisonError::into_inner) = Some(executed.output.clone());
        cx.pause.request(reason);
    }
    if executed.failed {
        let message = if executed.error_message.is_empty() { executed.summary } else { executed.error_message };
        return Err(ToolFailure { message, detail: Some(executed.output) });
    }
    let images: Vec<&str> = executed
        .follow_up
        .iter()
        .filter(|part| part.kind == "image_url")
        .map(|part| part.image_url.as_str())
        .collect();
    Ok(json!({ "name": executed.name, "summary": executed.summary, "output": executed.output, "images": images }))
}

/// The per-turn system prompt: the same blocks `session::build_messages`
/// sends as system messages, joined.
async fn system_prompt(run: &Run, session: &AgentSession, context: &str) -> String {
    let (id, user) = (session.id, session.user_id);
    let mut images: Vec<AgentArtifact> = run
        .agent
        .with_db(move |conn| store::recent_artifacts(conn, id, user, 40))
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.kind == "image" || a.mime_type.starts_with("image/"))
        .take(8)
        .collect();
    images.reverse();
    let mut blocks = vec![prompts::system_prompt(&run.language)];
    if !run.active_document_path.is_empty() {
        blocks.push(prompts::linked_document(&run.active_document_path));
    }
    blocks.push(attachments::prompt_block(&run.attachments));
    blocks.push(prompts::recent_images(&images));
    blocks.push(context.to_owned());
    blocks.retain(|block| !block.trim().is_empty());
    blocks.join("\n\n")
}

fn user_content(run: &Run) -> Vec<ContentBlock> {
    let mut content = vec![ContentBlock::text(run.prompt.clone())];
    content.extend(
        run.attachments
            .iter()
            .filter(|attachment| !attachment.image_url.is_empty())
            .map(|attachment| ContentBlock::Image { url: attachment.image_url.clone() }),
    );
    content
}

/// Runs the turn and finishes it exactly as `session::drive` does.
pub async fn drive(run: &Arc<Run>, session: AgentSession, prompt: &str, context: &str, specs: Vec<ToolSpec>) {
    let pending: Pending = Arc::new(Mutex::new(None));
    let tools = match legacy_tools(run, &specs, &pending) {
        Ok(tools) => tools,
        Err(error) => {
            session::fail(run, "Execution failed", "final", &error).await;
            return;
        }
    };
    let llm = Arc::new(AgentLlm { run: run.clone(), calls: AtomicUsize::new(0), last: Mutex::new(None) });
    let mut driver = Driver::new(Arc::new(SqliteLog::new(run.agent.db().clone())), llm.clone());
    driver.max_steps = turn::MAX_TURNS as u32;
    driver.pipeline = Pipeline::default().with(RecoveryPrompt);
    driver.stop_checks.push(Arc::new(UnresolvedWrites));
    let cancel = Cancel::default();
    let watcher = {
        let (emitter, cancel) = (run.emitter.clone(), cancel.clone());
        // Holds an emitter clone, so it must be aborted when the turn ends or
        // the response body would never close.
        tokio::spawn(async move {
            emitter.closed().await;
            cancel.cancel();
        })
    };
    let input = TurnInput {
        session: format!("agent:{}", run.session_id),
        system: system_prompt(run, &session, context).await,
        tools,
        user: user_content(run),
        cancel,
        live: Arc::new(|_: Live| {}),
    };
    let outcome = driver.run_turn(input).await;
    watcher.abort();
    match outcome {
        Ok(TurnEndReason::Completed) => {
            let Some((result, streamed)) = llm.last.lock().unwrap_or_else(PoisonError::into_inner).take() else {
                session::fail(run, "Execution failed", "final", "the model returned no reply").await;
                return;
            };
            let reply = result.content.trim().to_owned();
            session::finish(run, session, prompt, reply, streamed, &result).await;
        }
        Ok(TurnEndReason::AwaitingApproval) => {
            let output = pending.lock().unwrap_or_else(PoisonError::into_inner).take().unwrap_or_default();
            session::await_approval(run, session, output).await;
        }
        Ok(TurnEndReason::StepLimit) => {
            let message = format!("agent tool loop exceeded {} turns; narrow the task or clarify the next step", turn::MAX_TURNS);
            session::fail(run, "Execution failed", "final", &message).await;
        }
        Ok(TurnEndReason::Cancelled) | Err(_) if run.emitter.is_closed() => {
            session::set_status(run, "idle").await;
            run.event(EventInput::new("task.failed", "final", "failed", "Execution stopped", "The client stopped the request")).await;
        }
        Ok(TurnEndReason::Cancelled | TurnEndReason::Failed) => {
            session::fail(run, "Execution failed", "final", "the turn ended unexpectedly").await;
        }
        Err(error) => session::fail(run, "Execution failed", "final", &error).await,
    }
}
```

Adjust while implementing, and report each adjustment:
- `attachments::prompt_block`, `prompts::recent_images`, `prompts::linked_document`,
  and `prompts::system_prompt` must be reachable (`pub(crate)` if private).
- If `Executed` fields are private, make them `pub(crate)`.
- If clippy rejects `as u32`, use `u32::try_from(turn::MAX_TURNS).unwrap_or(16)`.
- The order of the `match` arms matters: the closed-client arm must come
  before the other `Cancelled` and `Err` arms.

- [ ] **Step 3: Branch in `session::drive`**

Right after `let tool_prompt = prompts::tool_loop(&names, &run.pane);`, add:

```rust
    if agent.harness() {
        let context = [context, tool_prompt].join("\n\n");
        crate::harness_turn::drive(&run, session, &content, &context, specs).await;
        return;
    }
```

(`context` and `tool_prompt` are moved here; the legacy path below keeps using
its own `build_messages` call, so restructure with `let joined = ...` before
the branch if the borrow checker requires it.)

- [ ] **Step 4: Build and run the existing agent tests (legacy mode)**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-agent && CARGO_INCREMENTAL=0 cargo clippy -p kition-agent --all-targets -- -D warnings`
Expected: pass, clean; nothing changed in legacy mode.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-agent
git commit -m "Run agent turns on the harness behind the flag"
```

### Task 10: Parity in both modes

**Files:**
- Modify: `crates/kition-agent/tests/agent_flow.rs`

- [ ] **Step 1: Run each end-to-end test in both modes**

Turn the bodies of `streams_a_turn_with_a_tool_call` and
`commands_outside_the_policy_wait_for_approval` into
`async fn tool_call_turn(harness_mode: bool)` and
`async fn approval_turns(harness_mode: bool)`, each starting with
`let Harness { app, workspace, .. } = app_with(harness_mode);`, and add four
tests:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn streams_a_turn_with_a_tool_call() {
    tool_call_turn(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_a_turn_with_a_tool_call_on_the_harness() {
    tool_call_turn(true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_outside_the_policy_wait_for_approval() {
    approval_turns(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_outside_the_policy_wait_for_approval_on_the_harness() {
    approval_turns(true).await;
}
```

In `tool_call_turn`, when `harness_mode` is true, also assert the session's
harness log through the store (the test has `db` in `app_with`; return it from
`Harness` if needed):

```rust
    if harness_mode {
        let log = kition_harness::log::SqliteLog::new(db.clone());
        let kinds: Vec<&str> = kition_harness::log::SessionLog::read(&log, &format!("agent:{session_id}"))
            .unwrap_or_else(|error| panic!("{error}"))
            .iter()
            .map(|event| event.body.kind())
            .collect();
        assert_eq!(kinds.first(), Some(&"turn/start"));
        assert!(kinds.contains(&"tool/result"));
        assert_eq!(kinds.last(), Some(&"turn/end"));
    }
```

(`kition-harness` must be a dev-dependency of `kition-agent` for the test,
or reachable through the normal dependency added in Task 8.)

- [ ] **Step 2: Run them**

Run: `CARGO_INCREMENTAL=0 cargo test -p kition-agent --test agent_flow`
Expected: 4 passed. A failure in harness mode is a parity bug: fix
`harness_turn.rs`, not the test's expectations.

- [ ] **Step 3: Full gates**

```bash
pnpm check:desktop
python3 scripts/check-i18n.py
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy pnpm test:table:e2e
```

Expected: all exit 0.

- [ ] **Step 4: Try it in the desktop client (manual)**

With the user's go-ahead, start the desktop app with
`KITION_AGENT_HARNESS=1` and a DeepSeek model, and run one document task and
one kit task (for example a Photo edit). The panel must look the same as
without the flag.

- [ ] **Step 5: Commit**

```bash
git add crates/kition-agent
git commit -m "Prove harness turns match the original loop end to end"
```

---

## Deferred to later phases (unchanged from the phase A plan)

Pane providers (C), kit providers and the Kit AI bridge (D, E), the renderer
reading session events and removing `turn.rs` (F), and the DeepSeek Harness
SDK protocol server (G). The session event table joins the workspace mirror in
phase F, when it becomes the source of truth for the panel.
