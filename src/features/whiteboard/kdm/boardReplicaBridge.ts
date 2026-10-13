/**
 * The glue between the record view of `BoardStore` and its KDM replica: committing record diffs as
 * KDM transactions and the store's undo-step bookkeeping over the replica's undo stack and undo
 * groups.
 */
import { open } from '@/lib/kdm/envelope'
import { system, uuidFromBytes, type Origin, type Replica } from '@/lib/kdm'
import type { BoardRecord } from '../lib/boardRecords'
import type { BoardRecordDiff } from '../lib/boardRecordDiff'
import { boardRootId, readBoardBindingRecords, readBoardElementRecords, readBoardPageRecords } from './boardKdmRead'
import { repairBoardPlacements, writeBoardDiff, type BoardWriteResult } from './boardKdmWrite'

/** A committed record diff: whether the document changed, and what the write could not do as asked. */
export type BoardCommit = BoardWriteResult & { changed: boolean }

/** Records to put into and ids to remove from the view so that it shows what the replica has. */
export type BoardViewPatch = { put: BoardRecord[]; removed: string[] }

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

  constructor(readonly replica: Replica) {
    this.rootId = boardRootId(replica)
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
    const result = this.replica.transact(origin, (tx) => writeBoardDiff(tx, this.rootId, persisted))
    const changed = !this.replica.version().equals(before)
    if (changed) {
      if (this.groupOwner !== null) this.groupChanged = true
      else this.undoDepth += 1
    }
    return { changed, ...result }
  }

  /**
   * Writes the repair `diff` and removes duplicate list placements as one `system` transaction,
   * which the KDM keeps out of the undo history.
   */
  repair(diff: BoardRecordDiff) {
    const persisted = persistedBoardDiff(diff)
    this.replica.transact(system('repair'), (tx) => {
      if (!isEmptyDiff(persisted)) writeBoardDiff(tx, this.rootId, persisted)
      repairBoardPlacements(tx, this.rootId)
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
    if (uuidFromBytes(open(bytes).docId) !== this.replica.docId) this.replica.importChanges(bytes)
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
