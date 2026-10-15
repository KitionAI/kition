# Harness Phase G Implementation Plan: DeepSeek Harness SDK Protocol, One Wire Format, Conformance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DeepSeek Harness (dsh) SDK clients drive Kition's agent through a headless stdio binary `kition-dsh`; the dsh `SessionEvent` envelope becomes the only wire format everywhere (SDK stdio, HTTP stream, `GET /session-events`, renderer); conformance is proven by the real pinned dsh TypeScript SDK client and recorded in a report (Kit Standard D2, D4).

**Architecture:** Storage stays Kition's internal `EventBody`, aligned so a pure, stateless `kition_harness::dsh::project` maps every stored event 1:1 (same seq) to a dsh `SessionEvent`. `kition-dsh` constructs the agent in process (no Tauri, no HTTP listener) and reuses the existing turn path (`session.rs` / `turn.rs`). The renderer moves to the projected events in G4.

**Tech Stack:** Rust (`kition-harness`, `kition-agent`, `kition-ai`, `kition-workspacestorage`), React/TypeScript, Node (dev-only conformance tooling).

**Base:** work directly on `feat/kit-photo-tab` (no feature branch). Commit only touched files (the kit line commits on the same branch). Prefix git with `PATH=/usr/bin:$PATH` on this machine. Build with `CARGO_INCREMENTAL=0`.

**Binding decisions:** no compatibility layers (new event fields are required; no `#[serde(default)]` to read old logs; old dev databases can be wiped), one wire format, lean code, no migrations, provider-agnostic. Decided by default (revisit if the user objects): SDK sessions are not gated by Kition Cloud sign-in; SDK data directory defaults to `~/.kition/sdk`; `kition-dsh` is a dev/CLI binary, not bundled in the desktop app yet; ACP (D3) deferred to phase H.

dsh references are paths in `github.com/deepseek-ai/deepseek-harness` at commit `d743267388641bc76f17c45ce8b4c231aed1d32c` (`d7432673`, release `0.2.1-alpha.2`) and the published `0.2.1-alpha.2` npm packages.

---

## 1. The dsh SDK protocol at d7432673 (`packages/sdk/{protocol,server,client}`)

### 1.1 Transport (`transport.ts`)
Newline-delimited JSON-RPC 2.0 over stdin/stdout, UTF-8. `id`+`method` = request, `id` only = response, `method` only = notification. Blank and non-JSON lines are ignored. Non-object params are treated as `{}`. Client notifications without a handler are dropped. No handler → `-32601 "method not found: <m>"`; every handler failure → `-32603` with `message` = the error message (the server emits no other codes; an unknown method throws inside the handler → `-32603`). Response ids echo the request id (string or number; the client uses `req_<uuid>`). Stdout carries protocol frames only; logs go to stderr.

### 1.2 Requests

| Method | Params | Result | Behavior and exact errors |
|---|---|---|---|
| `initialize` | `{cwd, provider, model, reasoningEffort?, maxTokens?}` | `{serverInfo:{name:"deepseek-harness-sdk-runtime", version}}` | `initialize reasoningEffort must be a non-empty string`; `initialize maxTokens must be a positive safe integer`; unknown provider `no adapter registered for provider "<p>"`; `cwd` resolved absolute; no reinitialization |
| `session/prompt` | `{sessionId, contentBlocks: (ContentBlock \| {type:"image", data, mimeType})[]}` | `{messageId}` | before init `SDK server is not initialized`; unknown id lazily creates the session; queued, returns at once; image without attachment store `SDK image prompt requires an attachment store` |
| `session/wait` | `{sessionId}` | `{}` | `session/wait requires a sessionId string`; `unknown SDK session: <id>`; resolves when idle; rejects only on a live failure with no later `turn/end`; response follows every notification emitted during the wait |
| `session/working-directory/get` | `{sessionId}` | `{cwd}` | `working-directory requests require a non-empty sessionId`; unknown id creates the session |
| `session/working-directory/set` | `{sessionId, path}` | `{cwd}` | `working-directory set requires a path string` |
| `shutdown` | none | `{}` | flush, dispose, exit 0; EOF and signals also end the process |
| other | | | `-32603 "unknown DeepSeek Harness SDK runtime method: <m>"` |

