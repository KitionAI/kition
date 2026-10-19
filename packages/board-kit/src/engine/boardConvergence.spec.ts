/**
 * The Board kit's convergence suite (standard 2.0 section 11, L6): kition-sdk's TypeScript runner
 * (`@kition/convergence`, carried as src/lib/convergence) drives replicas of `BoardDocument`
 * through the board's own commands and the contract 2 replica members. The probe is the first
 * plain rectangle of the first page; its label is the text the suite types into (an element's
 * `text` is a KDM text field, and its lines are its paragraphs). Frames nest through the
 * `parent` reference, so reparent swaps two frames, and the view check holds the board's own
 * invariants: no hierarchy cycle and no binding to a missing element, in the view and in the state.
 *
 * `KITION_CONVERGENCE_REPORT=<file>` writes the report for `check-manifest.mjs --convergence`;
 * `KITION_CONVERGENCE_SEEDS` and `KITION_CONVERGENCE_STEPS` make the fuzzed runs heavier.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { kitEngineClass } from '@kition/kit-engine'
import { canonicalText, randomActor, Replica } from '@kition/kdm'
import { BoardStore, boardSchema, createBoardElementRecord, createBoardFromRecords, createBoardRecordsFromElements } from '@kition/board-editor/model'
import type { WhiteboardElement } from '@kition/board-editor'
import { getBoardConnectorAnchorAt } from '@kition/board-editor/lib/boardBindingEngine'
import { isBoardContainerElement } from '@kition/board-editor/lib/boardHierarchy'
import { boardElementFromRecord, type BoardElementRecord, type BoardRecord } from '@kition/board-editor/lib/boardRecords'
import { KitEngineAdapter, optionsFromEnv, run, runOne, type EngineDocument, type Rng, type Script } from '../../../../src/lib/convergence'
import { boardModel, type BoardView } from './boardModel'

/**
 * Ids and actors from counters that `create` restarts, so a failing seed replays the same run (the
 * board's own commands still make random ids where they copy elements, as in a duplicated page).
 */
const counters = { id: 0, actor: 0n }
const newObjectId = () => {
  counters.id += 1
  return `e${counters.id}`
}
const nextActor = () => {
  counters.actor += 1n
  return counters.actor
}

const BoardDocument = kitEngineClass(boardModel, { actor: nextActor })
const SCHEMA = readFileSync(path.join(__dirname, '../../model/schema.json'), 'utf8')

type Doc = EngineDocument<BoardView>
type Rectangle = Extract<WhiteboardElement, { kind: 'rectangle' }>
type Connector = Extract<WhiteboardElement, { kind: 'connector' }>

const rectangle = (id: string, x: number, y: number, text: string, extra: Partial<Rectangle> = {}): Rectangle => ({
  id,
  kind: 'rectangle',
  x,
  y,
  width: 160,
  height: 100,
  text,
  shapeType: 'rectangle',
  shapeStyle: 'sticky',
  ...extra,
})

const frame = (id: string, x: number, y: number): Rectangle => rectangle(id, x, y, '', { width: 400, height: 300, shapeType: 'frame', shapeStyle: 'frame' })

/** The board every scenario starts from: two notes, a label, two frames, a connector between the notes, and a second page. */
function startingRecords(): BoardRecord[] {
  const connector: Connector = { id: 'link', kind: 'connector', start: { x: 160, y: 50 }, end: { x: 240, y: 50 }, connectorType: 'straight', endArrowhead: 'arrow' }
  const records = createBoardRecordsFromElements([
    rectangle('note-1', 0, 0, 'hello'),
    rectangle('note-2', 240, 0, 'world'),
    { id: 'label', kind: 'text', x: 0, y: 200, text: 'notes' },
    frame('frame-a', 0, 400),
    frame('frame-b', 500, 400),
    connector,
  ])
  records.push(
    { record_type: 'binding', id: 'binding:link:start', binding_type: 'connector', from_id: 'link', to_id: 'note-1', terminal: 'start', to_anchor: { x: 1, y: 0.5 } },
    { record_type: 'binding', id: 'binding:link:end', binding_type: 'connector', from_id: 'link', to_id: 'note-2', terminal: 'end', to_anchor: { x: 0, y: 0.5 } },
    { record_type: 'page', id: 'page-2', name: 'Later', index: 1 },
    createBoardElementRecord({ element: rectangle('later-1', 0, 0, 'later'), index: 0, pageId: 'page-2' }),
  )
  return records
}

