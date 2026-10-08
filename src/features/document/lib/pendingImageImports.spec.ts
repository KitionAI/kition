import { beforeEach, describe, expect, it, vi } from 'vitest'

const desktop = vi.hoisted(() => ({
  importWorkspaceImageFromBlobURL: vi.fn(), importWorkspaceImageFromFile: vi.fn(),
  importWorkspaceImageFromClipboard: vi.fn(), canImportWorkspaceImageFromClipboard: vi.fn(),
}))
vi.mock('@/services/desktop', () => desktop)

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  localStorage.clear()
})

async function deferred() {
  const module = await import('./pendingImageImports')
  const markdown = module.deferImageImport({ kind: 'source', source: 'https://example.invalid/image?accessToken=fictional', alt: 'Diagram' }, 'Notes/page.md', new Error('403'))
  const source = markdown.slice(markdown.indexOf('](') + 2, -1)
  return { module, markdown, id: module.pendingImageId(source)! }
}

describe('pending local image imports', () => {
  it('restores completed attachments under non-Latin note folders', async () => {
    const { module, id } = await deferred()
    const noteName = String.fromCodePoint(0x7b14, 0x8bb0)
    desktop.importWorkspaceImageFromBlobURL.mockResolvedValue({
      importedPath: `attachments/Notes/${noteName} (1).md/image.png`, relativePath: 'image.png',
    })
    const destination = await module.retryPendingImage(id, `Notes/${noteName}.md`)
    expect(destination).toContain('%20%281%29.md')
    vi.resetModules()
    const restored = await import('./pendingImageImports')
    expect(restored.pendingImageStatus(id).destination).toBe(destination)
  })
  it('restores retry information after restarting and removes the signed source after success', async () => {
    const { id, markdown } = await deferred()
    expect(markdown).not.toContain('accessToken')
    vi.resetModules()
    const restored = await import('./pendingImageImports')
    expect(restored.pendingImageStatus(id)).toMatchObject({ available: true, reason: 'accessDenied' })
    desktop.importWorkspaceImageFromBlobURL.mockResolvedValue({ importedPath: 'attachments/saved.png', relativePath: 'saved.png' })
    expect(await restored.retryPendingImage(id, 'Notes/page.md')).toBe('../attachments/saved.png')
    expect(localStorage.getItem(`kition.pending-image.${id}`)).not.toContain('accessToken')
    vi.resetModules()
    const completed = await import('./pendingImageImports')
    expect(await completed.retryPendingImage(id, 'Notes/page.md')).toBe('../attachments/saved.png')
    expect(desktop.importWorkspaceImageFromBlobURL).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent retries and permits retrying a failed download', async () => {
    const { module, id } = await deferred()
    desktop.importWorkspaceImageFromBlobURL.mockRejectedValue(new Error('403'))
    const retries = await Promise.allSettled([module.retryPendingImage(id, ''), module.retryPendingImage(id, '')])
    expect(retries.every((result) => result.status === 'rejected')).toBe(true)
    expect(desktop.importWorkspaceImageFromBlobURL).toHaveBeenCalledTimes(1)
    desktop.importWorkspaceImageFromBlobURL.mockResolvedValue({ importedPath: 'attachments/saved.png', relativePath: 'saved.png' })
    expect(await module.retryPendingImage(id, '')).toBe('attachments/saved.png')
  })

  it('does not accept external URLs as completed local attachments', async () => {
    const module = await import('./pendingImageImports')
    const id = crypto.randomUUID()
    localStorage.setItem(`kition.pending-image.${id}`, JSON.stringify({ destination: '//example.invalid/image.png' }))
    expect(module.pendingImageStatus(id).available).toBe(false)
  })
})
