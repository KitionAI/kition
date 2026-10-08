import { describe, expect, it, vi } from 'vitest'
import { documentAttachmentFolder } from './documentAttachments'

const desktop = vi.hoisted(() => ({
  importWorkspaceImageFromBlobURL: vi.fn(), importWorkspaceImageFromFile: vi.fn(),
  importWorkspaceImageFromClipboard: vi.fn(), canImportWorkspaceImageFromClipboard: vi.fn(),
}))
vi.mock('@/services/desktop', () => desktop)
import { importDocumentClipboardImages } from './documentImagePaste'
import { persistBlobImageLinks } from './documentAssetPersistence'

describe('per-document attachment folders', () => {
  it('uses the same folder when saving temporary blob images', async () => {
    desktop.importWorkspaceImageFromBlobURL.mockImplementation(async ({ folder }: { folder: string }) => ({
      importedPath: `${folder}/saved.png`, relativePath: 'saved.png',
    }))
    expect(await persistBlobImageLinks('Before ![Photo](blob:temporary) after', 'Notes/Plan.md'))
      .toBe('Before ![Photo](../attachments/Notes/Plan.md/saved.png) after')
  })
  it('separates same-name notes by full workspace path and extension', () => {
    expect(documentAttachmentFolder('Team A/Plan.md')).toBe('attachments/Team A/Plan.md')
    expect(documentAttachmentFolder('Team B/Plan.md')).toBe('attachments/Team B/Plan.md')
    expect(documentAttachmentFolder('Team A/Plan.markdown')).toBe('attachments/Team A/Plan.markdown')
    expect(documentAttachmentFolder('')).toBe('attachments/_unfiled')
    expect(() => documentAttachmentFolder('../outside.md')).toThrow()
  })

  it.each(['file', 'source', 'native'])('groups %s imports and emits document-relative links', async (kind) => {
    const save = async ({ folder }: { folder: string }) => ({ importedPath: `${folder}/image.png`, relativePath: 'image.png' })
    desktop.importWorkspaceImageFromFile.mockImplementation(save)
    desktop.importWorkspaceImageFromBlobURL.mockImplementation(save)
    desktop.importWorkspaceImageFromClipboard.mockImplementation(save)
    const image = kind === 'file'
      ? { kind: 'file' as const, file: new File(['image'], 'image.png', { type: 'image/png' }), alt: 'Photo' }
      : { kind: 'source' as const, source: 'https://example.invalid/image.png', alt: 'Photo' }
    const result = await importDocumentClipboardImages([image], { documentPath: 'Team A/Plan #1.md', preferNativeClipboard: kind === 'native' })
    expect(result).toEqual(['![Photo](<../attachments/Team A/Plan %231.md/image.png>)'])
  })
})