### 1.3 Notifications (server → client)
`session.event {sessionId, event}` (every session, live appends only); `session.status {sessionId, status: "running"|"idle"}`; `subagent.started` / `subagent.finished` (Kition never sends them).

### 1.4 What clients require
TS client: spawns `process.execPath` with `[dshBin, "--profile", "sdk", ...("--patch", p)]` (so `dshBin` is a JS module → Kition provides a Node shim); `initialize` must return string `serverInfo.name`/`version` within 10 s; `HarnessSession.run()` sends `session/prompt`, skips notifications until a `session.event` of type `agent/inbox/spliced` whose `data.inserted[].id` equals the returned `messageId` (the receipt), collects until `session.status idle`, validates each event (`type` string; `assistant/message` `data.message.content` array of `{type}`; `turn/end` `data.reason.kind` string; `aborted` needs `reason.reason.kind` in `user|parent|disposed|legacy|hook`, `hook` needs a string `reason`); `finalResponse` = text blocks of the last `assistant/message`. Defaults `provider:"deepseek-official"`, `model:"deepseek-v4-flash"`. Python client runs `[dsh_bin, "--profile", <profile>, *("--patch", p)]` and sets `DSH_HOME`.

### 1.5 SessionEvent envelope (`packages/core/session/src/types.ts`, `docs/persistence-schema.json` v4)

```text
{ type, seq (>= 0, contiguous), time (Unix ms), data,
  surfaceOp?: "append" | {op:"replace", startSeq, endSeq}   // required on surface types, forbidden otherwise
  sourceEventSeqs?: number[],                                 // surface types only (Kition never emits)
  ignorable?: true }
```

Surface types: `system/message`, `developer/message`, `user/message`, `assistant/message`, `tool/result`.

| Type | `data` |
|---|---|
| `turn/start` | `{turn}` |
| `turn/end` | `{turn, reason}`; reason `{kind:"completed"}` / `{kind:"aborted", reason:{kind:"user"\|"parent"\|"disposed"\|"legacy"} \| {kind:"hook", reason}}` / `{kind:"error", error:{message, code, status?, requestId?, providerRetryAfterMs?, offloadImages?}}` / `blocked` / `max-tokens` / `interrupted` / `forked` |
| `step/start`, `step/end` | `{turn, step}` |
| `system/message` | `{turn, step, message:{id, role:"system", content:Block[], source:{kind:"system-prompt"}}}` |
| `user/message` | `{id, role:"user", content:Block[], source}` (closed union incl. `user`, `user-approval`, `runtime-context`, `{kind:"tool", callId}`) |
| `agent/inbox/spliced` | `{target:"next-turn"\|"next-step", start, inserted: UserMessage[], removedCount?, outcome?:"canceled"}` |
| `assistant/message` | `{turn, step, message:{id, role:"assistant", content:Block[], source:{kind:"model", provider, model, replayState?}}, stream: AssistantStreamRecord[], usage?, interrupted?}` |
| `assistant/attempt` | `{turn, step, stream}` |
| `tool/call` | `{turn, step, callId, name, arguments: string}` |
| `tool/result` | `{turn, step, message:{id, role:"tool", source:{kind:"tool", callId}, toolCallId, content:Block[], isError?}, error?:{name, code, reason?}, meta?}` |
| `approval/asked` | `{id, toolName, callId?, reason?}` |
| `approval/decided` | `{id, outcome}` |
| `deliverables/presented` | `{turn, callId, files:{path, description?}[]}` |
| `todo/write` | `{todos:{content, status}[]}` |
| `llm/retry` | `{retryId, turn, step, provider, mode:"normal", policyKey, retry, maxRetries, delayMs, failure}` |
| `llm/retry-started` | `{retryId, turn, step, retry}` |
| `permission/preset` | `{preset}` |
| `plugin:<seg>/...` | plugin records; must carry `ignorable: true` |

