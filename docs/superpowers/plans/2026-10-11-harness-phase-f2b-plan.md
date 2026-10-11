# Harness Phase F2b Implementation Plan: The Agent Panel On Standard Session Events

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The stream of `POST /agent/sessions/{id}/messages/stream` becomes DeepSeek Harness SDK notifications (`session.event`, `session.status`, `agent/assistant-stream`); the session event log (`agent_session_events`) is the only record of a conversation; the renderer builds the agent panel by reducing session events (plus live text chunks) into one view model. Every custom frame, every `agent_events` timeline row, the `/messages`, `/tool-calls`, `/events` endpoints, the startup backfill, the DeepSeek/Kimi settings migrations, and the tables `agent_messages`, `agent_tool_calls`, `agent_artifacts`, `agent_events`, `agent_plans`, `agent_goals`, `agent_subagents` are deleted. No migration, no compatibility with old data (there are no users).

**Architecture:** `kition-harness` learns the remaining dsh events Kition needs (all pinned names at `d7432673`, from `packages/core/session/src/known-event-types.ts`: `approval/decided`, `deliverables/presented`, `todo/write`, `llm/retry`, `permission/preset`, plus the `user/message.source` field), a tool-side emit channel (dsh tools append through `exec.agent.session.append`), hosted-tool calls carried on the model reply, and the dsh `AssistantStreamFrame` for live text. `kition-agent` writes no rows except `agent_sessions`; its stream is a projection of the harness `Live` sink. The renderer replaces the frame handling in `useWorkspaceAgent.ts` with a pure reducer (`agentSessionView.ts`) and a pure effects function (`agentEventEffects.ts`); components keep their look and take a turn view instead of four row arrays.

**Tech Stack:** Rust (`kition-harness`, `kition-agent`, `kition-ai`, `kition-api`, `kition-store`, `kition-workspacestorage`), React/TypeScript, Playwright, JSON Schema contracts.

**Base:** `feat/kit-photo-tab` at or after `6ce604c5`, new branch `feat/harness-phase-f2b`. Build with `CARGO_INCREMENTAL=0`. `crates/kition-agent/src/tools/kits.rs` is owned by the kit line and read-only here; this line may change the execution wrapper in `tools/mod.rs` (recording, frames, approval plumbing) but not kit tool logic. Seams `kits.rs` relies on stay intact: `Run`, `Run::agent.kits()`, `ToolOutput::new`, `ToolOutput { follow_up, .. }`, `ToolError { message, summary, output }`, `catalog::ToolDef`, `READ_ONLY`, `WORKSPACE_WRITE`. Nothing model-specific outside `kition-ai` (Task 2 moves the existing violations). Task 9 changes `tools::dispatch` signatures: tell the kit line before it lands.

**Binding decisions:** no old way, nothing kept as a fallback; no migration, no backfill, stale tables and columns in developer databases are ignored (`migrate` only creates what is missing; nothing reads them); the session log is the single source of truth for a conversation; provider-agnostic.

DeepSeek Harness references below are paths inside a clone of `github.com/deepseek-ai/deepseek-harness` at commit `d7432673`.

---

## 1. The stream

### 1.1 Shape

NDJSON, one JSON-RPC 2.0 notification per line, in the dsh SDK protocol shapes (`packages/sdk/protocol/src/types.ts`). The kit bridge (`GET /v1/kits/bridge`) already uses one JSON-RPC message per line.

```jsonc
{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"agent:42","status":"running"}}
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"agent:42","event":{"seq":17,"at":1760000000000,"type":"turn/start","turn":3}}}
{"jsonrpc":"2.0","method":"agent/assistant-stream","params":{"sessionId":"agent:42","frame":{"type":"start","attemptId":"agent:42#3.1","revision":1,"turn":3,"step":1}}}
{"jsonrpc":"2.0","method":"agent/assistant-stream","params":{"sessionId":"agent:42","frame":{"type":"chunk","attemptId":"agent:42#3.1","revision":1,"index":0,"time":1760000000100,"chunk":{"type":"text-delta","index":0,"text":"Hel"}}}}
{"jsonrpc":"2.0","method":"agent/assistant-stream","params":{"sessionId":"agent:42","frame":{"type":"end","attemptId":"agent:42#3.1","revision":1,"index":1,"outcome":{"kind":"committed","eventType":"assistant/message","seq":21}}}}
{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"agent:42","status":"idle"}}
```

- `session.event`: `params.event` is exactly a `sessionEvent` of `contracts/runtime/agent-session-events.schema.json` (Kition's flattened `{seq, at, type, ...}`, `raw_items` cleared, arguments through each tool's log projection; identical to `GET /session-events`). Projecting to the literal dsh `{type, seq, time, data}` envelope stays with phase G.
- `session.status`: from `Live::Status`; `running` at turn start, `idle` after `turn/end`. The stream closes after `idle`.
- `agent/assistant-stream`: the dsh `AssistantStreamFrame` (`packages/core/agent/src/runtime-types.ts`), chunks as dsh `StreamChunk` (`text-delta {index,text}`, `tool-call-delta {index,id,name?,argumentsDelta}`). Not one of the four SDK notifications; in dsh it is the process-local `agent/assistant-stream` agent event its own web client reads live. Kition needs it to show text and patch previews while the model writes; frame and method name are dsh's. Text uses block index 0, tool call `i` uses `1 + i`. The engine's `tool_call_ready` is dropped (the durable `tool/call` follows).

**No Kition-only frames.** Errors before streaming are HTTP errors from `prepare` (missing model and unsupported `wire_api` move there). Errors after streaming starts are `turn/end {reason:"failed", error}`. If the log write fails, the stream ends without `idle`; the client shows "outcome unknown" (`AgentStreamInterruptedError`) and re-reads the log. Session updates (title, active document) come from `GET /agent/sessions` after `idle`.

### 1.2 Contract

