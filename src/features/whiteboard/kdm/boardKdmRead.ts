/**
 * The record view of a board replica: the `BoardRecord`s the store and the editor work with,
 * rebuilt from the KDM document. Element order comes from the page's `elements` list and page
 * order from the board's `pages` list; indexes are positions, never stored.
 */
import type { Replica } from '@/lib/kdm'
import {
  createBoardElementRecord,
  type BoardBindingRecord,
  type BoardElementRecord,
  type BoardPageRecord,
  type BoardRecord,
} from '../lib/boardRecords'
import type {
  WhiteboardElement,
  WhiteboardElementStyle,
  WhiteboardPoint,
} from '../lib/whiteboardTypes'
import { BOARD_STYLE_FIELDS, boardSchema } from './boardSchema'

type Fields = Record<string, unknown>
type BoardState = { objects: Record<string, Fields> }

/** The element kinds this build reads; an element of another kind is kept but not shown. */
export const BOARD_ELEMENT_KINDS: ReadonlySet<string> = new Set(['rectangle', 'text', 'stroke', 'connector', 'image'])
const TERMINALS = ['start', 'end'] as const
const ELEMENT_FIELDS = Object.entries(boardSchema.types.Element.fields)

/**
 * What the reader makes of one item of a page's `elements` list: an element it shows there, an
 * element it already showed earlier (on an earlier page or earlier in this list), an object it
 * cannot show (a kind this build does not know), or a dangling id.
 */
export type BoardItemState = 'element' | 'duplicate' | 'unknown' | 'missing'

/** One page as the reader sees it. */
export type BoardPageLayout = {
  id: string
  /** The page's `elements` list as stored. */
  items: readonly string[]
  /** The state of each item of `items`. */
  states: readonly BoardItemState[]
  /** The elements shown on the page, in order: a record's `index` is its position here. */
  elements: readonly string[]
}

/**
 * Where the reader shows every element: pages in the board's order (each page once), and in each
 * page the elements not shown before. An element a merge left on two pages is shown on the first.
 */
export type BoardLayout = {
  pages: readonly BoardPageLayout[]
  placement: ReadonlyMap<string, { pageId: string; index: number }>
}

/** The reads `boardLayout` needs, so the replica, its JSON state, and a transaction share one set of rules. */
export type BoardLayoutSource = {
  /** The root's `pages` list as stored. */
  pageIds(): readonly string[]
  isPage(id: string): boolean
  /** A page's `elements` list as stored. */
  items(pageId: string): readonly string[]
  /** `'element'` for an element of a known kind, `'unknown'` for another object, `'missing'` for no object. */
  objectState(id: string): Exclude<BoardItemState, 'duplicate'>
}

/**
 * The reader's layout of the board. With `until`, it stops reading once every id of `until` is
 * placed, so its last page may be partial. @internal Shared by the readers and `boardKdmWrite`.
 */
export function boardLayout(source: BoardLayoutSource, until?: ReadonlySet<string>): BoardLayout {
  const placement = new Map<string, { pageId: string; index: number }>()
  const known = new Map<string, Exclude<BoardItemState, 'duplicate'>>()
  const pages: BoardPageLayout[] = []
  let pending = until?.size ?? -1
  for (const pageId of readablePages(source)) {
    if (pending === 0) break
    const items = source.items(pageId)
    const elements: string[] = []
    const states: BoardItemState[] = []
    for (const id of items) {
      if (pending === 0) break
      let object = known.get(id)
      if (object === undefined) {
        object = source.objectState(id)
        known.set(id, object)
      }
      if (object !== 'element') {
        states.push(object)
      } else if (placement.has(id)) {
        states.push('duplicate')
      } else {
        placement.set(id, { pageId, index: elements.length })
        elements.push(id)
        states.push('element')
        if (until?.has(id)) pending -= 1
      }
    }
    pages.push({ id: pageId, items, states, elements })
  }
  return { pages, placement }
}

