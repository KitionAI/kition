/**
 * Performance measurement of the whiteboard KDM on large boards (Phase 2a, Task 10). Skipped
 * unless `KITION_BOARD_BENCH=1`: this is a manual benchmark, not a correctness test, and its
 * timings vary with the machine, so it only asserts that it ran — the budgets below are reported
 * in the printed table, not enforced. Run it with:
 *
 *   KITION_BOARD_BENCH=1 pnpm vitest run --config tooling/vitest.config.ts \
 *     src/features/whiteboard/kdm/boardKdm.bench.spec.ts
 *
 * Each board is mixed rectangles with labels (~70%), connectors bound to two rectangles each
 * (~20%), and 50-point strokes (~10%), spread over a main page plus a 100-element second page.
 * The 5,000-element board gets the full set of measurements; the 1,000- and 10,000-element
 * boards get open/drag/undo/encode only, so the suite finishes in reasonable time.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { loadavg } from 'node:os'
import { performance } from 'node:perf_hooks'
import { randomActor, type Replica } from '@/lib/kdm'
import { createBoardFromRecords, decodeBoardFile, encodeBoardFile } from './boardKdmFile'
import { readBoardRecords } from './boardKdmRead'
import { BoardStore } from '../lib/boardStore'
import {
  createBoardElementRecord,
  type BoardBindingRecord,
  type BoardElementRecord,
  type BoardPageRecord,
  type BoardRecord,
} from '../lib/boardRecords'
import type { WhiteboardElement } from '../lib/whiteboardTypes'

const RUN = process.env.KITION_BOARD_BENCH === '1'
// Generous: this suite builds and round-trips boards of up to 10,000 elements several times
// over, and the host this runs on may be shared with other heavy jobs (see the printed load
// average), so a single measurement can occasionally take seconds rather than milliseconds.
const BENCH_TIMEOUT = 900_000

// Repeat counts: low for the expensive whole-board operations (decode, store construction,
// encode, reorder) so the suite stays within reasonable time on a loaded machine; the plan asks
// for 100 specifically for the drag commit, which is cheap enough to afford it.
const WHOLE_BOARD_RUNS = 3
const PER_COMMAND_RUNS = 8
const DRAG_RUNS = 100
const SQUASH_GESTURE_RUNS = 3

type Row = { board: string; measurement: string; value: string; budget: string }
const rows: Row[] = []

function addRow(board: string, measurement: string, value: string, budget: string) {
  rows.push({ board, measurement, value, budget })
}

function addTiming(board: string, measurement: string, ms: number, budget: string) {
  addRow(board, measurement, `${ms.toFixed(2)} ms`, budget)
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** The median wall-clock time of `action`, run `runs` times; `setup` prepares each run without
 *  being timed (so e.g. a decode before a "store construction" measurement is excluded). */
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
  const header = '| Board | Measurement | Result | Budget |'
  const divider = '| --- | --- | --- | --- |'
  const body = data.map((row) => `| ${row.board} | ${row.measurement} | ${row.value} | ${row.budget} |`)
  return [header, divider, ...body].join('\n')
}

function boardLabel(size: number): string {
  return `${size.toLocaleString('en-US')} elements`
}

function fileSizeKb(text: string): number {
  return new TextEncoder().encode(text).length / 1024
}

// ---- board construction: ~70% rectangles with labels, ~20% connectors bound to two rectangles,
// ~10% 50-point strokes, on a main page plus a 100-element second page ------------------------

const STYLE = { strokeColor: 'ink', fillColor: 'white', opacity: 1, fillStyle: 'solid', dashStyle: 'solid', strokeSize: 'm' } as const

function rectangleAt(id: string, index: number, pageId: string): BoardElementRecord {
  const column = index % 50
  const row = Math.floor(index / 50)
  return createBoardElementRecord({
    element: {
      id,
      kind: 'rectangle',
      x: column * 160,
      y: row * 140,
      width: 140,
      height: 100,
      text: `Rectangle ${id} — a label long enough to look like real board content`,
      style: { ...STYLE },
    } as WhiteboardElement,
    index,
    pageId,
  })
}

function strokeAt(id: string, index: number, pageId: string): BoardElementRecord {
  const points = Array.from({ length: 50 }, (_, p) => ({
    x: Math.round(Math.sin(p / 4) * 60 + p * 3),
    y: Math.round(Math.cos(p / 4) * 60),
  }))
  return createBoardElementRecord({ element: { id, kind: 'stroke', points } as WhiteboardElement, index, pageId })
}

function connectorAt(id: string, index: number, pageId: string): BoardElementRecord {
  return createBoardElementRecord({
    element: { id, kind: 'connector', start: { x: 0, y: 0 }, end: { x: 160, y: 100 }, connectorType: 'straight' } as WhiteboardElement,
    index,
    pageId,
  })
}

