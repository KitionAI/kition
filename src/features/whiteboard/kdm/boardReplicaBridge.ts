/**
 * The glue between the record view of `BoardStore` and its KDM replica: committing record diffs as
 * KDM transactions and the store's undo-step bookkeeping over the replica's undo stack and undo
 * groups.
 */
import { open } from '@/lib/kdm/envelope'
import { uuidFromBytes, type Origin, type Replica } from '@/lib/kdm'
import type { BoardRecord } from '../lib/boardRecords'
import type { BoardRecordDiff } from '../lib/boardRecordDiff'
import { boardRootId } from './boardKdmRead'
import { writeBoardDiff } from './boardKdmWrite'

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
   * Writes the persisted part of `diff` as one transaction of `origin`. Answers whether the
   * document changed, that is whether the transaction is (part of) an undo step.
   */
  commit(diff: BoardRecordDiff, origin: Origin) {
    const persisted = persistedBoardDiff(diff)
    if (isEmptyDiff(persisted)) return false
    const before = this.replica.version()
    this.replica.transact(origin, (tx) => writeBoardDiff(tx, this.rootId, persisted))
    const changed = !this.replica.version().equals(before)
    if (changed) {
      if (this.groupOwner !== null) this.groupChanged = true
      else this.undoDepth += 1
    }
    return changed
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
