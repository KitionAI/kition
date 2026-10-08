# Live Agent Evaluation: 2026-09-30

Status: Initial live smoke evaluation; the full repeated baseline remains pending.

## Method

Requests used the actual Kition runtime Agent NDJSON endpoint and the configured
Kition Cloud `gpt-5.5` model with medium reasoning. There were no mocked model or
tool responses. The runtime was an explicit local binary advertising version
`dev`, protocol 1, and build commit `9a9e7733a04c`. The client checkout was
`62a88604` with the uncommitted P0 client changes described in the improvement
plan. These results describe that runtime and hosted model combination, not all
published Kition releases or all available models.

The evaluation used an isolated temporary database and workspace, with only the
synthetic corpus folder attached as a read-only source. Existing user documents
were not modified. The saved desktop cloud session was restored through the
public session-status endpoint before generation. Two preliminary requests were
rejected by the local authentication gate before restoration; they are setup
attempts, not generation results.

Each scenario ran once. Scenarios had fresh sessions except for the intentional
same-session memory recall; they shared the isolated workspace and some ran
concurrently. This is a smoke test, not the corpus protocol's fresh-workspace,
three-repetition baseline. Durations include tool execution and may reflect
concurrent cloud traffic. No token or billing totals were available in the
captured completion events.

This test bypassed the renderer. It does not evaluate the client's deterministic
file-import routing, rendered table interactions, citation navigation, or the
right-panel layout. English outputs and concise observable evidence are saved
in [the evidence directory](evaluations/2026-09-30/summary.json). The Chinese
sample remains outside the repository to respect its localization boundary.

## Observed results

| Scenario | Result | Evidence |
| --- | --- | --- |
| Sourced English announcement | Failed the requested length; core facts and provenance passed | 62.6 s. Saved a real Markdown artifact with the current date, 24 teams, correct survey denominator, and source locators. It contains 398 whitespace-delimited words including headings and citations against a 500-word request. |
| Targeted article revision | Passed | 68.1 s. Replaced the Evidence section with survey findings. Byte comparisons confirmed the prefix and suffix outside that section, including frontmatter, links, and code, were unchanged. |
| Native table and revenue analysis | Values passed; schema quality needs improvement | 84.0 s. Six fields and six persisted rows, IDs `001` through `006`, paid revenue USD 65, known total USD 85, and correct team totals. Quantity became a text field and the empty value became the string `unknown`. |
| Folder retrieval | Passed this sample | 46.1 s. Correctly found the current launch date and 24 teams, rejected the superseded date, and cited verification code `PILOT-7319` at line 1206 of the large file. |
| Remember preference | Honest limitation disclosure | 26.4 s. Said it could retain the arbitrary label within the chat but could not guarantee future-chat persistence. No document was created for memory. |
| Recall in same chat | Passed | 7.2 s. Returned the exact arbitrary label. |
| Recall in new chat | Cross-chat recall unavailable in this setup | 21.5 s. Could not recall the label and did not invent it. The advertised tool list contained no memory-specific tool. This does not establish whether other runtime configurations support memory. |
| Explicitly typed native table | Passed | 78.3 s. A second table preserved six records, text IDs, numeric quantity and price, selection status, and a genuine null for the missing quantity. Schema and rows were fetched independently after completion. |
| Chinese announcement | Failed grounding; short of requested length | 82.6 s. Saved an actual Chinese artifact with correct core facts, but introduced unapproved pre-launch requirements and contained only 663 Han characters across the full artifact against approximately 800 requested for the body. |

The default table prompt asked that missing quantity remain unknown but did not
explicitly prescribe a numeric column or null representation. Its text-column
choice is a usability limitation, not proof that explicit numeric typing fails.
The explicit numeric-schema probe succeeded. Together, these two observations
support adding a default schema policy; they do not establish failure of numeric
storage or calculation.

All nine generation turns returned terminal frames without error frames and
emitted `task.completed`. Output acceptance still failed for both announcements.
The retained event counts demonstrate why execution status and output quality
must be reported separately. Tool-call counts use persisted tool records rather
than streaming start/update frames, which can appear more than once per call.

## Writing assessment

The English announcement is factually grounded, but reads like a sequence of
source summaries. Its archived-date explanation, internal budget, and export
compatibility caveats compete with the reader-facing announcement. Dense inline
locators interrupt the prose. This is an editorial judgment on one sample, not
a measured general writing score. The fictional and synthetic qualifiers came
from the fixtures and are not hallucinations.

The Chinese announcement used natural paragraphs and explained the overlapping
survey groups correctly. However, it instructed teams to designate a contact,
prepare a research scenario, and organize initial materials before launch.
Those requirements are absent from the sources and were not labeled as proposed
steps. It also presented specific future evaluation priorities as settled plans.
This is a groundedness failure even though the dates, counts, and support owner
were correct. The 663-character count includes headings and source labels, so
the body itself is shorter still. The localized artifact's SHA-256 is recorded
in the evidence summary; its content was visually read as text, not screenshot
audited in the application.

The model also saved the requested `announcement.md` under
`Agent/announcement/announcement.md` and accurately reported that location.
Artifact discovery should use returned artifact paths instead of assuming a
workspace-root filename.

## Consequences for the improvement plan

1. Add output acceptance checks for requested length, required sections, factual
   support, saved artifact existence, and a focused editorial review before
   reporting writing completion.
2. Make numeric column inference and a missing-value policy explicit in the
   table workflow. Verify persisted schema and records, as well as the prose
   calculation. This Agent test did not exercise the deterministic import API.
3. Treat session context and durable memory as separate capabilities. Show the
   available scope accurately and implement inspectable, editable durable memory
   through a negotiated public contract before promising cross-chat recall.
4. Surface observable milestones such as sources read, rows saved, artifact
   saved, and checks passed in the right panel. A terminal task event is evidence
   of execution completion, not proof that every output requirement passed.
5. Keep the full 60-case, three-repetition baseline open. Add realistic customer
   briefs and larger typed tables before generalizing from these synthetic cases.

## Regression checks

`python3 scripts/check-i18n.py` passed. `pnpm test:table:e2e` passed all 13 tests.
These checks cover repository localization and table-widget regressions; they
are separate from the live quality observations above.
