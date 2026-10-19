import { agent, person, randomActor, Replica } from '@kition/kdm'
import { createBoardFromRecords, createEmptyBoard } from '../kdm/boardKdmFile'
import { readBoardRecords, readBoardTitle } from '../kdm/boardKdmRead'
import { BoardReplicaHistory, type BoardCommit } from '../kdm/boardReplicaBridge'
import { boardSchema } from '../kdm/boardSchema'
import {
  BOARD_META_RECORD_ID,
  DEFAULT_BOARD_PAGE_ID,
  boardElementFromRecord,
  cloneBoardRecord,
  compareBoardRecords,
  createBoardBaseRecords,
  type BoardElementRecord,
  type BoardMetaRecord,
  type BoardPageRecord,
  type BoardRecord,
} from './boardRecords'
import { repairBoardHierarchyRecords } from './boardHierarchy'
import { repairBoardBindingRecords } from './boardBindingEngine'
import { BoardSpatialIndex } from './boardSpatialIndex'
import type { WhiteboardBounds, WhiteboardElement, WhiteboardPoint } from './whiteboardTypes'
import {
  boardRecordsEqual,
  diffBoardRecords,
  isBoardRecordDiffEmpty,
  type BoardRecordDiff,
} from './boardRecordDiff'

export type { BoardRecordDiff } from './boardRecordDiff'
export { reverseBoardRecordDiff, squashBoardRecordDiffs } from './boardRecordDiff'

export type BoardHistoryEntry = {
  label: string
  diff: BoardRecordDiff
  source: 'agent' | 'user'
}

/**
 * A point in the undo history that later commands can be squashed into one undo step or bailed
 * back to. The outermost open mark holds the replica's undo group.
 */
export type BoardHistoryMark = {
  generation: number
  /** Undo steps of this store when the mark was taken. */
  depth: number
  serial: number
  /** The record view when the mark was taken. */
  baseline: ReadonlyMap<string, BoardRecord>
  /** The user operation count when the mark was taken. */
  operations: number
}

export type BoardStoreSnapshot = {
  revision: number
  canUndo: boolean
  canRedo: boolean
  isTransacting: boolean
}

type BoardTransactionOptions = {
  live?: boolean
  source?: BoardHistoryEntry['source']
}

/** The principals of local transactions; authorization never relies on them. */
const LOCAL_PERSON = 'user:local'
const LOCAL_AGENT = 'agent:whiteboard'
const RECENT_OPERATION_LIMIT = 100

/**
 * The whiteboard's records, backed by a KDM replica. The `Map` of records is the view the editor
 * reads and edits: transactions change it directly (live gestures notify on every change) and
 * write their diff to the replica as one field-level KDM transaction when they commit. Undo,
 * redo, imports, and loads rebuild the view from the replica. The meta record (current page) is
 * view state: it is never written to the replica and never an undo step.
 */
export class BoardStore {
  private history!: BoardReplicaHistory
  private records = new Map<string, BoardRecord>()
  private listeners = new Set<() => void>()
  private activeTransaction: BoardTransaction | null = null
  /** Bumped when the history restarts (a new replica); older marks are void. */
  private historyGeneration = 0
  private markSerial = 0
  /** Set when an import arrived during a transaction: the view is rebuilt when it ends. */
  private viewStale = false
  private recentOperations: Array<{ serial: number; label: string }> = []
  private operationSerial = 0
  private recordsCache: readonly BoardRecord[] | null = null
  private elementsCache: readonly WhiteboardElement[] | null = null
  private readonly spatialIndex = new BoardSpatialIndex()
  /** A board this person may only view (a co-edited board they are a viewer of): nothing commits. */
  private readOnly = false
  private revision = 0
  private storeSnapshot: BoardStoreSnapshot = {
    revision: 0,
    canUndo: false,
    canRedo: false,
    isTransacting: false,
  }

