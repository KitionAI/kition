/**
 * Writes a store diff into a KDM transaction as field-level operations: only the fields that
 * changed are set, text is edited minimally, and order changes become list moves. Concurrent
 * edits of different fields, of one label, or of the order of different elements therefore merge.
 */
import type { Tx } from '@/lib/kdm'
import type {
  BoardBindingRecord,
  BoardElementRecord,
  BoardPageRecord,
  BoardRecord,
} from '../lib/boardRecords'
import type { BoardRecordDiff } from '../lib/boardRecordDiff'
import type { WhiteboardElement } from '../lib/whiteboardTypes'
import { BOARD_STYLE_FIELDS } from './boardSchema'

type Terminal = 'start' | 'end'
type BindingValue = { target: string; anchor: { x: number; y: number } | null }

/** Element fields stored as plain registers, read straight from the element. */
const PLAIN_FIELDS = [
  'x', 'y', 'width', 'height', 'rotation', 'locked',
  'shapeType', 'shapeStyle', 'fontSize',
  'connectorType', 'startArrowhead', 'endArrowhead', 'connectorRole', 'mindMapBranchAxis',
  'mindMapBranchSide', 'mindMapDirection', 'mindMapCollapsed',
] as const

/** Element fields holding JSON values. */
const JSON_FIELDS = ['points', 'start', 'end', 'sourceRefIds'] as const

/** Applies `diff` to `tx`; `rootId` is the board's `Board` object. */
export function writeBoardDiff(tx: Tx, rootId: string, diff: BoardRecordDiff): void {
  const updates = diff.updated
  const addedPages = diff.added.filter(isPage)
  const addedElements = diff.added.filter(isElement)
  const removedPages = diff.removed.filter(isPage)
  const removedElements = diff.removed.filter(isElement)
  const elementUpdates = updates.filter((u): u is { before: BoardElementRecord; after: BoardElementRecord } => isElement(u.before) && isElement(u.after))
  const pageUpdates = updates.filter((u): u is { before: BoardPageRecord; after: BoardPageRecord } => isPage(u.before) && isPage(u.after))
  const removedPageIds = new Set(removedPages.map((page) => page.id))

  // Every element's page after the diff, for those the diff names.
  const placed = new Map<string, BoardElementRecord>()
  for (const element of addedElements) placed.set(element.id, element)
  for (const { after } of elementUpdates) placed.set(after.id, after)
  const removedElementIds = new Set(removedElements.map((element) => element.id))

  // Lists whose order may change, with their current order read before any operation.
  const touchedPages = new Set<string>()
  for (const element of addedElements) touchedPages.add(element.page_id)
  for (const element of removedElements) touchedPages.add(element.page_id)
  for (const { before, after } of elementUpdates) {
    if (before.page_id === after.page_id && before.index === after.index) continue
    touchedPages.add(before.page_id)
    touchedPages.add(after.page_id)
  }
  for (const id of removedPageIds) touchedPages.delete(id)
  const elementOrder = new Map<string, Map<string, number>>()
  for (const pageId of touchedPages) elementOrder.set(pageId, currentOrder(tx, pageId, 'elements'))
  const pagesTouched = addedPages.length > 0
    || removedPages.length > 0
    || pageUpdates.some(({ before, after }) => before.index !== after.index)
  const pageOrder = pagesTouched ? currentOrder(tx, rootId, 'pages') : null

  for (const page of addedPages) tx.create('Page', { name: page.name }, { id: page.id })
  for (const { before, after } of pageUpdates) {
    if (before.name !== after.name && tx.exists(after.id)) tx.set(after.id, 'name', after.name)
  }

  for (const element of addedElements) {
    tx.create('Element', withoutNulls(fieldsFromElement(element)), { id: element.id })
    const text = textOf(element)
    if (text) tx.textInsert(element.id, 'text', 0, text)
  }
  for (const { before, after } of elementUpdates) {
    // An element a merge removed is not brought back by an edit made before the store saw it.
    if (!tx.exists(after.id)) continue
    const previous = fieldsFromElement(before)
    const next = fieldsFromElement(after)
    for (const [field, value] of Object.entries(next)) {
      if (!sameValue(previous[field], value)) tx.set(after.id, field, value)
    }
    if (textOf(before) !== textOf(after)) writeText(tx, after.id, textOf(after))
  }

  for (const binding of diff.removed.filter(isBinding)) clearBinding(tx, binding)
  for (const binding of diff.added.filter(isBinding)) writeBinding(tx, binding)
  for (const { before, after } of updates) {
    if (!isBinding(before) || !isBinding(after)) continue
    const previous = bindingTerminal(before)
    if (previous && (previous !== bindingTerminal(after) || before.from_id !== after.from_id)) clearBinding(tx, before)
    else if (sameValue(bindingValue(before), bindingValue(after))) continue
    writeBinding(tx, after)
  }

  for (const element of removedElements) {
    if (tx.exists(element.id)) tx.delete(element.id)
  }

  for (const [pageId, order] of elementOrder) {
    if (!tx.exists(pageId)) continue
    for (const id of removedElementIds) order.delete(id)
    for (const [id, element] of placed) {
      if (element.page_id === pageId && tx.exists(id)) order.set(id, element.index)
      else order.delete(id)
    }
    syncListOrder(tx, pageId, 'elements', sortedIds(order))
  }

  if (pageOrder) {
    for (const id of removedPageIds) pageOrder.delete(id)
    for (const page of addedPages) pageOrder.set(page.id, page.index)
    for (const { after } of pageUpdates) if (pageOrder.has(after.id)) pageOrder.set(after.id, after.index)
    syncListOrder(tx, rootId, 'pages', sortedIds(pageOrder))
  }

  for (const pageId of removedPageIds) {
    if (!tx.exists(pageId)) continue
    for (const id of tx.listItems(pageId, 'elements')) {
      const movedTo = placed.get(id)?.page_id
      if (movedTo !== undefined && movedTo !== pageId) continue
      if (tx.exists(id)) tx.delete(id)
    }
    tx.delete(pageId)
  }
}

