import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { replicaChange } from '@/features/document/kdm/codeMirrorBinding'
import { snippetExpandExtension } from './snippet-expand'

let view: EditorView | null = null

beforeEach(() => {
  window.localStorage.setItem('kition.document.snippets', JSON.stringify([{ trigger: ':todo', expansion: '- [ ] {{cursor}}' }]))
})

afterEach(() => {
  view?.destroy()
  view = null
  window.localStorage.clear()
})

function editor(doc: string) {
  view = new EditorView({ state: EditorState.create({ doc, extensions: [snippetExpandExtension()] }), parent: document.body })
  return view
}

describe('snippetExpandExtension', () => {
  it('expands a trigger the person types, followed by a space', async () => {
    const v = editor('')
    v.dispatch({ changes: { from: 0, insert: ':todo' }, userEvent: 'input.type' })
    v.dispatch({ changes: { from: 5, insert: ' ' }, selection: { anchor: 6 }, userEvent: 'input.type' })
    await Promise.resolve()
    expect(v.state.doc.toString()).toBe('- [ ]  ')
  })

  it('ignores text that reaches the editor from the replica (a merged file change, another view)', async () => {
    const v = editor('')
    v.dispatch({ changes: { from: 0, insert: ':todo' }, userEvent: 'input.type' })
    // Another writer appends a space after the trigger; the caret is right after it.
    v.dispatch({ changes: { from: 5, insert: ' ' }, selection: { anchor: 6 }, annotations: replicaChange.of(true) })
    await Promise.resolve()
    expect(v.state.doc.toString()).toBe(':todo ')
  })
})
