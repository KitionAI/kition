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
import { BOARD_ELEMENT_KINDS, boardLayout, knownLayoutSource, readablePages, type BoardLayoutSource, type BoardPageLayout, type BoardViewRead } from './boardKdmRead'
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

/**
 * What a write could not do as the diff asked; the store re-reads these ids from the replica.
 * `skipped`: updates of elements or pages the replica no longer has, and added or updated bindings
 * whose connector it no longer has (binding record ids). `relocated`: elements the diff put on a
 * page that neither the replica nor the diff has; they were placed last on the board's first page.
 */
export type BoardWriteResult = { skipped: string[]; relocated: string[] }

/**
 * What the writer may take from an earlier read of the replica instead of reading every listed
 * object again: `read`, and the objects `changed` since it (all others are as `read` saw them).
 */
export type BoardWriteHint = { read: BoardViewRead; changed: ReadonlySet<string> }

type ElementUpdate = { before: BoardElementRecord; after: BoardElementRecord }
type PageUpdate = { before: BoardPageRecord; after: BoardPageRecord }

/** Order keys of relocated elements: after every element of the page, in diff index order. */
const RELOCATED = 2 ** 40

const EMPTY_PAGE: BoardPageLayout = { id: '', items: [], states: [], elements: [] }

/**
 * Applies `diff` to `tx`; `rootId` is the board's `Board` object. Throws before staging anything
 * when a value cannot be stored (a number that is not finite).
 */
