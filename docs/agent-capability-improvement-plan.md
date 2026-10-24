# Agent Capability Improvement Plan

Status: In progress; P0 client reliability and evaluation corpus implemented

Research date: 2026-09-30

### Implementation progress (2026-09-30)

- The stream reader now rejects EOF without a terminal frame, releases its reader,
  and preserves delivered events. The client retains partial replies and artifacts,
  records an unconfirmed interruption, and does not report request success.
- Unfinished timeline operations no longer become completed merely because the
  client is idle. Successful tool calls alone do not establish task completion.
- Timeline copy now uses locale resources. English and Simplified Chinese are
  provided, including reconnect reasons and artifact actions. The other supported
  locales currently retain English fallback copy for the new keys.
- A [versioned evaluation corpus](agent-evaluation.md) contains 60 tasks and 12
  synthetic source files, with held-out cases and an execution protocol. Its live
  repeated model baseline remains pending, so P0 as a whole is not yet complete.
- An initial [live smoke evaluation](agent-live-evaluation-2026-09-30.md) used
  Kition Cloud with actual artifact and table-record checks. It found short
  announcements, unsupported additions in Chinese prose, a default numeric-field
  inference weakness, and unavailable cross-session recall in the tested setup.
  Explicit table typing, targeted edits, and the selected retrieval sample passed.
- Focused stream, hook, timeline, and browser regressions cover interruptions,
  cancellation, preserved output, localization, and unconfirmed completion.
  Public run-state contracts and the P1 panel extensions remain pending.

## 1. Outcome and scope

Make Kition Agent reliably finish knowledge-work tasks: research selected folders,
write and revise useful articles, create and analyze correct tables, retain useful
context, and explain its progress in the right panel.

The first release prioritizes documents, tables, folder research, memory, and
execution visibility. All Agent panes should share the same completion,
provenance, recovery, and memory rules. Browser, workflow, scenario, image,
and design experiences adopt those rules without losing their
existing specialized contracts.

This is a client and public-behavior plan. Private runtime orchestration, prompts,
storage, parsing, indexing, and implementation designs belong exclusively in
`KitionAI/kition-runtime`. No private runtime source was inspected for this plan.
The initial plan used code and public documentation. A subsequent live smoke
evaluation is linked above; a full repeated benchmark and screenshot-based visual
audit remain pending. Neither code inspection nor that small sample establishes
the cause of every reported quality problem.

## 2. What exists and what needs attention

Paths below are relative to the repository root. Findings describe the inspected
client revision, not unobserved private implementation.

| Area | Evidence | Assessment and consequence |
| --- | --- | --- |
| Shared Agent surface | `src/api/agent.ts`: `AgentPaneContext`, capabilities, tools, skills, sessions, events, artifacts | Reuse the common Agent surface; do not create a separate assistant for every task. |
| Document editing | `src/features/agent/lib/agentDocumentEditing.ts`: save before sending, read before editing, ordered patches, stale-content recovery | Edit reliability already has explicit guidance. Article quality still needs separately measured evidence coverage, structure, style, and revision fidelity. |
| Table import | [Table File Import](table-file-import.md), `contracts/runtime/data-import.schema.json`, `src/features/agent/lib/tableFileImportIntent.ts` | Deterministic CSV/TSV/XLSX import, preview, idempotency, and failure guarantees already exist in the public behavior. Preserve them; do not ask a model to recreate imported rows. |
| Folder research | [Agent Local Analysis Folders PRD](agent-local-analysis-prd.md), `contracts/runtime/agent-local-sources.schema.json` | Up to eight read-only sources, virtual paths, bounded lexical search, line reads, and instruction discovery are already specified. The text-reading contract rejects binary files; it is not proof of searchable PDF/DOCX/XLSX content. |
| Remembered context | `src/features/agent/lib/agentDocumentContexts.ts`, `agentLocalSources.ts` | Device-local document and folder selections persist by workspace/session. This is distinct from cross-session preference or project-fact memory. No dedicated memory lifecycle contract was found in the inspected Agent API/contracts. |
| Plans and activity | `src/features/agent/components/PlanCard.tsx`, `AgentConversation.tsx`, `src/features/agent/lib/agentTimeline.ts` | Plans, tool activity, approvals, reconnect notices, and artifacts already render. Extend these with task outcomes, sources, validation, and memory usage. |
| Status localization | `src/features/agent/lib/agentTimelineI18n.ts`: `resolveAgentTimelineLocale` always returns `en-US` | Timeline labels ignore the selected locale. Some changed-file and artifact labels in `AgentConversation.tsx` are also inline English. |
| Stream completion | `src/api/agent.ts`: `streamAgentMessage` returns nullable `doneEvent`; `useWorkspaceAgent.ts` records success after a normal return | EOF without a terminal event can reach the success path. Add a regression before changing behavior; do not infer successful delivery from transport closure. |
| Turn attribution | `agentTimeline.ts`: events/tools use message IDs, artifacts use creation-time intervals | Explicit turn identity should replace timestamp inference for new events, retaining compatibility for older runtimes. |
| Scenario progress | `src/features/agent/components/BuildProgressCard.tsx` | Four fixed subtasks produce a percentage and infer the next running step. This component does not express failed, canceled, or skipped steps. Do not generalize this percentage to arbitrary Agent tasks. |
| Tests | `e2e/table-agent-document-flow.spec.ts`, `e2e/helpers/mockApi.ts`, Agent unit specs | Mocked interactions establish client behavior. They do not establish article quality, retrieval recall, formula correctness, or real-model task completion. |

The 4,000-character slice in `useWorkspaceAgent.ts` limits a synthetic timeline
preview. The full streaming text is accumulated separately; this is not evidence
that model context or article output is truncated to 4,000 characters.

Working hypothesis: quality depends on task routing, evidence selection, usable
tools, revision handling, and verified delivery as well as model capability.
Measure those factors before selecting a replacement model or adding a vector
database.

## 3. Lessons from Codex and official OpenAI documentation

These are documented public mechanisms, not claims about undisclosed product
internals. Kition recommendations in the last column are proposed adaptations.