const store = (doc: Doc) => doc.session.view.store
const elementRecords = (doc: Doc) => store(doc).getRecords().filter((record): record is BoardElementRecord => record.record_type === 'element')

/** The elements of the first page, in order. */
function firstPageElements(doc: Doc): BoardElementRecord[] {
  const first = store(doc).getPages().sort((a, b) => a.index - b.index)[0]
  return elementRecords(doc).filter((record) => record.page_id === first?.id).sort((a, b) => a.index - b.index)
}

/** The elements of the page the replica shows (where element commands act). */
const shownElements = (doc: Doc) => store(doc).getCurrentPageElements()

const isNote = (element: WhiteboardElement): element is Rectangle => element.kind === 'rectangle' && !isBoardContainerElement(element)

/** The probe: the first plain rectangle of the first page. */
function probe(doc: Doc): Rectangle | null {
  const record = firstPageElements(doc).map(boardElementFromRecord).find(isNote)
  return record ?? null
}

/** Code point `at` of `text` as a UTF-16 index. */
const unitIndex = (text: string, at: number) => Array.from(text).slice(0, at).join('').length

function withText(text: string, at: number, removed: number, inserted: string) {
  const chars = Array.from(text)
  chars.splice(at, removed, inserted)
  return chars.join('')
}

/** Records as a view check compares them: without the meta record (view state). */
const comparable = (records: readonly BoardRecord[]) => records.filter((record) => record.record_type !== 'meta')

/** A path to `id` through `parent` that comes back to it, or `null`. */
function cycleThrough(id: string, parentOf: (id: string) => string | null | undefined): string[] | null {
  const seen = [id]
  for (let parent = parentOf(id); parent; parent = parentOf(parent)) {
    if (parent === id) return [...seen, parent]
    if (seen.includes(parent)) return null
    seen.push(parent)
  }
  return null
}

class BoardKit extends KitEngineAdapter<BoardView> {
  constructor() {
    super({ name: 'kit.board', schema: SCHEMA, model: boardModel, documentClass: BoardDocument, actor: nextActor, fileName: 'Board.kiboard' })
  }

  create(): Doc {
    counters.id = 0
    counters.actor = 0n
    return this.open(createBoardFromRecords('Board', this.newActor(), startingRecords()))
  }

  private update(doc: Doc, element: WhiteboardElement) {
    this.run(doc, 'element.update', { elements: [element] })
  }

  /** Replaces the probe's label with `text`. */
  private retext(doc: Doc, edit: (text: string) => string): boolean {
    const target = probe(doc)
    if (!target) throw new Error('the board has no note to type into')
    this.update(doc, { ...target, text: edit(target.text ?? '') })
    return true
  }