export function writeBoardDiff(tx: Tx, rootId: string, diff: BoardRecordDiff, hint?: BoardWriteHint): BoardWriteResult {
  const skipped: string[] = []
  const relocated: string[] = []
  const updates = diff.updated
  const addedPages = diff.added.filter(isPage)
  const removedPages = diff.removed.filter(isPage)
  const removedElements = diff.removed.filter(isElement)
  const elementUpdates = updates.filter((u): u is ElementUpdate => isElement(u.before) && isElement(u.after))
  const pageUpdates = updates.filter((u): u is PageUpdate => isPage(u.before) && isPage(u.after))
  const removedPageIds = new Set(removedPages.map((page) => page.id))
  const removedElementIds = new Set(removedElements.map((element) => element.id))

  // Everything to store, checked before the first operation.
  const creations = diff.added.filter(isElement).map((element) => ({ element, fields: checkedFields(element.id, withoutNulls(fieldsFromElement(element))) }))
  const changes = elementUpdates.flatMap(({ before, after }) => {
    // Most updates of a reorder only change the element's place.
    if (sameExceptPlacement(before, after)) return []
    const previous = fieldsFromElement(before)
    const changed = Object.entries(fieldsFromElement(after)).filter(([field, value]) => !sameValue(previous[field], value))
    return [{ before, after, changed: Object.entries(checkedFields(after.id, Object.fromEntries(changed))) }]
  })
  for (const binding of [...diff.added, ...updates.map((u) => u.after)]) {
    if (isBinding(binding)) checkedFields(binding.from_id, { [`${bindingTerminal(binding) ?? 'binding'}Binding`]: bindingValue(binding) })
  }

  const moves = elementUpdates.filter(({ before, after }) => before.page_id !== after.page_id || before.index !== after.index)
  const pagesTouched = addedPages.length > 0
    || removedPages.length > 0
    || pageUpdates.some(({ before, after }) => before.index !== after.index)
  // The reader's view of the lists, read before any operation: the hint answers for the objects
  // it knows, and every page's list is read once.
  const source = hint ? knownLayoutSource(txSource(tx, rootId), hint.read, hint.changed) : txSource(tx, rootId)
  const readsLists = creations.length > 0 || removedElements.length > 0 || moves.length > 0 || pagesTouched
  const readable = readsLists ? readablePages(source) : []
  const lists = new Map(readable.map((pageId) => [pageId, source.items(pageId)]))
  // The pages listing each element the diff adds, moves, or removes.
  const listedOn = new Map<string, Set<string>>()
  for (const id of [...removedElementIds, ...creations.map(({ element }) => element.id), ...moves.map(({ after }) => after.id)]) listedOn.set(id, new Set())
  for (const [pageId, items] of lists) {
    for (const id of items) listedOn.get(id)?.add(pageId)
  }

  // Page order after the diff; its first page receives elements whose page does not exist.
  const pageOrder = new Map(readable.map((pageId, index) => [pageId, index]))
  for (const id of removedPageIds) pageOrder.delete(id)
  for (const page of addedPages) pageOrder.set(page.id, page.index)
  for (const { after } of pageUpdates) if (pageOrder.has(after.id)) pageOrder.set(after.id, after.index)
  const pageIds = sortedIds(pageOrder)
  const livePages = new Set(pageIds)
  const firstPage = pageIds[0] as string | undefined

  // Before any operation, an element the hint knows as shown exists.
  const known = (id: string) => hint !== undefined && !hint.changed.has(id) && hint.read.records.get(id)?.record_type === 'element'
  const exists = (id: string) => known(id) || tx.exists(id)

  // The page and order key of every element the diff adds or moves (`null`: no page to put it
  // on), decided before any operation so that only the pages they touch are laid out.
  type Place = { pageId: string; key: number; relocated: boolean } | null
  const placeOf = (element: BoardElementRecord): Place => {
    if (livePages.has(element.page_id)) return { pageId: element.page_id, key: element.index, relocated: false }
    return firstPage === undefined ? null : { pageId: firstPage, key: RELOCATED + element.index, relocated: true }
  }
  const creationPlaces = creations.map(({ element }) => placeOf(element))
  // `undefined`: the element no longer exists (a merge removed it), so it is not moved.
  const movePlaces = moves.map(({ after }) => (exists(after.id) ? placeOf(after) : undefined))
  const placed = new Map<string, { pageId: string; key: number }>()
  creations.forEach(({ element }, index) => {
    const where = creationPlaces[index]
    if (where) placed.set(element.id, where)
  })
  moves.forEach(({ after }, index) => {
    const where = movePlaces[index]
    if (where) placed.set(after.id, where)
  })

  // Lists whose order changes: the pages of added, moved, and removed elements, wherever the
  // replica lists them (a merge may have listed one element on two pages).
  const touchedPages = new Set<string>()
  for (const [id, { pageId }] of placed) {
    touchedPages.add(pageId)
    for (const pageWithId of listedOn.get(id) ?? []) touchedPages.add(pageWithId)
  }
  for (const id of removedElementIds) for (const pageWithId of listedOn.get(id) ?? []) touchedPages.add(pageWithId)
  // Removing a page needs every element's placement; otherwise only the touched pages are laid out.
  const layout = readsLists
    ? boardLayout({ ...source, items: (pageId) => lists.get(pageId) ?? source.items(pageId) }, undefined, removedPages.length > 0 ? undefined : touchedPages)
    : null
  const layoutPages = new Map(layout?.pages.map((page) => [page.id, page]))

  for (const page of addedPages) tx.create('Page', { name: wellFormed(page.name) }, { id: page.id })
  for (const { before, after } of pageUpdates) {
    if (!tx.exists(after.id)) skipped.push(after.id)
    else if (before.name !== after.name) tx.set(after.id, 'name', wellFormed(after.name))
  }

  creations.forEach(({ element, fields }, index) => {
    const where = creationPlaces[index]
    if (!where) {
      skipped.push(element.id)
      return
    }
    if (where.relocated) relocated.push(element.id)
    tx.create('Element', fields, { id: element.id })
    const text = textOf(element)
    if (text) tx.textInsert(element.id, 'text', 0, text)
  })
  for (const { before, after, changed } of changes) {
    // An element a merge removed is not brought back by an edit made before the store saw it.
    if (!exists(after.id)) {
      skipped.push(after.id)
      continue
    }
    for (const [field, value] of changed) tx.set(after.id, field, value)
    writeText(tx, after.id, textOf(before), textOf(after))
  }
  moves.forEach(({ after }, index) => {
    const where = movePlaces[index]
    if (where === null) skipped.push(after.id)
    else if (where?.relocated) relocated.push(after.id)
  })

  for (const binding of diff.removed.filter(isBinding)) clearBinding(tx, binding)
  for (const binding of diff.added.filter(isBinding)) {
    if (!writeBinding(tx, binding)) skipped.push(binding.id)
  }
  for (const { before, after } of updates) {
    if (!isBinding(before) || !isBinding(after)) continue
    const previous = bindingTerminal(before)
    if (previous && (previous !== bindingTerminal(after) || before.from_id !== after.from_id)) clearBinding(tx, before)
    else if (sameValue(bindingValue(before), bindingValue(after))) continue
    if (!writeBinding(tx, after)) skipped.push(after.id)
  }

  for (const element of removedElements) {
    if (tx.exists(element.id)) tx.delete(element.id)
  }

  for (const pageId of touchedPages) {
    if (removedPageIds.has(pageId) || !tx.exists(pageId)) continue
    const page = layoutPages.get(pageId) ?? EMPTY_PAGE
    const order = new Map(page.elements.map((id, index) => [id, index]))
    for (const id of removedElementIds) order.delete(id)
    for (const [id, target] of placed) {
      if (target.pageId === pageId) order.set(id, target.key)
      else order.delete(id)
    }
    const unknown = new Set(page.items.filter((_, index) => page.states[index] === 'unknown'))
    syncListOrder(tx, pageId, 'elements', sortedIds(order), unknown)
  }

  if (pagesTouched) syncListOrder(tx, rootId, 'pages', pageIds)

  for (const pageId of removedPageIds) {
    if (!tx.exists(pageId)) continue
    for (const id of tx.listItems(pageId, 'elements')) {
      const home = placed.get(id)?.pageId ?? layout?.placement.get(id)?.pageId
      if ((home === undefined || home === pageId) && tx.exists(id)) tx.delete(id)
    }
    tx.delete(pageId)
  }
  return { skipped, relocated }
}

