/**
 * Performance measurement of the Markdown document KDM (Phase 2c, Task 8). Skipped unless
 * `KITION_DOC_BENCH=1`: this is a manual benchmark, not a correctness test, and its timings vary
 * with the machine, so it only asserts that it ran — the budgets below are reported in the
 * printed table, not enforced (except where noted). Run it with:
 *
 *   KITION_DOC_BENCH=1 pnpm vitest run --config tooling/vitest.config.ts \
 *     src/features/document/kdm/documentKdm.bench.spec.ts
 *
 * Each document is realistic Markdown: headings, prose paragraphs mixing CJK and emoji, bullet
 * lists, GFM tables, and fenced code blocks, generated to approximately 100 KB, 1 MB, and 5 MB.
 * Every size gets the full set of measurements from Task 8: import, snapshot size, open from
 * store, one keystroke through a real `EditorView`, a 100 KB paste, an external merge of a 1%
 * scattered change against 0.5% local edits, save (render + snapshot), undo of the last
 * keystroke, and the first undo after loading a fresh replica (Loro's documented first-undo
 * cost, isolated from the editor so it is not confused with `TextBinding`'s own work).
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, afterAll, describe, expect, it } from 'vitest'
import { loadavg } from 'node:os'
import { performance } from 'node:perf_hooks'
import { newDocId, randomActor, Replica, Rng, person, system, type ObjectId, type Origin } from '@/lib/kdm'
import { TextBinding } from './codeMirrorBinding'
import { applyEditsToString, mergeEdits, mergeExternalText, type TextEdit } from './documentMerge'
import { DOCUMENT_BODY, DOCUMENT_ROOT, documentSchema } from './documentSchema'
import { createDocumentReplica, documentBody, documentRootId, renderText, type LineStyle } from './documentText'

const RUN = process.env.KITION_DOC_BENCH === '1'
// Generous: this suite builds and round-trips documents of up to 5 MB several times over, and
// the host this runs on may be shared with other heavy jobs (see the printed load average), so a
// single measurement can occasionally take seconds rather than milliseconds.
const BENCH_TIMEOUT = 900_000

// Repeat counts: low for the expensive whole-document operations (import, open, merge, save) so
// the suite stays within reasonable time on a loaded machine; the task asks for 200 specifically
// for the keystroke, which is cheap enough to afford it.
const IMPORT_RUNS = 5
const OPEN_RUNS = 5
const KEYSTROKE_RUNS = 200
const PASTE_RUNS = 5
const MERGE_RUNS = 5
const SAVE_RUNS = 5
const UNDO_RUNS = 20

type Row = { size: string; measurement: string; value: string; budget: string }
const rows: Row[] = []

function addRow(size: string, measurement: string, value: string, budget: string) {
  rows.push({ size, measurement, value, budget })
}

function addTiming(size: string, measurement: string, ms: number, budget: string) {
  addRow(size, measurement, `${ms.toFixed(2)} ms`, budget)
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** The median wall-clock time of `action`, run `runs` times; `setup` prepares each run without
 *  being timed (so e.g. building a fresh replica before a "merge" measurement is excluded). */
function benchmark<T>(runs: number, setup: () => T, action: (context: T) => void): number {
  const samples: number[] = []
  for (let index = 0; index < runs; index += 1) {
    const context = setup()
    const start = performance.now()
    action(context)
    samples.push(performance.now() - start)
  }
  return median(samples)
}

