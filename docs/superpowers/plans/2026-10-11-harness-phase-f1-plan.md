# Harness Phase F1 Implementation Plan: The Harness By Default

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent turns run on `kition-harness` by default; the original loop
remains only as a fallback (`KITION_AGENT_HARNESS=0`) for one release. The
session event log becomes readable over the API with a public contract, and
the last pane knowledge leaves `harness_turn.rs`. The renderer keeps working
unchanged (it still consumes the NDJSON frames).

**Architecture:** Backend only. Phase F2 (a separate plan) moves the renderer
onto the event log, removes the custom patch frames, and deletes the original
loop; that work follows `docs/design.md` and needs desktop-client checks.

**Tech Stack:** Rust (`kition-agent`, `kition-api`, `kition-harness`), JSON
Schema contracts, generated TypeScript types.

**Base:** `feat/kit-photo-tab` at or after `d5abf7cf`. Do not edit
`crates/kition-agent/src/tools/kits.rs` or `tools/mod.rs`. Build with
`CARGO_INCREMENTAL=0`.

---

### Task 1: The harness by default

**Files:**
- Modify: `crates/kition-api/src/agent.rs`

- [ ] **Step 1: Failing test** (in `agent.rs` tests, create the module if absent)

```rust
    #[test]
    fn the_harness_is_on_unless_turned_off() {
        assert!(harness_enabled(None));
        assert!(harness_enabled(Some("1")));
        assert!(harness_enabled(Some("")));
        assert!(!harness_enabled(Some("0")));
        assert!(!harness_enabled(Some(" off ")));
        assert!(!harness_enabled(Some("false")));
    }
```

- [ ] **Step 2: Implement**

```rust
/// Agent turns run on the harness unless `KITION_AGENT_HARNESS` is `0`,
/// `off`, or `false` (the original loop stays as a fallback for one release).
fn harness_enabled(value: Option<&str>) -> bool {
    !matches!(
        value.map(|value| value.trim().to_ascii_lowercase()).as_deref(),
        Some("0" | "off" | "false")
    )
}
```

and `harness: harness_enabled(std::env::var("KITION_AGENT_HARNESS").ok().as_deref()),`.

- [ ] **Step 3: Docs.** Wherever the flag is documented (`grep -rn KITION_AGENT_HARNESS docs crates src-tauri`), say it is on by default and `0` falls back.

- [ ] **Step 4: Run, lint, commit**

`cargo test -p kition-api harness_enabled`, `cargo clippy -p kition-api --all-targets -- -D warnings`

```bash
git commit -m "Run agent turns on the harness by default"
```

### Task 2: Read the session event log

**Files:**
- Create: `contracts/runtime/agent-session-events.schema.json`
- Modify: `crates/kition-agent/src/routes.rs`, `src/api/agent.ts` (client function), `e2e/helpers/mockApi.ts` (mock route)
- Generated: `src/api/generated/agent-session-events.ts` (`pnpm contracts:generate`)

Route: `GET /agent/sessions/{id}/session-events?after=<seq>` for the caller's
own session (reuse `session::owned_session`; 404 otherwise). It returns the
standard envelope the other agent routes use, with
`{ "items": SessionEvent[], "next_after": <last seq or the given after> }`,
events with `seq > after` in order, at most 500 per page. `SessionEvent` is
the serde form from `kition-harness` (`seq`, `at`, `type`, camelCase fields).
Logged tool arguments are already redacted by the harness.

- [ ] **Step 1: Contract.** Write the schema with `$defs` for `contentBlock`
  (`text` / `image`), `loggedCall`, and `sessionEvent` as a `oneOf` over every
  `EventBody::KINDS` entry with its fields exactly as serialized (check
  `crates/kition-harness/src/events.rs`), plus `page` (`items`, `next_after`).
  Run `pnpm contracts:generate`.
- [ ] **Step 2: Failing test** in `crates/kition-agent/tests/agent_flow.rs`:
  after `tool_call_turn(true)`'s turn, `GET /agent/sessions/{id}/session-events`
  returns 200 with items starting at `turn/start` and ending at `turn/end`,
  every item validates against the contract's `sessionEvent` (use
  `jsonschema` like `crates/kition-kits/tests/kits.rs` does), and
  `?after=<last seq>` returns no items; another session id returns 404.
- [ ] **Step 3: Implement** the route and handler (session key
  `agent:<id>`, `SqliteLog`), the client function
  `listAgentSessionEvents(sessionId, after?)` in `src/api/agent.ts` typed with
  the generated types, and the mock route in `e2e/helpers/mockApi.ts`
  returning `{ items: [], next_after: 0 }`.
- [ ] **Step 4: Run** `cargo test -p kition-agent`, `pnpm check:contracts`,
  `pnpm run typecheck`, `pnpm vitest run --config tooling/vitest.config.ts src/api` (if API specs exist).
- [ ] **Step 5: Commit** `"Expose the agent session event log with a public contract"`.

### Task 3: Patch tools own their logging and presentation

**Files:**
- Modify: `crates/kition-agent/src/harness_turn.rs`, `crates/kition-agent/src/providers/{mod,whiteboard,design}.rs`

Today `harness_turn::logged_arguments` names `whiteboard_propose_patch` and
`design_propose_patch`. Move each tool's log projection into its provider:
extend the tool factory so a provider can pass a per-tool argument projection
and a presentation projection (`ToolBuilder::log_arguments` and
`ToolBuilder::presentation_meta`). The whiteboard and design providers pass:

- log projection: the summary `persisted_input` uses today
  (`{type, schema_version, summary_chars, operation_count}`);
- presentation meta: `{ "kind": "whiteboard.patch" | "design.patch", "patch": <the validated patch the tool proposed> }`,
  taken from the tool's output (read `tools/canvas.rs` to find where the
  validated patch is in the output value; if it is only sent as a frame, use
  the arguments' `operations` and `summary` instead and say so).

The generic projection for the remaining tools (`configure_smtp_connection`,
`source_search`, `source_file_search`) stays in `harness_turn.rs`.

- [ ] **Step 1: Failing tests.** In `harness_turn.rs`, extend the self-scan
  test needles with `"_propose_patch"`. In the whiteboard provider, a unit
  test that its tool's logged arguments are summarized and its presentation
  meta carries the patch (call the projections directly).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `cargo test -p kition-agent` (agent_flow 8/8 incl. parity).
- [ ] **Step 4: Commit** `"Let the patch tools own their log summary and presentation"`.

### Task 4: Gates and docs

- [ ] `pnpm check:desktop`, `python3 scripts/check-i18n.py`,
  `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy pnpm test:table:e2e`,
  `pnpm check:contracts`.
- [ ] In `docs/superpowers/plans/2026-10-11-harness-agent-plan.md`, note in
  the phase table that F is split: F1 done (this plan), F2 pending (renderer
  on the event log, patch frames removed, original loop deleted).
