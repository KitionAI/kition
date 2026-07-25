import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  statWorkspaceDocument: vi.fn(),
}))

vi.mock('./request', () => ({
  default: {
    get: vi.fn(),
    post: mocks.post,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@/services/desktop', () => ({
  statWorkspaceDocument: mocks.statWorkspaceDocument,
}))

describe('openDataDocumentByPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.statWorkspaceDocument.mockResolvedValue(null)
    mocks.post.mockResolvedValue({ id: 1, path: 'Tasks.kitable', tables: [] })
  })

  it('rejects empty Kitable files before calling the runtime', async () => {
    mocks.statWorkspaceDocument.mockResolvedValue({ mtime_ms: 1, size: 0 })
    const { openDataDocumentByPath } = await import('./dataDocuments')

    await expect(openDataDocumentByPath({ path: 'Empty.kitable' }))
      .rejects.toThrow('This Kitable file is empty or incomplete.')
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('opens non-empty Kitable files through the runtime', async () => {
    mocks.statWorkspaceDocument.mockResolvedValue({ mtime_ms: 1, size: 4096 })
    const { openDataDocumentByPath } = await import('./dataDocuments')

    await expect(openDataDocumentByPath({ path: 'Tasks.kitable' }))
      .resolves.toMatchObject({ id: 1, path: 'Tasks.kitable' })
    expect(mocks.post).toHaveBeenCalledWith('/v1/data-documents/open', { path: 'Tasks.kitable' })
  })

  it('keeps browser and older-runtime fallbacks working when stat is unavailable', async () => {
    mocks.statWorkspaceDocument.mockRejectedValue(new Error('handler unavailable'))
    const { openDataDocumentByPath } = await import('./dataDocuments')

    await expect(openDataDocumentByPath({ path: 'Tasks.kitable' })).resolves.toBeTruthy()
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })
})