New `contracts/runtime/agent-stream.schema.json` (`$id https://kition.ai/contracts/runtime/agent-stream.schema.json`, root `$ref: #/$defs/notification`). `$defs`: `sessionId` (string, pattern `^agent:[1-9][0-9]*$`); `sessionEventNotification`, `sessionStatusNotification`, `assistantStreamNotification` (each `{jsonrpc: const "2.0", method: const, params}`, `additionalProperties: false`; the event uses `$ref: "agent-session-events.schema.json#/$defs/sessionEvent"`, a sibling ref the generator supports); `assistantStreamFrame` (`oneOf` start / chunk / end; end `outcome` is `{kind:"committed", eventType: enum [assistant/message, assistant/attempt], seq}` or `{kind:"abandoned"}`); `streamChunk` (`oneOf` text-delta / tool-call-delta); `notification` (`oneOf` the three). The description states: the stream ends after `session.status idle`; EOF before `idle` means unknown outcome and the client reads `GET /agent/sessions/{id}/session-events?after=`; a request whose image `request_id` was already used streams only `running` and `idle`.

### 1.3 Session-events contract additions

In `agent-session-events.schema.json`, flattened into the same envelope:

| Event | Fields | Written by |
|---|---|---|
| `user/message` | `+ source: {kind}`; kinds `user` (shown as a bubble), `approval` (hidden approval resume), `context-action` (hidden follow-up), `recovery` (driver recovery context), `tool-follow-up` (hosted image follow-up); open string as in dsh | driver |
| `approval/asked` | reshaped to dsh: `{id, toolName, callId, reason?}`, `id = "approval:" + callId` | driver |
| `approval/decided` | `{id, outcome: "allowed-once"\|"rejected"\|"cancelled"\|"unavailable"}` | `session::drive` before the resume turn |
| `deliverables/presented` | `{turn, callId, files: [{path, description?}]}` | driver, after a successful `tool/result` |
| `todo/write` | `{todos: [{content, status: pending\|in_progress\|completed}]}` | driver, after the `update_plan` result |
| `llm/retry` | `{retryId, turn, step, provider, mode:"normal", policyKey:"engine", retry, maxRetries, delayMs, failure:{message, code}}` | driver, through the LLM sink |
| `permission/preset` | `{preset: "research"\|"preview"\|"apply"}` (execution mode), when it changes | driver, step 1 |

`tool/result.meta` documents the known `kind`s as `anyOf` plus an open fallback: `whiteboard.patch` and `design.patch` `{kind, patch}`; `shell.approval` `{kind, command, reason, requires:"approval", decision:"prompt", suggested?}`; `image_generation.variant` `{kind, request_id, artifact}`; hosted calls `{hosted:true}`.

---

## 2. What replaces what

### 2.1 Frames

| Current frame | Replacement |
|---|---|
| `started` | `session.status running` + `turn/start`; session fields from `GET /agent/sessions` after idle |
| `user_message` | `session.event user/message` (`source.kind`) |
| `delta` (`send_text_in_chunks`) | deleted; the reply is in `assistant/message` |
| `model_delta` | `agent/assistant-stream` chunk `text-delta` |
| `model_tool_call_delta` | chunk `tool-call-delta` |
| `model_tool_call_ready` | deleted (`tool/call` follows) |
| `tool_call` (running, completed) | `tool/call`, then `tool/result` |
| `tool_error` | `tool/result {isError:true}` (content[0] message, content[1] detail JSON) |
| `artifact` | `deliverables/presented` |
| `agent_event` | 2.2 |
| `whiteboard_patch`, `design_patch` | provisional: `tool-call-delta` arguments; final: `tool/result.meta {kind, patch}` |
| `assistant_message` | `assistant/message` (last of the turn = reply) |
| `done` (+message, session, artifact, awaiting_shell_approval, shell_approval_required) | `turn/end {reason}` + `session.status idle`; approval is `approval/asked` + `tool/result.meta` |
| `error` | `turn/end {reason:"failed", error}`, or an HTTP error before streaming |

### 2.2 `agent_events` row kinds

| Row kind | Replacement |
|---|---|
| `task.created`, `task.started` | `turn/start` |
| `skill.enabled` | removed (skills are prompt sections in `system/message`; dsh has no event for that) |
| `prompt.sent` (+`turn_capabilities`) | removed; `step/start` is the debug row; turn capabilities have no UI consumer (`agentTurnCapabilities.ts` is spec-only), contract and code deleted |
| `model.turn.started` / `model.turn.completed` | `step/start` / `assistant/message` (tool call count = `toolCalls.length`) |
| `model.reconnecting` | `llm/retry` |
| `model.delta`, `model.tool_call.delta/ready` (client-made) | live stream state in the reducer |
| `tool.requested` / `tool.completed` / `tool.failed` / `tool.denied` | `tool/call` / `tool/result` / `tool/result isError` / `tool/result isError` (permission message) |
| `artifact.created` | `deliverables/presented` |
| `plan.updated` (+`agent_plans`) | `todo/write`; explanation from the `update_plan` result value |
| `table.plan.generated` | derived in the renderer from the final `assistant/message` fenced `table_plan` block, the turn's table tool results, and `permission/preset` (`agentTablePlan.ts`, a port of `table_plan.rs`) |
| `table.plan.attached`, `whiteboard.context.attached`, `design.context.attached`, `local_sources.attached` | removed (context reaches the model via `system/message`; the composer already shows attached context) |
| `shell.approval_required`, `task.awaiting_approval`, `user.input_needed` | `approval/asked` + `turn/end awaiting-approval` |
| `shell.approval_decided` | `approval/decided` |
| `response.completed`, `task.completed` | `turn/end completed` |
| `task.failed` | `turn/end failed` / `cancelled` / `step-limit` (with `error`) |
| `image_generation.accepted/progress/artifact/completed/failed/canceled` | the image composer turn (2.5) |
| `client.turn.interrupted` | the reducer's `interrupted` on the active turn |

Desktop hooks (`run.rs` `hook_name`) fire from live events in the new `stream::live_sink`: `turn/start` → `task_started` (`intent`); `turn/end` completed → `task_completed` (`final`); failed/cancelled/step-limit → `task_failed` (`final`); `tool/call` → `tool_called` (`tools::stage(name)`; today nothing emits `tool.called`, so it now fires for real); `approval/asked` → `user_input_needed` (`execute`).

### 2.3 Endpoints

| Endpoint | Fate |
|---|---|
| `GET /agent/sessions/{id}/messages` | deleted (history from `/session-events`) |
| `GET /agent/sessions/{id}/tool-calls` | deleted |
| `GET /agent/sessions/{id}/events` | deleted |
| artifacts | no list endpoint today; now from `deliverables/presented` |
| `GET /agent/sessions/{id}/session-events?after=` | kept: history and reconnect; paged on open and after every stream ends |

### 2.4 Tables