  /**
   * A store over `source`: a replica (repaired once if its records need it), records (built into
   * a new replica, as `replaceRecords` does), or nothing (a new empty board).
   */
  constructor(source?: Replica | readonly BoardRecord[]) {
    if (source instanceof Replica) this.adopt(source, { repair: true })
    else if (source) this.replaceRecords(source, { notify: false })
    else this.adopt(createEmptyBoard('Board', randomActor()), { repair: false })
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = () => this.storeSnapshot

  /**
   * Makes the board view-only (or editable again): a transaction then commits nothing (its live
   * changes are reverted), and undo and redo do nothing. Merges still arrive.
   */
  setReadOnly(readOnly: boolean) {
    this.readOnly = readOnly
  }

  isReadOnly() {
    return this.readOnly
  }

  /** The KDM document behind the view. Change it only through this store. */
  getReplica(): Replica {
    return this.history.replica
  }

  /** The whole document as KDM snapshot bytes. */
  snapshot(): Uint8Array {
    return this.history.replica.snapshot()
  }

  getRecords(): readonly BoardRecord[] {
    if (!this.recordsCache) {
      this.recordsCache = [...this.records.values()]
        .map(cloneBoardRecord)
        .sort(compareBoardRecords)
    }
    return this.recordsCache
  }

  getRecord(id: string): BoardRecord | null {
    const record = this.records.get(id)
    return record ? cloneBoardRecord(record) : null
  }

  getElementRecord(id: string): BoardElementRecord | null {
    const record = this.records.get(id)
    return record?.record_type === 'element'
      ? cloneBoardRecord(record) as BoardElementRecord
      : null
  }

  getCurrentPageId() {
    const meta = this.records.get(BOARD_META_RECORD_ID)
    return meta?.record_type === 'meta'
      ? meta.active_page_id
      : DEFAULT_BOARD_PAGE_ID
  }

  /** Shows the page `pageId`: view state only, not an undo step. Answers whether the page changed. */
  setActivePage(pageId: string) {
    if (this.records.get(pageId)?.record_type !== 'page') return false
    if (this.getCurrentPageId() === pageId) return false
    this.records.set(BOARD_META_RECORD_ID, createMetaRecord(pageId))
    this.invalidateCaches()
    this.notify()
    return true
  }

  getPages() {
    return this.getRecords().filter((record): record is BoardPageRecord => (
      record.record_type === 'page'
    ))
  }

  getCurrentPageElements(): readonly WhiteboardElement[] {
    if (!this.elementsCache) {
      const pageId = this.getCurrentPageId()
      this.elementsCache = this.getRecords()
        .filter((record): record is BoardElementRecord => (
          record.record_type === 'element' && record.page_id === pageId
        ))
        .map(boardElementFromRecord)
      this.spatialIndex.sync(this.elementsCache)
    }
    return this.elementsCache
  }

  queryCurrentPageElements(bounds: WhiteboardBounds) {
    this.getCurrentPageElements()
    return this.spatialIndex.query(bounds)
  }

  queryCurrentPageElementsAtPoint(point: WhiteboardPoint, tolerance = 0) {
    this.getCurrentPageElements()
    return this.spatialIndex.queryPoint(point, tolerance)
  }

  getNextElementIndex(pageId = this.getCurrentPageId()) {
    let next = 0
    for (const record of this.records.values()) {
      if (record.record_type === 'element' && record.page_id === pageId) {
        next = Math.max(next, record.index + 1)
      }
    }
    return next
  }

  /** Labels of the latest committed user operations, newest first (context for the agent). */
  getRecentUserOperations(limit = 50) {
    return this.recentOperations
      .slice(-Math.max(0, limit))
      .reverse()
      .map((entry) => entry.label)
  }

  /**
   * Replaces the board with `records` in a new replica whose history starts empty: the board is
   * built in the replica's creating commit, so it is not an undo step.
   */
  replaceRecords(
    records: readonly BoardRecord[],
    options: { notify?: boolean } = {},
  ) {
    if (this.activeTransaction) this.activeTransaction.cancel()
    const normalized = normalizeBoardRecords(records)
    const previous = this.history?.replica
    const title = previous ? readBoardTitle(previous) : 'Board'
    const replica = createBoardFromRecords(title, previous?.actor ?? randomActor(), [...normalized.values()])
    this.records = new Map([[BOARD_META_RECORD_ID, normalized.get(BOARD_META_RECORD_ID)!]])
    this.adopt(replica, { repair: false })
    if (options.notify !== false) this.notify()
  }

  /**
   * Opens `replica` (a loaded document) as this store's board, repaired once if its records need
   * it, with a history that starts empty. The current page is kept when the board has it.
   */
  load(replica: Replica) {
    if (this.activeTransaction) this.activeTransaction.cancel()
    this.adopt(replica, { repair: true })
    this.notify()
  }

  /**
   * Merges changes from another copy of the document (`Replica.exportChanges` or a snapshot) and
   * rebuilds the view, repairing what the merge left inconsistent. During a marked gesture (an open
   * undo group) the changes wait until it ends; during a transaction the view is rebuilt when the
   * transaction ends. Changes of another document are refused (`wrong-document`).
   */
  importChanges(bytes: Uint8Array) {
    if (!this.history.importChanges(bytes)) return
    if (this.activeTransaction) {
      this.viewStale = true
      return
    }
    this.rebuildView({ repair: true })
    this.notify()
  }

  /**
   * Follows changes made to the replica outside this store (a kit session's import, undo, or
   * redo, which took the changed objects from the replica itself): rebuilds the view from the
   * objects `changed`, repairing what the change left inconsistent, as `importChanges` does.
   */
  followReplica(changed: Iterable<string>) {
    this.history.noteChanged(changed)
    if (this.activeTransaction) {
      this.viewStale = true
      return
    }
    this.rebuildView({ repair: true })
    this.notify()
  }

  transact(
    label: string,
    update: (transaction: BoardTransaction) => void,
    options: BoardTransactionOptions = {},
  ): BoardRecordDiff | null {
    const transaction = this.beginTransaction(label, options)
    try {
      update(transaction)
      return transaction.commit()
    } catch (error) {
      transaction.cancel()
      throw error
    }
  }

  beginTransaction(
    label: string,
    options: BoardTransactionOptions = {},
  ) {
    if (this.activeTransaction) {
      throw new Error('Board store already has an active transaction')
    }
    const transaction = new BoardTransaction(
      this,
      label,
      Boolean(options.live),
      options.source || 'user',
    )
    this.activeTransaction = transaction
    return transaction
  }

  /** Undoes this replica's last undo step (an open undo group ends first). */
  undo() {
    return this.step('undo')
  }

  redo() {
    return this.step('redo')
  }

  /** Starts the history afresh: the same document in a new replica without undo steps. */
  clearHistory() {
    this.history.closeGroup()
    if (!this.history.canUndo() && !this.history.canRedo()) return
    const { replica } = this.history
    this.adopt(Replica.load(boardSchema, replica.snapshot(), replica.actor), { repair: false, keepView: true })
    this.notify()
  }

  /**
   * Marks the history: the commands until `squashToMark` become one undo step. The outermost open
   * mark opens the replica's undo group; inner marks share it.
   */
  markHistory(): BoardHistoryMark {
    this.markSerial += 1
    this.history.openGroup(this.markSerial)
    return {
      generation: this.historyGeneration,
      depth: this.history.depth,
      serial: this.markSerial,
      baseline: new Map(this.records),
      operations: this.operationSerial,
    }
  }

  /**
   * Makes the changes since `mark` one undo step labelled `label`. A mark whose group already
   * ended may be squashed again: its later undo steps are merged into one.
   */
  squashToMark(mark: BoardHistoryMark, label: string) {
    if (!this.isUsableHistoryMark(mark)) return null
    if (this.history.group === mark.serial) this.history.closeGroup()
    else if (this.history.group === null && this.history.depth - mark.depth > 1) this.mergeStepsSince(mark)
    if (this.dropOperationsSince(mark)) this.recordOperation(label)
    const diff = diffBoardRecords(mark.baseline, this.records)
    if (this.history.flushImports()) this.rebuildView({ repair: true })
    this.notify()
    return isBoardRecordDiffEmpty(diff) ? null : diff
  }

  /** Reverts the changes since `mark` without leaving a redo step. */
  bailToMark(mark: BoardHistoryMark) {
    if (!this.isUsableHistoryMark(mark)) return null
    if (this.activeTransaction) this.activeTransaction.cancel()
    const diff = diffBoardRecords(mark.baseline, this.records)
    const group = this.history.group
    if (group === null || group === mark.serial) {
      this.history.closeGroup()
      if (this.history.undoTo(mark.depth)) this.history.clearRedo()
    } else {
      // An inner mark: the way back joins the outer mark's undo group.
      this.history.commit(diffBoardRecords(this.records, mark.baseline), person(LOCAL_PERSON))
    }
    this.dropOperationsSince(mark)
    this.history.flushImports()
    this.rebuildView({ repair: false })
    this.notify()
    return isBoardRecordDiffEmpty(diff) ? null : diff
  }

  finishTransaction(transaction: BoardTransaction, mode: 'commit' | 'cancel') {
    if (this.activeTransaction !== transaction) {
      throw new Error('Board transaction is no longer active')
    }
    this.activeTransaction = null

    if (mode === 'cancel') {
      const restored = transaction.restoreBeforeRecords()
      if (this.refreshStaleView() || restored || transaction.live) this.notify()
      return null
    }

    const diff = transaction.createDiff()
    if (isBoardRecordDiffEmpty(diff)) {
      if (this.refreshStaleView() || transaction.live) this.notify()
      return null
    }
    if (this.readOnly) {
      transaction.restoreBeforeRecords()
      this.refreshStaleView()
      this.notify()
      return null
    }
    const origin = transaction.source === 'agent'
      ? agent(LOCAL_AGENT, transaction.label)
      : person(LOCAL_PERSON, transaction.label)
    let committed: BoardCommit
    try {
      committed = this.history.commit(diff, origin)
    } catch (error) {
      transaction.restoreBeforeRecords()
      this.refreshStaleView()
      this.notify()
      throw error
    }
    if (committed.changed && transaction.source === 'user') this.recordOperation(transaction.label)
    if (!this.refreshStaleView()) this.readBack(diff, committed)
    this.notify()
    return diff
  }

  readInternalRecord(id: string) {
    return this.records.get(id)
  }

  writeInternalRecord(record: BoardRecord, live: boolean) {
    const current = this.records.get(record.id)
    const next = cloneBoardRecord(record)
    if (current && boardRecordsEqual(current, next)) return false
    this.records.set(next.id, next)
    this.invalidateCaches()
    if (live) this.notify()
    return true
  }

  removeInternalRecord(id: string, live: boolean) {
    if (!this.records.delete(id)) return false
    this.invalidateCaches()
    if (live) this.notify()
    return true
  }

  /** Makes `replica` the document of this store, with a fresh history. */
  private adopt(replica: Replica, options: { repair: boolean; keepView?: boolean }) {
    this.history = new BoardReplicaHistory(replica)
    this.historyGeneration += 1
    this.viewStale = false
    if (options.keepView) this.invalidateCaches()
    else this.rebuildView({ repair: options.repair })
  }

  /**
   * Rebuilds the view from the replica, keeping the current page: re-reads what changed since the
   * last read (`BoardReplicaHistory.read`) and normalizes the result, keeping the records it does
   * not change. With `repair`, what `normalizeBoardRecords` corrects in persisted data (dangling
   * parents and bindings, connector ends) and duplicate list placements left by merges are
   * repaired in one `system` transaction, which is not an undo step; a healthy board writes nothing.
   */
  private rebuildView(options: { repair: boolean }) {
    const { records, duplicates } = this.history.read()
    const meta = this.records.get(BOARD_META_RECORD_ID)
    const view = normalizeBoardRecords(meta ? [meta, ...records.values()] : records.values())
    if (options.repair) this.history.repair(diffBoardRecords(records, view), duplicates)
    this.records = view
    this.invalidateCaches()
  }

  /**
   * Re-reads from the replica what a commit could not write as asked (an element or page an import
   * deleted during the gesture, an element placed on a page the document lacks), so the view shows
   * what the document has and no ghost stays on the canvas.
   */
  private readBack(diff: BoardRecordDiff, written: BoardCommit) {
    const { put, removed } = this.history.readBack(this.records, diff, written)
    for (const id of removed) this.removeInternalRecord(id, false)
    for (const record of put) this.writeInternalRecord(record, false)
    if (removed.length > 0 && this.records.get(this.getCurrentPageId())?.record_type !== 'page') {
      const first = this.getPages()[0]
      if (first) this.records.set(BOARD_META_RECORD_ID, createMetaRecord(first.id))
      this.invalidateCaches()
    }
  }

  /** Rebuilds a view that imports made stale during a transaction; answers whether it did. */
  private refreshStaleView() {
    if (!this.viewStale) return false
    this.viewStale = false
    this.rebuildView({ repair: true })
    return true
  }

  private step(direction: 'undo' | 'redo') {
    if (this.readOnly) return null
    if (this.activeTransaction) this.activeTransaction.cancel()
    this.history.closeGroup()
    if (this.history.flushImports()) this.rebuildView({ repair: true })
    const before = this.records
    if (!(direction === 'undo' ? this.history.undo() : this.history.redo())) return null
    this.rebuildView({ repair: false })
    this.notify()
    return diffBoardRecords(before, this.records)
  }

  /**
   * Turns the undo steps since `mark` into one: undoes them, then writes the difference to the
   * state they had reached as one transaction.
   */
  private mergeStepsSince(mark: BoardHistoryMark) {
    const target = this.records
    this.history.undoTo(mark.depth)
    this.rebuildView({ repair: false })
    this.history.commit(diffBoardRecords(this.records, target), person(LOCAL_PERSON))
    this.history.clearRedo()
    this.rebuildView({ repair: false })
  }

  private recordOperation(label: string) {
    this.operationSerial += 1
    this.recentOperations.push({ serial: this.operationSerial, label })
    if (this.recentOperations.length > RECENT_OPERATION_LIMIT) this.recentOperations.shift()
  }

  /** Forgets the user operations recorded since `mark`; answers whether there were any. */
  private dropOperationsSince(mark: BoardHistoryMark) {
    const kept = this.recentOperations.filter((entry) => entry.serial <= mark.operations)
    const removed = kept.length !== this.recentOperations.length
    this.recentOperations = kept
    return removed
  }

  private invalidateCaches() {
    this.recordsCache = null
    this.elementsCache = null
  }

  private isUsableHistoryMark(mark: BoardHistoryMark) {
    return mark.generation === this.historyGeneration
      && mark.depth >= 0
      && mark.depth <= this.history.depth
  }

  private notify() {
    this.revision += 1
    this.storeSnapshot = {
      revision: this.revision,
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
      isTransacting: this.activeTransaction !== null,
    }
    for (const listener of this.listeners) listener()
  }
}

export class BoardTransaction {
  private before = new Map<string, BoardRecord | undefined>()
  private active = true