  override script(doc: Doc, step: Script): boolean {
    switch (step.kind) {
      case 'SetField': {
        const target = probe(doc)
        // A fuzzed board can lose every note: the step then adds one, which is an edit too.
        if (!target) return this.script(doc, { kind: 'Create' })
        this.update(doc, step.slot === 0 ? { ...target, x: step.value } : { ...target, y: step.value })
        return true
      }
      case 'Create':
        this.run(doc, 'element.create', { elements: [rectangle(newObjectId(), 40, 40, 'new')] })
        return true
      case 'Delete': {
        const target = probe(doc)
        if (target) this.run(doc, 'element.delete', { elementIds: [target.id] })
        return true
      }
      case 'Duplicate': {
        const target = probe(doc)
        if (target) this.run(doc, 'element.paste', { elements: [{ ...target, id: newObjectId(), x: target.x + 20, locked: false }], bindings: [] })
        return true
      }
      case 'Reorder': {
        const elements = firstPageElements(doc)
        const target = elements[step.which % Math.max(elements.length, 1)]
        if (target) this.run(doc, 'element.reorder', { elementIds: [target.id], placement: 'front' })
        return true
      }
      case 'Reparent': {
        const frames = firstPageElements(doc).map(boardElementFromRecord).filter(isBoardContainerElement)
        if (frames.length < 2) return true
        const [child, parent] = step.which === 0 ? [frames[0], frames[1]] : [frames[1], frames[0]]
        this.update(doc, { ...child, parentId: parent.id })
        return true
      }
      case 'InsertText':
        return this.retext(doc, (text) => withText(text, step.at, 0, step.text))
      case 'DeleteText':
        return this.retext(doc, (text) => withText(text, step.at, step.len, ''))
      case 'SplitParagraph':
        return this.retext(doc, (text) => withText(text, step.at, 0, '\n'))
      case 'MergeParagraph':
        return this.retext(doc, (text) => {
          if (Array.from(text)[step.at] !== '\n') throw new Error(`no paragraph break at ${step.at} of ${JSON.stringify(text)}`)
          return withText(text, step.at, 1, '')
        })
      default:
        // An image element names a workspace file rather than a blob: the board has no blob fields.
        return false
    }
  }

  text(doc: Doc): string {
    return probe(doc)?.text ?? ''
  }

