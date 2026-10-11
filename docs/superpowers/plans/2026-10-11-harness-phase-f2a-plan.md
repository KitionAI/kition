# Harness Phase F2a Implementation Plan: One Agent Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The harness is the only agent loop. Delete the original loop, the
`KITION_AGENT_HARNESS` flag, and every path that existed only for it; keep
the code small and named for what it is.

**Architecture:** `kition-agent` keeps `session.rs` (request validation,
turn start, finishing frames), `turn.rs` (the harness turn, renamed from
`harness_turn.rs`), `model.rs` (the `Llm` seam over the engine: frames,
retry events, hosted calls), and `providers/`. Pane parity, which compared
against the original loop, becomes golden expectations frozen from today's
output before the original loop is deleted.

**Tech Stack:** Rust (`kition-agent`, `kition-api`), docs.

**Base:** `feat/kit-photo-tab` at or after `72a46238`. Do not edit
`crates/kition-agent/src/tools/kits.rs` or `tools/mod.rs` (kit line). Build
with `CARGO_INCREMENTAL=0`.

**Out of scope (F2b, separate plan):** the stream carrying standard session
events and the renderer timeline built from them; removing the custom
whiteboard/design frames; the `agent_tool_calls` / `agent_events` rows and
frames written inside `tools::execute` (owned by the kit line; F2b needs that
line to agree on removing them).

---

### Task 1: Freeze pane expectations

**Files:**
- Modify: `crates/kition-agent/tests/agent_flow.rs`
- Create: `crates/kition-agent/tests/golden/panes.json`

While the original loop still exists, record what each parity scenario sends
so the expectations survive its deletion.

- [ ] **Step 1:** Add a test-only switch (env `KITION_WRITE_GOLDEN=1`) to the
  parity test that writes, for every scenario, the legacy request's sorted
  tool objects and sorted prompt lines and its user message to
  `tests/golden/panes.json` (keyed by a stable scenario name). Run it once to
  generate the file, review it (no host paths, no secrets; the scenarios use
  temp dirs: replace any temp path with a `<workspace>` placeholder when
  writing and when comparing).
- [ ] **Step 2:** Change the parity test to compare the harness request with
  the golden entry instead of the legacy request. It must pass.
- [ ] **Step 3:** Commit `"Freeze pane expectations as golden data"`.

### Task 2: Delete the original loop and the flag

**Files:**
- Delete: `crates/kition-agent/src/turn.rs` (original loop)
- Rename: `crates/kition-agent/src/harness_turn.rs` → `turn.rs`
- Create: `crates/kition-agent/src/model.rs` (`AgentLlm` plus the stream
  handler, retry handler, and hosted-search recording it uses, moved from the
  old `turn.rs`; `MAX_TURNS` moves here as `MAX_STEPS`)
- Modify: `session.rs`, `prompts.rs`, `run.rs`, `lib.rs`,
  `crates/kition-api/src/agent.rs`, `providers/*`, `tests/agent_flow.rs`,
  `tests/live_openai.rs`

- [ ] **Step 1: `session.rs`.** Remove `tool_specs`, `build_context`,
  `build_messages`, and the original-loop branch of `drive`; `drive` always
  calls `turn::drive`. `turn_capabilities` takes the assembled tool names.
  Keep only what `prepare`, `drive`, the image-intent path, `finish`,
  `await_approval`, `fail`, `set_status`, `previous_conversation`, and the
  providers use; move provider-only helpers (`active_table_context`,
  `active_data_document`, `supports_hosted_*`) into the provider files that
  use them if only one provider uses each.
- [ ] **Step 2: `prompts.rs`.** Delete `tool_loop` and anything only it used;
  keep `general_lines`, `table_lines`, `pane`, and the prompt functions the
  providers call.
- [ ] **Step 3: flag.** Remove `AgentConfig::harness`, `Agent::harness()`,
  `harness_enabled`, the startup log line, and every doc/comment mention of
  `KITION_AGENT_HARNESS` in code and in `docs/` outside the dated phase plans
  (those are history). `turn.rs` keeps its module doc describing the turn,
  not the flag.
- [ ] **Step 4: tests.** `agent_flow.rs`: one mode only; drop the
  `harness_mode` parameter, the `_on_the_harness` duplicates, and
  `app_with`'s flag. The session-events and log checks stay (they are no
  longer conditional). `live_openai.rs`: two tests (Responses, Chat
  Completions), no original-loop variants.
- [ ] **Step 5: names.** Rename identifiers that only made sense next to the
  original loop (`legacy_tools`, `legacy_call`, `legacy_factory`,
  `harness_tool`, "harness turn" in comments) to plain names (`tools`,
  `call_tool`, `factory`, "turn"). Do not rename `kition-harness` types.
- [ ] **Step 6: dead code.** `cargo clippy -p kition-agent -p kition-api
  --all-targets -- -D warnings` and `pnpm check:knip` must be clean; delete
  whatever became unused (including `providers/mcp.rs`'s `model_spec` if only
  the deleted `tool_specs` used it besides the provider).
- [ ] **Step 7: Run** `cargo test -p kition-agent -p kition-api`.
- [ ] **Step 8: Commit** `"Make the harness the only agent loop"`.

### Task 3: Gates and docs

- [ ] `pnpm check:desktop`, `python3 scripts/check-i18n.py`,
  `pnpm check:contracts`,
  `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy pnpm test:table:e2e`.
- [ ] `docs/superpowers/plans/2026-10-11-harness-agent-plan.md`: F2a done
  (original loop and flag deleted), F2b pending.
- [ ] Report the net line count change (`git diff --stat <base>..HEAD -- crates/kition-agent crates/kition-api`).