  constructor(
    private store: BoardStore,
    readonly label: string,
    readonly live: boolean,
    readonly source: BoardHistoryEntry['source'],
  ) {}

  get(id: string) {
    this.assertActive()
    const record = this.store.readInternalRecord(id)
    return record ? cloneBoardRecord(record) : null
  }

  put(record: BoardRecord) {
    this.assertActive()
    this.captureBefore(record.id)
    this.store.writeInternalRecord(record, this.live)
    return this
  }

  remove(id: string) {
    this.assertActive()
    this.captureBefore(id)
    this.store.removeInternalRecord(id, this.live)
    return this
  }

  commit() {
    this.assertActive()
    this.active = false
    return this.store.finishTransaction(this, 'commit')
  }

  cancel() {
    if (!this.active) return null
    this.active = false
    return this.store.finishTransaction(this, 'cancel')
  }

  createDiff(): BoardRecordDiff {
    const diff: BoardRecordDiff = {
      added: [],
      updated: [],
      removed: [],
    }
    for (const [id, before] of this.before) {
      const after = this.store.readInternalRecord(id)
      if (!before && after) diff.added.push(cloneBoardRecord(after))
      else if (before && !after) diff.removed.push(cloneBoardRecord(before))
      else if (before && after && !boardRecordsEqual(before, after)) {
        diff.updated.push({
          before: cloneBoardRecord(before),
          after: cloneBoardRecord(after),
        })
      }
    }
    diff.added.sort(compareBoardRecords)
    diff.removed.sort(compareBoardRecords)
    diff.updated.sort((left, right) => compareBoardRecords(left.after, right.after))
    return diff
  }

