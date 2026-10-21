import type { Version } from '@kition/kdm'
import type { BoardStore } from '@kition/board-editor/model'

/** The engine worker's replica, as the kit session exposes it (`session.replica`). */
export type EngineReplica = {
  exportChanges(since: ArrayBuffer): Promise<{ changes: ArrayBuffer; blobs: ArrayBuffer }>
  importChanges(changes: ArrayBuffer, blobs: ArrayBuffer): Promise<unknown>
}

const NO_BLOBS = new ArrayBuffer(0)

/** The bytes of `view` as an `ArrayBuffer` of their own (the worker takes it). */
function own(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer as ArrayBuffer
}

/**
 * Keeps two replicas of one board in step: the editor's, which the board editor's `BoardStore`
 * edits in the page, and the engine worker's, which the host saves, co-edits through, and runs
 * agents and scripts on. Both are KDM replicas of the same document with their own actors, so each
 * takes the other's changes as it would a collaborator's: the editor's commits go to the worker
 * (`push`), and whatever the worker took from elsewhere comes to the editor (`pull`). Exchanges run
 * one at a time, in order.
 */
export class WorkerRelay {
  private queue: Promise<void> = Promise.resolve()
  /** The editor's changes the worker has, as far as the editor knows. */
  private pushed: Version
  private closed = false

  constructor(
    private readonly store: BoardStore,
    private readonly engine: EngineReplica,
    private readonly report: (error: unknown) => void,
  ) {
    this.pushed = store.getReplica().version()
  }

  /** Sends the editor's commits the worker does not have yet. */
  push() {
    this.enqueue(async () => {
      const replica = this.store.getReplica()
      const version = replica.version()
      if (this.pushed.includes(version)) return
      await this.engine.importChanges(own(replica.exportChanges(this.pushed)), NO_BLOBS)
      this.pushed = version
    })
  }

  /** Takes the worker's changes the editor does not have yet. */
  pull() {
    this.enqueue(async () => {
      const replica = this.store.getReplica()
      const { changes } = await this.engine.exportChanges(own(replica.version().encode()))
      if (this.closed || this.store.getReplica() !== replica) return
      // Read after the wait: the editor may have committed meanwhile, and those commits are not the
      // worker's yet. Unless the editor committed since its last push, the worker now has all it has.
      const before = replica.version()
      const caughtUp = this.pushed.includes(before)
      this.store.importChanges(new Uint8Array(changes))
      if (caughtUp) this.pushed = replica.version()
    })
  }

  close() {
    this.closed = true
  }

  /** Waits for the exchanges asked for so far. */
  settled() {
    return this.queue
  }

  private enqueue(step: () => Promise<void>) {
    this.queue = this.queue.then(async () => {
      if (this.closed) return
      try {
        await step()
      } catch (error) {
        this.report(error)
      }
    })
  }
}
