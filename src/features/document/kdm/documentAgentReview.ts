/**
 * The review of an agent's edit to an open document: the edit is already in the text (one
 * agent-origin undo step, saved), and the editor marks what it inserted and what it removed until
 * the person accepts or rejects it. The marks live with the document session, so they survive
 * tab switches and editor remounts, and follow every later change of the text (typing, merges).
 */
import { ChangeSet, StateEffect, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { createDocumentRevisionComparison } from '@/features/document/lib/documentRevision'
import type { TextDelta } from '@/lib/kdm'
import { deltaToChanges } from './codeMirrorBinding'

/** What an agent's edit changed, positioned in the current text. */
export type AgentReviewMarks = {
  /** The length of the text the positions refer to. */
  length: number
  /** Ranges of text the agent inserted, sorted. */
  added: Array<{ from: number; to: number }>
  /** Text the agent removed, at the position it was removed from, sorted. */
  removed: Array<{ at: number; text: string }>
}

/**
 * The marks of the edit `before → after`, in `after`'s positions: the changed lines, compared word
 * by word, as the review panel shows them (`createDocumentRevisionComparison`).
 */
export function agentReviewMarks(before: string, after: string): AgentReviewMarks {
  const marks: AgentReviewMarks = { length: after.length, added: [], removed: [] }
  let position = 0
  for (const segment of createDocumentRevisionComparison(before, after).segments) {
    if (segment.kind === 'equal') {
      position += segment.text.length
      continue
    }
    for (const part of segment.change.parts) {
      if (part.kind === 'removed') {
        const last = marks.removed[marks.removed.length - 1]
        if (last && last.at === position) last.text += part.text
        else marks.removed.push({ at: position, text: part.text })
        continue
      }
      if (part.kind === 'added') {
        const last = marks.added[marks.added.length - 1]
        if (last && last.to === position) last.to += part.text.length
        else marks.added.push({ from: position, to: position + part.text.length })
      }
      position += part.text.length
    }
  }
  return marks
}

/** The marks after the text changed by `delta` (a KDM text delta of the text the marks refer to). */
export function mapAgentReviewMarks(marks: AgentReviewMarks, delta: readonly TextDelta[]): AgentReviewMarks {
  let changes: ChangeSet
  try {
    changes = ChangeSet.of(deltaToChanges(delta), marks.length)
  } catch {
    // The delta is not of this text (it should not happen): the marks are dropped, not misplaced.
    return { length: marks.length, added: [], removed: [] }
  }
  const added: AgentReviewMarks['added'] = []
  for (const range of marks.added) {
    const from = changes.mapPos(range.from, 1)
    const to = changes.mapPos(range.to, -1)
    if (to > from) added.push({ from, to })
  }
  const removed = marks.removed.map((point) => ({ at: changes.mapPos(point.at, -1), text: point.text }))
  return { length: changes.newLength, added, removed }
}

/** `earlier` (already mapped to `later`'s text) and `later` together. */
export function addAgentReviewMarks(earlier: AgentReviewMarks, later: AgentReviewMarks): AgentReviewMarks {
  return {
    length: later.length,
    added: [...earlier.added, ...later.added].sort((a, b) => a.from - b.from || a.to - b.to),
    removed: [...earlier.removed, ...later.removed].sort((a, b) => a.at - b.at),
  }
}

/** Where an editor finds the review of its document. */
export type AgentReviewSource = {
  agentReview: () => { marks: AgentReviewMarks } | null
  /** Called when a review starts, grows, or ends (not when only its marks moved with the text). */
  subscribeAgentReview: (listener: () => void) => () => void
}

class RemovedTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: RemovedTextWidget) {
    return other.text === this.text
  }

  toDOM() {
    const element = document.createElement('span')
    element.className = 'cm-agent-review-removed'
    element.textContent = this.text
    return element
  }

  ignoreEvent() {
    return false
  }
}

const addedMark = Decoration.mark({ class: 'cm-agent-review-added' })
const refreshReview = StateEffect.define<null>()

function reviewDecorations(view: EditorView, source: AgentReviewSource): DecorationSet {
  const review = source.agentReview()
  // The editor shows the session's text a moment later during an IME composition: no marks meanwhile.
  if (!review || review.marks.length !== view.state.doc.length) return Decoration.none
  const ranges = [
    ...review.marks.added.map((range) => addedMark.range(range.from, range.to)),
    ...review.marks.removed.map((point) => Decoration.widget({ widget: new RemovedTextWidget(point.text), side: -1 }).range(point.at)),
  ]
  return Decoration.set(ranges, true)
}

/** Marks an agent's edit under review in an editor bound to the document. */
export function agentReviewHighlight(source: AgentReviewSource): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      private readonly unsubscribe: () => void

      constructor(private readonly view: EditorView) {
        this.decorations = reviewDecorations(view, source)
        this.unsubscribe = source.subscribeAgentReview(() => {
          // Not inside an editor update: a review starts or ends from a command or a bridge request.
          this.view.dispatch({ effects: refreshReview.of(null) })
        })
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshReview)))) {
          this.decorations = reviewDecorations(update.view, source)
        }
      }

      destroy() {
        this.unsubscribe()
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}