function toMarkdownTable(data: readonly Row[]): string {
  const header = '| Document | Measurement | Result | Budget |'
  const divider = '| --- | --- | --- | --- |'
  const body = data.map((row) => `| ${row.size} | ${row.measurement} | ${row.value} | ${row.budget} |`)
  return [header, divider, ...body].join('\n')
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

// ---- Markdown construction: headings, prose with CJK and emoji, lists, GFM tables, code blocks,
// cycled until the text reaches the target size ----------------------------------------------

/** CJK text (U+62A5 U+544A), as a named constant: the repository keeps non-English text out of
 *  source files. Means "report". */
const REPORT = String.fromCodePoint(0x62a5, 0x544a)
/** CJK text (U+8BA1 U+5212), "plan". */
const PLAN = String.fromCodePoint(0x8ba1, 0x5212)
/** CJK text (U+56E2 U+961F), "team". */
const TEAM = String.fromCodePoint(0x56e2, 0x961f)

const EMOJIS = ['😀', '👍', '🎉', '✅', '📊'] as const

function heading(index: number): string {
  const level = (index % 3) + 1
  return `${'#'.repeat(level)} Section ${index} ${EMOJIS[index % EMOJIS.length]}`
}

function paragraph(index: number): string {
  return (
    `Paragraph ${index} covers the ${PLAN} and the ${REPORT} prepared by the ${TEAM} ${EMOJIS[(index + 1) % EMOJIS.length]}. ` +
    'It restates ordinary English sentences long enough to look like real document prose, mixing in ' +
    'short phrases so neither the diff nor the encoder sees one repeated line across the whole file.'
  )
}

function list(index: number): string {
  const items = Array.from({ length: 5 }, (_, i) => `- Item ${index}.${i}: a task for the ${TEAM} ${EMOJIS[(index + i) % EMOJIS.length]}`)
  return items.join('\n')
}

function table(index: number): string {
  const header = '| Name | Status | Owner |'
  const divider = '| --- | --- | --- |'
  const rows = Array.from({ length: 4 }, (_, i) => `| Row ${index}.${i} | ${REPORT} | ${TEAM} ${i} |`)
  return [header, divider, ...rows].join('\n')
}

function codeBlock(index: number): string {
  return ['```ts', `function step${index}(value: number): number {`, '  return value * 2 + 1', '}', '```'].join('\n')
}

/** Realistic Markdown of approximately `targetBytes` (UTF-8), cycling through the block kinds
 *  above. Byte size is tracked incrementally (one `TextEncoder` call per block) rather than
 *  re-encoding the whole growing buffer, so this stays linear even at 5 MB. */
function markdownOfSize(targetBytes: number): string {
  const title = '# Benchmark Document'
  const blocks: string[] = [title]
  let bytes = byteLength(title)
  let index = 0
  while (bytes < targetBytes) {
    const kind = index % 5
    const block = kind === 0 ? heading(index) : kind === 1 ? paragraph(index) : kind === 2 ? list(index) : kind === 3 ? table(index) : codeBlock(index)
    blocks.push(block)
    bytes += byteLength(block) + 2 // the blank line joining blocks
    index += 1
  }
  return `${blocks.join('\n\n')}\n`
}

// ---- A scattered text change: `fraction` of the text's characters replaced at random, non-
// overlapping positions (never splitting a surrogate pair), for the external-merge measurement --

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

function scatterEdits(text: string, fraction: number, seed: number): string {
  const rng = new Rng(seed)
  const targetChanged = Math.max(1, Math.floor(text.length * fraction))
  const editCount = Math.max(1, Math.floor(targetChanged / 1.5)) // edits replace 1-2 characters each
  const positions = new Set<number>()
  while (positions.size < editCount && positions.size < text.length) positions.add(rng.below(text.length))
  const edits: TextEdit[] = []
  for (let from of [...positions].sort((a, b) => a - b)) {
    if (isLowSurrogate(text.charCodeAt(from))) from += 1
    if (from >= text.length) continue
    const last = edits[edits.length - 1]
    if (last && from < last.to) continue
    let to = Math.min(text.length, from + 1 + rng.below(2))
    if (to < text.length && isHighSurrogate(text.charCodeAt(to - 1))) to += 1
    edits.push({ from, to, insert: 'Z' })
  }
  return applyEditsToString(text, edits)
}

// ---- An `EditorView` bound to a fresh replica through `TextBinding`, like the app's editor -----

type Mounted = { replica: Replica; rootId: ObjectId; binding: TextBinding; view: EditorView }

function mountEditor(markdown: string): Mounted {
  const { replica, rootId } = createDocumentReplica(markdown, randomActor())
  const binding = new TextBinding(replica, rootId, DOCUMENT_BODY, person('bench:doc'))
  const view = new EditorView({ state: EditorState.create({ doc: markdown, extensions: [binding.extension] }), parent: document.body })
  return { replica, rootId, binding, view }
}

function unmountEditor(mounted: Mounted): void {
  mounted.binding.dispose()
  mounted.view.destroy()
}

// ---- The budgeted measurements, run on every document size ----------------------------------

function measureImport(markdown: string): number {
  return benchmark(IMPORT_RUNS, () => undefined, () => {
    createDocumentReplica(markdown, randomActor())
  })
}

function measureOpen(snapshotBytes: Uint8Array): number {
  return benchmark(OPEN_RUNS, () => undefined, () => {
    const loaded = Replica.load(documentSchema, snapshotBytes, randomActor())
    const rootId = documentRootId(loaded)
    documentBody(loaded, rootId)
  })
}

/** One keystroke, dispatched through CodeMirror: `TextBinding.pushLocal` publishes it to the
 *  replica synchronously inside the same `view.dispatch` call, so this times both updates. */
function measureKeystroke(markdown: string): number {
  const mounted = mountEditor(markdown)
  try {
    let position = Math.floor(markdown.length / 2)
    return benchmark(
      KEYSTROKE_RUNS,
      () => {
        const at = position
        position += 1
        return at
      },
      (at) => {
        mounted.view.dispatch({ changes: { from: at, insert: 'x' }, userEvent: 'input.type' })
      },
    )
  } finally {
    unmountEditor(mounted)
  }
}

function measurePaste(markdown: string, pasteText: string): number {
  const mounted = mountEditor(markdown)
  try {
    let position = Math.floor(markdown.length / 2)
    return benchmark(
      PASTE_RUNS,
      () => {
        const at = position
        position += pasteText.length
        return at
      },
      (at) => {
        mounted.view.dispatch({ changes: { from: at, insert: pasteText }, userEvent: 'input.paste' })
      },
    )
  } finally {
    unmountEditor(mounted)
  }
}

const EXTERNAL_MERGE_ORIGIN: Origin = { kind: 'import', principal: 'bench:file' }

/** The external merge, whole (diff, merge, and the replica transaction) and its diff and merge alone, with the number of edits. */
function measureMerge(markdown: string): { whole: number; diff: number; edits: number } {
  const base = markdown
  const current = scatterEdits(base, 0.005, 1001)
  const incoming = scatterEdits(base, 0.01, 2002)
  const whole = benchmark(
    MERGE_RUNS,
    () => createDocumentReplica(current, randomActor()),
    ({ replica, rootId }) => {
      replica.transact(EXTERNAL_MERGE_ORIGIN, (tx) => mergeExternalText(tx, rootId, base, incoming, current))
    },
  )
  let edits = 0
  const diff = benchmark(MERGE_RUNS, () => undefined, () => {
    edits = mergeEdits(base, incoming, current).length
  })
  return { whole, diff, edits }
}

const DELETE_COUNT = 500

/** A replica holding `markdown` inserted in one piece, as `createDocumentReplica` did before it wrote the body in pieces. */
function singleInsertReplica(markdown: string): { replica: Replica; rootId: ObjectId } {
  const { replica, result: rootId } = Replica.createWith(documentSchema, newDocId(), randomActor(), system('create'), (tx) => {
    const id = tx.create(DOCUMENT_ROOT, {})
    tx.textInsert(id, DOCUMENT_BODY, 0, markdown)
    return id
  })
  return { replica, rootId }
}

/** `DELETE_COUNT` one-character deletes at line starts spread over the text, in one transaction (last first, so positions stay put). */
function measureDeletes(markdown: string, build: (markdown: string) => { replica: Replica; rootId: ObjectId }): number {
  const positions: number[] = []
  for (let index = 0; index < DELETE_COUNT; index += 1) positions.push(markdown.lastIndexOf('\n', Math.floor(((index + 0.5) / DELETE_COUNT) * markdown.length)) + 1)
  return benchmark(1, () => build(markdown), ({ replica, rootId }) => {
    replica.transact(person('bench:delete'), (tx) => {
      for (let index = positions.length - 1; index >= 0; index -= 1) tx.textDelete(rootId, DOCUMENT_BODY, positions[index], 1)
    })
  })
}

function measureSave(replica: Replica, rootId: ObjectId, style: LineStyle): number {
  return benchmark(SAVE_RUNS, () => undefined, () => {
    renderText(documentBody(replica, rootId), style)
    replica.snapshot()
  })
}

/** Undo of the last keystroke: `replica.undo()` is called directly (not through CodeMirror), and
 *  the bound editor picks up the change through `TextBinding`'s subscription, synchronously. */
function measureUndo(markdown: string): number {
  const mounted = mountEditor(markdown)
  try {
    const position = Math.floor(markdown.length / 2)
    return benchmark(
      UNDO_RUNS,
      () => {
        mounted.view.dispatch({ changes: { from: position, insert: 'x' }, userEvent: 'input.type' })
      },
      () => {
        mounted.replica.undo()
      },
    )
  } finally {
    unmountEditor(mounted)
  }
}

/** The first `undo()` call on a freshly loaded replica, and a second (warm) one on the same
 *  replica for comparison — Loro's `UndoManager` is known to pay extra setup cost on the first
 *  undo after a document loads. Measured on the replica alone (no editor), to isolate the
 *  engine's cost from `TextBinding`'s. Single samples, not medians: "first" happens once. */
function measureFirstAndSecondUndo(snapshotBytes: Uint8Array): { first: number; second: number } {
  const loaded = Replica.load(documentSchema, snapshotBytes, randomActor())
  const rootId = documentRootId(loaded)
  const length = loaded.textLength(rootId, DOCUMENT_BODY)
  loaded.transact(person('bench:undo-a'), (tx) => tx.textInsert(rootId, DOCUMENT_BODY, length, 'a'))
  loaded.transact(person('bench:undo-b'), (tx) => tx.textInsert(rootId, DOCUMENT_BODY, length + 1, 'b'))
  const firstStart = performance.now()
  loaded.undo()
  const first = performance.now() - firstStart
  const secondStart = performance.now()
  loaded.undo()
  const second = performance.now() - secondStart
  return { first, second }
}

function measureDocument(label: string, targetBytes: number): void {
  const markdown = markdownOfSize(targetBytes)
  addRow(label, 'markdown size', kb(byteLength(markdown)), '–')

  addTiming(label, 'createDocumentReplica (import)', measureImport(markdown), '–')

  const { replica: sourceReplica, rootId, style } = createDocumentReplica(markdown, randomActor())
  const snapshotBytes = sourceReplica.snapshot()
  addRow(label, 'snapshot size', kb(snapshotBytes.length), '–')

  addTiming(label, 'Replica.load + first read (open from store)', measureOpen(snapshotBytes), '–')
  addTiming(label, 'keystroke → replica + editor update', measureKeystroke(markdown), '< 16 ms')

  const pasteText = markdownOfSize(100_000)
  addTiming(label, '100 KB paste', measurePaste(markdown, pasteText), '–')
  addTiming(label, `${DELETE_COUNT} scattered deletes, body in pieces (createDocumentReplica)`, measureDeletes(markdown, (text) => createDocumentReplica(text, randomActor())), '–')
  addTiming(label, `${DELETE_COUNT} scattered deletes, body in one insertion (before)`, measureDeletes(markdown, singleInsertReplica), '–')
  const merge = measureMerge(markdown)
  addTiming(label, 'mergeExternalText (1% external, 0.5% local)', merge.whole, '–')
  addTiming(label, `mergeEdits alone (diff + merge, ${merge.edits} edits)`, merge.diff, label === '1 MB' ? '< 100 ms' : label === '5 MB' ? '< 500 ms' : '–')
  addTiming(label, 'renderText + snapshot() (save)', measureSave(sourceReplica, rootId, style), '< 300 ms')
  addTiming(label, 'undo of the last keystroke', measureUndo(markdown), '–')

  const { first, second } = measureFirstAndSecondUndo(snapshotBytes)
  addTiming(label, 'first undo after load (single sample)', first, '–')
  addTiming(label, 'second undo after load (single sample, warm)', second, '–')
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove()
})

describe.skipIf(!RUN)('document KDM performance (Phase 2c Task 8)', () => {
  it('measures a 100 KB document', () => {
    measureDocument('100 KB', 100_000)
    expect(rows.length).toBeGreaterThan(0)
  }, BENCH_TIMEOUT)

  it('measures a 1 MB document', () => {
    measureDocument('1 MB', 1_000_000)
    expect(rows.length).toBeGreaterThan(0)
  }, BENCH_TIMEOUT)

  it('measures a 5 MB document', () => {
    measureDocument('5 MB', 5_000_000)
    expect(rows.length).toBeGreaterThan(0)
  }, BENCH_TIMEOUT)

  afterAll(() => {
    const [load1, load5, load15] = loadavg()
    // eslint-disable-next-line no-console -- the report this task asks for is this printed table.
    console.log(`\nLoad average (1m, 5m, 15m): ${load1.toFixed(2)}, ${load5.toFixed(2)}, ${load15.toFixed(2)}\n`)
    // eslint-disable-next-line no-console -- same as above.
    console.log(`${toMarkdownTable(rows)}\n`)
  })
})