  restoreBeforeRecords() {
    let changed = false
    for (const [id, before] of this.before) {
      if (before) changed = this.store.writeInternalRecord(before, false) || changed
      else changed = this.store.removeInternalRecord(id, false) || changed
    }
    return changed
  }

  private captureBefore(id: string) {
    if (this.before.has(id)) return
    const record = this.store.readInternalRecord(id)
    this.before.set(id, record ? cloneBoardRecord(record) : undefined)
  }

  private assertActive() {
    if (!this.active) throw new Error('Board transaction is no longer active')
  }
}

/**
 * The view of `records`: one page at least, a meta record naming an existing page, pages indexed
 * in order, elements on existing pages, and hierarchy and bindings repaired. Records it does not
 * change are kept as they are (the same objects), so diffs against the previous view stay cheap.
 */
function normalizeBoardRecords(records: Iterable<BoardRecord>) {
  const normalized = new Map<string, BoardRecord>()
  for (const record of records) {
    if (!normalized.has(record.id)) normalized.set(record.id, record)
  }

  const pages = [...normalized.values()]
    .filter((record): record is BoardPageRecord => record.record_type === 'page')
  if (pages.length === 0) {
    const page = createBoardBaseRecords()[1] as BoardPageRecord
    normalized.set(page.id, page)
    pages.push(page)
  }
  const pageIds = new Set(pages.map((page) => page.id))

  const meta = normalized.get(BOARD_META_RECORD_ID)
  const activePageId = meta?.record_type === 'meta' && pageIds.has(meta.active_page_id)
    ? meta.active_page_id
    : pages[0].id
  normalized.set(BOARD_META_RECORD_ID, meta?.record_type === 'meta' && meta.active_page_id === activePageId
    ? meta
    : createMetaRecord(activePageId))

  pages
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
    .forEach((page, index) => {
      if (page.index !== index) normalized.set(page.id, { ...page, index })
    })

  const elements: BoardElementRecord[] = []
  for (const record of normalized.values()) {
    if (record.record_type !== 'element') continue
    if (pageIds.has(record.page_id)) elements.push(record)
    else {
      const moved = { ...record, page_id: activePageId }
      normalized.set(record.id, moved)
      elements.push(moved)
    }
  }
  const repairedElements = repairBoardHierarchyRecords(elements)
  repairedElements.forEach((record, index) => {
    if (record !== elements[index]) normalized.set(record.id, record)
  })
  const repairedRecords = repairBoardBindingRecords([...normalized.values()])
  normalized.clear()
  for (const record of repairedRecords) normalized.set(record.id, record)
  return normalized
}

function createMetaRecord(pageId: string): BoardMetaRecord {
  return {
    record_type: 'meta',
    id: BOARD_META_RECORD_ID,
    active_page_id: pageId,
  }
}