/**
 * The KDM fields of an element: every register field of the schema except the connector bindings
 * (written from binding records), `null` when absent, with the style flattened. Text is not a
 * register and is written with `writeText`.
 */
function fieldsFromElement(element: WhiteboardElement): Record<string, unknown> {
  const source = element as Record<string, unknown>
  const fields: Record<string, unknown> = { kind: element.kind }
  for (const key of PLAIN_FIELDS) fields[key] = source[key] ?? null
  for (const key of JSON_FIELDS) fields[key] = source[key] === undefined || source[key] === null ? null : plainJson(source[key])
  fields.parent = element.parentId ?? null
  for (const key of BOARD_STYLE_FIELDS) fields[key] = element.style?.[key] ?? null
  fields.image = element.kind === 'image'
    ? (element.alt === undefined ? { workspacePath: element.workspacePath } : { workspacePath: element.workspacePath, alt: element.alt })
    : null
  return fields
}

/**
 * Replaces the element's text with `next` as one deletion and one insertion between the common
 * prefix and suffix, never cutting a surrogate pair.
 */
function writeText(tx: Tx, id: string, next: string): void {
  const current = tx.text(id, 'text')
  if (current === next) return
  const shorter = Math.min(current.length, next.length)
  let start = 0
  while (start < shorter && current.charCodeAt(start) === next.charCodeAt(start)) start += 1
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start -= 1
  let end = 0
  while (end < shorter - start && current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end += 1
  if (end > 0 && isLowSurrogate(current.charCodeAt(current.length - end))) end -= 1
  const removed = current.length - end - start
  if (removed > 0) tx.textDelete(id, 'text', start, removed)
  const inserted = next.slice(start, next.length - end)
  if (inserted) tx.textInsert(id, 'text', start, inserted)
}

/**
 * Makes a list equal to `target`: removes items not in it (and repeated items), keeps the longest
 * run already in order, and moves or inserts every other item right after its predecessor.
 */
function syncListOrder(tx: Tx, ownerId: string, field: string, target: readonly string[]): void {
  const current = tx.listItems(ownerId, field)
  const position = new Map(target.map((id, index) => [id, index]))
  const seen = new Set<string>()
  const keep = current.map((id) => {
    if (!position.has(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (keep[index]) continue
    tx.listRemove(ownerId, field, index)
    current.splice(index, 1)
  }
  const stable = longestIncreasingRun(current.map((id) => position.get(id) ?? 0))
    .reduce((ids, index) => ids.add(current[index]), new Set<string>())
  target.forEach((id, index) => {
    if (stable.has(id)) return
    let to = index === 0 ? 0 : current.indexOf(target[index - 1]) + 1
    const from = current.indexOf(id)
    if (from === -1) {
      tx.listInsert(ownerId, field, to, id)
      current.splice(to, 0, id)
      return
    }
    if (from < to) to -= 1
    if (from === to) return
    tx.listMove(ownerId, field, from, to)
    current.splice(from, 1)
    current.splice(to, 0, id)
  })
}

/** Indexes (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasingRun(values: readonly number[]): number[] {
  const tails: number[] = []
  const previous: number[] = new Array(values.length).fill(-1)
  values.forEach((value, index) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (values[tails[middle]] < value) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tails[low - 1]
    tails[low] = index
  })
  const run: number[] = []
  for (let index = tails.at(-1) ?? -1; index !== -1; index = previous[index]) run.push(index)
  return run.reverse()
}

/**
 * The current order of a list as record indexes: the position of each live item among the live
 * items, as `readBoardRecords` numbers them. Empty when the owner does not exist yet.
 */
function currentOrder(tx: Tx, ownerId: string, field: string): Map<string, number> {
  const order = new Map<string, number>()
  if (!tx.exists(ownerId)) return order
  for (const id of tx.listItems(ownerId, field)) {
    if (!order.has(id) && tx.exists(id)) order.set(id, order.size)
  }
  return order
}

/** Ids by index, then id, as the store orders records. */
function sortedIds(order: Map<string, number>): string[] {
  return [...order].sort(([left, a], [right, b]) => a - b || left.localeCompare(right)).map(([id]) => id)
}

function writeBinding(tx: Tx, binding: BoardBindingRecord): void {
  const terminal = bindingTerminal(binding)
  if (terminal && tx.exists(binding.from_id)) tx.set(binding.from_id, `${terminal}Binding`, bindingValue(binding))
}

function clearBinding(tx: Tx, binding: BoardBindingRecord): void {
  const terminal = bindingTerminal(binding)
  if (terminal && tx.exists(binding.from_id)) tx.set(binding.from_id, `${terminal}Binding`, null)
}

function bindingValue(binding: BoardBindingRecord): BindingValue {
  const anchor = binding.to_anchor
  return { target: binding.to_id, anchor: anchor ? { x: anchor.x, y: anchor.y } : null }
}

function bindingTerminal(binding: BoardBindingRecord): Terminal | null {
  if (binding.terminal) return binding.terminal
  if (binding.id.endsWith(':start')) return 'start'
  if (binding.id.endsWith(':end')) return 'end'
  return null
}

function textOf(element: WhiteboardElement): string {
  return element.kind === 'rectangle' || element.kind === 'text' ? element.text ?? '' : ''
}

function withoutNulls(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null))
}

/** A JSON copy without `undefined` members, which the KDM refuses. */
function plainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined)
  if (keys.length !== Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined).length) return false
  return keys.every((key) => sameValue(leftRecord[key], rightRecord[key]))
}

const isPage = (record: BoardRecord): record is BoardPageRecord => record.record_type === 'page'
const isElement = (record: BoardRecord): record is BoardElementRecord => record.record_type === 'element'
const isBinding = (record: BoardRecord): record is BoardBindingRecord => record.record_type === 'binding'
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff
