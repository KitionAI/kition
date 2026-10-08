import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { copiedStrongLabels } from '../../lib/markdown-strong'
import { livePreviewExtension } from './live-preview'
import { markdownToHtml } from '@/services/markdownRenderer'

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((view) => { view.destroy(); view.dom.remove() }))
function mount(doc: string) {
  const view = new EditorView({ parent: document.body, state: EditorState.create({
    doc, extensions: [markdown({ base: markdownLanguage, extensions: [copiedStrongLabels] }), livePreviewExtension()],
  }) })
  views.push(view)
  return view
}

describe('copied strong labels', () => {
  it.each(['**Company: **Details', '**Deployment:**Details', '### **Use cases: **', '## Company | **ERP**'])('renders %s without stray markers', (source) => {
    const view = mount(source)
    expect(view.dom.querySelector('.cm-md-strong')).not.toBeNull()
    expect(view.contentDOM.textContent).not.toContain('**')
    expect(view.state.doc.toString()).toBe(source)
    expect(markdownToHtml(source)).toContain('<strong>')
  })

  it('supports non-Latin labels and punctuation without changing their source', () => {
    const label = String.fromCodePoint(0x4f01, 0x4e1a, 0x7b80, 0x4ecb, 0xff1a)
    const body = String.fromCodePoint(0x516c, 0x53f8)
    const source = `**${label} **${body}`
    const view = mount(source)
    expect(view.contentDOM.textContent).toBe(`${label} ${body}`)
    expect(markdownToHtml(source)).toContain(`<strong>${label} </strong>${body}`)
  })

  it.each(['`**Label: **`', '```text\n**Label: **\n```', '\\*\\*Label: \\*\\*', '**   **', 'plain **unclosed'])('leaves literal examples and incomplete markers unchanged: %s', (source) => {
    const view = mount(source)
    expect(view.dom.querySelector('.cm-md-strong')).toBeNull()
    expect(markdownToHtml(source)).not.toContain('<strong>')
  })
})
