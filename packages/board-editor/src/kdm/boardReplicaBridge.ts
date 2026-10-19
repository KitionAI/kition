/**
 * The glue between the record view of `BoardStore` and its KDM replica: committing record diffs as
 * KDM transactions and the store's undo-step bookkeeping over the replica's undo stack and undo
 * groups.
 */
import { openEnvelope, system, uuidFromBytes, type Origin, type Replica } from '@kition/kdm'
import type { BoardRecord } from '../lib/boardRecords'
import type { BoardRecordDiff } from '../lib/boardRecordDiff'
import {
  boardRootId,
  duplicatePlacements,
  readBoardBindingRecords,
  readBoardElementRecords,
  readBoardPageRecords,
  readBoardView,
  refreshBoardView,
  type BoardDuplicatePlacement,
  type BoardViewRead,
} from './boardKdmRead'
import { repairBoardPlacements, writeBoardDiff, type BoardWriteHint, type BoardWriteResult } from './boardKdmWrite'

/** A committed record diff: whether the document changed, and what the write could not do as asked. */
export type BoardCommit = BoardWriteResult & { changed: boolean }

/** Records to put into and ids to remove from the view so that it shows what the replica has. */
export type BoardViewPatch = { put: BoardRecord[]; removed: string[] }

/**
 * The board as the reader sees it (`readBoardRecords` by id), and what a merge left that the
 * reader skips and `repair` removes: list entries of elements shown elsewhere (`duplicates`), list
 * entries naming no object (`dangling`), and `orphans`, elements on no page because their page was
 * deleted while another replica added them to it or moved them onto it (the page's deletion wins).
 */
export type BoardRead = {
  records: ReadonlyMap<string, BoardRecord>
  duplicates: BoardDuplicatePlacement[]
  dangling: boolean
  orphans: string[]
}

/**
 * One replica of a board and the undo steps the store has on its undo stack. A step is a committed
 * transaction that changed the document, or an undo group that did; undo and redo move steps
 * between the stacks.
 */
export class BoardReplicaHistory {
  readonly rootId: string
  /** Undo steps on the replica's undo stack, an open undo group excluded. */
  private undoDepth = 0
  /** The owner (a history mark serial) of the open undo group, and whether it changed anything. */
  private groupOwner: number | null = null
  private groupChanged = false
  /** Changes imported during an open undo group, applied when it ends. */
  private pendingImports: Uint8Array[] = []
  /** The last read of the board, and the objects changed since (by any means: `Replica.takeChanged`). */
  private lastRead: BoardViewRead
  private changedSinceRead = new Set<string>()
  /**
   * The changed objects whose state for the writer (shown element, other object, or none) may
   * differ from the last read: all of them except elements this store's commits only edited.
   */
  private unsettledSinceRead = new Set<string>()
  /** Whether the next read checks every element for orphans (the first one does). */
  private checkEveryElement = true

  constructor(readonly replica: Replica) {
    replica.takeChanged()
    this.lastRead = readBoardView(replica)
    this.rootId = this.lastRead.rootId ?? boardRootId(replica)
  }

  /**
   * Reads the board. Only the objects changed since the last read and the pages' lists are read
   * again, unless many changed or the root did; the result always equals a full read.
   */
  read(): BoardRead {
    this.collectChanges()
    const previous = this.lastRead
    const changed = new Set(this.changedSinceRead)
    const refreshed = refreshBoardView(this.replica, previous, changed)
    this.lastRead = refreshed ?? readBoardView(this.replica)
    this.changedSinceRead.clear()
    this.unsettledSinceRead.clear()
    const { layout, hidden } = this.lastRead
    const dangling = [...hidden.values()].includes('missing')
      || (this.replica.exists(this.rootId) && this.replica.list(this.rootId, 'pages').length !== layout.pages.length)
    return { records: this.lastRead.records, duplicates: duplicatePlacements(layout), dangling, orphans: this.orphans(previous, changed) }
  }

  /**
   * Elements no shown page lists. Every element is checked on the first read (a document saved with
   * orphans), and when a change touched an object that is gone and was a page or unknown to
   * `previous`: a page deleted here or by the merge, whose list a merge may have added elements to
   * or moved elements onto. Otherwise only the changed objects can be orphans.
   */
  private orphans(previous: BoardViewRead, changed: ReadonlySet<string>): string[] {
    const records = this.lastRead.records
    const everything = this.checkEveryElement || [...changed].some((id) => {
      if (records.has(id) || this.replica.exists(id)) return false
      const before = previous.records.get(id)
      return before === undefined || before.record_type === 'page'
    })
    this.checkEveryElement = false
    const candidates = (everything ? this.replica.objectsOfType('Element') : [...changed])
      .filter((id) => !records.has(id) && this.replica.exists(id) && this.replica.objectType(id) === 'Element')
    if (candidates.length === 0) return []
    const listed = new Set(this.lastRead.layout.pages.flatMap((page) => page.items))
    return candidates.filter((id) => !listed.has(id))
  }

