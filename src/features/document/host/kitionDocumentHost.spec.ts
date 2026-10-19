import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDocumentHost } from '@kition/document-editor'
import { clipboardHtmlToMarkdown } from '@kition/document-editor/clipboard'
import { livePreviewExtension } from '@kition/document-editor/editor'
import { installKitionDocumentHost } from './kitionDocumentHost'

const views: EditorView[] = []

function mount(doc: string, sourcePath: string) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [markdown({ base: markdownLanguage }), livePreviewExtension({ sourcePath })],
    }),
  })
  views.push(view)
  return view
}

beforeEach(() => installKitionDocumentHost())

afterEach(() => {
  views.splice(0).forEach((view) => {
    view.destroy()
    view.dom.remove()
  })
  setDocumentHost({})
})

describe("the Markdown editor's images in Kition", () => {
  it('resolves angle-bracket generated image destinations from the workspace root', () => {
    const desktopWindow = window as typeof window & { kitionDesktop?: unknown }
    const previousDesktopBridge = desktopWindow.kitionDesktop
    desktopWindow.kitionDesktop = { shell: 'tauri' }
    try {
      const view = mount('![Generated image](<Agent/images/9/ig_generated.png>)', 'Articles/AI/Attention residue.md')
      expect(view.dom.querySelector<HTMLImageElement>('.cm-md-image img')?.src).toBe('http://127.0.0.1:18101/workspace-files/Agent/images/9/ig_generated.png')
    } finally {
      desktopWindow.kitionDesktop = previousDesktopBridge
    }
  })

  it('retains imported images in preserved tables', () => {
    const source = clipboardHtmlToMarkdown('<table><tr><td colspan="2"><img src="https://example.com/image.png" alt="Diagram"></td></tr></table>', new Map([
      ['https://example.com/image.png', '![Diagram](<../attachments/diagram one.png>)'],
    ]))
    const view = mount(source, 'Notes/example.md')
    expect(view.dom.querySelector('img')?.src).toContain('/workspace-files/attachments/diagram%20one.png')
  })
})
