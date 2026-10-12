# Harness Agent Program: Status And Next Steps

Snapshot taken when work paused. Read this first when resuming.

## Direction (user decisions)

- The agent core is `crates/kition-harness`, following DeepSeek Harness
  contracts (pinned `0.2.1-alpha.2`, commit `d7432673`) and the Kition Kit
  Standard. It is provider-agnostic: model-specific rules live only in
  `kition-ai` wires.
- No old way: replaced code, flags, and fallbacks are deleted, not kept.
  Everything follows the standard. Code stays lean.
- No users yet: no data migration, backfill, or compatibility with old data.
- The kit layer (Kit AI bridge, kit MCP server, kit tools in
  `crates/kition-agent/src/tools/kits.rs`) is owned by the other session line.
  This line may change the execution wrapper in `tools/mod.rs` but not kit
  tool logic.

## Done and merged into `feat/kit-photo-tab`

| Step | Result |
| --- | --- |
| Phase A | `kition-harness` crate: events, schemas, tools, policies, log, model seam, providers, driver |
| Phase B | Agent on the harness; DeepSeek via its Anthropic-compatible Messages API; OpenAI Chat Completions wire (Kimi, gateways); request headers sent once |
| Flag readiness | Bounded history, busy 409, stop without waiting for long tools |
| Phase C | Every pane, local sources, kits, and MCP as providers; pane golden data |
| Phase F1 | Session-events API with contract; patch tools own their log projection |
| Phase F2a | The harness is the only loop; original loop and flag deleted; modules `session.rs`, `turn.rs`, `model.rs`, `log.rs`, `providers/` |

Live tests (`crates/kition-agent/tests/live_openai.rs`, ignored by default)
passed against an OpenAI-compatible gateway on both wires.

## In progress: Phase F2b on `feat/harness-phase-f2b`

Plan: [2026-10-11-harness-phase-f2b-plan.md](2026-10-11-harness-phase-f2b-plan.md).
Worktree used: `../kition-harness-g`.

Committed (all gates green at `461fd326`):

| Task | Commit(s) |
| --- | --- |
| 1 Drop backfill and settings migrations | `94250961` |
| 2 Hosted support rules in `kition-ai` | `4adb35d2` |
| 3 dsh events (`approval/decided`, `deliverables/presented`, `todo/write`, `llm/retry`, `permission/preset`, `user/message.source`) | `6f802af1` |
| 4 Tool emits, hosted calls, permission preset | `b0a2a8ef` |
| Retry events as dsh (chain id, `llm/retry-started`) | `51accb0c` |
| 5 `agent/assistant-stream` frames | `5bd5e518` |
| 6a–6d Complete log (deliverables, todos, approval meta, early failures, hosted calls, image composer turn, history by source) | `c9c85fd6`, `9cf8c17a`, `50cf560d`, `8d7c3d9f` |
| Stream revision per session, Responses chunk ids | `461fd326` |
| 6 review fixes (composer turns end once, failed start ends the turn, off-executor claim read, approval meta defaults, revision counter dropped on delete) | `ef6c183c` |

Task 7 (renderer view libraries) was stopped midway. Only its fixtures are
committed (`src/features/agent/lib/__fixtures__/`); the modules
`agentSessionView.ts`, `agentEventEffects.ts`, `agentTablePlan.ts`,
`agentImageJob.ts` and their specs still have to be written.

Known interim effect until the switch: the current renderer drops live image
variant cards (the old `image_generation.artifact` events now carry `call_id`
instead of a numeric `id`). Accepted; the switch fixes it.

## Next steps, in order

1. **Task 7**: the four renderer libraries with specs, from the committed
   fixtures.
2. **Switch and deletion in one step** (plan Tasks 8, 9 and 10 merged, per the
   user's "no compatibility"): standard NDJSON notifications and the renderer
   built from session events; delete every custom frame, the `agent_events`
   timeline, `/messages`, `/tool-calls`, `/events`, the old row writes, the
   seven dropped tables, and old renderer modules; workspace state version 3.
3. **Task 11**: merge the latest `feat/kit-photo-tab`, run the full gate, then
   the 14 real desktop-client checks in plan section 9 (needs the user).
4. Later: phase G (DeepSeek Harness SDK protocol server, ACP, conformance
   report), native rewrites of tool families.

## How to resume

```bash
cd <repo-root>/../kition-harness-g        # or: git worktree add ../kition-harness-g feat/harness-phase-f2b
ln -s ../kition-kit-tab/node_modules node_modules   # if node_modules is missing
CARGO_INCREMENTAL=0 cargo test -p kition-harness -p kition-agent -p kition-ai
```

Gates: `pnpm check:desktop`, `pnpm check:contracts`, `pnpm check:knip`,
`python3 scripts/check-i18n.py`, and with proxy variables unset
`pnpm test:table:e2e`.

If a test that runs `git` fails with "Bad CPU type in executable", the first
`git` on `PATH` is an x86 build without Rosetta; put `/usr/bin` first on
`PATH` for the gates.