  /** What the writer may take from the last read: the objects not changed since keep their state. */
  private writeHint(): BoardWriteHint {
    this.collectChanges()
    return { read: this.lastRead, changed: this.unsettledSinceRead }
  }

  /**
   * Takes `ids` as changed since the last read: objects whose changes someone else took from the
   * replica (`Replica.takeChanged`), such as a kit session that imported or undid them itself.
   */
  noteChanged(ids: Iterable<string>) {
    for (const id of ids) {
      this.changedSinceRead.add(id)
      this.unsettledSinceRead.add(id)
    }
  }

  private collectChanges() {
    for (const id of this.replica.takeChanged()) {
      this.changedSinceRead.add(id)
      this.unsettledSinceRead.add(id)
    }
  }

  /**
   * Collects what the commit of `diff` changed. An element it edited without deleting it or
   * changing its kind is still the shown element the last read saw, so the writer keeps trusting
   * the read for it; everything else it changed is unsettled.
   */
  private collectCommit(diff: BoardRecordDiff) {
    const removesPages = diff.removed.some((record) => record.record_type === 'page')
    const removed = new Set(diff.removed.map((record) => record.id))
    for (const { before, after } of diff.updated) {
      if (before.record_type === 'element' && (after.record_type !== 'element' || before.kind !== after.kind)) removed.add(after.id)
    }
    for (const id of this.replica.takeChanged()) {
      this.changedSinceRead.add(id)
      const settled = !removesPages
        && !removed.has(id)
        && !this.unsettledSinceRead.has(id)
        && this.lastRead.records.get(id)?.record_type === 'element'
      if (!settled) this.unsettledSinceRead.add(id)
    }
  }

  get depth() {
    return this.undoDepth
  }

  /** The owner of the open undo group, or `null`. */
  get group() {
    return this.groupOwner
  }

  canUndo() {
    return this.replica.canUndo()
  }

  canRedo() {
    return this.replica.canRedo()
  }

  /**
   * Writes the persisted part of `diff` as one transaction of `origin`. `changed` tells whether the
   * document changed, that is whether the transaction is (part of) an undo step.
   */
  commit(diff: BoardRecordDiff, origin: Origin): BoardCommit {
    const persisted = persistedBoardDiff(diff)
    if (isEmptyDiff(persisted)) return { changed: false, skipped: [], relocated: [] }
    const before = this.replica.version()
    const hint = this.writeHint()
    const result = this.replica.transact(origin, (tx) => writeBoardDiff(tx, this.rootId, persisted, hint))
    this.collectCommit(persisted)
    const changed = !this.replica.version().equals(before)
    if (changed) {
      if (this.groupOwner !== null) this.groupChanged = true
      else this.undoDepth += 1
    }
    return { changed, ...result }
  }

  /**
   * Writes the repair `diff`, removes the list entries the last `read` skipped, and deletes its
   * orphans, as one `system` transaction, which the KDM keeps out of the undo history. Nothing to
   * repair writes nothing.
   */
  repair(diff: BoardRecordDiff, read: Pick<BoardRead, 'duplicates' | 'dangling' | 'orphans'>) {
    const persisted = persistedBoardDiff(diff)
    const placements = read.duplicates.length > 0 || read.dangling
    if (isEmptyDiff(persisted) && !placements && read.orphans.length === 0) return
    const hint = this.writeHint()
    this.replica.transact(system('repair'), (tx) => {
      if (!isEmptyDiff(persisted)) writeBoardDiff(tx, this.rootId, persisted, hint)
      if (placements) repairBoardPlacements(tx, this.rootId)
      for (const id of read.orphans) if (tx.exists(id)) tx.delete(id)
    })
  }

