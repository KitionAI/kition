import { describe, expect, it, vi } from 'vitest'

import {
  createExportImageInliner,
  decodeHtmlAttribute,
  decodeURIPath,
  escapeHtmlAttribute,
  imageMimeTypeFromPath,
  isImagePath,
  isWorkspaceRootImagePath,
  parentWorkspacePath,
  unresolvedClipboardImageSources,
  unwrapMarkdownDestination,
} from './export-images.mjs'

describe('export image helpers', () => {
  it('round-trips HTML attribute escaping and decodes nested URI encoding', () => {
    expect(decodeHtmlAttribute(escapeHtmlAttribute('a&b"<c>'))).toBe('a&b"<c>')
    expect(decodeURIPath('docs/caf%25C3%25A9/img.png')).toBe('docs/café/img.png')
    expect(unwrapMarkdownDestination('<my image.png>')).toBe('my image.png')
  })

  it('classifies image paths and workspace roots', () => {
    expect(isImagePath('a/b.PNG?x=1')).toBe(true)
    expect(isImagePath('a/b.md')).toBe(false)
    expect(isWorkspaceRootImagePath('attachments/x.png')).toBe(true)
    expect(isWorkspaceRootImagePath('notes/x.png')).toBe(false)
    expect(parentWorkspacePath('notes/sub/doc.md')).toBe('notes/sub')
    expect(imageMimeTypeFromPath('x.webp?v=2')).toBe('image/webp')
    expect(imageMimeTypeFromPath('x.unknown')).toBe('image/png')
  })

  it('lists clipboard image sources that are not data URLs', () => {
    const html = '<img src="data:image/png;base64,AAA"><img src="/workspace-files/a.png"><img src=\'https://x/y.png\'>'
    expect(unresolvedClipboardImageSources(html)).toEqual(['/workspace-files/a.png', 'https://x/y.png'])
  })
})

describe('createExportImageInliner', () => {
  const deps = {
    getBackendPublicBaseURL: () => 'http://127.0.0.1:18101',
    getWorkspaceRoot: () => '/vault',
    resolveSafeWorkspacePath: vi.fn(async (relativePath: string) => ({ absolutePath: `/vault/${relativePath}` })),
    resolveSafeWorkspaceProtocolPath: vi.fn(async () => ({ absolutePath: '/vault/protocol.png' })),
    assertWorkspacePathSafe: vi.fn(async (_root: string, target: string) => target),
    readFile: vi.fn(async (filePath: string) => Buffer.from(`file:${filePath}`)),
    fetchImage: vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new TextEncoder().encode('remote').buffer,
    })),
  }
  const inliner = createExportImageInliner(deps)

  it('resolves relative images next to the document and workspace-root images at the root', async () => {
    expect(await inliner.exportImageFilePath('pic.png', 'notes/doc.md')).toBe('/vault/notes/pic.png')
    expect(await inliner.exportImageFilePath('attachments/pic.png', 'notes/doc.md')).toBe('/vault/attachments/pic.png')
    expect(await inliner.exportImageFilePath('/workspace-files/a%20b.png', 'notes/doc.md')).toBe('/vault/a b.png')
    expect(await inliner.exportImageFilePath('data:image/png;base64,AAA', 'notes/doc.md')).toBe('')
  })

  it('inlines local and remote images and leaves unresolved tags alone', async () => {
    const html = '<p><img src="pic.png" alt="a"><img src="https://cdn/x.jpg"><img src="blob:abc"></p>'
    const result = await inliner.inlineExportImages(html, 'notes/doc.md')
    expect(result).toContain(`src="data:image/png;base64,${Buffer.from('file:/vault/notes/pic.png').toString('base64')}"`)
    expect(result).toContain(`src="data:image/jpeg;base64,${Buffer.from('remote').toString('base64')}"`)
    expect(result).toContain('src="blob:abc"')
    expect(inliner.resolveExportImageURL('/api/x.png')).toBe('http://127.0.0.1:18101/api/x.png')
    expect(inliner.workspaceRelativePathFromPublicURL('http://127.0.0.1:18101/workspace-files/a/b.png')).toBe('a/b.png')
  })
})