Blocks: `{type:"text", text}`, `{type:"reasoning", text}`, `{type:"tool-call", id, name, arguments: string}`, `{type:"image", attachment:{attachmentId, bytes, width, height, mediaType, name?, originalDimensions?}, offloaded?}`, `{type:"file", attachment:{attachmentId, bytes, name}}`.

Compact stream records: `{type:"chunk", time, chunk:{type:"block-start", index, blockType}}`, `{type:"text-chunks", time0, index, dt:number[], texts:string[]}`, `{type:"tool-call-chunks", time0, index, dt, id, name?, args:string[]}`, `{type:"chunk", time, chunk:{type:"block-end", index, block}}`, `{type:"chunk", time, chunk:{type:"usage", usage}}`, `{type:"chunk", time, chunk:{type:"finish", reason:{kind:"stop"|"tool-calls"|"max-tokens"} | {kind:"error"|"aborted", failure}}}`.

dsh order: `agent/inbox/spliced` (inserted) → `turn/start` → `agent/inbox/spliced` (`removedCount:1`) → `step/start` → `system/message` → `user/message` → `assistant/message` → `tool/call` → `tool/result` → … → `step/end` → `turn/end`.

---

## 2. Design

### 2.1 `kition-dsh`: stdio binary, in process, headless
`crates/kition-agent/src/bin/kition-dsh.rs` (modeled on `kition-kits-mcp`). No network listener, no auth (the parent owns the pipes), one process, workspace chosen by `initialize.cwd`, own data directory (no concurrent driving with the desktop). Relaying to a running desktop over loopback is rejected (it would need a token scheme against the loopback-only API and could not switch workspaces).

CLI: `kition-dsh [--profile sdk] [--data-dir <dir>]`. Other profiles exit 2 (`kition-dsh: profile "<p>" is not supported`); `--patch` exits 2 (`kition-dsh: dsh profile patches are not supported`); `DSH_HOME` ignored. Data directory: `--data-dir`, else `$KITION_SDK_HOME`, else `<config dir>/sdk` (`$KITION_CONFIG_DIR`, else `~/.kition`, as `execpolicy::default_path`), holding `kition.db` and `uploads/`. `tracing` to stderr only.

Headless construction inside `initialize`: `Db::open(<data>/kition.db)`, `kition_store::seed::run`, `users::find_local_user` → `user_id`; `Engine::new(<data>/uploads, None)` (no cloud resolver; `kition-cloud` routes rejected); `Agent::new(AgentConfig { db, engine, workspace_dir: canonical cwd, upload_dir, policy_path: execpolicy::default_path(), hooks: None, smtp: None, tables: None, portal_base_url: "", mcp_path: mcp::default_path(), workflow_prompt: None, kits: Some(KitManager::from_env(Some(cwd))) })`; `agent.mcp().reload()` bounded by 5 s (warn and continue). v1 limitation: no data-table tools, no schedulers, no Kition Cloud gate.

### 2.2 Log alignment (storage) and projection
Storage changes (required fields, no defaults):

| Change | Where | Why |
|---|---|---|
| seq starts at 0 | `log.rs` (`MemoryLog` `events.len()`, `SqliteLog` `COALESCE(MAX(seq), -1) + 1`) | dsh seq starts at 0, contiguous |
| `turn`, `step` on `SystemMessage`, `AssistantMessage`, `AssistantAttempt`, `ToolCall`, `ToolResult` | `events.rs`, `driver.rs`, `tools/images.rs` | dsh data requires them |
| `aborted: bool` on `AssistantAttempt` | driver (`input.cancel.is_cancelled()`) | finish reason `aborted` vs `error` |
| `provider: String` on `AssistantMessage` (`LlmReply.provider` from `Run.provider_route`) | `llm.rs`, `model.rs`, `run.rs` | `message.source.provider` |
| `hosted: bool` on `ToolCall`, `ToolResult` | `driver.rs` `record_hosted`, composer | hosted and composer pairs project to plugin records |
| `id` on `UserMessage`; `EventBody::InboxSpliced { target, start, inserted: Vec<QueuedMessage>, removed_count: Option<u32> }` (`agent/inbox/spliced`); `QueuedMessage { id, content, source }` | `events.rs`, `driver.rs` (`TurnInput.message_id`), `session.rs` (mints uuid), composer | SDK receipt; dsh inbox |