  /**
   * Re-reads from the replica what the commit of `diff` could not write as asked (`skipped` and
   * `relocated` ids), so the view shows what the document has. `view` is the record view.
   */
  readBack(view: ReadonlyMap<string, BoardRecord>, diff: BoardRecordDiff, written: BoardWriteResult): BoardViewPatch {
    const patch: BoardViewPatch = { put: [], removed: [] }
    if (written.skipped.length === 0 && written.relocated.length === 0) return patch
    const diffRecords = new Map<string, BoardRecord>()
    for (const record of [...diff.added, ...diff.updated.map((update) => update.after)]) diffRecords.set(record.id, record)
    const elements = new Set<string>()
    const connectors = new Set<string>()
    // A relocated element's page is missing from the document, so the view's pages are re-read too.
    let readPages = written.relocated.length > 0
    for (const id of [...written.skipped, ...written.relocated]) {
      const record = diffRecords.get(id) ?? view.get(id)
      if (record?.record_type === 'page') readPages = true
      else if (record?.record_type === 'binding') {
        // A binding is skipped when its connector is gone: the view's connector is re-read as well.
        elements.add(record.from_id)
        connectors.add(record.from_id)
      } else if (record?.record_type === 'element') {
        elements.add(id)
        if (record.kind === 'connector') connectors.add(id)
      }
    }
    if (readPages) {
      const pages = readBoardPageRecords(this.replica, this.rootId)
      const live = new Set(pages.map((page) => page.id))
      patch.put.push(...pages)
      for (const record of view.values()) {
        if (record.record_type === 'page' && !live.has(record.id)) patch.removed.push(record.id)
        // Elements the view still shows on a page the document no longer has.
        else if (record.record_type === 'element' && !live.has(record.page_id)) {
          elements.add(record.id)
          if (record.kind === 'connector') connectors.add(record.id)
        }
      }
    }
    for (const [id, record] of readBoardElementRecords(this.replica, [...elements], this.rootId)) {
      if (record) patch.put.push(record)
      else patch.removed.push(id)
    }
    if (connectors.size > 0) {
      const bindings = readBoardBindingRecords(this.replica, [...connectors], this.rootId)
      const kept = new Set(bindings.map((binding) => binding.id))
      for (const record of view.values()) {
        if (record.record_type === 'binding' && connectors.has(record.from_id) && !kept.has(record.id)) patch.removed.push(record.id)
      }
      patch.put.push(...bindings)
    }
    return patch
  }

  /** Opens an undo group owned by `owner` unless one is open; answers whether it opened one. */
  openGroup(owner: number) {
    if (this.groupOwner !== null) return false
    this.replica.beginUndoGroup()
    this.groupOwner = owner
    this.groupChanged = false
    return true
  }

  /** Ends the open undo group; a group that changed something is one more undo step. */
  closeGroup() {
    if (this.groupOwner === null) return
    this.replica.endUndoGroup()
    if (this.groupChanged) this.undoDepth += 1
    this.groupOwner = null
    this.groupChanged = false
  }

  undo() {
    this.closeGroup()
    if (!this.replica.undo()) return false
    this.undoDepth = Math.max(0, this.undoDepth - 1)
    return true
  }

  redo() {
    this.closeGroup()
    if (!this.replica.redo()) return false
    this.undoDepth += 1
    return true
  }

  /** Undoes the steps above `depth`; answers whether any was undone. */
  undoTo(depth: number) {
    let undone = false
    while (this.undoDepth > depth && this.undo()) undone = true
    return undone
  }

  clearRedo() {
    this.replica.clearRedo()
  }

  /**
   * Imports changes, or keeps them for the end of the open undo group (an import into a group
   * could split it). Changes of another document are refused (`wrong-document`) either way.
   * Answers whether the document changed now.
   */
  importChanges(bytes: Uint8Array) {
    if (this.groupOwner === null) return this.replica.importChanges(bytes).size > 0
    // The replica's own check throws `wrong-document` and changes nothing.
    if (uuidFromBytes(openEnvelope(bytes).docId) !== this.replica.docId) this.replica.importChanges(bytes)
    this.pendingImports.push(bytes.slice())
    return false
  }

  /** Imports the changes kept during an undo group once it ended; answers whether any changed the document. */
  flushImports() {
    if (this.groupOwner !== null || this.pendingImports.length === 0) return false
    const pending = this.pendingImports
    this.pendingImports = []
    let changed = false
    for (const bytes of pending) {
      try {
        changed = this.replica.importChanges(bytes).size > 0 || changed
      } catch {
        // Their document was checked when they arrived; changes the engine cannot read are dropped
        // rather than breaking the gesture that deferred them.
      }
    }
    return changed
  }
}

/** `diff` without view state: the meta record never reaches the document. */
function persistedBoardDiff(diff: BoardRecordDiff): BoardRecordDiff {
  return {
    added: diff.added.filter(isPersisted),
    updated: diff.updated.filter((update) => isPersisted(update.after)),
    removed: diff.removed.filter(isPersisted),
  }
}

const isPersisted = (record: BoardRecord) => record.record_type !== 'meta'
const isEmptyDiff = (diff: BoardRecordDiff) => diff.added.length === 0 && diff.updated.length === 0 && diff.removed.length === 0