  /** One command from the board's catalogue, with random parameters; `null` when it has nothing to act on. */
  randomEdit(doc: Doc, rng: Rng): string | null {
    const elements = shownElements(doc)
    const pages = store(doc).getPages().sort((a, b) => a.index - b.index)
    const any = rng.pick(elements)
    const value = rng.below(1000)
    // On an empty page the element commands have nothing to act on: add one, as a person would.
    const command = elements.length === 0 ? 0 : rng.below(18)
    switch (command) {
      case 0: {
        const kind = rng.below(3)
        const element: WhiteboardElement = kind === 0
          ? rectangle(newObjectId(), value, value / 2, `n${value}`)
          : kind === 1
            ? { id: newObjectId(), kind: 'text', x: value, y: 20, text: `t${value}` }
            : { id: newObjectId(), kind: 'stroke', points: [{ x: 0, y: 0 }, { x: value, y: 10 }] }
        this.run(doc, 'element.create', { elements: [element] })
        return 'element.create'
      }
      case 1: {
        if (!any || any.kind === 'connector' || any.kind === 'stroke') return null
        this.update(doc, { ...any, x: value, y: rng.below(1000) })
        return 'element.update move'
      }
      case 2: {
        const target = rng.pick(elements.filter((element) => element.kind === 'rectangle' || element.kind === 'text'))
        if (!target || (target.kind !== 'rectangle' && target.kind !== 'text')) return null
        const text = target.text ?? ''
        const at = rng.below(Array.from(text).length + 1)
        const removed = rng.chance(30) ? rng.below(3) : 0
        this.update(doc, { ...target, text: withText(text, at, removed, rng.chance(20) ? '\n' : `w${value}`) } as WhiteboardElement)
        return 'element.update text'
      }
      case 3: {
        if (!any) return null
        const colors = ['red', 'blue', 'green', 'yellow'] as const
        this.update(doc, { ...any, style: { ...any.style, fillColor: colors[value % colors.length] } })
        return 'element.update style'
      }
      case 4: {
        if (!any || elements.length < 2) return null
        this.run(doc, 'element.delete', { elementIds: [any.id] })
        return 'element.delete'
      }
      case 5: {
        if (!any) return null
        const placements = ['front', 'forward', 'backward', 'back'] as const
        this.run(doc, 'element.reorder', { elementIds: [any.id], placement: placements[value % placements.length] })
        return 'element.reorder'
      }
      case 6: {
        const ends = elements.filter((element) => element.kind !== 'connector' && element.kind !== 'stroke')
        const from = rng.pick(ends)
        const to = rng.pick(ends)
        if (!from || !to || from.id === to.id) return null
        const start = getBoardConnectorAnchorAt(from, { x: 1, y: 0.5 })
        const end = getBoardConnectorAnchorAt(to, { x: 0, y: 0.5 })
        if (!start || !end) return null
        const connector: Connector = { id: newObjectId(), kind: 'connector', start: start.point, end: end.point, connectorType: 'straight' }
        this.run(doc, 'connector.create', { element: connector, bindings: [{ anchor: start, terminal: 'start' }, { anchor: end, terminal: 'end' }] })
        return 'connector.create'
      }
      case 7: {
        const connector = rng.pick(elements.filter((element) => element.kind === 'connector'))
        if (!connector) return null
        const terminal = rng.chance(50) ? 'start' : 'end'
        const target = rng.pick(elements.filter((element) => element.kind !== 'connector' && element.kind !== 'stroke'))
        const binding = rng.chance(50) && target ? getBoardConnectorAnchorAt(target, { x: 0.5, y: 0 }) : null
        this.run(doc, 'connector.update-terminal', { connectorId: connector.id, terminal, point: binding?.point ?? { x: value, y: value }, ...(binding ? { binding } : {}) })
        return 'connector.update-terminal'
      }
      case 8: {
        if (!any) return null
        this.run(doc, 'element.paste', { elements: [{ ...any, id: newObjectId(), parentId: undefined, locked: false }], bindings: [] })
        return 'element.paste'
      }
      case 9: {
        const roots = elements.filter((element) => !element.parentId && element.kind !== 'connector')
        const first = rng.pick(roots)
        const second = rng.pick(roots)
        if (!first) return null
        const ids = second && second.id !== first.id ? [first.id, second.id] : [first.id]
        this.run(doc, 'element.group', { containerId: newObjectId(), containerKind: ids.length > 1 && rng.chance(50) ? 'group' : 'frame', elementIds: ids })
        return 'element.group'
      }
      case 10: {
        const container = rng.pick(elements.filter(isBoardContainerElement))
        if (!container) return null
        this.run(doc, 'element.ungroup', { containerIds: [container.id] })
        return 'element.ungroup'
      }
      case 11: {
        const child = rng.pick(elements.filter((element) => element.kind !== 'connector'))
        const parent = rng.pick(elements.filter((element) => isBoardContainerElement(element)))
        if (!child || !parent || child.id === parent.id) return null
        this.update(doc, { ...child, parentId: rng.chance(20) ? undefined : parent.id })
        return 'element.update parent'
      }
      case 12:
        this.run(doc, 'page.create', { pageId: newObjectId(), name: `Page ${value}`, activate: rng.chance(50) })
        return 'page.create'
      case 13: {
        const page = rng.pick(pages)
        if (!page) return null
        this.run(doc, 'page.rename', { pageId: page.id, name: `Renamed ${value}` })
        return 'page.rename'
      }
      case 14: {
        const page = rng.pick(pages)
        if (!page) return null
        this.run(doc, 'page.duplicate', { sourcePageId: page.id, pageId: newObjectId(), name: `Copy ${value}` })
        return 'page.duplicate'
      }
      case 15: {
        const page = rng.pick(pages)
        if (!page || pages.length < 2) return null
        this.run(doc, 'page.delete', { pageId: page.id })
        return 'page.delete'
      }
      case 16: {
        const page = rng.pick(pages)
        if (!page) return null
        this.run(doc, 'page.reorder', { pageId: page.id, placement: rng.chance(50) ? 'previous' : 'next' })
        return 'page.reorder'
      }
      default: {
        const page = rng.pick(pages)
        if (!page) return null
        // View state only: the next element commands act on this page.
        this.run(doc, 'page.activate', { pageId: page.id })
        return 'page.activate'
      }
    }
  }

