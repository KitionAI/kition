import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  statWorkspaceDocument: vi.fn(),
}))

vi.mock('./request', () => ({
  default: {
    get: mocks.get,
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

describe('data document AI config normalization', () => {
  beforeEach(() => vi.clearAllMocks())

  it('strips legacy sizes from loaded image configs', async () => {
    mocks.get.mockResolvedValue({
      id: 1,
      tables: [{
        id: 2,
        fields: [
          {
            id: 3,
            options: {},
            ai_config: {
              type: 'image_customization',
              enabled: true,
              auto_update: true,
              prompt: 'Create a thumbnail',
              size: '1792x1024',
            },
          },
          {
            id: 4,
            options: {
              ai_config: {
                type: 'image_customization',
                enabled: true,
                auto_update: true,
                prompt: 'Create another thumbnail',
                size: '1792x1024',
              },
            },
            ai_config: null,
          },
          {
            id: 5,
            options: {},
            ai_config: {
              type: 'image_generation',
              enabled: true,
              auto_update: false,
              source_field_id: 1,
              size: '1024x1024',
              aspect_ratio: '4:3',
              resolution: '1K',
              quality: 'medium',
              n: 3,
              image_use_case: 'product_showcase',
            },
          },
        ],
      }],
    })
    const { getDataDocument } = await import('./dataDocuments')

    const document = await getDataDocument(1)
    const fields = document.tables[0]?.fields || []

    expect(fields[0]?.ai_config).not.toHaveProperty('size')
    expect(fields[1]?.ai_config).not.toHaveProperty('size')
    expect(fields[1]?.options).not.toHaveProperty('ai_config')
    expect(fields[2]?.ai_config).not.toHaveProperty('size')
    expect(fields[2]?.ai_config).toMatchObject({ aspect_ratio: '4:3', resolution: '1K' })
  })
})