| Documented mechanism | Official evidence | Proposed Kition adaptation |
| --- | --- | --- |
| Skills expose concise metadata first and load full instructions when selected | [Build skills](https://learn.chatgpt.com/docs/build-skills) | Discover task workflows without loading every writing, table, browser, and image instruction on every turn. |
| Repeatable workflows combine skills, executable tools, and context continuity | [Shell + Skills + Compaction](https://developers.openai.com/blog/skills-shell-tips) | Pair writing and table workflows with validation and actual artifact production. Reuse approved deterministic tools. |
| App Server separates threads, turns, item lifecycles, plans, diffs, and terminal outcomes | [Codex App Server](https://learn.chatgpt.com/docs/app-server) | Use authoritative structured activity and outcome events for the panel. Keep transport completion separate from task success. |
| Local Codex memories recall useful prior work, have separate use/contribution controls, and are not the source of mandatory project rules | [Memories](https://learn.chatgpt.com/docs/customization/memories) | Separate task continuity, user preferences, project knowledge, and source discovery. Make durable memory inspectable and controllable. |
| Compaction preserves context needed by subsequent turns in a long interaction | [Compaction](https://developers.openai.com/api/docs/guides/compaction) | Require long-task continuity independently of cross-session memory. Negotiate provider support rather than assuming an OpenAI-specific API exists everywhere. |
| Artifact workflows identify source data, output format, structure, review criteria, and refinement | [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer) | Deliver an openable artifact with verification and focused follow-up edits. Do not treat a chat claim as proof a file was created. |

The recommendation is to adopt these observable workflow properties. This plan
does not require replacing the Kition runtime with Codex App Server, adopting a
managed API, or copying Codex's local storage layout.

## 4. Shared task behavior

For substantive work, the user should observe the following sequence, with
irrelevant stages omitted for simple tasks:

1. Resolve the requested deliverable, target, current selection, and available
   tools. The user's request takes precedence over the currently open pane.
2. Recover relevant task context and enabled memories, showing their provenance.
3. Find and read the needed sources; report material gaps or conflicts.
4. Establish a short plan when the task has multiple dependent steps.
5. Produce or revise the artifact through the appropriate supported tools.
6. Check the result against the request and deterministic constraints; repair
   recoverable failures within a bounded budget.
7. Report the actual outcome, saved artifacts, checks, and unresolved issues.

Writing, table creation, table analysis, folder research, workflow, browser,
image, and design tasks need distinct workflow descriptions and
output criteria. Combined tasks can use several workflows sequentially. Do not
force every task through a visible wizard or require approval for an already
authorized, reversible operation.

An unavailable tool must produce a clear limitation or supported fallback. A
missing spreadsheet capability must never silently turn a requested workbook
into a Markdown table. Track model/provider, advertised capabilities, workflow
version, latency, and verification outcomes in privacy-safe evaluation metadata.

## 5. Writing and revision quality

### User-visible workflow

- Infer a compact brief: purpose, audience, language, tone, target length,
  publication format, requested structure, sources, and destination. Ask only
  when a missing answer would materially change the result.
- For source-based articles, gather evidence before drafting. Link material
  factual claims to sources and label estimates, unresolved contradictions, and
  unsupported requests. Creative writing does not require invented citations.
- Use an outline for long articles, then draft coherent sections and check the
  complete document for repetition, inconsistent terminology, weak transitions,
  missing requirements, and unsupported conclusions.
- Preserve user edits, document structure, links, images, and frontmatter unless
  the requested change requires modifying them. A targeted revision must not
  rewrite unrelated sections.
- Save to the requested workspace target, reopen the current version, validate
  Markdown structure and links, and expose the existing diff/review experience.
  Where a formatted export is supported, verify the rendered export as well.
- Finish with an artifact link and concise check results. Distinguish a saved
  draft with unresolved facts from a fully verified deliverable.

### Acceptance examples

- Turn five source documents into an article with attributable claims and no
  invented numbers; identify a deliberate contradiction in the sources.
- Revise only the requested section in a long document, preserving unrelated
  paragraphs and embedded assets exactly.
- Continue after an interrupted draft without duplicating sections; reopen the
  saved file and verify all requested sections exist.
- Apply an enabled style preference in a new session, then obey a conflicting
  explicit instruction for the current article.

## 6. Table and spreadsheet quality

Treat three deliverables separately: a GFM table in a document, a structured
Kitable resource, and an exported spreadsheet workbook. Resolve the intended
format from the request and target; ask only when the ambiguity affects the work.

| Task | Required observable behavior | Verification |
| --- | --- | --- |
| Import CSV/TSV/XLSX | Use the existing deterministic preview/import protocol, including sheet selection and field overrides | Exact row counts, identifiers, leading zeros, dates, nulls, decimal precision, and no duplicate replay |
| Build a Kitable | Propose typed fields, relationships, views, and uniqueness rules appropriate to the task | Read back schema and records; distinguish real supplied data from explicitly requested sample data |
| Modify a table | Resolve exact table and row scope; show meaningful changes for broad or destructive edits | Validate constraints and actual created/updated/skipped counts; detect concurrent changes |
| Analyze data | Use complete bounded queries or deterministic aggregations rather than totals guessed from a sample | Reconcile totals, filters, units, currencies, timezone rules, and missing values |
| Add formulas | Use the advertised formula dialect and supported functions | Check references, types, error values, boundary cases, and recalculated results |
| Produce a workbook | Use a separately advertised export capability; preserve formulas, formatting, and sheets where supported | Reopen the artifact, check calculations and structure, and inspect its preview |

Do not promise full Excel formula compatibility because Kitable has a formula
field. Capability negotiation and format-specific tests must establish support.
Preserve existing rollback/idempotency guarantees. After cancellation or an
ambiguous network result, reconcile the operation before retrying a mutation.

## 7. Research in selected folders

Extend the existing local-source PRD rather than replacing its read-only model.
Retain the eight-source limit, explicit folder-picker grant, virtual source
paths, bounded traversal, ignore behavior, and workspace-only write targets.

### Retrieval experience

1. Establish which folders are available and which file types can actually be
   read. A typed host path is not a grant.
2. Discover candidate filenames and directories, search content, then read the
   relevant passages. Follow references and query variations when evidence is
   incomplete; do not stop at the first plausible hit.
3. Treat an explicit file reference as a strong search hint. Distinguish no
   matches from skipped files, unavailable parsers, exhausted limits, stale
   sources, or denied access.
4. Return source locators with relative path, version/fingerprint, and a line,
   page, section, or sheet/range as appropriate. Clicking a locator should open
   the precise evidence after rechecking the current grant.
5. Present a concise coverage summary: examined files, relevant sources,
   unsupported files, conflicts, and remaining gaps. Counts must reflect actual
   events; unknown totals must remain unknown.

### Format coverage and sequencing

- First measure the existing text/Markdown/code search and bounded reads.
- Add capability-gated PDF and DOCX extraction, and XLSX sheet/range inspection.
  Validate reading order, headings, merged cells, formulas versus cached values,
  and page/sheet locators. Extraction is distinct from importing data into Kitable.
- Treat scanned PDFs/images as a separate OCR capability. Report unreadable
  pages and uncertain extraction rather than silently returning empty content.
- Consider an optional local lexical index and then hybrid/semantic retrieval
  only if measured recall or latency requires it. Any persistent extracted-text
  index is a scope change to the current PRD and requires an explicit contract,
  retention policy, and user control before introduction.

Source text remains untrusted evidence. Instructions found inside a document
cannot grant tools, expand a folder boundary, override the user's task, or request
secret disclosure. Preserve the existing project-instruction feature with an
explicit provenance/trust boundary. Test symlinks, traversal, removed grants,
ignored credentials, oversized files, and malicious source instructions.

Do not persist source snippets or raw host roots in timeline events, evaluation
logs, or portable workspace metadata. A user-requested sourced article may contain
the necessary synthesis and citations; that does not authorize retaining a full
copy of every source or silently promoting its contents to durable memory.

## 8. Memory and long-task continuity

| Context class | Purpose | User control and validity |
| --- | --- | --- |
| Current task | Goal, accepted decisions, remaining steps, output targets, verified checkpoints, and unresolved issues | Resume the same task across reconnect/restart; recheck artifact revisions and folder grants |
| User preference | Writing style, preferred output format, terminology, and similar stable choices | Explicit remember request, or an enabled automatic-memory policy; view, edit, delete, disable |
| Workspace knowledge | Approved project conventions and durable decisions with provenance | Workspace-scoped by default; date/version, supersession, correction, and expiry where applicable |
| Source discovery hints | Where useful material may be found | Revalidate the grant and source; a hint is neither evidence nor permission |

Keep mandatory workspace rules in their existing authoritative documents. An
explicit current instruction overrides a recalled preference. A corrected or
deleted memory must not reappear through an old summary or background update.
Do not share project facts across workspaces or accounts by default.

Expose separate controls for using existing memories and contributing new ones.
Initial durable memory should focus on explicit user preferences and approved
workspace decisions. Automatic extraction can follow after isolation, deletion,
and false-recall tests pass. Exclude secrets and attached-source content by
default; derived source facts require a separately defined opt-in policy.

Each recalled entry needs an ID, scope, origin, update time, and validity state.
The panel should show which entries affected a turn and offer correction or
removal. Relevant memories are selected within a bounded context budget; do not
append every prior conversation to every new request.

Long-task compaction is independent of durable memory. Its observable guarantee
is preservation of the current goal, user corrections, unresolved work, source
references, output revisions, and completed operations. After compaction or
restart, reread changed evidence and reconcile writes before continuing. Provider
support and fallback behavior require black-box tests; the client must not invent
or interpret opaque provider compaction data.

## 9. Right-panel status and review

Extend `AgentChatPanel`, `AgentConversation`, and `PlanCard` with a compact task
summary and collapsible details. Keep the composer and conversation usable in a
narrow panel; avoid a second permanent dashboard.

| Panel element | Example English source copy | Source of truth |
| --- | --- | --- |
| Current activity | Searching selected folders; Drafting section 2; Checking totals | Typed current operation and stage |
| Plan | Research sources; Draft article; Verify and save | Actual plan updates, including skipped/blocked steps |
| Evidence | Read 6 files; 2 files could not be parsed | Retrieval and extraction receipts |
| Memory | Used 2 preferences; Remembered the requested format | Scoped recall/update receipts |
| Waiting/recovery | Waiting for your answer; Reconnecting, attempt 2 of 5 | Actual input/approval/reconnect state |
| Result | Saved draft; Verified table; Completed with unresolved sources | Terminal outcome plus artifact/validation receipts |

Required behavior:

- Separate execution state (`queued`, `running`, `waiting_for_user`,
  `reconnecting`, `completed`, `failed`, `canceled`) from working stage
  (`research`, `draft`, `edit`, `validate`, `save`) and result quality
  (`verified`, `partial`, `unverified`). These names are proposals, not current
  wire values.
- Show human-readable progress and evidence. Keep raw arguments and protocol
  details behind existing debug controls; do not expose private reasoning.
- Avoid fake percentages. Use counts only when a denominator is known, otherwise
  show the current stage, elapsed time, and last observed activity.
- Do not infer success from a stopped spinner, stream EOF, generated prose, or a
  successful intermediate tool. A saved artifact and a verified artifact are
  different outcomes. Read-only answers have their own evidence criteria.
- Preserve completed artifacts and useful partial work on failure. Offer the
  relevant action: resume, retry the failed read, reopen the saved draft, correct
  a source, or review a change. Do not automatically replay an uncertain write.
- Isolate updates by session/turn, handle duplicates and out-of-order events,
  and recover the authoritative state after reconnect or application restart.
- Localize all user-facing labels through `src/i18n/locales/<locale>/agent.json`.
  Repository prose and fixtures stay English; locale-specific test expectations
  should reference approved locale resources.
- Follow [design.md](design.md): white/light-neutral surfaces, purple `#5645d4`
  primary actions, 8px buttons, 12px cards, restrained borders and shadows. Use
  shared primitives/tokens. Preserve keyboard access, focus, reduced motion, and
  polite live announcements without announcing every token.

Validate the implemented panel with screenshots in narrow/wide layouts and
supported themes. This plan's status recommendations come from code inspection,
not a claim that the current rendered layout has been visually audited.

## 10. Public contracts and compatibility

The following are proposed public additions. Review their final names against the
existing capability system before implementation; they are not shipped APIs.

| Proposed contract | Minimum observable surface | Client adoption |
| --- | --- | --- |
| `agent-run-state.schema.json` | Session/turn/event IDs, monotonic ordering, stage, execution state, structured errors, authoritative terminal outcome, snapshot/recovery semantics | Typed reducer and status UI; adapt legacy NDJSON and scenario SSE separately |
| `agent-deliverable.schema.json` | Artifact identity, target revision, saved state, verification result, unresolved requirements, related turn | Result cards and reliable completion checks |
| `agent-evidence.schema.json` | Source ID, virtual locator, source version, coverage/truncation/parser status; no persisted raw snippets | Evidence drawer and source navigation |
| `agent-memory.schema.json` | Scoped list/read/update/delete behavior, recall/update receipts, independent use/contribution controls, deletion semantics | Memory controls and per-turn disclosure |
| Existing local-source and turn-capability schemas | Advertised extraction formats, OCR availability, continuity and new-contract versions | Capability-gated controls and explicit unsupported states |

For each contract: specify required/optional fields, enums, payload bounds,
permission behavior, unknown-event handling, cancellation, replay, and error
examples. Add public mocks and generated client types before depending on private
runtime support. Keep storage layouts, model prompt assembly, algorithms, and
private implementation decisions out of this repository.

Older runtimes retain existing supported flows. Missing flags disable only the
new dependent feature with an understandable reason. Never manufacture memory,
verification, or extraction status from model text. An EOF without a terminal
event is an unknown/interrupted outcome until a supported status refresh resolves
it, not an automatic failure of every completed artifact.

## 11. Delivery phases and concrete tasks

Each item is independently reviewable. The checklist records completed increments;
phase completion still requires its full exit criteria.

| Phase | Work and likely client locations | Exit criterion |
| --- | --- | --- |
| P0: Baseline and immediate reliability | `src/api/agent.spec.ts`, `useWorkspaceAgent.spec.ts`, `agentTimelineI18n.ts`, `AgentConversation.tsx`, locale resources; add public evaluation fixtures | Reproduce and fix missing-terminal success; localize activity; record current task-quality baseline |
| P1: Shared observable task state | New run-state/deliverable contracts and generated types; `e2e/helpers/mockApi.ts`; extract a reducer from `useWorkspaceAgent.ts`; extend `PlanCard` and conversation activity | Event replay, reconnect, cancellation, unknown events, and old-runtime fallback pass; partial outcomes are visible |
| P2: Writing and table delivery | Existing document targeting/editing helpers, table import flow, result review; public writing/table black-box scenarios | Source-based article, targeted revision, deterministic import, table creation, and verified analysis meet the release rubric |
| P3: Folder evidence | Extend local-source contract, source context cards, evidence navigation, parser capability states; align the local-source PRD | Text and advertised document formats return precise sources; limits and missing coverage are visible |
| P4: Memory and continuity | Memory contract and mocked API, account/workspace-scoped controls, per-turn memory receipts; continuity scenarios | New-session preference recall, correction/deletion, isolation, disabled memory, compaction, and restart tests pass |
| P5: All-surface rollout | Adapters for scenario, workflow, browser, image, and design events; shared outcome/review UI | Existing specialized behavior is preserved and every surface passes common completion/recovery tests |

Dependencies: P0 precedes P1. P2 and P3 depend on P1 and can be delivered in
separate increments. P4 can establish explicit preferences after P1, but recalling
source-derived knowledge depends on P3 and the approved source-retention policy.
P5 follows validation of the shared contract on documents and tables.

### Implementation checklist

- [ ] P0: Freeze an evaluation set and run the current model/provider configuration
  against it; record model, capabilities, runtime version, settings, and failures.
- [x] P0: Add the EOF-without-terminal regression, fix success reporting, and
  localize timeline/result labels without changing private runtime behavior.
- [ ] P1: Publish public schema examples and mocks, then implement client state
  projection and status/review controls behind capability flags.
- [ ] P1: Deliver corresponding private runtime behavior in its own repository;
  validate through an explicit local runtime binary as a black box.
- [ ] P2: Establish writing and table workflow behavior through contracts,
  artifact checks, and task-quality evaluations; preserve import guarantees.
- [ ] P3: Establish text retrieval quality first, then add document extraction
  and precise citations. Introduce indexing only with measured justification.
- [ ] P4: Deliver explicit durable memory and controls, then evaluate automatic
  contribution separately. Verify long-task continuity for each supported provider.
- [ ] P5: Roll out the common contract to every Agent surface; record quality,
  latency, and cost deltas before enabling by default.

The first useful milestone is P0 plus P1 and one complete P2 path: selected source
material to a saved, checked article, with truthful progress and recovery. The
next is deterministic table import/analysis with verified counts. Memory and
document extraction then build on observable, testable task behavior.

## 12. Evaluation and release criteria

Create a versioned, English-only public corpus of 60 tasks: 15 writing/revision,
15 table/import/analysis, 15 folder-research, 10 memory/continuity, and 5 mixed
surface tasks. Include long files, conflicting sources, empty results, duplicate
rows, stale revisions, malformed input, unsupported formats, and interrupted
streams. Use synthetic or appropriately licensed data, never user folder contents.

Run each real-model task three times for a candidate release. Report each family
separately, raw pass counts, variability, model/provider, workflow/runtime version,
token usage where available, elapsed time, and tool failures. Keep a held-out
subset and compare against the frozen baseline. Mock tests are a separate gate.

Proposed initial targets, to be calibrated against P0 rather than presented as
already measured performance:

| Metric | Proposed gate |
| --- | --- |
| Completed deliverables | At least 90% task success in each primary family, not only in aggregate |
| Writing quality | Average at least 4/5 on usefulness, structure, source fidelity, and revision fidelity; blind human review of at least 10 paired outputs |
| Numeric/table invariants | 100% exact counts/totals for deterministic fixtures; zero silent truncation, duplicated replay, or corrupted unrelated data |
| Retrieval coverage | At least 90% of required evidence items found on the frozen corpus; at least 95% citation locator correctness |
| Memory | At least 90% relevant preference recall; zero cross-account/workspace leaks or reuse of deleted/disabled memories in isolation fixtures |
| Continuity | All deterministic compaction/reconnect/restart fixtures preserve user corrections and avoid replaying completed mutations |
| Truthful status | Zero successful completion claims for missing-terminal or failed-delivery fixtures; all known terminal states recover correctly |
| UI responsiveness | Local busy feedback within 300 ms and visible state within 1 second of receiving its event on the test device |
| Latency and cost | Record p50/p95 and cost per successful task; investigate more than 20% regression against the same-provider baseline before rollout |

A severe boundary violation, fabricated completion, or data corruption blocks a
release regardless of the aggregate score. Model-based grading may help triage
style, but cannot replace deterministic checks or human article review.

### Verification layers

1. Contract and reducer tests: malformed/unknown/duplicate/out-of-order events,
   missing terminal markers, reconnect, cancellation, and legacy capability modes.
2. Client integration tests: article targeting, table result refresh, evidence
   links, memory controls, localization, accessible status, and review actions.
3. Black-box runtime tests using `KITION_API_BINARY=<runtime-binary> pnpm dev`:
   actual reads/writes, extraction, evidence, counts, replay, and continuity.
4. Real-model evaluation: task quality and source fidelity with generated artifacts
   inspected independently of assistant prose.
5. Visual verification for changed UI, against [design.md](design.md).

For every completed task, run `python3 scripts/check-i18n.py` and
`pnpm test:table:e2e`; both must exit 0. Implementation tasks additionally run the
relevant unit/integration checks and required frontend build checks. The mandatory
table-widget test verifies three widget regressions; it is not an Agent-quality
benchmark.

## 13. Defaults and unresolved measurements

- Start with existing providers and tools. Choose model changes from measured
  task-quality gains, with capability compatibility and cost considered together.
- Prioritize text/Markdown articles and Kitable operations. DOCX/PDF extraction,
  OCR, and workbook export are advertised extensions with separate validation.
- Keep durable project memory workspace-scoped; source access remains device-local
  and separately granted. Account-global preferences require explicit scope.
- Keep existing permission flows. Add a question only for unresolved intent,
  destructive scope, or a genuinely new permission boundary.
- Defer semantic indexing and autonomous agent delegation until evaluations show
  that simpler workflows cannot meet recall, quality, or latency goals.
- Schedule estimates remain open until P0 establishes failures, current runtime
  capabilities, and the size of the cross-repository changes.
