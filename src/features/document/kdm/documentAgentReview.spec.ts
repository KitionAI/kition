import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addAgentReviewMarks,
  agentReviewHighlight,
  agentReviewMarks,
  mapAgentReviewMarks,
  type AgentReviewMarks,
  type AgentReviewSource,
} from './documentAgentReview'

/** The text of each added range and the removed texts, as the editor marks them. */
function shown(text: string, marks: AgentReviewMarks) {
  return {
    added: marks.added.map((range) => text.slice(range.from, range.to)),
    removed: marks.removed.map((point) => `${point.at}:${point.text}`),
  }
}

describe('agentReviewMarks', () => {
  it('marks what the edit inserted and where it removed text', () => {
    const before = 'The pilot starts in October.\nKeep this.\n'
    const after = 'The pilot starts in November.\nKeep this.\nNew line.\n'
    const marks = agentReviewMarks(before, after)
    expect(marks.length).toBe(after.length)
    const result = shown(after, marks)
    expect(result.added.join('|')).toContain('Nov')
    expect(result.added.join('|')).toContain('New line.\n')
    expect(result.removed.some((entry) => entry.includes('Oct'))).toBe(true)
  })

  it('has no marks for an unchanged text', () => {
    expect(agentReviewMarks('same', 'same')).toEqual({ length: 4, added: [], removed: [] })
  })
})

describe('mapAgentReviewMarks', () => {
  it('follows typing before and inside the marks; a deleted insertion loses its mark', () => {
    const before = 'a b c'
    const after = 'a XY b c'
    let marks = agentReviewMarks(before, after)
    expect(shown(after, marks).added).toEqual(['XY '])
    // Typing at the start moves the mark.
    marks = mapAgentReviewMarks(marks, [{ insert: '>> ' }])
    let text = `>> ${after}`
    expect(shown(text, marks).added).toEqual(['XY '])
    expect(marks.length).toBe(text.length)
    // Typing right after the mark does not extend it.
    marks = mapAgentReviewMarks(marks, [{ retain: 8 }, { insert: '!' }])
    text = `${text.slice(0, 8)}!${text.slice(8)}`
    expect(shown(text, marks).added).toEqual(['XY '])
    // Deleting the inserted text drops its mark.
    marks = mapAgentReviewMarks(marks, [{ retain: 5 }, { delete: 3 }])
    expect(marks.added).toEqual([])
  })

  it('keeps removed text at its place', () => {
    let marks = agentReviewMarks('one two three', 'one three')
    expect(marks.removed).toEqual([{ at: 4, text: 'two ' }])
    marks = mapAgentReviewMarks(marks, [{ insert: '0 ' }])
    expect(marks.removed).toEqual([{ at: 6, text: 'two ' }])
  })
})

describe('addAgentReviewMarks', () => {
  it('adds a later edit’s marks to the earlier ones', () => {
    const first = agentReviewMarks('a\nb\nc\n', 'A\nb\nc\n')
    const second = agentReviewMarks('A\nb\nc\n', 'A\nb\nC\n')
    const both = addAgentReviewMarks(first, second)
    expect(shown('A\nb\nC\n', both).added).toEqual(['A', 'C'])
    expect(both.length).toBe(6)
  })
})

describe('agentReviewHighlight', () => {
  const views: EditorView[] = []
  afterEach(() => {
    for (const view of views.splice(0)) view.destroy()
  })

  function source(initial: { marks: AgentReviewMarks } | null) {
    const listeners = new Set<() => void>()
    const state = { review: initial }
    const value: AgentReviewSource = {
      agentReview: () => state.review,
      subscribeAgentReview: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    return {
      value,
      set(review: { marks: AgentReviewMarks } | null) {
        state.review = review
        for (const listener of listeners) listener()
      },
    }
  }

  it('shows added and removed text while the review lasts', () => {
    const text = 'one three'
    const review = source({ marks: agentReviewMarks('one two three plus', text) })
    const view = new EditorView({ state: EditorState.create({ doc: text, extensions: [agentReviewHighlight(review.value)] }), parent: document.body })
    views.push(view)
    expect(view.dom.querySelectorAll('.cm-agent-review-removed').length).toBeGreaterThan(0)
    expect(view.dom.textContent).toContain('two')
    review.set(null)
    expect(view.dom.querySelectorAll('.cm-agent-review-removed')).toHaveLength(0)
    review.set({ marks: agentReviewMarks('one', text) })
    expect(view.dom.querySelector('.cm-agent-review-added')?.textContent).toBe(' three')
  })

  it('shows nothing while the editor and the marks disagree on the text', () => {
    const review = source({ marks: agentReviewMarks('a', 'ab') })
    const view = new EditorView({ state: EditorState.create({ doc: 'abc', extensions: [agentReviewHighlight(review.value)] }), parent: document.body })
    views.push(view)
    expect(view.dom.querySelectorAll('.cm-agent-review-added')).toHaveLength(0)
  })
})