For every turn with user input the driver appends `InboxSpliced{target:"next-turn", start:0, inserted:[msg]}`, `TurnStart`, `InboxSpliced{..., inserted:[], removed_count:Some(1)}`, …, `UserMessage{id: msg.id, …}` via a shared `driver::open_turn(log, session, live, turn, Option<&QueuedMessage>)` (the composer uses it too). `derive.rs` / `history.rs` ignore `InboxSpliced`.

Module `crates/kition-harness/src/dsh.rs`:

```rust
pub const HOSTED_TOOL_CALL: &str = "plugin:kition/hosted-tool-call";
pub const HOSTED_TOOL_RESULT: &str = "plugin:kition/hosted-tool-result";
/// The DeepSeek Harness SessionEvent for a stored event; `session` is its log key (ids).
pub fn project(event: &SessionEvent, session: &str) -> serde_json::Value;
```

Envelope `{type, seq, time: at, data, surfaceOp?: "append", ignorable?: true}`; message ids: stored id for user messages, else `format!("{session}#{seq}")`.

| Stored | dsh |
|---|---|
| `turn/start {turn}` | `{turn}` |
| `turn/end` | `completed` → `{kind:"completed"}`; `cancelled` → `{kind:"aborted", reason:{kind:"user"}}`; `failed` → `{kind:"error", error:{message, code:"UNKNOWN"}}`; `step-limit` → `{kind:"error", error:{message:"the turn reached its step limit", code:"STEP_LIMIT"}}`; `awaiting-approval` → `{kind:"aborted", reason:{kind:"hook", reason:"awaiting-approval"}}` |
| `step/start`, `step/end` | `{turn, step}` |
| `system/message` | `{turn, step, message:{id, role:"system", content:[{type:"text",text}], source:{kind:"system-prompt"}}}` + `surfaceOp` |
| `user/message` | `{id, role:"user", content, source}` + `surfaceOp`; `user` → `{kind:"user"}`, `approval` → `{kind:"user-approval"}`, `context-action`/`recovery`/`tool-follow-up` → `{kind:"runtime-context"}` |
| `agent/inbox/spliced` | same fields, camelCase |
| `assistant/message` | `{turn, step, message:{id, role:"assistant", content:[text if non-empty, …tool-call{id:callId, name, arguments: string}], source:{kind:"model", provider, model}}, stream: compact(...)}` + `surfaceOp`; `rawItems` never projected |
| `assistant/attempt` | `{turn, step, stream:[finish {kind: aborted?"aborted":"error", failure:{code: aborted?"ABORTED":"UNKNOWN", message}}]}` |
| `tool/call` (not hosted) | `{turn, step, callId, name, arguments: string}` |
| `tool/result` (not hosted) | `{turn, step, message:{id, role:"tool", source:{kind:"tool",callId}, toolCallId, content, isError only if error}, meta?}` + `surfaceOp`; `value` not projected |
| hosted `tool/call` / `tool/result` | `plugin:kition/hosted-tool-call` / `-result`, `ignorable: true`, data `{turn, step, callId, name, arguments}` / `{turn, step, callId, name, content, value, meta?}` |
| approval, deliverables, todo, retry, preset events | same fields inside `data` |

`compact`: per content block `i`: `block-start`, then `text-chunks {time0:at, index, dt:[], texts:[text]}` or `tool-call-chunks {time0:at, index, dt:[], id, name, args:[arguments]}`, then `block-end {block}`; then `finish`: `tool-calls` if calls, else `max-tokens` if `stopReason` in `length|max_tokens|max_output_tokens|incomplete`, else `stop`. All times `at`.

Images until G4: `{type:"text", text:"[image omitted]"}`.

