import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { setDocumentHost } from '../../host'
import { livePreviewExtension } from './live-preview'
import { clipboardHtmlToMarkdown } from '../../lib/documentClipboard'
import { isDocumentTableHtml, sanitizeDocumentTableHtml } from '../../lib/documentTableHtml'
import hawkTable from '../../lib/fixtures/hawkTable.html?raw'

const views: EditorView[] = []
afterEach(() => {
  views.splice(0).forEach((view) => { view.destroy(); view.dom.remove() })
  setDocumentHost({})
})

function mount(doc: string, reading = false) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [
      markdown({ base: markdownLanguage }),
      livePreviewExtension({ sourcePath: 'Notes/example.md', revealSourceOnFocus: !reading }),
    ] }),
  })
  views.push(view)
  return view
}

describe('HTML table live preview', () => {
  it('renders pasted Hawk table content and merged cells without source metadata', () => {
    const source = clipboardHtmlToMarkdown(hawkTable)
    const view = mount(source)
    const table = view.dom.querySelector('.cm-html-table-widget table')!
    expect(table).not.toBeNull()
    expect(table.querySelectorAll('tr')).toHaveLength(4)
    expect(table.querySelector('[rowspan="3"]')?.textContent).toBe('@Coordinator')
    expect(table.querySelector('[colspan="2"]')?.textContent).toBe('Shared owner')
    expect(table.querySelectorAll('tr')[2].cells[1].querySelectorAll('p')).toHaveLength(2)
    expect(source).not.toMatch(/data-hk-|style=|class=/)
    expect(view.dom.textContent).not.toContain('<table')
    expect(view.state.doc.toString()).toBe(source)
  })

  it('renders already-saved HTML in reading mode and while the cursor is inside it', () => {
    const html = hawkTable.slice(hawkTable.indexOf('<table'))
    for (const reading of [false, true]) {
      const view = mount(html, reading)
      view.dispatch({ selection: { anchor: html.indexOf('Quality') } })
      view.focus()
      expect(view.dom.querySelector('.cm-html-table-widget')).not.toBeNull()
      expect(view.dom.textContent).not.toContain('data-hk-guid')
    }
  })

  it('leaves literal HTML code examples visible and unrelated HTML untouched', () => {
    const view = mount('```html\n<table><tr><td>Example</td></tr></table>\n```')
    expect(view.dom.querySelector('.cm-html-table-widget')).toBeNull()
    expect(view.dom.textContent).toContain('<table>')
    expect(isDocumentTableHtml('<table><tr><td>A</td></tr></table><p>After</p>')).toBe(false)
    expect(isDocumentTableHtml('<table><tr><td>A</td></tr></table>\nAfter')).toBe(false)
    expect(isDocumentTableHtml('<table><tr><td>Incomplete')).toBe(false)
  })

  it('removes active content and untrusted styling from existing table HTML', () => {
    const safe = sanitizeDocumentTableHtml('<table style="position:fixed" onclick="alert(1)"><tr><td><script>alert(1)</script><iframe src="https://example.com"></iframe><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">Unsafe</a><span style="color:red" data-private="id">Text</span></td></tr></table>')
    expect(safe).not.toMatch(/script|iframe|onerror|onclick|javascript:|style=|data-private/)
    expect(safe).toContain('Unsafe')
    expect(safe).toContain('Text')
  })

  it('keeps nested tables and adjacent tables', () => {
    const view = mount('<table><tr><td>Outer<table><tr><td>Inner</td></tr></table></td></tr></table>\n<table><tr><td>Second</td></tr></table>')
    expect(view.dom.querySelectorAll('.cm-html-table-widget table')).toHaveLength(3)
    expect(view.dom.textContent).toContain('OuterInner')
    expect(view.dom.textContent).toContain('Second')
  })

  it('retains imported images in preserved tables, shown where the host resolves them', () => {
    const source = clipboardHtmlToMarkdown('<table><tr><td colspan="2"><img src="https://example.com/image.png" alt="Diagram"></td></tr></table>', new Map([
      ['https://example.com/image.png', '![Diagram](<../attachments/diagram one.png>)'],
    ]))
    expect(source).toContain('src="../attachments/diagram%20one.png"')
    expect(source).not.toContain('example.com')
    setDocumentHost({ resolveImageURL: (image, documentPath) => `https://files.test/${documentPath.split('/').slice(0, -1).join('/')}/${image}` })
    const view = mount(source)
    // The source is relative to the document's folder (Notes/), as a host resolves it.
    expect(view.dom.querySelector('img')?.src).toBe('https://files.test/attachments/diagram%20one.png')
  })
})
