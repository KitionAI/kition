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
  relativeMarkdownPath,
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
      importedPath: 'attachments/pasted-feishu.png',
      relativePath: 'pasted-feishu.png',
    })
    const images = extractImageOnlyClipboardHTML(
      '<meta charset="utf-8"><img src="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/image-id/?preview_type=16" alt="image-id">',
    )

    await expect(importDocumentClipboardImages(images, { preferNativeClipboard: true, documentPath: 'notes/today.md' }))
      .resolves.toEqual(['![image-id](../attachments/pasted-feishu.png)'])
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

  it('stores a pasted image file in attachments and links it relative to the document folder', async () => {
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    desktopMocks.importWorkspaceImageFromFile.mockResolvedValue({
      importedPath: 'attachments/pasted-photo.png',
      relativePath: 'pasted-photo.png',
    })

    await expect(importDocumentClipboardImages(
      [{ kind: 'file', file, alt: 'photo' }],
      { documentPath: 'reference/how_to_use_ga4_for_seo/overview.md' },
    )).resolves.toEqual(['![photo](../../attachments/pasted-photo.png)'])
    expect(desktopMocks.importWorkspaceImageFromFile).toHaveBeenCalledWith({
      file,
      folder: 'attachments',
      index: 1,
    })
  })

  it('links a pasted image from a root document without a parent prefix', async () => {
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    desktopMocks.importWorkspaceImageFromFile.mockResolvedValue({
      importedPath: 'attachments/pasted-photo.png',
      relativePath: 'pasted-photo.png',
    })

    await expect(importDocumentClipboardImages([{ kind: 'file', file, alt: 'photo' }], { documentPath: 'Home.md' }))
      .resolves.toEqual(['![photo](attachments/pasted-photo.png)'])
  })

  it('computes document-relative paths, sharing a common prefix and quoting spaces', () => {
    expect(relativeMarkdownPath('Home.md', 'attachments/a.png')).toBe('attachments/a.png')
    expect(relativeMarkdownPath('notes/daily/today.md', 'attachments/a.png')).toBe('../../attachments/a.png')
    expect(relativeMarkdownPath('attachments/readme.md', 'attachments/a.png')).toBe('a.png')
    expect(relativeMarkdownPath('reference/x/y.md', 'reference/img/a.png')).toBe('../img/a.png')
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