/** One page's elements in the plan's mix, with connectors bound at both ends to a rectangle on
 *  the same page (skipped when the page has no rectangles). */
function pageOfElements(pageId: string, prefix: string, count: number): { elements: BoardElementRecord[]; bindings: BoardBindingRecord[] } {
  const strokeCount = Math.round(count * 0.1)
  const connectorCount = Math.round(count * 0.2)
  const rectangleCount = Math.max(0, count - strokeCount - connectorCount)
  const elements: BoardElementRecord[] = []
  const rectangleIds: string[] = []
  let index = 0
  for (let i = 0; i < rectangleCount; i += 1, index += 1) {
    const id = `${prefix}r${i}`
    rectangleIds.push(id)
    elements.push(rectangleAt(id, index, pageId))
  }
  const bindings: BoardBindingRecord[] = []
  for (let i = 0; i < connectorCount; i += 1, index += 1) {
    const id = `${prefix}c${i}`
    elements.push(connectorAt(id, index, pageId))
    if (rectangleIds.length > 0) {
      const from = rectangleIds[i % rectangleIds.length]
      const to = rectangleIds[(i + 1) % rectangleIds.length]
      bindings.push({ record_type: 'binding', id: `binding:${id}:start`, binding_type: 'connector', from_id: id, to_id: from, terminal: 'start' })
      bindings.push({ record_type: 'binding', id: `binding:${id}:end`, binding_type: 'connector', from_id: id, to_id: to, terminal: 'end' })
    }
  }
  for (let i = 0; i < strokeCount; i += 1, index += 1) elements.push(strokeAt(`${prefix}s${i}`, index, pageId))
  return { elements, bindings }
}

/** Board records for a board of `totalElements`: a main page and a 100-element second page. */
function boardRecordsOfSize(totalElements: number): BoardRecord[] {
  const secondPageCount = Math.min(100, totalElements)
  const mainPageCount = totalElements - secondPageCount
  const pages: BoardPageRecord[] = [
    { record_type: 'page', id: 'page:main', name: 'Main', index: 0 },
    { record_type: 'page', id: 'page:second', name: 'Second', index: 1 },
  ]
  const main = pageOfElements('page:main', 'm', mainPageCount)
  const second = pageOfElements('page:second', 's', secondPageCount)
  return [...pages, ...main.elements, ...second.elements, ...main.bindings, ...second.bindings]
}

/** Moves the element with the highest `index` on the store's current page to the front (`index`
 *  0), shifting the rest back by one — the real cost of "bring to front" on a large page. */
function moveBackToFront(store: BoardStore) {
  const pageId = store.getCurrentPageId()
  const onPage = store.getRecords()
    .filter((record): record is BoardElementRecord => record.record_type === 'element' && record.page_id === pageId)
    .sort((a, b) => a.index - b.index)
  if (onPage.length < 2) return
  const last = onPage[onPage.length - 1]
  store.transact('reorder', (tx) => {
    tx.put({ ...last, index: 0 } as BoardElementRecord)
    for (const record of onPage.slice(0, -1)) tx.put({ ...record, index: record.index + 1 } as BoardElementRecord)
  })
}

// ---- the four budgeted measurements, run on every board size --------------------------------

function measureCore(size: number) {
  const label = boardLabel(size)
  const records = boardRecordsOfSize(size)
  const sourceReplica = createBoardFromRecords('Board', randomActor(), records)
  const text = encodeBoardFile(sourceReplica)
  addRow(label, 'file size', `${fileSizeKb(text).toFixed(1)} KB`, '–')

  const freshReplica = (): Replica => {
    const decoded = decodeBoardFile(text, randomActor())
    if (decoded.kind !== 'board') throw new Error(`expected a board, got ${decoded.reason}`)
    return decoded.replica
  }

  const openReadMs = benchmark(WHOLE_BOARD_RUNS, () => undefined, () => {
    const decoded = decodeBoardFile(text, randomActor())
    if (decoded.kind !== 'board') throw new Error(`expected a board, got ${decoded.reason}`)
    readBoardRecords(decoded.replica)
  })
  addTiming(label, 'decode + first read', openReadMs, '< 1,500 ms')

  const dragStore = new BoardStore(freshReplica())
  const dragMs = benchmark(DRAG_RUNS, () => undefined, () => {
    const live = dragStore.beginTransaction('move', { live: true })
    for (let step = 0; step < 20; step += 1) {
      const current = live.get('mr0') as BoardElementRecord & { x: number; y: number }
      live.put({ ...current, x: current.x + 1, y: current.y + 0.5 } as BoardElementRecord)
    }
    live.commit()
  })
  addTiming(label, 'drag commit (20 live updates)', dragMs, '< 16 ms')

  const undoStore = new BoardStore(freshReplica())
  for (let i = 0; i < PER_COMMAND_RUNS; i += 1) {
    const id = `bench-undo-${size}-${i}`
    undoStore.transact('add', (tx) => tx.put(rectangleAt(id, undoStore.getNextElementIndex(), undoStore.getCurrentPageId())))
  }
  const undoMs = benchmark(PER_COMMAND_RUNS, () => undefined, () => { undoStore.undo() })
  addTiming(label, 'undo + view rebuild', undoMs, '< 100 ms')

  const encodeMs = benchmark(WHOLE_BOARD_RUNS, () => undefined, () => { encodeBoardFile(sourceReplica) })
  addTiming(label, 'encodeBoardFile', encodeMs, '< 3,000 ms')

  return { freshReplica }
}