  /**
   * The view is what a fresh store reads from the replica, and the board's invariants hold in the
   * view and in the state: every parent is a container on the element's page, no hierarchy cycle,
   * and every binding names an element that exists.
   */
  checkView(doc: Doc): void {
    const live = comparable(store(doc).getRecords())
    const fresh = comparable(new BoardStore(Replica.load(boardSchema, doc.session.replica.snapshot(), randomActor())).getRecords())
    if (canonicalText(live) !== canonicalText(fresh)) {
      const text = (records: BoardRecord[], id: string) => canonicalText(records.find((record) => record.id === id) ?? null)
      const ids = new Set([...live, ...fresh].map((record) => record.id))
      const differing = [...ids].filter((id) => text(live, id) !== text(fresh, id))
      const first = differing[0] ?? ''
      throw new Error(`the store's view differs from a fresh read of its replica at ${differing.slice(0, 5).join(', ')}: ${text(live, first).slice(0, 400)} vs ${text(fresh, first).slice(0, 400)}`)
    }
    const elements = new Map(live.flatMap((record): Array<[string, BoardElementRecord]> => (record.record_type === 'element' ? [[record.id, record]] : [])))
    for (const element of elements.values()) {
      if (!element.parentId) continue
      const parent = elements.get(element.parentId)
      if (!parent || parent.page_id !== element.page_id || !isBoardContainerElement(boardElementFromRecord(parent))) {
        throw new Error(`element ${element.id} has parent ${element.parentId}, which is not a container on its page`)
      }
      const cycle = cycleThrough(element.id, (id) => elements.get(id)?.parentId)
      if (cycle) throw new Error(`the view's hierarchy has a cycle: ${cycle.join(' > ')}`)
    }
    // The state, which the object model and other replicas read, is repaired as well.
    const objects = (doc.session.replica.stateJson() as { objects: Record<string, Record<string, unknown>> }).objects
    const field = (id: string, name: string) => objects[id]?.[name]
    for (const [id, object] of Object.entries(objects)) {
      if (object.$type !== 'Element') continue
      const cycle = cycleThrough(id, (child) => field(child, 'parent') as string | null | undefined)
      if (cycle) throw new Error(`the state's hierarchy has a cycle: ${cycle.join(' > ')}`)
      for (const terminal of ['startBinding', 'endBinding']) {
        const target = (object[terminal] as { target?: string } | null | undefined)?.target
        if (target !== undefined && objects[target]?.$type !== 'Element') throw new Error(`connector ${id}.${terminal} names ${target}, which is not an element`)
      }
    }
  }
}

describe('the Board kit converges (standard 2.0 L6)', () => {
  it('passes the convergence suite', () => {
    const report = run(new BoardKit(), optionsFromEnv(process.env))
    if (process.env.KITION_CONVERGENCE_REPORT) writeFileSync(process.env.KITION_CONVERGENCE_REPORT, report.toJsonText())
    expect(report.level6(), report.render()).toBe(true)
    // An image names a workspace file rather than a blob: the board has no blob field, and it
    // passes every other scenario, paragraphs (label lines) and frame nesting included.
    expect(report.checks.filter((check) => check.outcome.kind !== 'passed').map((check) => check.id)).toEqual(['blobs-late'])
  }, 300_000)

  it('keeps a reparent cycle out of the board: the frames end unnested on every replica', () => {
    const report = runOne(new BoardKit(), 'reparent', optionsFromEnv(process.env))
    expect(report?.outcome('reparent')).toEqual({ kind: 'passed' })
  }, 60_000)
})
