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
import type { WhiteboardElement } from './whiteboardTypes'

export type BoardRecordUpdate = {
  before: BoardRecord
  after: BoardRecord
}

export type BoardRecordDiff = {
  added: BoardRecord[]
  updated: BoardRecordUpdate[]
  removed: BoardRecord[]
}

export type BoardHistoryEntry = {
  label: string
  diff: BoardRecordDiff
  source: 'agent' | 'user'
}

export type BoardHistoryMark = {
  generation: number
  depth: number
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

const EMPTY_DIFF: BoardRecordDiff = {
  added: [],
  updated: [],
  removed: [],
}

export class BoardStore {
  private records = new Map<string, BoardRecord>()
  private listeners = new Set<() => void>()
  private past: BoardHistoryEntry[] = []
  private future: BoardHistoryEntry[] = []
  private activeTransaction: BoardTransaction | null = null
  private historyGeneration = 0
  private recordsCache: readonly BoardRecord[] | null = null
  private elementsCache: readonly WhiteboardElement[] | null = null
  private revision = 0
  private snapshot: BoardStoreSnapshot = {
    revision: 0,
    canUndo: false,
    canRedo: false,
    isTransacting: false,
  }

  constructor(records: readonly BoardRecord[] = createBoardBaseRecords()) {
    this.replaceRecords(records, { notify: false })
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = () => this.snapshot

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

  getCurrentPageElements(): readonly WhiteboardElement[] {
    if (!this.elementsCache) {
      const pageId = this.getCurrentPageId()
      this.elementsCache = this.getRecords()
        .filter((record): record is BoardElementRecord => (
          record.record_type === 'element' && record.page_id === pageId
        ))
        .map(boardElementFromRecord)
    }
    return this.elementsCache
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

  getRecentUserOperations(limit = 50) {
    return this.past
      .filter((entry) => entry.source === 'user')
      .slice(-Math.max(0, limit))
      .reverse()
      .map((entry) => entry.label)
  }

  replaceRecords(
    records: readonly BoardRecord[],
    options: { notify?: boolean } = {},
  ) {
    if (this.activeTransaction) this.activeTransaction.cancel()
    this.records = normalizeBoardRecords(records)
    this.past = []
    this.future = []
    this.historyGeneration += 1
    this.invalidateCaches()
    if (options.notify !== false) this.notify()
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

  undo() {
    if (this.activeTransaction) this.activeTransaction.cancel()
    const entry = this.past.pop()
    if (!entry) return null
    this.applyDiff(entry.diff, 'inverse')
    this.future.push(entry)
    this.notify()
    return entry.diff
  }

  redo() {
    if (this.activeTransaction) this.activeTransaction.cancel()
    const entry = this.future.pop()
    if (!entry) return null
    this.applyDiff(entry.diff, 'forward')
    this.past.push(entry)
    this.notify()
    return entry.diff
  }

  clearHistory() {
    if (this.past.length === 0 && this.future.length === 0) return
    this.past = []
    this.future = []
    this.historyGeneration += 1
    this.notify()
  }

  markHistory(): BoardHistoryMark {
    return {
      generation: this.historyGeneration,
      depth: this.past.length,
    }
  }

  squashToMark(mark: BoardHistoryMark, label: string) {
    if (!this.isUsableHistoryMark(mark)) return null
    const entries = this.past.slice(mark.depth)
    if (entries.length === 0) return null
    const diff = squashBoardRecordDiffs(entries.map((entry) => entry.diff))
    this.past = this.past.slice(0, mark.depth)
    if (!isBoardRecordDiffEmpty(diff)) {
      const source = entries.some((entry) => entry.source === 'agent') ? 'agent' : 'user'
      this.past.push({ label, diff, source })
    }
    this.future = []
    this.notify()
    return diff
  }

  bailToMark(mark: BoardHistoryMark) {
    if (!this.isUsableHistoryMark(mark)) return null
    const entries = this.past.slice(mark.depth)
    if (entries.length === 0) return null
    const diff = squashBoardRecordDiffs(entries.map((entry) => entry.diff))
    this.applyDiff(diff, 'inverse')
    this.past = this.past.slice(0, mark.depth)
    this.future = []
    this.notify()
    return diff
  }

  finishTransaction(transaction: BoardTransaction, mode: 'commit' | 'cancel') {
    if (this.activeTransaction !== transaction) {
      throw new Error('Board transaction is no longer active')
    }
    this.activeTransaction = null

    if (mode === 'cancel') {
      const restored = transaction.restoreBeforeRecords()
      if (restored || transaction.live) this.notify()
      return null
    }

    const diff = transaction.createDiff()
    if (isBoardRecordDiffEmpty(diff)) {
      if (transaction.live) this.notify()
      return null
    }
    this.past.push({
      label: transaction.label,
      diff,
      source: transaction.source,
    })
    this.future = []
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

  private applyDiff(diff: BoardRecordDiff, direction: 'forward' | 'inverse') {
    if (direction === 'forward') {
      for (const record of diff.removed) this.records.delete(record.id)
      for (const update of diff.updated) {
        this.records.set(update.after.id, cloneBoardRecord(update.after))
      }
      for (const record of diff.added) {
        this.records.set(record.id, cloneBoardRecord(record))
      }
    } else {
      for (const record of diff.added) this.records.delete(record.id)
      for (const update of diff.updated) {
        this.records.set(update.before.id, cloneBoardRecord(update.before))
      }
      for (const record of diff.removed) {
        this.records.set(record.id, cloneBoardRecord(record))
      }
    }
    this.records = normalizeBoardRecords(this.records.values())
    this.invalidateCaches()
  }

  private invalidateCaches() {
    this.recordsCache = null
    this.elementsCache = null
  }

  private isUsableHistoryMark(mark: BoardHistoryMark) {
    return mark.generation === this.historyGeneration
      && mark.depth >= 0
      && mark.depth <= this.past.length
  }

  private notify() {
    this.revision += 1
    this.snapshot = {
      revision: this.revision,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
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

export function reverseBoardRecordDiff(diff: BoardRecordDiff): BoardRecordDiff {
  return {
    added: diff.removed.map(cloneBoardRecord),
    updated: diff.updated.map((update) => ({
      before: cloneBoardRecord(update.after),
      after: cloneBoardRecord(update.before),
    })),
    removed: diff.added.map(cloneBoardRecord),
  }
}

export function squashBoardRecordDiffs(
  diffs: readonly BoardRecordDiff[],
): BoardRecordDiff {
  const transitions = new Map<string, {
    before: BoardRecord | undefined
    after: BoardRecord | undefined
  }>()

  for (const diff of diffs) {
    for (const record of diff.added) {
      const transition = transitions.get(record.id)
      transitions.set(record.id, {
        before: transition?.before,
        after: cloneBoardRecord(record),
      })
    }
    for (const update of diff.updated) {
      const transition = transitions.get(update.after.id)
      transitions.set(update.after.id, {
        before: transition ? transition.before : cloneBoardRecord(update.before),
        after: cloneBoardRecord(update.after),
      })
    }
    for (const record of diff.removed) {
      const transition = transitions.get(record.id)
      transitions.set(record.id, {
        before: transition ? transition.before : cloneBoardRecord(record),
        after: undefined,
      })
    }
  }

  const squashed: BoardRecordDiff = {
    added: [],
    updated: [],
    removed: [],
  }
  for (const transition of transitions.values()) {
    if (!transition.before && transition.after) {
      squashed.added.push(cloneBoardRecord(transition.after))
    } else if (transition.before && !transition.after) {
      squashed.removed.push(cloneBoardRecord(transition.before))
    } else if (
      transition.before
      && transition.after
      && !boardRecordsEqual(transition.before, transition.after)
    ) {
      squashed.updated.push({
        before: cloneBoardRecord(transition.before),
        after: cloneBoardRecord(transition.after),
      })
    }
  }
  squashed.added.sort(compareBoardRecords)
  squashed.removed.sort(compareBoardRecords)
  squashed.updated.sort((left, right) => compareBoardRecords(left.after, right.after))
  return squashed
}

export function isBoardRecordDiffEmpty(diff: BoardRecordDiff) {
  return diff.added.length === 0
    && diff.updated.length === 0
    && diff.removed.length === 0
}

function normalizeBoardRecords(records: Iterable<BoardRecord>) {
  const normalized = new Map<string, BoardRecord>()
  for (const record of records) {
    if (!normalized.has(record.id)) normalized.set(record.id, cloneBoardRecord(record))
  }

  const pages = [...normalized.values()]
    .filter((record): record is BoardPageRecord => record.record_type === 'page')
  if (pages.length === 0) {
    const page = createBoardBaseRecords()[1] as BoardPageRecord
    normalized.set(page.id, page)
    pages.push(page)
  }

  const meta = normalized.get(BOARD_META_RECORD_ID)
  const activePageId = meta?.record_type === 'meta'
    && pages.some((page) => page.id === meta.active_page_id)
    ? meta.active_page_id
    : pages[0].id
  const normalizedMeta: BoardMetaRecord = {
    record_type: 'meta',
    id: BOARD_META_RECORD_ID,
    active_page_id: activePageId,
  }
  normalized.set(normalizedMeta.id, normalizedMeta)

  for (const record of normalized.values()) {
    if (
      record.record_type === 'element'
      && !pages.some((page) => page.id === record.page_id)
    ) {
      normalized.set(record.id, { ...record, page_id: activePageId })
    }
  }
  return normalized
}

function boardRecordsEqual(left: BoardRecord, right: BoardRecord) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function createEmptyBoardRecordDiff(): BoardRecordDiff {
  return {
    added: [...EMPTY_DIFF.added],
    updated: [...EMPTY_DIFF.updated],
    removed: [...EMPTY_DIFF.removed],
  }
}
