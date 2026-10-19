import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { livePreviewExtension, livePreviewField } from './live-preview'
import { MermaidWidget } from './mermaid-widget'
import { revealedMermaidSourceField } from './mermaid-source'

vi.mock('../../markdown/mermaid', () => ({ renderMermaid: vi.fn().mockResolvedValue('<svg viewBox="0 0 10 10"></svg>') }))
const source = 'Before\n\n```mermaid\nflowchart TB\n  a --> b\n```\n\nAfter'
const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((view) => { view.destroy(); view.dom.remove() }))
function mount() {
  const view = new EditorView({ parent: document.body, state: EditorState.create({
    doc: source, extensions: [markdown({ base: markdownLanguage }), livePreviewExtension()],
  }) })
  views.push(view)
  return view
}
function diagramCount(view: EditorView) {
  let count = 0
  view.state.field(livePreviewField).between(0, view.state.doc.length, (_from, _to, decoration) => {
    if (decoration.spec.widget instanceof MermaidWidget) count++
  })
  return count
}

describe('explicit Mermaid source editing', () => {
  it('keeps the diagram when the caret or selection enters the fenced source range', () => {
    const view = mount()
    view.focus()
    for (const anchor of [source.indexOf('```'), source.indexOf('a -->'), source.lastIndexOf('```')]) {
      view.dispatch({ selection: { anchor } })
      expect(diagramCount(view)).toBe(1)
    }
    view.dispatch({ selection: { anchor: 0, head: source.length } })
    expect(diagramCount(view)).toBe(1)
    expect(view.state.doc.toString()).toBe(source)
  })

  it('maps explicit source editing through edits and returns to the diagram when leaving', () => {
    const view = mount()
    ;(view.dom.querySelector('.cm-md-mermaid-edit') as HTMLButtonElement).click()
    expect(diagramCount(view)).toBe(0)
    const from = source.indexOf('a -->')
    view.dispatch({ changes: { from, to: from + 1, insert: 'client' }, selection: { anchor: from + 6 } })
    expect(diagramCount(view)).toBe(0)
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    expect(diagramCount(view)).toBe(1)
    expect(view.state.field(revealedMermaidSourceField)).toBeNull()
    expect(view.state.doc.toString()).toContain('client --> b')
  })
})