/** The root's pages the reader shows, in order, each once. */
function readablePages(source: BoardLayoutSource): string[] {
  const pages = new Set<string>()
  for (const id of source.pageIds()) if (!pages.has(id) && source.isPage(id)) pages.add(id)
  return [...pages]
}

/** All records of the board: its pages, their elements in order, and connector bindings. */
export function readBoardRecords(replica: Replica): BoardRecord[] {
  return [...readBoardView(replica).records.values()]
}

/** An item the reader skips because its element is shown earlier (see `findBoardDuplicatePlacements`). */
export type BoardDuplicatePlacement = { id: string; pageId: string; index: number }

/**
 * A full read of the board, kept so that later reads can re-read only what changed
 * (`refreshBoardView`).
 */
export type BoardViewRead = {
  /** The `Board` object, `null` for a document without one (it reads as no records). */
  rootId: string | null
  /** The records `readBoardRecords` gives, by id, in its order. */
  records: ReadonlyMap<string, BoardRecord>
  layout: BoardLayout
  /** Objects listed on the shown pages that the reader does not show: kinds it does not know, and dangling ids. */
  hidden: ReadonlyMap<string, 'unknown' | 'missing'>
}

const PLACEHOLDER: BoardPageRecord = { record_type: 'page', id: '', name: '', index: -1 }

/** The whole board in one engine read: `readBoardRecords` with the layout behind it. */
export function readBoardView(replica: Replica): BoardViewRead {
  const { objects } = replica.stateJson() as BoardState
  const root = findRoot(objects)
  if (!root) return { rootId: null, records: new Map(), layout: { pages: [], placement: new Map() }, hidden: new Map() }
  const records = new Map<string, BoardRecord>()
  const bindings: BoardBindingRecord[] = []
  const layout = boardLayout(stateSource(objects, root))
  layout.pages.forEach((page, pageIndex) => {
    records.set(page.id, { record_type: 'page', id: page.id, name: stringOr(objects[page.id].name, ''), index: pageIndex })
    page.elements.forEach((id, index) => {
      const fields = objects[id]
      const element = elementFromFields(id, fields)
      if (!element) return
      records.set(id, createBoardElementRecord({ element, index, pageId: page.id }))
      if (element.kind === 'connector') bindings.push(...bindingsOf(id, fields))
    })
  })
  for (const binding of bindings) records.set(binding.id, binding)
  return { rootId: root, records, layout, hidden: hiddenItems(layout) }
}

/**
 * `previous` (a read of this replica) brought up to date after the objects in `changed` changed,
 * reading only those objects and the pages' lists: equal to a new `readBoardView`. `null` when a
 * full read is the better choice: the root changed (title or page list) or more than `limit`
 * (a share of the records) changed.
 */
export function refreshBoardView(replica: Replica, previous: BoardViewRead, changed: ReadonlySet<string>, limit = 0.25): BoardViewRead | null {
  const root = previous.rootId
  if (root === null || changed.has(root) || changed.size > Math.max(16, previous.records.size * limit)) return null
  if (changed.size === 0) return previous
  const base = replicaSource(replica, root)
  const lists = new Map(previous.layout.pages.map((page) => [page.id, page.items]))
  const source = knownLayoutSource({
    pageIds: base.pageIds,
    isPage: base.isPage,
    items: (pageId) => (changed.has(pageId) ? undefined : lists.get(pageId)) ?? base.items(pageId),
    objectState: base.objectState,
  }, previous, changed)
  const layout = boardLayout(source)
  const records = new Map<string, BoardRecord>()
  const bindings = new Map<string, BoardBindingRecord>()
  const reread: string[] = []
  layout.pages.forEach((page, pageIndex) => {
    const before = previous.records.get(page.id)
    records.set(page.id, before?.record_type === 'page' && before.index === pageIndex && !changed.has(page.id)
      ? before
      : { record_type: 'page', id: page.id, name: stringOr(replica.get(page.id, 'name'), ''), index: pageIndex })
    page.elements.forEach((id, index) => {
      const before = previous.records.get(id)
      if (before?.record_type !== 'element' || changed.has(id)) {
        reread.push(id)
        records.set(id, PLACEHOLDER) // keeps the reading order; replaced below
        return
      }
      records.set(id, before.page_id === page.id && before.index === index ? before : { ...before, page_id: page.id, index })
      if (before.kind === 'connector') {
        for (const terminal of TERMINALS) {
          const binding = previous.records.get(`binding:${id}:${terminal}`)
          if (binding?.record_type === 'binding') bindings.set(binding.id, binding)
        }
      }
    })
  })
  for (const id of reread) {
    const place = layout.placement.get(id)!
    const fields = replicaFields(replica, id)
    const element = elementFromFields(id, fields)
    if (!element) {
      records.delete(id)
      continue
    }
    records.set(id, createBoardElementRecord({ element, index: place.index, pageId: place.pageId }))
    if (element.kind === 'connector') for (const binding of bindingsOf(id, fields)) bindings.set(binding.id, binding)
  }
  for (const [id, binding] of bindings) records.set(id, binding)
  return { rootId: root, records, layout, hidden: hiddenItems(layout) }
}

