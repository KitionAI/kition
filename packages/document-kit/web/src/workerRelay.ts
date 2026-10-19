import type { Replica, Version } from '@kition/kdm'

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
 * Keeps two replicas of one document in step: the editor's, which CodeMirror edits in the page
 * (through its `TextBinding`), and the engine worker's, which the host saves, co-edits through,
 * and runs agents, comments, and scripts on. Both are KDM replicas of the same document with
 * their own actors, so each takes the other's changes as it would a collaborator's: the editor's
 * edits go to the worker (`push`), and whatever the worker took from elsewhere comes to the editor
 * (`pull`), where the binding shows it as a remote change. Exchanges run one at a time, in order.
 */
export class WorkerRelay {
  private queue: Promise<void> = Promise.resolve()
  /** The editor's changes the worker has, as far as the editor knows. */
  private pushed: Version
  private closed = false

  constructor(
    private readonly replica: Replica,
    private readonly engine: EngineReplica,
    private readonly report: (error: unknown) => void,
    /** Called after changes from the worker reached the editor's replica. */
    private readonly pulled: () => void = () => {},
  ) {
    this.pushed = replica.version()
  }

  /** Sends the editor's edits the worker does not have yet. */
  push() {
    this.enqueue(async () => {
      const version = this.replica.version()
      if (this.pushed.includes(version)) return
      await this.engine.importChanges(own(this.replica.exportChanges(this.pushed)), NO_BLOBS)
      this.pushed = version
    })
  }

  /** Takes the worker's changes the editor does not have yet. */
  pull() {
    this.enqueue(async () => {
      const before = this.replica.version()
      const { changes } = await this.engine.exportChanges(own(before.encode()))
      if (this.closed) return
      // Unless the editor edited since its last push, the worker now has all the editor has.
      const caughtUp = this.pushed.includes(before)
      this.replica.importChanges(new Uint8Array(changes))
      if (caughtUp) this.pushed = this.replica.version()
      if (!this.replica.version().equals(before)) this.pulled()
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
