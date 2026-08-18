import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import {
  canPasteNativeDocumentClipboardImage,
  collectDocumentClipboardImages,
  extractImageOnlyClipboardHTML,
  importDocumentClipboardImages,
} from './documentImagePaste'

describe('document image paste', () => {
  beforeEach(() => {
    desktopMocks.canImportWorkspaceImageFromClipboard.mockReset().mockReturnValue(false)
    desktopMocks.importWorkspaceImageFromBlobURL.mockReset()
    desktopMocks.importWorkspaceImageFromClipboard.mockReset().mockResolvedValue(null)
    desktopMocks.importWorkspaceImageFromFile.mockReset()
  })

  it('keeps a copied image file even when the clipboard also contains its external URL', () => {
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    const images = collectDocumentClipboardImages({
      items: [{
        kind: 'file',
        type: 'image/png',
        getAsFile: () => file,
      }],
      files: [],
      getData: (type: string) => type === 'text/plain' ? 'https://cdn.example.com/photo.png' : '',
    } as unknown as DataTransfer)

    expect(images).toEqual([{ kind: 'file', file, alt: 'photo' }])
  })

  it('recognizes a copied image file when the clipboard item omits its MIME type', () => {
    const file = new File(['image'], 'photo.png', { type: '' })
    const images = collectDocumentClipboardImages({
      items: [{
        kind: 'file',
        type: '',
        getAsFile: () => file,
      }],
      files: [],
      getData: () => '',
    } as unknown as DataTransfer)

    expect(images).toEqual([{ kind: 'file', file, alt: 'photo' }])
  })

  it('does not count the same clipboard image from items and files twice', () => {
    const itemFile = new File(['image'], 'image.png', { type: 'image/png' })
    const listFile = new File(['image'], 'image.png', { type: 'image/png' })
    const images = collectDocumentClipboardImages({
      items: [{
        kind: 'file',
        type: 'image/png',
        getAsFile: () => itemFile,
      }],
      files: [listFile],
      getData: () => '',
    } as unknown as DataTransfer)

    expect(images).toEqual([{ kind: 'file', file: itemFile, alt: 'image' }])
  })

  it('reads an image-only HTML clipboard payload from an external site', () => {
    expect(extractImageOnlyClipboardHTML(
      '<a href="https://example.com/article"><img src="https://cdn.example.com/photo?id=7" alt="Cover"></a>',
    )).toEqual([{
      kind: 'source',
      source: 'https://cdn.example.com/photo?id=7',
      alt: 'Cover',
    }])
  })

  it('uses the native desktop image instead of a protected Feishu preview URL', async () => {
    desktopMocks.importWorkspaceImageFromClipboard.mockResolvedValue({
      importedPath: 'Attachments/pasted-feishu.png',
      relativePath: 'pasted-feishu.png',
    })
    const images = extractImageOnlyClipboardHTML(
      '<meta charset="utf-8"><img src="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/image-id/?preview_type=16" alt="image-id">',
    )

    await expect(importDocumentClipboardImages(images, { preferNativeClipboard: true }))
      .resolves.toEqual(['![[Attachments/pasted-feishu.png]]'])
    expect(desktopMocks.importWorkspaceImageFromBlobURL).not.toHaveBeenCalled()
  })

  it('allows a native-image fallback when the paste event exposes no web payload', () => {
    desktopMocks.canImportWorkspaceImageFromClipboard.mockReturnValue(true)

    expect(canPasteNativeDocumentClipboardImage({
      getData: () => '',
    } as unknown as DataTransfer)).toBe(true)
  })

  it('does not swallow normal article text that happens to contain an image', () => {
    expect(extractImageOnlyClipboardHTML(
      '<p>Article introduction</p><img src="https://cdn.example.com/photo.png">',
    )).toEqual([])
  })

  it('stores a pasted image file in Attachments and returns a durable wikilink', async () => {
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    desktopMocks.importWorkspaceImageFromFile.mockResolvedValue({
      importedPath: 'Attachments/pasted-photo.png',
      relativePath: 'pasted-photo.png',
    })

    await expect(importDocumentClipboardImages([{ kind: 'file', file, alt: 'photo' }]))
      .resolves.toEqual(['![[Attachments/pasted-photo.png]]'])
    expect(desktopMocks.importWorkspaceImageFromFile).toHaveBeenCalledWith({
      file,
      folder: 'Attachments',
      index: 1,
    })
  })

  it('falls back to a remote Markdown image when the site blocks downloading', async () => {
    desktopMocks.importWorkspaceImageFromBlobURL.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(importDocumentClipboardImages([{
      kind: 'source',
      source: 'https://cdn.example.com/photo?id=7',
      alt: 'Cover image',
    }])).resolves.toEqual([
      '![Cover image](<https://cdn.example.com/photo?id=7>)',
    ])
  })
})
