/**
 * CodeMirror on a KDM text field. Local editor transactions publish their exact changes (never a
 * whole-string replacement); every other change of the field (another replica, undo, an agent, a
 * merged file change) arrives in the editor as a CodeMirror change in UTF-16 positions.
 */
import { Annotation, ChangeSet, Transaction, type ChangeSpec, type Text } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { ObjectId, Origin, Replica, TextDelta, Tx } from '@/lib/kdm'
import { applyTextEdits, commonPrefixLength, commonSuffixLength, diffText, type TextEdit } from './documentMerge'

/**
 * Marks the transactions a `TextBinding` dispatches: changes that came from the replica (another
 * replica, undo, an agent, a merged file change), not from this editor. Other extensions use it
 * to tell them apart; they are also kept out of CodeMirror's own history.
 */
export const replicaChange = Annotation.define<true>()

/** The edits of one replaced range, minimised to what differs (common prefix and suffix kept). */
function minimalEdits(removed: string, inserted: string, at: number, out: TextEdit[]): void {
  const prefix = commonPrefixLength(removed, inserted)
  const suffix = commonSuffixLength(removed, inserted, Math.min(removed.length, inserted.length) - prefix)
  const from = at + prefix
  const removedMiddle = removed.slice(prefix, removed.length - suffix)
  const insertedMiddle = inserted.slice(prefix, inserted.length - suffix)
  if (!removedMiddle || !insertedMiddle) {
    if (removedMiddle || insertedMiddle) out.push({ from, to: from + removedMiddle.length, insert: insertedMiddle })
    return
  }
  // Commands and widgets that rewrite whole blocks change a few lines of them: keep the rest.
  for (const edit of diffText(removedMiddle, insertedMiddle)) out.push({ from: from + edit.from, to: from + edit.to, insert: edit.insert })
}

/**
 * Applies a CodeMirror change set to a KDM text field inside one transaction. Each replaced range
 * is minimised to the text that differs, so a command that rewrites a whole document or table
 * becomes small edits that merge with concurrent changes. `before` is the text the changes start
 * from (the transaction's start document); without it the field's text is read when needed.
 */
export function applyChangeSet(tx: Tx, id: ObjectId, field: string, changes: ChangeSet, before?: Text): void {
  const length = tx.textLength(id, field)
  if (changes.length !== length) throw new Error(`applyChangeSet: the changes start from ${changes.length} code units, the text has ${length}`)
  let replaced = false
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (fromA < toA && fromB < toB) replaced = true
  })
  const source: Text | string | null = before ?? (replaced ? tx.text(id, field) : null)
  const edits: TextEdit[] = []
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.toString()
    if (fromA === toA || !text || source === null) edits.push({ from: fromA, to: toA, insert: text })
    else minimalEdits(typeof source === 'string' ? source.slice(fromA, toA) : source.sliceString(fromA, toA), text, fromA, edits)
  })
  applyTextEdits(tx, id, field, edits)
}

/** A KDM text delta as CodeMirror change specs, all relative to the document before it. */
export function deltaToChanges(delta: readonly TextDelta[]): ChangeSpec[] {
  const changes: ChangeSpec[] = []
  let position = 0
  for (const op of delta) {
    if ('retain' in op) position += op.retain
    else if ('delete' in op) {
      changes.push({ from: position, to: position + op.delete })
      position += op.delete
    } else changes.push({ from: position, insert: op.insert })
  }
  return changes
}

export type TextBindingOptions = {
  /** Called when a local change could not be published; the editor is then reset to the replica's text. */
  onError?: (error: unknown) => void
}

/**
 * Binds one text field of one replica to an editor, one editor at a time: add `extension` to the
 * editor, whose document must start as the field's text (otherwise the binding resets it to the
 * field's text right after it mounts). An editor that remounts only needs the extension again;
 * the text and its undo history live in the replica.
 *
 * Every local transaction is published as one KDM transaction with `origin`. Every other change
 * of the field reaches the editor, annotated with `replicaChange`, except the ones the editor just
 * published. While an IME composition is under way, those changes wait and are applied in order
 * after it ends; local changes made meanwhile are published at their place in the replica.
 */
export class TextBinding {
  /** The CodeMirror extension that connects an editor to the field. */
  readonly extension = this.plugin()
  private view: EditorView | null = null
  /** Replica changes the editor does not show yet, relative to the editor's document. */
  private pending: ChangeSet | null = null
  /** Set when the editor's document must be replaced by the field's text. */
  private stale = false
  private publishing = false
  private updating = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly unsubscribe: () => void

