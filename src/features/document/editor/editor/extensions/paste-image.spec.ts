import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const desktopMocks = vi.hoisted(() => ({
  canImportWorkspaceImageFromClipboard: vi.fn(),
  importWorkspaceImageFromBlobURL: vi.fn(),
  importWorkspaceImageFromClipboard: vi.fn(),
  importWorkspaceImageFromFile: vi.fn(),
}))

vi.mock('@/services/desktop', () => ({
  canImportWorkspaceImageFromClipboard: desktopMocks.canImportWorkspaceImageFromClipboard,
  importWorkspaceImageFromBlobURL: desktopMocks.importWorkspaceImageFromBlobURL,
  importWorkspaceImageFromClipboard: desktopMocks.importWorkspaceImageFromClipboard,
  importWorkspaceImageFromFile: desktopMocks.importWorkspaceImageFromFile,
}))

import { pasteImageExtension } from './paste-image'

describe('pasteImageExtension', () => {
  let view: EditorView | null = null

  beforeEach(() => {
    desktopMocks.canImportWorkspaceImageFromClipboard.mockReset().mockReturnValue(false)
    desktopMocks.importWorkspaceImageFromBlobURL.mockReset()
    desktopMocks.importWorkspaceImageFromClipboard.mockReset().mockResolvedValue(null)
    desktopMocks.importWorkspaceImageFromFile.mockReset()
  })

  afterEach(() => {
    view?.destroy()
    view = null
    document.body.replaceChildren()
  })

  it('imports a copied image even when the clipboard also contains its direct URL', async () => {
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    desktopMocks.importWorkspaceImageFromFile.mockResolvedValue({
      importedPath: 'Attachments/pasted-photo.png',
      relativePath: 'pasted-photo.png',
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
      expect(view?.state.doc.toString()).toBe('![[Attachments/pasted-photo.png]]')
    })
    expect(event.defaultPrevented).toBe(true)
    expect(desktopMocks.importWorkspaceImageFromFile).toHaveBeenCalledWith({
      file,
      folder: 'Attachments',
      index: 1,
    })
  })

  it('pastes an external-site HTML image when no image file is provided', async () => {
    desktopMocks.importWorkspaceImageFromBlobURL.mockRejectedValue(new TypeError('Failed to fetch'))
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
      expect(view?.state.doc.toString()).toBe(
        '![Cover](<https://cdn.example.com/photo?id=7>)',
      )
    })
    expect(event.defaultPrevented).toBe(true)
  })

  it('uses the native image behind a protected Feishu clipboard URL', async () => {
    desktopMocks.importWorkspaceImageFromClipboard.mockResolvedValue({
      importedPath: 'Attachments/pasted-feishu.png',
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
      expect(view?.state.doc.toString()).toBe('![[Attachments/pasted-feishu.png]]')
    })
    expect(event.defaultPrevented).toBe(true)
    expect(desktopMocks.importWorkspaceImageFromBlobURL).not.toHaveBeenCalled()
  })

  it('pastes a native desktop image when Feishu exposes no browser clipboard payload', async () => {
    desktopMocks.canImportWorkspaceImageFromClipboard.mockReturnValue(true)
    desktopMocks.importWorkspaceImageFromClipboard.mockResolvedValue({
      importedPath: 'Attachments/pasted-feishu.png',
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
      expect(view?.state.doc.toString()).toBe('![[Attachments/pasted-feishu.png]]')
    })
    expect(event.defaultPrevented).toBe(true)
  })
})