/**
 * The layout reads of `base` answered from `read` where it can: objects not in `changed` keep
 * the state and page-ness `read` saw. For the writer, which asks for the state of every listed
 * item. @internal
 */
export function knownLayoutSource(base: BoardLayoutSource, read: BoardViewRead, changed: ReadonlySet<string>): BoardLayoutSource {
  return {
    pageIds: base.pageIds,
    isPage: (id) => (!changed.has(id) && read.records.get(id)?.record_type === 'page') || base.isPage(id),
    items: base.items,
    objectState: (id) => {
      if (!changed.has(id)) {
        if (read.records.get(id)?.record_type === 'element') return 'element'
        const hidden = read.hidden.get(id)
        if (hidden) return hidden
      }
      return base.objectState(id)
    },
  }
}

/** The list entries of `layout` the reader skips because their element is shown earlier. */
export function duplicatePlacements(layout: BoardLayout): BoardDuplicatePlacement[] {
  const out: BoardDuplicatePlacement[] = []
  for (const page of layout.pages) {
    page.states.forEach((state, index) => {
      if (state === 'duplicate') out.push({ id: page.items[index], pageId: page.id, index })
    })
  }
  return out
}

function hiddenItems(layout: BoardLayout): Map<string, 'unknown' | 'missing'> {
  const hidden = new Map<string, 'unknown' | 'missing'>()
  for (const page of layout.pages) {
    page.states.forEach((state, index) => {
      if (state === 'unknown' || state === 'missing') hidden.set(page.items[index], state)
    })
  }
  return hidden
}

/**
 * The board's page records, without reading its elements. The per-object reads take the board's
 * root id (`boardRootId`) when the caller knows it, which saves a scan of every object.
 */
export function readBoardPageRecords(replica: Replica, rootId?: string): BoardPageRecord[] {
  const root = rootId ?? rootOf(replica)
  if (root === null || !replica.exists(root)) return []
  return readablePages(replicaSource(replica, root)).map((id, index) => ({
    record_type: 'page',
    id,
    name: stringOr(replica.get(id, 'name'), ''),
    index,
  }))
}

/**
 * The records of a few elements, as `readBoardRecords` would give them (page and index from the
 * element's placement), without materialising the whole board: `null` for an element the reader
 * does not show (deleted, on no page, or of an unknown kind).
 */
export function readBoardElementRecords(replica: Replica, ids: readonly string[], rootId?: string): Map<string, BoardElementRecord | null> {
  const placed = readPlaced(replica, ids, rootId)
  return new Map(ids.map((id) => [id, placed.get(id)?.record ?? null]))
}

/** One element's record, as `readBoardRecords` would give it; `null` when the reader does not show it. */
export function readBoardElementRecord(replica: Replica, id: string, rootId?: string): BoardElementRecord | null {
  return readBoardElementRecords(replica, [id], rootId).get(id) ?? null
}