Remaining deviations (recorded in the report): hosted/composer pairs as plugin records; `approval/asked` after the paused result (SDK sessions never pause, §2.4); `approval/decided` at the next drive and ids `approval:<callId>`; retries inside the open attempt; no `request/header`/`request/context`; logged (redacted) `tool/call.arguments`; no `usage`, no `reasoning` blocks; the SDK receipt is logged at turn start (queued prompts live in memory).

### 2.3 Model selection
`$KITION_CONFIG_DIR/sdk-providers.toml` (default `~/.kition/sdk-providers.toml`):

```toml
[providers.gateway]
wire_api = "chat_completions"          # responses | chat_completions | anthropic_messages
base_url = "https://gateway.example.com/v1"
api_key_env = "GATEWAY_API_KEY"        # key read only from this environment variable
provider_type = "custom"               # optional, default "custom"
hosted_web_search_version = ""         # optional
```

Built-in route `deepseek-official` (a file entry with the same name overrides it): `provider_type = "deepseek"`, `wire_api = "anthropic_messages"`, `base_url = "https://api.deepseek.com/anthropic"`, `api_key_env = "DEEPSEEK_API_KEY"`. `initialize` → `RuntimeModel { provider_type, model_name: model, base_url, api_key: env[api_key_env], wire_api, reasoning_effort, max_output_tokens: maxTokens or 0, hosted_web_search_version, .. }`, `Run.provider_route = provider`. Errors: unknown route `no adapter registered for provider "<p>"`; missing key `no API key for provider route "<p>": export <ENV>` (name only); inline `api_key` rejected (`sdk-providers.toml: put keys in the environment (api_key_env), not in the file`); empty model `initialize model must be a non-empty string`. Never `{:?}` a `RuntimeModel`; a unit test asserts no key appears in errors or tracing fields.

### 2.4 SDK sessions
- SDK `sessionId` → `agent_sessions` row with `extra_data.sdk_session_id`, `workspace_root` = cwd, title `New chat`; helper `store::find_sdk_session(conn, user_id, root, sdk_id)` (`json_extract`). Unknown id creates the row on first prompt or working-directory call; known id resumes. Wire `sessionId` is the client string; the log key stays `agent:<row>`.
- `session/prompt`: only `text` blocks (joined with `"\n"`); image → `SDK image prompt requires an attachment store` until G4; other types `unsupported prompt content block type: <t>`; empty `Message content cannot be empty`. Mint `uuid` v4, push `{id, text}` onto the session's FIFO, return `{messageId}`. One worker per session drains it: `session::prepare(...)` → `with_message_id(id)` → `session::execute(...)`.
- Status: `running` when a worker starts, `idle` after the FIFO is empty and the last row is saved. One writer task owns stdout through one channel, so a `session/wait` response always follows earlier notifications.
- `session/wait`: waits for the worker; rejects `the turn failed and its end could not be logged: <error>` only when the last drive logged no `turn/end`.
- Approvals: `Run.approvals: Approvals::{Ask, Unavailable}`; SDK uses `Unavailable`: a prompt-gated `exec_command` returns a tool error `this command needs the person's approval, and no one can approve it in this session (approval unavailable)`; the turn continues.
- Working directory: `get` → root; `set` → `{cwd}` if the resolved path is the root, else `Kition sessions are confined to their workspace <root>`.
- Execution mode `apply`, pane `document`. Shutdown: answer `{}`, flush, cancel workers, `kits.shutdown().await`, exit 0 (EOF the same). `serverInfo {name:"deepseek-harness-sdk-runtime", version:"kition-<CARGO_PKG_VERSION>"}`.

### 2.5 One wire format (G4)
The projection becomes the only way out: contracts `contracts/runtime/dsh-session-event.schema.json` (replacing `agent-session-events.schema.json`; `agent-stream.schema.json` refs it), generated types, `stream.rs` live sink and `routes.rs` `list_session_events` call `dsh::project`, renderer libraries read `event.data.*` (hosted cards from plugin records; approval pending from `aborted/hook awaiting-approval`; tool summaries from `content`; image job and table plan from `meta`), e2e helpers and mocks. Images: content-addressed attachment store `<upload_dir>/agent-attachments/<sha256>.<ext>`, `GET /agent/attachments/{id}` (loopback, `CurrentUser`), `ContentBlock::Image` holds attachment metadata, the model seam resolves to `data:` URLs; this admits SDK image prompts and removes inline `data:` images from the log and the workspace mirror.

