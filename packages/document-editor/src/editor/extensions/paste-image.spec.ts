import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDocumentHost } from '../../host'

const imageImport = vi.hoisted(() => ({
  canReadClipboard: vi.fn(),
  fromURL: vi.fn(),
  fromClipboard: vi.fn(),
  fromFile: vi.fn(),
}))

// The app's image import, as the editor's host offers it.
setDocumentHost({ images: imageImport })

import { pasteImageExtension } from './paste-image'

describe('pasteImageExtension', () => {
  let view: EditorView | null = null

  beforeEach(() => {
    imageImport.canReadClipboard.mockReset().mockReturnValue(false)
    imageImport.fromURL.mockReset()
    imageImport.fromClipboard.mockReset().mockResolvedValue(null)
    imageImport.fromFile.mockReset()
  })

  afterEach(() => {
    view?.destroy()
    view = null
    document.body.replaceChildren()
  })

  it('imports a copied image even when the clipboard also contains its direct URL', async () => {
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    imageImport.fromFile.mockResolvedValue({
      importedPath: 'attachments/pasted-photo.png',
      relativePath: 'pasted-photo.png',
    })
    view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [pasteImageExtension({ sourcePath: 'Notes/demo.md' })],
      }),
      parent: document.body,
    })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => file,
        }],
        files: [],
        getData: (type: string) => type === 'text/plain'
          ? 'https://cdn.example.com/photo.png'
          : '',
      },
    })

    view.contentDOM.dispatchEvent(event)

    await vi.waitFor(() => {
      expect(view?.state.doc.toString()).toBe('![photo](../attachments/pasted-photo.png)')
    })
    expect(event.defaultPrevented).toBe(true)
    expect(imageImport.fromFile).toHaveBeenCalledWith({
      file,
      folder: 'attachments/Notes/demo.md',
      index: 1,
    })
  })

  it('does not insert an external image link when downloading fails', async () => {
    imageImport.fromURL.mockRejectedValue(new TypeError('Failed to fetch'))
    view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [pasteImageExtension()],
      }),
      parent: document.body,
    })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [],
        files: [],
        getData: (type: string) => type === 'text/html'
          ? '<img src="https://cdn.example.com/photo?id=7" alt="Cover">'
          : '',
      },
    })

    view.contentDOM.dispatchEvent(event)

    await vi.waitFor(() => {
      expect(imageImport.fromURL).toHaveBeenCalled()
      expect(view?.state.doc.toString()).toBe('')
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('uses the native image behind a protected Feishu clipboard URL', async () => {
    imageImport.fromClipboard.mockResolvedValue({
      importedPath: 'attachments/pasted-feishu.png',
      relativePath: 'pasted-feishu.png',
    })
    view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [pasteImageExtension()],
      }),
      parent: document.body,
    })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [],
        files: [],
        getData: (type: string) => type === 'text/html'
          ? '<meta charset="utf-8"><img src="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/image-id/?preview_type=16" alt="image-id">'
          : '',
      },
    })

    view.contentDOM.dispatchEvent(event)

    await vi.waitFor(() => {
      expect(view?.state.doc.toString()).toBe('![image-id](attachments/pasted-feishu.png)')
    })
    expect(event.defaultPrevented).toBe(true)
    expect(imageImport.fromURL).not.toHaveBeenCalled()
  })

  it('pastes a native desktop image when Feishu exposes no browser clipboard payload', async () => {
    imageImport.canReadClipboard.mockReturnValue(true)
    imageImport.fromClipboard.mockResolvedValue({
      importedPath: 'attachments/pasted-feishu.png',
      relativePath: 'pasted-feishu.png',
    })
    view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [pasteImageExtension()],
      }),
      parent: document.body,
    })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [],
        files: [],
        getData: () => '',
      },
    })

    view.contentDOM.dispatchEvent(event)

    await vi.waitFor(() => {
      expect(view?.state.doc.toString()).toBe('![image](attachments/pasted-feishu.png)')
    })
    expect(event.defaultPrevented).toBe(true)
  })
})