  constructor(
    private readonly replica: Replica,
    private readonly id: ObjectId,
    private readonly field: string,
    private readonly origin: Origin,
    private readonly options: TextBindingOptions = {},
  ) {
    this.unsubscribe = replica.subscribeText(id, field, (delta) => {
      if (!this.publishing) this.receive(delta)
    })
  }

  /** Stops following the field. The editor keeps its text. */
  dispose(): void {
    this.unsubscribe()
    this.cancelFlush()
    this.view = null
    this.pending = null
  }

  /** Publishes a local editor transaction; the extension calls it for every transaction. */
  pushLocal(transaction: Transaction): void {
    if (!transaction.docChanged || transaction.annotation(replicaChange)) return
    let changes = transaction.changes
    let before = transaction.startState.doc
    const pending = this.pending
    if (pending) {
      // The replica is ahead of the editor: publish the change where it lands in the replica.
      before = pending.apply(before)
      changes = transaction.changes.map(pending)
      this.pending = pending.map(transaction.changes, true)
    }
    this.publishing = true
    try {
      this.replica.transact(this.origin, (tx) => applyChangeSet(tx, this.id, this.field, changes, before))
    } catch (error) {
      this.stale = true
      this.scheduleFlush()
      ;(this.options.onError ?? console.error)(error)
    } finally {
      this.publishing = false
    }
  }

  private plugin() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the plugin's callbacks need the binding, not the plugin instance.
    const binding = this
    return ViewPlugin.define(
      (view) => {
        binding.attach(view)
        return {
          update: (update: ViewUpdate) => binding.update(update),
          destroy: () => binding.detach(view),
        }
      },
      {
        eventObservers: {
          compositionend: () => binding.scheduleFlush(),
        },
      },
    )
  }

  private attach(view: EditorView): void {
    if (this.view && this.view !== view) throw new Error('TextBinding: the field is already bound to another editor')
    this.view = view
    this.pending = null
    const text = this.replica.text(this.id, this.field)
    if (view.state.doc.length !== text.length || view.state.doc.toString() !== text) {
      this.stale = true
      this.scheduleFlush()
    }
  }

  private detach(view: EditorView): void {
    if (this.view !== view) return
    this.view = null
    this.pending = null
    this.stale = false
    this.cancelFlush()
  }

  private update(update: ViewUpdate): void {
    this.updating = true
    try {
      for (const transaction of update.transactions) this.pushLocal(transaction)
    } finally {
      this.updating = false
    }
    if (this.pending || this.stale) this.scheduleFlush()
  }

  /** Whether replica changes must wait: during an editor update or an IME composition. */
  private deferring(): boolean {
    return this.updating || (this.view !== null && this.view.compositionStarted)
  }

  private receive(delta: TextDelta[]): void {
    const view = this.view
    if (!view || this.stale) return
    const length = this.pending ? this.pending.newLength : view.state.doc.length
    let changes: ChangeSet
    try {
      changes = ChangeSet.of(deltaToChanges(delta), length)
    } catch {
      this.stale = true
      this.scheduleFlush()
      return
    }
    this.pending = this.pending ? this.pending.compose(changes) : changes
    if (this.deferring()) this.scheduleFlush()
    else this.flush()
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return
    // After CodeMirror has read the DOM changes that end a composition.
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 0)
  }

  private cancelFlush(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Shows the pending replica changes in the editor, unless they must still wait. */
  private flush(): void {
    const view = this.view
    if (!view || this.deferring()) return
    if (this.stale) {
      this.stale = false
      this.pending = null
      const text = this.replica.text(this.id, this.field)
      if (view.state.doc.toString() !== text) this.dispatch(view, { from: 0, to: view.state.doc.length, insert: text })
      return
    }
    const changes = this.pending
    if (!changes) return
    this.pending = null
    this.dispatch(view, changes)
    if (view.state.doc.length !== this.replica.textLength(this.id, this.field)) {
      this.stale = true
      this.flush()
    }
  }

  private dispatch(view: EditorView, changes: ChangeSet | ChangeSpec): void {
    view.dispatch({ changes, annotations: [replicaChange.of(true), Transaction.addToHistory.of(false)], filter: false })
  }
}
