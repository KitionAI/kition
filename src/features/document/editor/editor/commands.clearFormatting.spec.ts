import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { clearFormatting } from './commands'

function makeView(doc: string, selFrom: number, selTo: number) {
  const state = EditorState.create({ doc, selection: { anchor: selFrom, head: selTo } })
  return new EditorView({ state })
}

describe('clearFormatting', () => {
  it('removes ** and * pairs from selection', () => {
    const view = makeView('hello **bold** and *italic* world', 6, 27)
    clearFormatting(view)
    expect(view.state.doc.toString()).toBe('hello bold and italic world')
  })

  it('removes ~~ and ` and == markers', () => {
    const view = makeView('a ~~s~~ b `c` d ==h== e', 0, 23)
    clearFormatting(view)
    expect(view.state.doc.toString()).toBe('a s b c d h e')
  })

  it('no-ops on cursor (empty selection)', () => {
    const view = makeView('hello', 2, 2)
    const before = view.state.doc.toString()
    clearFormatting(view)
    expect(view.state.doc.toString()).toBe(before)
  })
})