| Table | Fate | Reason / replacement |
|---|---|---|
| `agent_sessions` | kept, minus `status`, `system_prompt` | session index (owner, `workspace_root`, soft delete, order, title, `active_document_path`, pane bindings in `extra_data`, `model_id`); running state from the log/stream; system prompt is `system/message` |
| `agent_session_events` | kept | the log |
| `agent_messages` | dropped | `user/message` / `assistant/message` |
| `agent_tool_calls` | dropped | `tool/call` / `tool/result`; approval resolved from the log |
| `agent_artifacts` | dropped | `deliverables/presented` (recent-images prompt and `finish`'s latest editable document read it) |
| `agent_events` | dropped | 2.2 |
| `agent_plans` | dropped | `todo/write` |
| `agent_goals`, `agent_subagents` | dropped | never written by the agent |

No migration or backfill: `log::backfill`, `BACKFILL_MESSAGES`, `conversation()`, `sessions_without_events_are_backfilled_once`, the `Agent::new` call, and `log::record_exchange` are deleted.

**Workspace portability:** `crates/kition-workspacestorage/src/state.rs` mirrors the agent tables into `.kition/agents/<id>/` (`session.json`, `messages.jsonl`, `events.jsonl`) but not the session log. New: `MIRRORED_TABLES` holds `agent_sessions` and `agent_session_events`; `session.json` (session row only) and `session-events.jsonl` (the log as `log::read_events` serves it, `raw_items` stripped). `STATE_SCHEMA_VERSION = 3`, only 3 importable; `classify_path` gains `agent_session_events`, loses `agent_message` / `agent_event`; the `workspace-storage.schema.json` enum matches.

### 2.5 Image composer turn (`image_generation_intent`)

A logged turn without a model call, written through `kition_harness::driver::append_live` (Task 3): `turn/start`, `step/start`, `user/message {source.kind:"user"}`; per variant `i`: `tool/call {callId: "img_<sha24(request_id)>_<i>", name:"image_generation", arguments:{request_id, intent_sha256, variant_index, variant_count, size, quality, template_id?, reference_count}}` then `tool/result {value: artifact_view, content:[text "Generated image i: <path>"], meta:{kind:"image_generation.variant", request_id, artifact}}` + `deliverables/presented`, or `tool/result {isError:true, content:[message, {"code","retryable"} JSON]}`; then `assistant/message "Generated N image(s) for review."`, `step/end`, `turn/end completed|failed|cancelled`. Idempotency (`claim`) scans the log for an `image_generation` `tool/call` with the same `request_id`; a different `intent_sha256` is HTTP 409 from `prepare`; a repeat streams `running`/`idle` only. `artifact.id` (row id) becomes `call_id` (string) in `agent-image-generation.schema.json#/$defs/artifact`; the `event` def becomes `variantCall` and `variantMeta`. Progress is finished results over `variant_count`. Orphan `tool/call`/`tool/result` pairs are skipped by `derive.rs`; later turns see the user text, the reply, and the recent-images prompt built from deliverables.

---

## 3. Shell approval

- **Ask.** `exec_command` keeps returning `interrupt: Some("await_shell_approval")` with `approval_output`. `providers/core.rs` offers `exec_command` with a `ToolShape` whose `presentation_meta(args, value)` returns `{kind:"shell.approval", command, reason, requires, decision, suggested}` when `value.output.requires == "approval"`, else `None`. The driver records the `tool/result` (with meta), then `approval/asked {id:"approval:"+callId, toolName:"exec_command", callId, reason}`, then `turn/end awaiting-approval`.
- **Contract.** `agent-shell-approval.schema.json` becomes `$defs.request` (the meta) and `$defs.response`: `{call_id: string(minLength 1), decision: enum allow_once|allow_always|deny}`. `StreamRequest.shell_approval` is `ShellApprovalInput { call_id: String, decision: String }`.
- **Resolution.** `exec::resolve_approval(agent, session_id, call_id, decision)` reads the log and calls a pure `pending_approval(events, call_id) -> Result<Pending { id, command, suggested_prefix }, String>`, valid when: the last `turn/end` is `awaiting-approval`; that turn has `approval/asked` with this `callId`; no later `approval/decided` with its `id`; the `tool/result` for `callId` is `exec_command` with `value.output.requires == "approval"` and a non-empty `command`. `allow_always` still saves a policy rule (`suggested.prefix`, else the first word). Replaces `store::find_tool_call` and the `agent_messages` count.
- **Decision.** `session::drive` appends `approval/decided {id, outcome}` before the resume turn: `allow_once` and `allow_always` → `allowed-once` (the rule is a policy change, not a session fact), `deny` → `rejected`. The resume turn's `user/message` has `source.kind:"approval"`. `Run::approved_command` stays.
- **Renderer.** The card shows when the active turn ended `awaiting-approval` and its `approval/asked` has no decision; card data is the meta of the `tool/result` with that `callId`; the response is `{call_id, decision}`.

## 4. Deliverables

Add `deliverables/presented` to `kition-harness` (`EventBody::DeliverablesPresented { turn, call_id, files: Vec<PresentedFile { path, description }> }`): a pinned dsh name meaning "files a turn hands to the user" (`packages/deliverables/tool-present/src/types.ts`), appended after a successful tool result keyed by `callId`, as dsh does. One typed event serves artifact chips, image strips, workspace-tree refresh, the recent-images prompt, and `finish`'s latest editable document; phase G clients render it natively. Rejected: artifacts in `presentationMeta` (every consumer parses tool-specific meta; nothing outside Kition recognizes it). Paths are workspace-relative; kind and MIME derive from the extension (`documents::is_editable_document`, new `log::is_image_path`); the old `title` becomes `description`.

## 5. Whiteboard and design patches

Removed: the `run.send(Frame whiteboard_patch|design_patch)` calls in `tools/canvas.rs` (validation and results stay) and their `event_summary`/`event_output`. Provisional preview: the renderer accumulates `tool-call-delta.argumentsDelta` per call id; once the arguments parse and the name is `whiteboard_propose_patch` or `design_propose_patch`, it emits a provisional patch. Final: a successful `tool/result` with `meta.kind == "whiteboard.patch"` or `"design.patch"` emits `meta.patch`. Cancel: an error result for that tool, or a non-completed `turn/end` while a provisional patch is pending. Board/design path comes from the turn context the client sent. Patches apply only from live events, never from history sync.

## 6. Renderer architecture

**New pure modules** (`src/features/agent/lib/`):

- `agentSessionView.ts` — types `AgentSessionView { cursor, turns: AgentTurnView[], live: { attemptId, text, toolArgs: Record<id,{name?, args}> } | null, running }`; `AgentTurnView { turn, startedAt, source, userText, userImages, preset?, steps[], toolRuns: AgentToolRun[], deliverables: AgentDeliverable[], retries[], todos?: { explanation?, items }, approval?: { id, callId, toolName, reason, request?, decided? }, reply?, partialReply?, end?: { reason, error, at }, interrupted? }`; `AgentToolRun { callId, name, arguments, status: running|completed|failed|awaiting_approval, summary, output, error, meta, hosted, startedAt, endedAt? }`. Functions `emptyAgentSessionView`, `applySessionEvent` (idempotent: ignores `seq <= cursor`), `applyAssistantStream`, `applyStatus`, `markInterrupted`. `reply` is the last `assistant/message` with content in a completed turn, `table_plan` block stripped for display.
- `agentEventEffects.ts` — `effectsOfEvent(event, view)` and `effectsOfStream(frame, view)` → `AgentEffect[]`: `documents-modified {paths}` (rules of `getAgentModifiedDocumentPaths` applied to runs: `document_write` `output.path`/`arguments.path`, `data_table_create`, `apply_patch` `file_ops`/`changes`), `deliverables-saved {paths}`, `table-mutated` (`TABLE_MUTATION_TOOL_NAMES`), `connections-changed {detail}` (`configure_smtp_connection` output), `whiteboard-patch {patch, provisional}`, `whiteboard-patch-cancelled`, `design-patch`, `design-patch-cancelled`.
- `agentTablePlan.ts` — `deriveTablePlan(turn) -> AgentTablePlanContext | null` (port of `table_plan.rs` `extract`/`finalize`; `requires_apply_confirmation` when `preset == "preview"`, `applied` when `"apply"`).
- `agentImageJob.ts` — `imageJobOf(turn)` → `{requestId, status, progress, artifacts, error}` from `image_generation` runs and `turn.end`; replaces `agentImageJobs.ts` and `agentImageGenerationStream.ts`.

**Hook (`useWorkspaceAgent.ts`).** State `agentSessionViews: Record<number, AgentSessionView>` replaces `agentMessages`, `agentToolCalls`, `agentEvents`, `agentImageGenerationEvents`, `agentStreamingText`, `agentArtifacts`. `syncSessionEvents(sessionId)` pages `listAgentSessionEvents` (`after = view.cursor`) until a short page, on `openAgentSession` and in `finally` after every stream; effects are not fired for synced events. The `onNotification` handler applies the reducer, then runs effects into the existing callbacks (`onWorkspaceDocumentsModified` + `agentModifiedDocumentPaths`, `onWorkspaceArtifactsSaved` + `refreshMentionableDocuments`, `onTableMutated` once after idle, `window.dispatchEvent('kition:connections:changed')`, `onWhiteboardPatch`/`Cancelled`, `onDesignPatch`/`Cancelled`, `notifyFromAgentEvent` from `turn/end`). After idle: `refreshAgentSessions()`, `setPendingFocusedSessionId`. Run status: `busy` from the send lifecycle; "Task completed" = `turn/end completed`; "Completion unknown" = `markInterrupted` (from `AgentStreamInterruptedError`), partial text → `partialReply`. `retryWhileSessionBusy` (409) unchanged. Optimistic bubble: client-only `pendingUserText` until `user/message` arrives.

**API.** `src/api/agentStream.ts`: `readAgentMessageStream` parses notifications, calls `onNotification`, resolves on `session.status idle`, throws `AgentStreamInterruptedError` on EOF before idle; `AgentExecutionError` from frames is gone. `src/api/agent.ts`: `listAgentMessages`, `listAgentToolCalls`, `listAgentEvents` deleted; `shellApproval: { call_id, decision }`. `src/api/agentTypes.ts`: `AgentMessage`, `AgentToolCall`, `AgentEvent`, `AgentArtifact`, `AgentStreamEvent` deleted; types come from generated `agent-stream.ts` and `agent-session-events.ts`.

**Components adapted** (looks unchanged; check against `docs/design.md` and `docs/product-ui-style.md`): `AgentConversation.tsx` (iterates `view.turns`; user bubble only for `source.kind == "user"`; run log items from the turn; image cards from `imageJobOf(turn)`); `AgentChatPanel.tsx`, `WorkspaceAgentPane.tsx`, `WorkspaceScreen.tsx`, `WorkspaceAgentSidebar.tsx` (pass views); `PlanCard.tsx` (`turn.todos`); `AgentContextCards.tsx` (`deriveTablePlan`); `AgentShellApprovalCard.tsx` (request/response types); `AgentImageResultCards.tsx` (job from the turn); `src/features/workspace/hooks/useAgentImageGeneration.ts`, `useWhiteboardImageGeneration.ts` (generated images from runs and deliverables; ids become call ids); `agentTimeline.ts`: `buildAgentRunLogItems({ turn, busy, debug, locale })` over `AgentToolRun`, formatters ported mechanically (`tool_name` → `name`, `input_data` → `arguments`, `output_data` → `output`, `error_message` → `error`, ms timestamps); reconnect rows from `turn.retries`; debug rows are `step/start` and `assistant/message`; unused i18n keys removed from `src/i18n/locales/*/agent.json`.

**Deleted:** `agentWhiteboardStream.ts` (+spec), `agentDesignStream.ts` (+spec), `agentImageGenerationStream.ts`, `agentImageJobs.ts` (+spec), `agentTimelineEvents.ts`, `agentTurnCapabilities.ts` (+spec), `agentTurnFailure.ts`, `components/AwaitUserInputModal.tsx` (no catalog tool produces it). In `agentShellApproval.ts` only `buildAgentShellApprovalFollowup` stays; `readLatestAgentShellApprovalRequest` moves into the view.

---

## 7. Tests

- **Harness:** units in `events.rs`, `driver.rs`, `derive.rs`; `tests/driver.rs`: emitted events land after a successful result and are dropped on error; hosted pairs follow `assistant/message`; frame order start, chunks, end(committed, seq = assistant/message seq), end(abandoned) on cancel; `llm/retry` appended; `permission/preset` reconciled; `approval/asked` shape; derive ignores orphan pairs, `todo/write`, deliverables, `llm/retry`. `DSH_KNOWN` in `lib.rs` gains the new names.
- **Agent (`tests/agent_flow.rs`):** `stream()` returns parsed notifications; helpers `events(&lines)`, `turn_end(&lines)`, `check_stream_contract(line)` (compiles `agent-stream.schema.json` with the sibling `agent-session-events.schema.json` registered via `jsonschema::options().with_resource(...)`, validates every line). Every existing test rewritten (busy refusal, image exchange history, step limit, disconnected image turn, chat completions, tool call, session-events API, approval by `call_id` with `approval/decided`; golden panes unchanged). New: deliverables after `document_write`; `todo/write` after `update_plan`; composer events and idempotent repeat; missing model → 400; the stream ends with `idle`.
- **Live (`tests/live_openai.rs`):** a `turn/end completed`, a non-empty final `assistant/message`, last line `session.status idle` (Responses and Chat Completions).
- **Renderer unit (vitest):** `agentSessionView.spec.ts` (sequences → turns, idempotency, hidden sources, approval lifecycle, interruption, stream accumulation); `agentEventEffects.spec.ts` (absorbs `agentWhiteboardStream.spec.ts`, `agentDesignStream.spec.ts`, `useWorkspaceAgentDocumentEditing.spec.ts`, `useWorkspaceAgentCompletion.spec.ts`); `agentTablePlan.spec.ts` (ports the Rust `extracts_and_merges_plans`); `agentImageJob.spec.ts`; `useWorkspaceAgent.spec.ts` rewritten around a fake `streamAgentMessage` feeding notifications; `agentImageGenerationContract.spec.ts` and `agentShellApproval.spec.ts` updated.
- **E2E:** new `e2e/helpers/agentStream.ts` (`notification.event(sessionId, seq, body)`, `notification.status(...)`, `notification.text(...)`, `ndjson(lines)`, `mockAgentTurn(page, script)` fulfilling `**/messages/stream` and serving the same events from `**/session-events` after the cursor); `e2e/helpers/mockApi.ts` drops `/messages`, `/tool-calls`, `/events`, `/session-events` echoes `after` as `next_after`; migrate `agent-run-status`, `table-agent-document-flow`, `whiteboard-agent`, `markdown-image-insertion`, `agent-image-preview`, `agent-image-chat`, `design-agent`, `design-image-studio`, `whiteboard-image-studio`, the agent part of `app-shell`. Gate `pnpm test:table:e2e`.

---

## 8. Tasks

Commands: `R` = `CARGO_INCREMENTAL=0 cargo test -p kition-harness -p kition-agent -p kition-api`; `V` = `pnpm vitest run --config tooling/vitest.config.ts src/features/agent src/api src/features/workspace`; `E <specs>` = `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy pnpm exec playwright test --config tooling/playwright.config.ts <specs> --workers=1`; `GATE` = `pnpm check:desktop && pnpm check:contracts && pnpm check:knip && python3 scripts/check-i18n.py && pnpm lint && pnpm build:check && pnpm test && env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy pnpm test:table:e2e`.

Every task ends green with a commit; the branch stays buildable at every commit: Tasks 1–7 are additive or internal (old frames still flow, old tables still written where noted); Task 8 is the one switch, backend and renderer in one commit (the renderer consumes the stream); Tasks 9–10 delete what nothing reads.

### Task 0: Branch and baseline
- [ ] `git switch -c feat/harness-phase-f2b` from `feat/kit-photo-tab`; run `GATE`; record pre-existing failures and the HEAD.

### Task 1: Delete the startup backfill and the settings migrations
**Files:** `crates/kition-agent/src/log.rs`, `run.rs`; `src/services/desktopSettings.ts` (+spec)
- [ ] Delete `backfill`, `BACKFILL_MESSAGES`, `conversation`, the test `sessions_without_events_are_backfilled_once`, their imports; `Agent::new` drops the backfill call; update module docs.
- [ ] Delete `migrateDeepSeekRoute` and `migrateKimiWire` and their specs (no users, no saved settings to migrate); keep the presets' defaults.
- [ ] `R`, `V`; commit `"Drop the backfill and settings migrations"`.

### Task 2: Model predicates into `kition-ai`
**Files:** `crates/kition-ai/src/engine/types.rs`, `crates/kition-agent/src/session.rs`, `tools/images.rs`
- [ ] Tests first: `RuntimeModel::supports_hosted_web_search()` and `supports_hosted_images()` in `types.rs` (cases moved from `session.rs::normalizes_modes_and_provider_support`).
- [ ] Move both functions (and `KITION_CLOUD_PROVIDER` use) into `impl RuntimeModel`; `session.rs` calls the methods. `save_hosted_images`: replace `"provider": "openai_responses"` with the result's `wire_api`.
- [ ] `CARGO_INCREMENTAL=0 cargo test -p kition-ai -p kition-agent`; commit `"Keep hosted tool support rules in kition-ai"`.

### Task 3: Harness event vocabulary
**Files:** `crates/kition-harness/src/{events.rs,lib.rs,derive.rs,driver.rs}`, `tests/driver.rs`, `contracts/runtime/agent-session-events.schema.json`, generated TS, `crates/kition-agent/src/{turn.rs,session.rs,log.rs,run.rs}`
- [ ] Tests first in `events.rs` (`every_event_body_round_trips_and_covers_kinds`): `UserMessage { content, source: MessageSource { kind } }` (`#[serde(default)]` kind `"user"`); `ApprovalAsked { id, tool_name, call_id, reason }` → `{"type":"approval/asked","id","toolName","callId","reason"}`; `ApprovalDecided { id, outcome: ApprovalOutcome }` (kebab-case); `DeliverablesPresented { turn, call_id, files: Vec<PresentedFile> }` (`description` skipped when empty); `TodoWrite { todos: Vec<TodoItem { content, status: TodoStatus }> }` (snake_case statuses); `LlmRetry { retry_id, turn, step, provider, mode, policy_key, retry, max_retries, delay_ms, failure: LlmFailure { message, code } }`; `PermissionPreset { preset }`.
- [ ] Extend `KINDS`/`kind()`; `DSH_KNOWN` gains `deliverables/presented`, `todo/write`, `llm/retry`, `permission/preset` (copied from the pinned file).
- [ ] `driver.rs`: `TurnInput.source: MessageSource` for the first `user/message`; recovery contexts kind `recovery`, `reply.follow_up` kind `tool-follow-up`; `ApprovalAsked` with `id: format!("approval:{call_id}")` and `tool_name`; expose `pub fn next_turn(events)` and `pub fn append_live(log, session, live, body) -> Result<SessionEvent, String>` (`Driver::append` uses it).
- [ ] `derive.rs`: the `ApprovalAsked` match reads the new fields; test that `approval/decided`, `todo/write`, `deliverables/presented`, `llm/retry`, `permission/preset` are not model history.
- [ ] Contract: defs and `oneOf` entries (1.3) and the `toolResultMeta` documentation; `pnpm contracts:generate`.
- [ ] `kition-agent`: `Run.source: &'static str` set in `session::drive` (`approval` when resuming an approval, `context-action` when `hide_user_message`, else `user`); `turn.rs` builds `TurnInput.source` from it.
- [ ] `R` (the session-events contract check passes); commit `"Log the dsh events the panel needs"`.

### Task 4: Tool emits, hosted calls, permission preset
**Files:** `crates/kition-harness/src/{tool.rs,llm.rs,driver.rs,testing.rs}`, `tests/driver.rs`
- [ ] Tests first: (a) a tool pushing `DeliverablesPresented` and `TodoWrite` through `cx.emit` gets them appended right after its `tool/result` (`turn` and `call_id` filled by the driver), and not when the tool fails; (b) `LlmReply.hosted = [HostedCall { call_id:"ws_1", name:"web_search", arguments, value, meta, files: [] }]` → `tool/call` + `tool/result {meta}` after `assistant/message`, and `derive_messages` has no tool message for `ws_1`; (c) `TurnInput.preset = Some("preview")` logs `permission/preset` once across two turns and again when it changes.
- [ ] `ToolContext { session_id, call_id, turn, cancel, pause, emit: Emits }` (`Emits` = `Arc<Mutex<Vec<EventBody>>>` with `push`/`take`); the driver takes emits after `record` and appends them when `!is_error`, overwriting `turn`/`call_id` in `DeliverablesPresented`.
- [ ] `LlmReply.hosted: Vec<HostedCall>`: the driver appends each as `ToolCall`, `ToolResult { is_error:false, meta }`, plus `DeliverablesPresented` when `files` is non-empty, before running the model's own calls.
- [ ] `TurnInput.preset: Option<String>` reconciled at step 1 beside `reconcile_system`.
- [ ] Harness tests; fix `kition-agent` compile (`preset: None` for now); `R`; commit `"Let tools and hosted calls add events to the log"`.

### Task 5: Harness live stream seam
**Files:** `crates/kition-harness/src/{llm.rs,driver.rs,testing.rs}`, `tests/driver.rs`, `crates/kition-agent/src/{model.rs,turn.rs}`
- [ ] Tests first: `ScriptedLlm` scripts chunks and retries (`LlmReply` + `Vec<StreamChunk>` per call); the `Live` sequence for a text reply is `Status(running)`, events, `AssistantStream(start)`, chunks with dense `index`, `assistant/message` event, `AssistantStream(end committed seq)`, …, `Status(idle)`; cancel ends with `end abandoned`; a scripted retry appends `llm/retry` with `turn` and `step`.
- [ ] `llm.rs`: `StreamChunk` (`#[serde(tag="type", rename_all="kebab-case")]`, camelCase fields); `LlmSink { chunk: Arc<dyn Fn(StreamChunk)+Send+Sync>, retry: Arc<dyn Fn(RetryInfo)+Send+Sync> }`; `RetryInfo { retry, max_retries, delay_ms, code, message, provider }`; `Llm::call(request, sink: LlmSink)`; `EngineLlm` maps engine `StreamEvent` and `RetryEvent`.
- [ ] `driver.rs`: `Live::{ Status { running }, AssistantStream(AssistantStreamFrame), Event(Box<SessionEvent>) }` (remove `AssistantText`); `AssistantStreamFrame`/`StreamOutcome` serde as dsh; `attempt_id = format!("{session}#{turn}.{step}")`, `revision = 1`; the retry sink calls `append_live(LlmRetry { retry_id: format!("{attempt_id}/{retry}"), mode:"normal", policy_key:"engine", .. })` synchronously.
- [ ] `kition-agent/model.rs`: `AgentLlm` forwards engine deltas to `sink.chunk` (text index 0, tool `1 + index`) and retries to `sink.retry`, still sending its old frames/events until Task 8; `turn.rs` sets `preset: Some(run.execution_mode.clone())`.
- [ ] `R`; commit `"Stream assistant text as dsh assistant-stream frames"`.

### Task 6: The agent writes a complete log (still additive)

**6a Deliverables and todos.** Files: `run.rs`, `tools/mod.rs`, `turn.rs`, `tools/documents.rs`, `files.rs`, `images.rs`, `web.rs`.
- [ ] Tests first (`agent_flow.rs`): a `document_write` turn logs `deliverables/presented {files:[{path}]}` after its result; an `update_plan` turn logs `todo/write`.
- [ ] `ToolOutput.deliverables: Vec<PresentedFile>`, `ToolOutput.todos: Option<Vec<TodoItem>>`, carried by `Executed`; every `record_artifact` site also pushes `PresentedFile { path, description: title }` (`documents::write`, `artifact_write`, `register_artifact`, `files::view_image`, `images::image_search`, `save_image_asset`, `web::web_article_save`); `files::update_plan` sets `todos`; `turn::call_tool` pushes `EventBody::DeliverablesPresented`/`TodoWrite` into `cx.emit`.
- [ ] `R`; commit `"Log what each tool delivers"`.

**6b Approval meta, sources, early failures.** Files: `providers/core.rs`, `session.rs`, `turn.rs`.
- [ ] Tests first: `commands_outside_the_policy_wait_for_approval` asserts the log has `tool/result.meta.kind == "shell.approval"` with the command, then `approval/asked {toolName:"exec_command"}`, then `turn/end awaiting-approval`; unit-test the `exec_shape` meta.
- [ ] `exec_shape()` in `providers/core.rs`; offer `exec_command` through `offer_shaped`. Move the missing `runtime_model` and unsupported `wire_api` checks into `prepare` (HTTP 400, non-image requests), with a test. An `assemble_turn` failure appends `turn/start` and `turn/end {failed, error}` via `append_live` (new `Driver::fail_turn`).
- [ ] `R`; commit `"Log approvals and early failures as the standard says"`.

**6c Hosted calls on the log.** Files: `model.rs`, `tools/images.rs`.
- [ ] Tests first: a fake Responses stream with a `web_search_call` and an `image_generation_call` item → `tool/call web_search` + `tool/result {meta.hosted}`; the image has a deliverable; the follow-up `user/message` has `source.kind == "tool-follow-up"`.
- [ ] `record_hosted_searches` returns `Vec<HostedCall>`; `save_hosted_images` returns `(Vec<HostedCall>, Vec<MessagePart>)` with call id `call.id` or `img_<step>_<i>`; both into `LlmReply.hosted`. Old rows/frames stay until Task 9.
- [ ] `R`; commit `"Log hosted search and image calls"`.

**6d Image composer as a logged turn.** Files: `tools/images.rs`, `session.rs`, `log.rs`, `contracts/runtime/agent-image-generation.schema.json`.
- [ ] Tests first: `an_image_exchange_is_history_for_the_next_turn` asserts the composer log (2.5); a repeat `request_id` with different settings → 409; same settings append nothing.
- [ ] `stream_intent` writes the turn through `append_live` (no-op live sink until Task 8); `claim` reads the log; delete `log::record_exchange`.
- [ ] Contract: `artifact.id` → `call_id: string`; `event` → `variantCall`, `variantMeta`. Keep emitting the old `image_generation.*` agent events for the current renderer until Task 8.
- [ ] `R`, `pnpm contracts:generate`; commit `"Log image composer requests as turns"`.

### Task 7: Renderer view libraries (additive, spec-backed)
**Files:** create `src/features/agent/lib/{agentSessionView,agentEventEffects,agentTablePlan,agentImageJob}.ts`, each with a spec; fixtures in `src/features/agent/lib/__fixtures__/`.
- [ ] Specs first from real sequences: copy JSON printed by the `agent_flow` logs of Tasks 3–6 (`--nocapture`) into fixtures (fictional paths only).
- [ ] Implement per section 6, importing only generated contract types.
- [ ] `V`, `pnpm check:knip`; commit `"Reduce session events into the agent panel view"`.

### Task 8: The switch (backend and renderer in one commit)

**Backend:** `stream.rs`, `turn.rs`, `session.rs`, `model.rs`, `run.rs`, `tools/mod.rs`, `tools/canvas.rs`, `tools/exec.rs`, `tools/images.rs`, `routes.rs`, `crates/kition-api/src/agent.rs`; contracts `agent-stream.schema.json` (new), `agent-shell-approval.schema.json`.
- [ ] Tests first: `agent_flow.rs` helpers to notifications, every line validated against `agent-stream.schema.json`; all tests updated per section 7; add `approval_resolves_by_call_id_from_the_log`; unit-test `exec::pending_approval` (not pending after a decision, after a later turn, for a non-exec call).
- [ ] `stream.rs`: delete `Frame`, `value`, `send_text_in_chunks`; add `Notification` (`SessionEvent{session_id, event}`, `Status`, `AssistantStream`) with `Emitter::notify`; `live_sink(emitter, session_key, hooks, user_id) -> LiveSink` (strips `raw_items` like `read_events`, fires the hook mapping from 2.2).
- [ ] `run.rs`: delete `Run::send`, `Run::event`, `EventInput`, `hook_name`, event-only `tool_call_id` arguments and `trigger_message_id` reads; keep `record_artifact` rows and `start_tool_call` rows one more commit, without frames.
- [ ] `turn.rs`: `live` = `stream::live_sink(...)`; delete `turn_capabilities` and `prompt.sent`.
- [ ] `session.rs`: `drive` sends no frames; for an approval it appends `approval/decided` via `append_live`; `finish`, `await_approval`, `fail` only update `agent_sessions` (title; `active_document_path` from the turn's latest editable deliverable in the log; `updated_at`); drop `table_plan::finalize`.
- [ ] `model.rs`: delete frame sending, retry events, `model.turn.*` events. `tools/mod.rs`: delete `tool_call`/`tool_error`/`artifact` frames and `tool.*` events; a permission denial returns `failed` with the message. `canvas.rs`: delete patch frames, `event_summary`/`event_output`. `images.rs`: delete `image_generation.*` events/frames and `emit_image_event`; live sink from `stream::live_sink`. `exec.rs`: `resolve_approval` by `call_id` from the log; `StreamRequest.shell_approval` = `{call_id, decision}`. Delete `table_plan.rs` and its module.
- [ ] Hooks adapter in `kition-api/src/agent.rs` unchanged (same `HookDispatch`).

**Renderer:** `src/api/{agentStream.ts,agent.ts,agentTypes.ts}`, `src/api/generated/agent-stream.ts`, `useWorkspaceAgent.ts` (+spec rewrite), the components and workspace hooks of section 6, the deleted libs of section 6, `e2e/helpers/agentStream.ts` (new), `e2e/helpers/mockApi.ts`, the ten e2e specs of section 7.
- [ ] Tests first: rewrite `useWorkspaceAgent.spec.ts` (turn with text, tool, deliverable, patch, approval; interruption → "completion unknown"; sync after stream); migrate the e2e specs to `mockAgentTurn` and watch them fail on the old hook.
- [ ] Implement API, hook, components, deletions; remove the `listAgentMessages`/`ToolCalls`/`Events` calls and mock routes.
- [ ] `R`, `V`, `E` on the ten specs, `pnpm check:contracts`, `pnpm check:knip`, `python3 scripts/check-i18n.py`, `pnpm check:e2e-coverage`, `pnpm test:table:e2e`.
- [ ] Update `tests/live_openai.rs` assertions (run with a key: `KITION_LIVE_OPENAI_KEY_FILE=... CARGO_INCREMENTAL=0 cargo test -p kition-agent --test live_openai -- --ignored --test-threads=1`).
- [ ] Commit `"Stream standard session events and build the agent panel from them"`.

### Task 9: Delete the old writes and endpoints
**Files:** `run.rs`, `session.rs`, `store.rs`, `routes.rs`, `log.rs`, `prompts.rs`, `providers/core.rs`, `tools/*.rs` (not `kits.rs`), `model.rs`; delete contracts `agent-turn-capabilities.schema.json`, `agent-model-reconnect.schema.json` (+ generated TS).
- [ ] Tests first: `log::recent_deliverables(events, n, filter)` units (images; latest editable document); the `agent_flow` recent-images prompt test reads deliverables.
- [ ] Delete `store::{insert_message,new_message,recent_messages,insert_tool_call,finish_tool_call,find_tool_call,insert_artifact,recent_artifacts,latest_artifact_for_message,insert_event,replace_plan,session_rows,set_session_status}`; row types `AgentMessage`, `AgentToolCall`, `AgentArtifact`, `AgentEvent`, `AgentPlanStep`; `tools::{start_tool_call,complete_tool_call,fail_tool_call,persisted_input,label}` (keep `stage` for hooks; keep one projection in `turn::logged_arguments`); `Run::record_artifact`; `ToolOutput.{artifact,event_summary,event_output}` (also in `sources.rs`, `documents.rs`); the `dispatch(.., call_id: i64, ..)` parameter and signatures that only passed it on; routes `list_messages`, `list_tool_calls`, `list_events` and `session_rows<T>`; the user/assistant message inserts in `drive`, `finish`, the composer.
- [ ] `prompts::recent_images(paths: &[String])`; `CoreProvider::load` and `latest_editable_document` read the log.
- [ ] `R`, `cargo clippy -p kition-agent --all-targets -- -D warnings`. If clippy flags something only `kits.rs` uses, do not edit `kits.rs`; keep it used and note it for the kit line. Commit `"Keep agent conversations only in the session log"`.

### Task 10: Schema and portable workspace state
**Files:** `crates/kition-store/schema/main.sql`, `crates/kition-store/src/rows.rs` (+ its `agent_goals` test), `crates/kition-agent/src/store.rs` (`AgentSession` without `status`, `system_prompt`; `routes.rs` `create_session`), `crates/kition-workspacestorage/src/{state.rs,storage.rs,lib.rs}`, `contracts/runtime/workspace-storage.schema.json`, `src/api/agentTypes.ts` (`AgentSession`), `e2e/helpers/mockApi.ts`.
- [ ] Tests first in `kition-workspacestorage`: export → import round-trips a session and its `session-events.jsonl` (seq, bodies, `raw_items` stripped); `classify_path(".kition/agents/7/session-events.jsonl") == "agent_session_events"`; version 2 files are not imported.
- [ ] Remove the `CREATE TABLE`/`CREATE INDEX` for the seven dropped tables and the two `agent_sessions` columns; remove the `rows.rs` row types; `MIRRORED_TABLES` = `agent_sessions`, `agent_session_events`; rewrite `export_agent_state`/`import_agent_state` (insert-if-absent on `(session_key, seq)`); `STATE_SCHEMA_VERSION = 3`.
- [ ] `CARGO_INCREMENTAL=0 cargo test -p kition-store -p kition-workspacestorage -p kition-agent -p kition-api`, `pnpm check:contracts`; commit `"Drop the agent tables the log replaced"`.

### Task 11: Docs, kit line merge, gates
- [ ] `docs/superpowers/plans/2026-10-11-harness-agent-plan.md`: F2b done; G's note that `session.event` is on the stream and the remaining G work is the dsh envelope and the stdio server. Remove frame or flag mentions in undated docs, if any.
- [ ] Merge the latest `feat/kit-photo-tab` into `feat/harness-phase-f2b`; expect conflicts in `tools/mod.rs` (dispatch, `stage`), `catalog.json`, `providers/kits.rs`, kit e2e specs; re-run `R` and the kit e2e specs.
- [ ] `GATE`; report `git diff --stat <base>..HEAD -- crates/kition-agent crates/kition-harness src/features/agent e2e`.
- [ ] Real desktop checks (section 9) before merging to `feat/kit-photo-tab`.

---

## 9. Risks and real-client checks

**Risks.** Task 8 is large (mitigated by Tasks 3–7 making the log complete and shipping the reducer, effects, and table plan as tested pure code first). The dsh envelope differs (flattened `{seq, at, type, ...}`; hosted and composer orphan pairs; `approval/asked` after the paused call's result) — phase G's projection must map these (mark `ignorable` or project hosted calls into assistant content); record in the phase G notes. Log size and page count (every tool value logged; 500-event pages; the workspace mirror rewrites every session's `session-events.jsonl` per debounced change — consider exporting only changed sessions if IO spikes). Privacy (the mirror writes tool values into the workspace folder, as it already does for tool outputs; `data:` images in `user/message` can be large — consider dropping `data:` image blocks on export). The retry append is synchronous in the engine's retry callback (short SQLite write). Hooks change (`tool_called` really fires). UI content changes (no "Skills enabled" / "context attached" rows; debug rows become step and assistant rows; looks unchanged; review against `docs/design.md`). Provisional patch preview appears once arguments are complete JSON (as today). Kit line conflicts in `tools/mod.rs` (Task 9 changes `dispatch`; coordinate).

**Check in the real desktop client (Tauri, WebKit) before the final merge:**
1. A plain question streams text incrementally; the reply bubble, title, and session list update after idle.
2. A document-write turn: modified marker, open document reloads, artifact chip, workspace tree refresh.
3. Whiteboard patch: provisional preview then final; accept and reject; a failed patch cancels the preview. Same for design.
4. Shell approval: allow once, allow always (rule visible in Settings), deny; reload while waiting — the card survives and resolves.
5. Stop mid-turn: shows stopped; reopen — history matches the log.
6. Image composer with 2–3 variants: cards fill progressively; a repeat click does not duplicate; reload mid-generation recovers the outcome.
7. Hosted web search (Responses model) and a hosted image saved into a document.
8. Throttle or drop the network: "Reconnecting n/5" appears.
9. Table import preview shows the plan card with Apply; Apply refreshes the table and hides the card.
10. `configure_smtp_connection` refreshes the workflow drawer.
11. An agent kit edit in an open editor (bridge) appears as a tool run and the editor updates.
12. Quit and relaunch: every session renders from the log alone.
13. Copy the workspace to another profile: sessions import with history.
14. Desktop hooks `task_started`, `task_completed`, `tool_called`, `user_input_needed` run.

### Critical files

`crates/kition-harness/src/driver.rs`, `crates/kition-harness/src/events.rs`, `crates/kition-agent/src/session.rs`, `crates/kition-agent/src/tools/mod.rs`, `src/features/agent/hooks/useWorkspaceAgent.ts`.