/**
 * Removes the list entries the reader skips because their element is shown on an earlier page or
 * earlier in the same list (see `findBoardDuplicatePlacements`). Answers how many it removed.
 */
export function repairBoardPlacements(tx: Tx, rootId: string): number {
  let removed = 0
  for (const page of boardLayout(txSource(tx, rootId)).pages) {
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
      if (page.states[index] !== 'duplicate') continue
      tx.listRemove(page.id, 'elements', index)
      removed += 1
    }
  }
  return removed
}

/** The reads of `boardLayout` through a transaction, so pending operations count. */
function txSource(tx: Tx, rootId: string): BoardLayoutSource {
  return {
    pageIds: () => (tx.exists(rootId) ? tx.listItems(rootId, 'pages') : []),
    isPage: (id) => tx.exists(id) && hasField(tx, id, 'name'),
    items: (pageId) => tx.listItems(pageId, 'elements'),
    objectState: (id) => {
      let kind: unknown
      try {
        kind = tx.get(id, 'kind')
      } catch {
        // No such object, or one without `kind` (not an element).
        return tx.exists(id) ? 'unknown' : 'missing'
      }
      return typeof kind === 'string' && BOARD_ELEMENT_KINDS.has(kind) ? 'element' : 'unknown'
    },
  }
}

/** Whether the object's type has `field` (`Page` has `name`, `Element` has `kind`). */
function hasField(tx: Tx, id: string, field: string): boolean {
  try {
    tx.get(id, field)
    return true
  } catch {
    return false
  }
}

/** `fields`, after refusing a number that is not finite anywhere in them. */
function checkedFields(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  for (const [field, value] of Object.entries(fields)) {
    if (!allFinite(value)) throw new Error(`Whiteboard element "${id}" has a number that is not finite in \`${field}\`; it cannot be saved.`)
  }
  return fields
}

function allFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (value === null || typeof value !== 'object') return true
  return Object.values(value).every(allFinite)
}

/**
 * The KDM fields of an element: every register field of the schema except the connector bindings
 * (written from binding records), `null` when absent, with the style flattened and strings as the
 * KDM stores them (`wellFormed`). Text is not a register and is written with `writeText`.
 */
function fieldsFromElement(element: WhiteboardElement): Record<string, unknown> {
  const source = element as Record<string, unknown>
  const fields: Record<string, unknown> = { kind: element.kind }
  for (const key of PLAIN_FIELDS) fields[key] = storedValue(source[key])
  for (const key of JSON_FIELDS) fields[key] = storedValue(source[key])
  fields.parent = storedValue(element.parentId)
  for (const key of BOARD_STYLE_FIELDS) fields[key] = storedValue(element.style?.[key])
  fields.image = element.kind === 'image'
    ? storedValue({ workspacePath: element.workspacePath, alt: element.alt })
    : null
  return fields
}

/**
 * `value` as the KDM stores it: `null` for `undefined`, object members holding `undefined` left
 * out, and lone surrogates in strings replaced with U+FFFD. Numbers are copied as they are, so
 * `checkedFields` can refuse one that is not finite.
 */
function storedValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return wellFormed(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(storedValue)
  const out: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value)) if (member !== undefined) out[wellFormed(key)] = storedValue(member)
  return out
}

/**
 * The string the KDM stores for `text`: every lone surrogate replaced with U+FFFD. The store may
 * use it so its records hold what the replica reads back.
 */
export function wellFormed(text: string): string {
  let out = ''
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0xd800 || unit > 0xdfff) continue
    if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(index + 1))) {
      index += 1
      continue
    }
    out += `${text.slice(start, index)}\ufffd`
    start = index + 1
  }
  return start === 0 ? text : out + text.slice(start)
}

/**
 * Applies the store's label edit `before` → `after` to the element's text as one deletion and one
 * insertion. The edit is the span between the common prefix and suffix of the two (never cutting
 * a surrogate pair). It is applied at its place when the replica's text still holds the store's
 * text up to the end of the span (an edit merged in after it) or from its start (an edit merged
 * in before it), so a concurrent edit elsewhere in the label survives; otherwise the replica's
 * text is replaced by `after` the same way.
 */
function writeText(tx: Tx, id: string, before: string, after: string): void {
  if (before === after) return
  const current = tx.text(id, 'text')
  if (current === after) return
  const edit = textEdit(before, after)
  const prefix = before.slice(0, edit.start)
  const removed = before.slice(edit.start, edit.end)
  const suffix = before.slice(edit.end)
  const removedLength = edit.end - edit.start
  const fromEnd = current.length - suffix.length - removedLength
  if (current.startsWith(prefix) && current.startsWith(removed, edit.start)) {
    applyEdit(tx, id, edit.start, removedLength, edit.inserted)
  } else if (fromEnd >= 0 && current.endsWith(suffix) && current.startsWith(removed, fromEnd)) {
    applyEdit(tx, id, fromEnd, removedLength, edit.inserted)
  } else {
    const fallback = textEdit(current, after)
    applyEdit(tx, id, fallback.start, fallback.end - fallback.start, fallback.inserted)
  }
}