// ---- the rest of the suite, run only on the 5,000-element board -----------------------------

function measureFull(size: number, freshReplica: () => Replica) {
  const label = boardLabel(size)

  const constructMs = benchmark(WHOLE_BOARD_RUNS, () => freshReplica(), (replica) => { new BoardStore(replica) })
  addTiming(label, 'store construction (from a decoded replica)', constructMs, '–')

  const textStore = new BoardStore(freshReplica())
  let toggle = false
  const textMs = benchmark(PER_COMMAND_RUNS, () => undefined, () => {
    toggle = !toggle
    const current = textStore.getElementRecord('mr0')!
    textStore.transact('edit text', (tx) => tx.put({ ...current, text: toggle ? 'Edited label — variant A' : 'Edited label — variant B' } as BoardElementRecord))
  })
  addTiming(label, 'text edit commit', textMs, '–')

  const addStore = new BoardStore(freshReplica())
  let addCounter = 0
  const addMs = benchmark(PER_COMMAND_RUNS, () => undefined, () => {
    addCounter += 1
    const id = `bench-add-${size}-${addCounter}`
    addStore.transact('add', (tx) => tx.put(rectangleAt(id, addStore.getNextElementIndex(), addStore.getCurrentPageId())))
  })
  addTiming(label, 'add one element', addMs, '–')

  const deleteStore = new BoardStore(freshReplica())
  const deleteIds: string[] = []
  for (let i = 0; i < PER_COMMAND_RUNS; i += 1) {
    const id = `bench-del-${size}-${i}`
    deleteStore.transact('add', (tx) => tx.put(rectangleAt(id, deleteStore.getNextElementIndex(), deleteStore.getCurrentPageId())))
    deleteIds.push(id)
  }
  let deleteIndex = 0
  const deleteMs = benchmark(PER_COMMAND_RUNS, () => undefined, () => {
    const id = deleteIds[deleteIndex]
    deleteIndex += 1
    deleteStore.transact('delete', (tx) => tx.remove(id))
  })
  addTiming(label, 'delete one element', deleteMs, '–')

  const reorderStore = new BoardStore(freshReplica())
  const reorderMs = benchmark(WHOLE_BOARD_RUNS, () => undefined, () => moveBackToFront(reorderStore))
  addTiming(label, 'reorder one element to front', reorderMs, '–')

  const redoStore = new BoardStore(freshReplica())
  for (let i = 0; i < PER_COMMAND_RUNS; i += 1) {
    const id = `bench-redo-${size}-${i}`
    redoStore.transact('add', (tx) => tx.put(rectangleAt(id, redoStore.getNextElementIndex(), redoStore.getCurrentPageId())))
  }
  for (let i = 0; i < PER_COMMAND_RUNS; i += 1) redoStore.undo()
  const redoMs = benchmark(PER_COMMAND_RUNS, () => undefined, () => { redoStore.redo() })
  addTiming(label, 'redo', redoMs, '–')

  const squashStore = new BoardStore(freshReplica())
  let squashCounter = 0
  const squashMs = benchmark(
    SQUASH_GESTURE_RUNS,
    () => {
      const mark = squashStore.markHistory()
      for (let i = 0; i < 10; i += 1) {
        squashCounter += 1
        const id = `bench-squash-${size}-${squashCounter}`
        squashStore.transact('step', (tx) => tx.put(rectangleAt(id, squashStore.getNextElementIndex(), squashStore.getCurrentPageId())))
      }
      return mark
    },
    (mark) => { squashStore.squashToMark(mark, 'Add ten') },
  )
  addTiming(label, 'marked 10-command gesture squashed', squashMs, '–')
}

describe.skipIf(!RUN)('whiteboard KDM performance (Phase 2a Task 10)', () => {
  it('measures a 5,000-element board: open, drag, undo, encode, and the rest', () => {
    const { freshReplica } = measureCore(5000)
    measureFull(5000, freshReplica)
    expect(rows.length).toBeGreaterThan(0)
  }, BENCH_TIMEOUT)

  it('measures a 1,000-element board: open, drag, undo, encode', () => {
    measureCore(1000)
    expect(rows.length).toBeGreaterThan(0)
  }, BENCH_TIMEOUT)

  it('measures a 10,000-element board: open, drag, undo, encode', () => {
    measureCore(10000)
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