/** The binding records of the given connectors, as `readBoardRecords` would give them. */
export function readBoardBindingRecords(replica: Replica, connectorIds: readonly string[], rootId?: string): BoardBindingRecord[] {
  const placed = readPlaced(replica, connectorIds, rootId)
  return [...new Set(connectorIds)].flatMap((id) => placed.get(id)?.bindings ?? [])
}

/**
 * The list entries the reader skips because their element is shown elsewhere: an element a merge
 * left on two pages (all placements after the first in board order) or listed twice on one page.
 * `index` is the entry's position in the page's stored list. A repair transaction removes them
 * (`repairBoardPlacements`).
 */
export function findBoardDuplicatePlacements(replica: Replica, rootId?: string): BoardDuplicatePlacement[] {
  const root = rootId ?? rootOf(replica)
  if (root === null || !replica.exists(root)) return []
  return duplicatePlacements(boardLayout(replicaSource(replica, root)))
}

export function readBoardTitle(replica: Replica): string {
  const root = rootOf(replica)
  return root === null ? '' : stringOr(replica.get(root, 'title'), '')
}

/** The id of the board's root object. */
export function boardRootId(replica: Replica): string {
  const root = rootOf(replica)
  if (root === null) throw new Error('The board document has no Board object.')
  return root
}

/** The `Board` object; the smallest id if concurrent creation left several. */
function rootOf(replica: Replica): string | null {
  return replica.objectsOfType('Board')[0] ?? null
}

/** Records and bindings of the given ids the reader shows, with one layout pass. */
function readPlaced(replica: Replica, ids: readonly string[], rootId: string | undefined) {
  const out = new Map<string, { record: BoardElementRecord; bindings: BoardBindingRecord[] }>()
  if (ids.length === 0) return out
  const root = rootId ?? rootOf(replica)
  if (root === null || !replica.exists(root)) return out
  const { placement } = boardLayout(replicaSource(replica, root), new Set(ids))
  for (const id of ids) {
    const place = placement.get(id)
    if (!place || out.has(id)) continue
    const fields = replicaFields(replica, id)
    const element = elementFromFields(id, fields)
    if (!element) continue
    out.set(id, {
      record: createBoardElementRecord({ element, index: place.index, pageId: place.pageId }),
      bindings: element.kind === 'connector' ? bindingsOf(id, fields) : [],
    })
  }
  return out
}

/** An element's fields read one by one, shaped like its entry in `stateJson`. */
function replicaFields(replica: Replica, id: string): Fields {
  const fields: Fields = { $type: 'Element' }
  for (const [name, def] of ELEMENT_FIELDS) fields[name] = def.kind === 'text' ? replica.text(id, name) : replica.get(id, name)
  return fields
}

function stateSource(objects: Record<string, Fields>, root: string): BoardLayoutSource {
  return {
    pageIds: () => stringItems(objects[root].pages),
    isPage: (id) => objects[id]?.$type === 'Page',
    items: (pageId) => stringItems(objects[pageId].elements),
    objectState: (id) => {
      const fields = objects[id]
      if (!fields) return 'missing'
      return fields.$type === 'Element' && typeof fields.kind === 'string' && BOARD_ELEMENT_KINDS.has(fields.kind) ? 'element' : 'unknown'
    },
  }
}

function replicaSource(replica: Replica, root: string): BoardLayoutSource {
  return {
    pageIds: () => replica.list(root, 'pages'),
    isPage: (id) => replica.exists(id) && replica.objectType(id) === 'Page',
    items: (pageId) => replica.list(pageId, 'elements'),
    objectState: (id) => {
      let kind: unknown
      try {
        kind = replica.get(id, 'kind')
      } catch {
        // No such object, or one without `kind` (not an element).
        return replica.exists(id) ? 'unknown' : 'missing'
      }
      return typeof kind === 'string' && BOARD_ELEMENT_KINDS.has(kind) ? 'element' : 'unknown'
    },
  }
}