### 2.6 ACP (D3): deferred to phase H
D3 asks Kition to host an external ACP agent (Kition as ACP client): ACP v1 client, foreign-agent session log, UI to configure agent commands, trust decisions. Product decisions, SHOULD-level; recorded as "D3: not implemented (SHOULD), deferred to phase H".

### 2.7 Conformance (D4)
`tooling/dsh-conformance/` (dev-only, own lockfile, not in the app or knip globs): `package.json` (private, ESM, exact pins `@deepseek-ai/dsh-sdk-client@0.2.1-alpha.2`, `@deepseek-ai/dsh-sdk-protocol@0.2.1-alpha.2`, `@deepseek-ai/dsh-session@0.2.1-alpha.2`, `@deepseek-ai/dsh-llm@0.2.1-alpha.2`, `@deepseek-ai/cordis@~4.0.5-alpha.1`; `pnpm.overrides` `"@deepseek-ai/dsh": "link:./stub-dsh"` to avoid the ~500 MB runtime the client only imports when `dshBin` is unset; fallback: install the real `@deepseek-ai/dsh@0.2.1-alpha.2` into the tooling folder), `stub-dsh/package.json`, committed `pnpm-lock.yaml`, `kition-dsh.mjs` (Node shim: spawns `$KITION_DSH_BIN` or `<repo>/target/debug/kition-dsh` with argv, inherits stdio, forwards signals, exits with the child's code), `scripted-model.mjs` (Chat Completions SSE fake on `127.0.0.1:0`), `persistence-schema.mjs` (fetches the pinned `docs/persistence-schema.json`, checks a recorded sha256, validates per `event:<type>` root; `plugin:` types get the envelope check plus `ignorable === true`), `conformance.test.mjs` (`node:test`), `report.mjs` (writes `docs/conformance/dsh-harness.md`).

Tests: start/`serverInfo`; `run("Say hi")` final response and events from the receipt to `turn/end{completed}`; a tool turn (`assistant/message` tool-call block → `tool/call` → `tool/result` same `callId`); every event passes `validatedSessionEvent` and the pinned persistence schema; all events of the session from seq 0 pass dsh `Session.create`; an approval-needing command → tool error, no `approval/asked`, turn completes; a second run continues at turn 2 with contiguous seq; two back-to-back prompts answered in order; `session/wait` `{}`; unknown session and unknown method reject with `-32603`; image prompt rejected (until G4); `close()` exits 0; no TCP listener during the run (`lsof`, skipped if absent); optional Python client run when `DSH_PYTHON_SDK` is set.

Report: Kit Standard version and level claimed (L4 partial: D2, D4 met; D1 by the kit line; D3 deferred), Kition commit, `DSH_TARGET` (fail if installed client versions differ), package versions and lockfile integrity, persistence-schema sha256, Node version, a row per test, the deviations list. Root script: `"conformance:dsh": "cargo build -p kition-agent --bin kition-dsh && pnpm --dir tooling/dsh-conformance install --frozen-lockfile && node --test tooling/dsh-conformance/conformance.test.mjs && node tooling/dsh-conformance/report.mjs"`. Live mode via `KITION_DSH_LIVE_BASE_URL`, `KITION_DSH_LIVE_WIRE`, `KITION_DSH_LIVE_MODEL`, `KITION_DSH_LIVE_KEY_FILE` (key in the child env only, via a temporary `sdk-providers.toml` route).

### 2.8 Thinking gap (G0)
In `crates/kition-ai/src/engine/anthropic.rs` only: `fn open_tool_turn_lacks_thinking(items: &[Value]) -> bool` (last assistant message has `tool_use` and no thinking block, and the following user content carries a `tool_result`). When thinking is enabled and it returns true, send this request with `thinking: {type: "disabled"}` (no `output_config`), and compute `max_tokens` accordingly.

---

## 3. Tasks

Inner loop: `CARGO_INCREMENTAL=0 cargo test -p kition-harness -p kition-agent -p kition-ai`; plus `pnpm vitest run --config tooling/vitest.config.ts src/features/agent src/api` when renderer files change. Each task test-first, one commit.

### G0
- [ ] **Task 1:** tests `open_tool_turn_without_thinking_disables_thinking`, `open_tool_turn_with_thinking_keeps_it`, `ended_turn_keeps_thinking`; extend `crates/kition-harness/tests/imported_history.rs` (paused-awaiting-approval log resumed → thinking disabled). Commit "Send an open tool turn without thinking blocks with thinking off".

### G1 Log alignment and projection
- [ ] **Task 2 Seq from 0:** `log.rs` both logs; `kition-agent/src/log.rs` `read_events(log, id, after: Option<u64>)`; `routes.rs` `after: Option<u64>`; contract `seq.minimum 0`, `after` optional; renderer cursor `-1`, `listAgentSessionEvents(sessionId, after?)` omits the param at `-1`; e2e fixtures from 0; workspace state `events_seq` → `events_count`. Commit "Number session events from 0 like DeepSeek Harness".
- [ ] **Task 3 Turn/step, aborted, provider, hosted:** files per 2.2; tests `step_scoped_events_carry_turn_and_step`, `hosted_calls_are_marked`, `a_cancelled_attempt_is_aborted`, round-trip in `events.rs`. Composer: `turn`, `step: 1`, `hosted: true`, `provider: "kition"`, `model: "image-composer"`. Commit "Log turn and step on step events, the provider of each reply, and hosted calls as hosted".
- [ ] **Task 4 Inbox:** `InboxSpliced`, `QueuedMessage`, `UserMessage.id`, `TurnInput.message_id`, `driver::open_turn`, composer uses it, `session::prepare` mints uuid, `Prepared::with_message_id`, `DSH_KNOWN` + `agent/inbox/spliced`, derive/history ignore it, contract, renderer reducer no-op, e2e mocks. Tests `a_turn_splices_its_prompt_in_and_claims_it` (order `[agent/inbox/spliced, turn/start, agent/inbox/spliced, step/start, system/message, user/message, assistant/message, step/end, turn/end]`, ids match), `a_turn_without_input_splices_nothing`. Commit "Record each prompt entering and leaving the inbox".
- [ ] **Task 5 Cancel and approvals:** `Run.emitter` → `Run.cancel: Cancel`; `Run.approvals`; `session::start` (HTTP) owns emitter, `TurnStream`, watcher, status, close; `session::execute(agent, user_id, prepared, TurnIo { live, cancel, approvals, provider_route }) -> bool`; `tools/exec.rs` uses `run.cancel` and the approval-unavailable error; `tools/images.rs` `run.cancel.is_cancelled()`. Tests: `a_command_that_needs_approval_fails_when_no_one_can_approve`; existing stop/disconnect agent_flow tests green. Commit "Drive turns on a cancel and let a session say no one can approve".
- [ ] **Task 6 Projection:** `crates/kition-harness/src/dsh.rs` (2.2) and `contracts/dsh/session-event.schema.json` (2020-12 transcription of the pinned persistence-schema roots for every mapped type + plugin envelope; header records the pinned SHA). Tests: one unit per row, `compact_stream_for_text_and_calls`, `raw_items_are_never_projected`, `turn_end_reasons`, `user_sources`; `tests/dsh_projection.rs` projects scripted logs (text, tools, hosted, retry, approval pause, cancel, failure, step limit) and validates every event against the schema; invariants (contiguous seq from 0, `surfaceOp` on surface types, non-hosted `tool/result` follows a tool-call with its `callId`, plugin records ignorable). G1 gates. Commit "Project the session log to DeepSeek Harness session events".

### G2 SDK server
- [ ] **Task 7 Routes:** `sdk/routes.rs` `route_model(file, params, env) -> Result<(RuntimeModel, String), String>`; tests per 2.3. Commit "Resolve SDK model routes from sdk-providers.toml and the environment".
- [ ] **Task 8 Transport:** `sdk/rpc.rs` `serve_lines(input, out, handler)` + writer task; tests per 1.1 with `tokio::io::duplex`. Commit "Speak newline-delimited JSON-RPC like the DeepSeek Harness transport".
- [ ] **Task 9 Server:** `sdk/server.rs`, `sdk/mod.rs` (`serve(input, output, SdkConfig)`), `store::find_sdk_session`; `crates/kition-agent/tests/sdk_server.rs` against a fake Chat Completions provider: initialize/reinitialize, ordered notifications (`running`, receipt, `turn/start` … `turn/end{completed}`, `idle`) each validated against the projection schema with the SDK `sessionId`, a tool turn, approval-unavailable, two queued prompts → one final `idle`, wait known/unknown, image error, working directory get/set, shutdown, resume after restart (same DB + SDK id → turn 2). Commit "Serve the DeepSeek Harness SDK protocol over stdio".
- [ ] **Task 10 Binary:** `src/bin/kition-dsh.rs` (2.1); integration test via `env!("CARGO_BIN_EXE_kition-dsh")`: `--patch` exits 2; initialize → prompt → shutdown exits 0 with every stdout line JSON-RPC; EOF exits 0. G2 gates. Commit "Add kition-dsh, a headless Kition agent for DeepSeek Harness SDK clients".

### G3 Conformance
- [ ] **Task 11:** everything in 2.7 + root `conformance:dsh`; `pnpm conformance:dsh` passes; `pnpm check:knip` clean. Commit "Drive Kition with the pinned DeepSeek Harness TypeScript SDK".
- [ ] **Task 12:** generated `docs/conformance/dsh-harness.md`; `DSH_TARGET` doc points to it; update the G row in `2026-10-11-harness-agent-plan.md` and `2026-10-11-harness-agent-status.md`. Commit "Record DeepSeek Harness conformance for 0.2.1-alpha.2".
- [ ] **Task 13 (needs the user's gateway):** live `pnpm conformance:dsh`; regenerate the live section.

### G4 One wire format
- [ ] **Task 14:** attachment store and final image projection (`attachments.rs`, `routes.rs`, `events.rs`, `model.rs`, `dsh.rs`); admit SDK image prompts; update the conformance test; `pnpm check:e2e-coverage`.
- [ ] **Task 15:** HTTP stream, session-events, renderer on dsh events (one switch commit, 2.5); delete `agent-session-events.schema.json` and the flattened wire; full gates.
- [ ] **Task 16 (needs the user):** desktop-client checks (F2b plan §9 items 1, 2, 4, 5, 6, 7, 12).

## 4. Gates
End of G1, G2, G3, G4 (`PATH=/usr/bin:$PATH`): `pnpm check:desktop`, `pnpm check:contracts`, `pnpm check:knip`, `python3 scripts/check-i18n.py`, `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy pnpm test:table:e2e`; `pnpm conformance:dsh` from G3 on; `pnpm test:unit` when renderer files change.

## 5. Risks and security
- No listener: `kition-dsh` must not link `kition-api` or bind sockets (code review + `lsof` check). Stdout is protocol-only: no `println!`/inherited stdio in library code.
- Workspace confinement: `initialize.cwd` must exist and is canonicalized; `working-directory/set` never leaves the root.
- Secrets: keys only from env vars named by routes; inline keys rejected; `RuntimeModel` never debug-formatted; errors carry variable names only; live keys in the child env only; report has no host paths.
- Unattended sessions never run prompt-gated commands. SDK data directory separate from the desktop database. The SDK client is trusted (it spawned the process and chooses `cwd`).
- Storage changes ripple through tests (small commits with contracts and mocks together). npm tarballs carry no `gitHead`: pin by release version; the report records both. The closed `user/message` source union is lossy (three Kition kinds → `runtime-context`). G4 is large (switch commit like F2b Task 8).
