import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const desktop = vi.hoisted(() => ({
  importWorkspaceImageFromBlobURL: vi.fn(), importWorkspaceImageFromFile: vi.fn(),
  importWorkspaceImageFromClipboard: vi.fn(), canImportWorkspaceImageFromClipboard: vi.fn(),
}))
vi.mock('@/services/desktop', () => desktop)
import { pasteHtmlExtension } from './paste-html'

let view: EditorView | undefined
beforeEach(() => { vi.resetAllMocks() })
afterEach(() => { view?.destroy(); document.body.replaceChildren() })

function createEditor(readOnly = false) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: 'old text', selection: { anchor: 0, head: 3 },
      extensions: [pasteHtmlExtension(), history(), EditorState.readOnly.of(readOnly)],
    }),
  })
  return view
}

function paste(editor: EditorView, payloads: Record<string, string>) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => payloads[type] || '' } })
  editor.contentDOM.dispatchEvent(event)
  return event
}

describe('HTML document paste', () => {
  it('keeps the pasted caption and a retry placeholder when an image download fails', async () => {
    desktop.importWorkspaceImageFromBlobURL.mockRejectedValue(new Error('403'))
    const editor = createEditor()
    paste(editor, { 'text/html': '<p>Caption</p><img src="https://example.com/image.png?accessToken=fictional">' })
    await vi.waitFor(() => expect(desktop.importWorkspaceImageFromBlobURL).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(editor.state.doc.toString()).toContain('Caption')
    expect(editor.state.doc.toString()).toContain('attachments/.pending-image-')
    expect(editor.state.doc.toString()).not.toContain('accessToken')
    expect(undo(editor)).toBe(true)
    expect(editor.state.doc.toString()).toBe('old text')
  })

  it.each(['text/markdown', 'text/plain'])('localizes Markdown image destinations in %s', async (format) => {
    desktop.importWorkspaceImageFromBlobURL.mockResolvedValue({ importedPath: 'attachments/local.png', relativePath: 'local.png' })
    const editor = createEditor()
    paste(editor, { [format]: 'Caption ![Diagram](<https://example.com/image?accessToken=fictional>)' })
    await vi.waitFor(() => expect(editor.state.doc.toString()).toContain('![Diagram](attachments/local.png)'))
    expect(editor.state.doc.toString()).not.toContain('accessToken')
    expect(undo(editor)).toBe(true)
    expect(editor.state.doc.toString()).toBe('old text')
  })

  it('localizes reference images and leaves image examples inside code alone', async () => {
    desktop.importWorkspaceImageFromBlobURL.mockResolvedValue({ importedPath: 'attachments/local.png', relativePath: 'local.png' })
    const editor = createEditor()
    paste(editor, { 'text/markdown': '![Diagram][img]\n\n[img]: https://example.com/real.png\n\n`![Example](https://example.com/code.png)`' })
    await vi.waitFor(() => expect(editor.state.doc.toString()).toContain('[img]: attachments/local.png'))
    expect(editor.state.doc.toString()).toContain('`![Example](https://example.com/code.png)`')
    expect(desktop.importWorkspaceImageFromBlobURL).toHaveBeenCalledTimes(1)
  })
  it('imports mixed-content images locally and keeps paste undoable', async () => {
    desktop.importWorkspaceImageFromBlobURL.mockResolvedValue({ importedPath: 'attachments/imported.png', relativePath: 'imported.png' })
    const editor = createEditor()
    paste(editor, { 'text/html': '<p>Caption</p><img src="https://example.com/image.png">' })
    await vi.waitFor(() => expect(editor.state.doc.toString()).toContain('attachments/imported.png'))
    expect(editor.state.doc.toString()).toContain('Caption')
    expect(undo(editor)).toBe(true)
    expect(editor.state.doc.toString()).toBe('old text')
  })

  it.each(['edit', 'undo', 'destroy'] as const)('does not overwrite %s while images download', async (action) => {
    let finish!: (value: { importedPath: string; relativePath: string }) => void
    desktop.importWorkspaceImageFromBlobURL.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const editor = createEditor()
    paste(editor, { 'text/html': '<p>Caption</p><img src="https://example.com/image.png">' })
    if (action === 'edit') editor.dispatch({ changes: { from: 0, to: 7, insert: 'Changed' } })
    if (action === 'undo') editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    if (action === 'destroy') editor.destroy()
    const expected = editor.state.doc.toString()
    finish({ importedPath: 'attachments/imported.png', relativePath: 'imported.png' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(editor.state.doc.toString()).toBe(expected)
  })

  it('maps the pasted range when text is inserted before it during download', async () => {
    let finish!: (value: { importedPath: string; relativePath: string }) => void
    desktop.importWorkspaceImageFromBlobURL.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const editor = createEditor()
    editor.dispatch({ selection: { anchor: editor.state.doc.length } })
    paste(editor, { 'text/html': '<p>Caption</p><img src="https://example.com/image.png">' })
    editor.dispatch({ changes: { from: 0, insert: 'Prefix ' } })
    finish({ importedPath: 'attachments/imported.png', relativePath: 'imported.png' })
    await vi.waitFor(() => expect(editor.state.doc.toString()).toContain('attachments/imported.png'))
    expect(editor.state.doc.toString()).toMatch(/^Prefix old textCaption/)
  })

  it('replaces the selection with rich Markdown in one undoable transaction', () => {
    const editor = createEditor()
    expect(paste(editor, { 'text/html': '<strong>new</strong>', 'text/plain': 'new' }).defaultPrevented).toBe(true)
    expect(editor.state.doc.toString()).toBe('**new** text')
    expect(undo(editor)).toBe(true)
    expect(editor.state.doc.toString()).toBe('old text')
  })

  it('preserves explicit Markdown exactly', () => {
    const editor = createEditor()
    paste(editor, { 'text/markdown': '[[Link]]', 'text/html': '<p>Link</p>' })
    expect(editor.state.doc.toString()).toBe('[[Link]] text')
  })

  it('does not mutate read-only documents', () => {
    const editor = createEditor(true)
    paste(editor, { 'text/html': '<b>new</b>' })
    expect(editor.state.doc.toString()).toBe('old text')
  })

  it('lets Shift+paste use the editor plain-text behavior', () => {
    const editor = createEditor()
    editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: true }))
    paste(editor, { 'text/html': '<b>new</b>', 'text/plain': 'new' })
    expect(editor.state.doc.toString()).toBe('new text')
  })

  it('pastes into all selections consistently', () => {
    const editor = createEditor()
    editor.setState(EditorState.create({
      doc: 'a b', selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(2, 3)]),
      extensions: [pasteHtmlExtension(), EditorState.allowMultipleSelections.of(true)],
    }))
    paste(editor, { 'text/html': '<b>x</b>' })
    expect(editor.state.doc.toString()).toBe('**x** **x**')
  })
})