/** Rebuilds a whiteboard element from its KDM fields; `null` for an unknown kind. `null` fields are absent. */
function elementFromFields(id: string, fields: Fields): WhiteboardElement | null {
  const kind = fields.kind
  if (typeof kind !== 'string' || !BOARD_ELEMENT_KINDS.has(kind)) return null
  const base: Record<string, unknown> = {
    id,
    kind,
    rotation: numberOr(fields.rotation, 0),
    locked: fields.locked === true,
  }
  const parent = present(fields.parent)
  if (typeof parent === 'string') base.parentId = parent
  const style = styleOf(fields)
  if (style) base.style = style
  const sourceRefIds = present(fields.sourceRefIds)
  if (Array.isArray(sourceRefIds)) base.sourceRefIds = sourceRefIds.filter((ref) => typeof ref === 'string')
  const text = typeof fields.text === 'string' ? fields.text : ''

  switch (kind) {
    case 'rectangle':
      Object.assign(base, geometry(fields, true))
      copyPresent(base, fields, ['shapeType', 'shapeStyle', 'mindMapBranchSide', 'mindMapDirection', 'mindMapCollapsed'])
      if (text) base.text = text
      break
    case 'text':
      Object.assign(base, geometry(fields, false))
      base.text = text
      copyPresent(base, fields, ['fontSize'])
      break
    case 'stroke':
      base.points = Array.isArray(fields.points) ? fields.points.filter(isPoint) : []
      break
    case 'connector':
      base.start = pointOr(fields.start)
      base.end = pointOr(fields.end)
      copyPresent(base, fields, ['connectorType', 'startArrowhead', 'endArrowhead', 'connectorRole', 'mindMapBranchAxis'])
      break
    case 'image': {
      Object.assign(base, geometry(fields, true))
      const image = isRecord(fields.image) ? fields.image : {}
      base.workspacePath = stringOr(image.workspacePath, '')
      if (typeof image.alt === 'string') base.alt = image.alt
      break
    }
  }
  return base as WhiteboardElement
}

function bindingsOf(connector: string, fields: Fields): BoardBindingRecord[] {
  const out: BoardBindingRecord[] = []
  for (const terminal of TERMINALS) {
    const binding = fields[`${terminal}Binding`]
    if (!isRecord(binding) || typeof binding.target !== 'string') continue
    const record: BoardBindingRecord = {
      record_type: 'binding',
      id: `binding:${connector}:${terminal}`,
      binding_type: 'connector',
      from_id: connector,
      to_id: binding.target,
      terminal,
    }
    if (isPoint(binding.anchor)) record.to_anchor = { x: binding.anchor.x, y: binding.anchor.y }
    out.push(record)
  }
  return out
}

/** The `Board` object; the smallest id if concurrent creation left several. */
function findRoot(objects: Record<string, Fields>): string | null {
  let root: string | null = null
  for (const [id, fields] of Object.entries(objects)) {
    if (fields.$type === 'Board' && (root === null || id < root)) root = id
  }
  return root
}

function styleOf(fields: Fields): Partial<WhiteboardElementStyle> | undefined {
  const style: Record<string, unknown> = {}
  for (const key of BOARD_STYLE_FIELDS) {
    const value = present(fields[key])
    if (value !== undefined) style[key] = value
  }
  return Object.keys(style).length > 0 ? (style as Partial<WhiteboardElementStyle>) : undefined
}

function geometry(fields: Fields, sized: boolean) {
  const out: Record<string, number> = { x: numberOr(fields.x, 0), y: numberOr(fields.y, 0) }
  if (sized) {
    out.width = numberOr(fields.width, 0)
    out.height = numberOr(fields.height, 0)
  }
  return out
}

function copyPresent(target: Record<string, unknown>, fields: Fields, keys: readonly string[]) {
  for (const key of keys) {
    const value = present(fields[key])
    if (value !== undefined) target[key] = value
  }
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

const present = (value: unknown): unknown => (value === null ? undefined : value)
const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback)
const stringOr = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
const isRecord = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value)
const isPoint = (value: unknown): value is WhiteboardPoint => isRecord(value) && typeof value.x === 'number' && typeof value.y === 'number'
const pointOr = (value: unknown): WhiteboardPoint => (isPoint(value) ? { x: value.x, y: value.y } : { x: 0, y: 0 })
