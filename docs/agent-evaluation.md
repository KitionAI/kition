# Agent Evaluation Baseline

Status: Corpus prepared; initial live smoke recorded; full repeated baseline pending

The versioned corpus lives in
[`e2e/fixtures/agent-evaluation/v1`](../e2e/fixtures/agent-evaluation/v1/manifest.json).
It contains 60 tasks: 15 writing, 15 table, 15 retrieval, 10 memory, and 5 mixed
tasks. Every fifth task in each family is held out of workflow tuning. All source
material is synthetic; no measured Kition performance is represented by it.

Validate the corpus with `node scripts/check-agent-evaluation.mjs`. This checks
case IDs, required fields, counts, and source availability. It does not call a
model or produce a task-quality score.

## Execution protocol

1. Record client revision, runtime version, advertised capabilities, model and
   provider identifiers, relevant settings, and workflow version when available.
   Never include credentials or host-identifying paths in the report.
2. Copy `sources/` into an isolated evaluation workspace. Grant only that source
   folder. Keep the canonical fixture files unchanged. Use a fresh workspace and
   session per case; memory cases intentionally span isolated sessions/workspaces.
3. Run each case three times. For multi-step prompts, perform the described
   actions as separate turns. The evaluator performs grant removal, source
   changes, cancellation, and restart at the stated checkpoints.
4. Check each acceptance criterion against actual artifacts and observable
   events. A successful chat response alone is insufficient. Evaluate numeric
   results with deterministic calculations; review article quality independently.
5. Record `passed`, `failed`, `unsupported`, or `not_run` per repetition, with the
   individual acceptance results and privacy-safe evidence references. Unsupported
   capabilities are reported separately and never counted as passed tasks, except
   cases explicitly testing an honest unsupported-capability response.
6. Report raw counts per family, variability, latency, usage/cost where available,
   and unresolved cases. Do not report an aggregate success rate as representative
   when some families remain unmeasured. Use the release gates in the
   [capability improvement plan](agent-capability-improvement-plan.md).

## Known fixture expectations

`orders.csv` contains six records. Paid revenue is USD 65.00, known total value is
USD 85.00, and order 006 has unknown quantity. Alpha contributes USD 45.00, Beta
USD 40.00, and Gamma USD 0.00. Upserting the update creates order 007 and changes
order 002 price to USD 11.00, producing seven unique records. IDs retain their
leading zeros. The survey has 18 respondents out of 24 invited teams, and its
request groups overlap.

The initial corpus emphasizes text/Markdown and deterministic table behavior.
Add binary format, OCR, and document-rendering fixtures alongside their advertised
capabilities. Do not use these text fixtures to claim PDF, DOCX, or XLSX parsing
quality.

An initial [live evaluation](agent-live-evaluation-2026-09-30.md) records nine
generation turns through Kition Cloud and the real Agent endpoint. It covers
writing, native tables, folder retrieval, and same/new-session recall with actual
artifact and record checks. This one-pass smoke evaluation does not satisfy the
full repeated baseline protocol above.

The mocked stream and UI regressions verify completion reporting and localization,
not writing quality or retrieval recall.