/** The span `[start, end)` of `from` that `to` replaces with `inserted`, cut between characters. */
function textEdit(from: string, to: string): { start: number; end: number; inserted: string } {
  const shorter = Math.min(from.length, to.length)
  let start = 0
  while (start < shorter && from.charCodeAt(start) === to.charCodeAt(start)) start += 1
  if (start > 0 && isHighSurrogate(from.charCodeAt(start - 1))) start -= 1
  let end = 0
  while (end < shorter - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end += 1
  if (end > 0 && isLowSurrogate(from.charCodeAt(from.length - end))) end -= 1
  return { start, end: from.length - end, inserted: to.slice(start, to.length - end) }
}

function applyEdit(tx: Tx, id: string, index: number, count: number, inserted: string): void {
  if (count > 0) tx.textDelete(id, 'text', index, count)
  if (inserted) tx.textInsert(id, 'text', index, inserted)
}

/**
 * Makes a list equal to `target`: removes items not in it (and repeated items), keeps the longest
 * run already in order, and moves or inserts every other item right after its predecessor. Items
 * in `anchored` (objects the reader cannot show) are kept, after the target item they follow now.
 *
 * Positions are tracked without rescanning the list: every item has an order key, `(slot, 0)` for
 * the item at `slot` of the current list and `(slot of the last kept item before it in target,
 * distance from that item)` for an item moved or inserted; a Fenwick tree counts the keys present,
 * so an item's index is the number of present keys below its key.
 */
function syncListOrder(tx: Tx, ownerId: string, field: string, wanted: readonly string[], anchored: ReadonlySet<string> = new Set()): void {
  const listed = tx.listItems(ownerId, field)
  const target = anchored.size > 0 ? withAnchored(listed, wanted, anchored) : wanted
  const position = new Map(target.map((id, index) => [id, index]))
  const seen = new Set<string>()
  const keep = listed.map((id) => {
    if (!position.has(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
  for (let index = listed.length - 1; index >= 0; index -= 1) {
    if (!keep[index]) tx.listRemove(ownerId, field, index)
  }
  const current = listed.filter((_, index) => keep[index])
  // Usually what is left is already in order and the rest are insertions (an add, a delete).
  let previous = -1
  if (current.every((id) => {
    const at = position.get(id) ?? -1
    const ordered = at > previous
    previous = at
    return ordered
  })) {
    target.forEach((id, index) => {
      if (!seen.has(id)) tx.listInsert(ownerId, field, index, id)
    })
    return
  }
  const stable = new Set(longestIncreasingRun(current.map((id) => position.get(id) ?? 0)).map((index) => current[index]))

  const width = target.length + 2
  const keyOf = new Map(current.map((id, slot) => [id, (slot + 1) * width]))
  let anchorBase = 0
  let anchorIndex = -1
  const newKeys = target.map((id, index) => {
    if (!stable.has(id)) return anchorBase + index - anchorIndex
    anchorBase = keyOf.get(id) ?? 0
    anchorIndex = index
    return -1
  })
  const sorted = Float64Array.from([...keyOf.values(), ...newKeys.filter((key) => key >= 0)]).sort()
  const rank = new Map<number, number>()
  sorted.forEach((key, index) => rank.set(key, index))
  const present = new Counts(sorted.length)
  for (const key of keyOf.values()) present.add(rank.get(key) ?? 0, 1)

  target.forEach((id, index) => {
    const key = newKeys[index]
    if (key < 0) return
    const old = keyOf.get(id)
    let from = -1
    if (old !== undefined) {
      const oldRank = rank.get(old) ?? 0
      from = present.below(oldRank)
      present.add(oldRank, -1)
    }
    const newRank = rank.get(key) ?? 0
    const to = present.below(newRank)
    present.add(newRank, 1)
    keyOf.set(id, key)
    if (from === -1) tx.listInsert(ownerId, field, to, id)
    else if (from !== to) tx.listMove(ownerId, field, from, to)
  })
}

/** A Fenwick tree of counts at positions `0..size-1`. */
class Counts {
  private readonly tree: Int32Array

  constructor(size: number) {
    this.tree = new Int32Array(size + 1)
  }

  add(position: number, delta: number): void {
    for (let node = position + 1; node < this.tree.length; node += node & -node) this.tree[node] += delta
  }

  /** The total count at positions below `position`. */
  below(position: number): number {
    let total = 0
    for (let node = position; node > 0; node -= node & -node) total += this.tree[node]
    return total
  }
}

/** `target` with each `anchored` item of `current` right after the target item it follows in `current`. */
function withAnchored(current: readonly string[], target: readonly string[], anchored: ReadonlySet<string>): string[] {
  const inTarget = new Set(target)
  const following = new Map<string | null, string[]>()
  const kept = new Set<string>()
  let anchor: string | null = null
  for (const id of current) {
    if (inTarget.has(id)) anchor = id
    else if (anchored.has(id) && !kept.has(id)) {
      kept.add(id)
      following.set(anchor, [...(following.get(anchor) ?? []), id])
    }
  }
  const out = [...(following.get(null) ?? [])]
  for (const id of target) out.push(id, ...(following.get(id) ?? []))
  return out
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

/** Ids by index, then id, as the store orders records. */
function sortedIds(order: Map<string, number>): string[] {
  return [...order].sort(([left, a], [right, b]) => a - b || left.localeCompare(right)).map(([id]) => id)
}

/** Stores a binding on its connector; `false` when the connector no longer exists. */
function writeBinding(tx: Tx, binding: BoardBindingRecord): boolean {
  const terminal = bindingTerminal(binding)
  if (!tx.exists(binding.from_id)) return false
  if (terminal) tx.set(binding.from_id, `${terminal}Binding`, bindingValue(binding))
  return true
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
  return element.kind === 'rectangle' || element.kind === 'text' ? wellFormed(element.text ?? '') : ''
}

function withoutNulls(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null))
}

/** Whether two element records differ at most in their page and index. */
function sameExceptPlacement(before: BoardElementRecord, after: BoardElementRecord): boolean {
  const left = before as Record<string, unknown>
  const right = after as Record<string, unknown>
  for (const key of Object.keys(right)) {
    if (key !== 'index' && key !== 'page_id' && !sameValue(left[key], right[key])) return false
  }
  for (const key of Object.keys(left)) {
    if (key !== 'index' && key !== 'page_id' && !Object.hasOwn(right, key) && left[key] !== undefined) return false
  }
  return true
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left === 'number' && typeof right === 'number') return Number.isNaN(left) && Number.isNaN(right)
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
