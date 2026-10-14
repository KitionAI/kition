import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  statWorkspaceDocument: vi.fn(),
}))

vi.mock('./request', () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
    patch: vi.fn(),
    put: mocks.put,
    delete: mocks.delete,
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

describe('table transaction API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('transactDataDocument posts the ops and unwraps the change and created row keys', async () => {
    const change = {
      documentId: '1',
      origin: 'person:session:abc',
      tables: [],
      schema: [],
      views: [],
      recordsUpserted: [[11, 'r1']],
      recordsDeleted: [],
      recordsReordered: [],
      dashboards: false,
    }
    mocks.post.mockResolvedValue({ code: 200, data: { change, created: ['r1'] } })
    const { transactDataDocument } = await import('./dataDocuments')

    const ops = [{ op: 'cells.set' as const, tableId: 11, records: [{ rowKey: 'r1', values: { title: 'a' } }] }]
    await expect(transactDataDocument(1, ops)).resolves.toEqual({ change, created: ['r1'] })
    expect(mocks.post).toHaveBeenCalledWith('/v1/data-documents/1/transact', { ops })
  })

  it('undoDataDocument and redoDataDocument post an empty body to their own routes', async () => {
    const change = {
      documentId: '1',
      origin: 'person:session:abc',
      tables: [],
      schema: [],
      views: [],
      recordsUpserted: [],
      recordsDeleted: [],
      recordsReordered: [],
      dashboards: false,
    }
    mocks.post.mockResolvedValue({ code: 200, data: { done: true, change } })
    const { undoDataDocument, redoDataDocument } = await import('./dataDocuments')

    await expect(undoDataDocument(1)).resolves.toEqual({ done: true, change })
    expect(mocks.post).toHaveBeenCalledWith('/v1/data-documents/1/undo', {})

    await expect(redoDataDocument(1)).resolves.toEqual({ done: true, change })
    expect(mocks.post).toHaveBeenCalledWith('/v1/data-documents/1/redo', {})
  })

  it('getDataDocumentHistoryState gets the history-state route', async () => {
    mocks.get.mockResolvedValue({ code: 200, data: { canUndo: true, canRedo: false } })
    const { getDataDocumentHistoryState } = await import('./dataDocuments')

    await expect(getDataDocumentHistoryState(1)).resolves.toEqual({ canUndo: true, canRedo: false })
    expect(mocks.get).toHaveBeenCalledWith('/v1/data-documents/1/history-state')
  })
})

describe('data dashboards API', () => {
  beforeEach(() => vi.clearAllMocks())

  const dashboard = {
    id: 'd1',
    title: 'Overview',
    order: 0,
    source_table_id: 11,
    layout: [],
    widgets: [],
  }

  it('listDataDashboards gets the dashboards route', async () => {
    mocks.get.mockResolvedValue({ code: 200, data: { items: [dashboard], total: 1 } })
    const { listDataDashboards } = await import('./dataDocuments')

    await expect(listDataDashboards(1)).resolves.toEqual({ items: [dashboard], total: 1 })
    expect(mocks.get).toHaveBeenCalledWith('/v1/data-documents/1/dashboards')
  })

  it('putDataDashboard puts the dashboard at its own id', async () => {
    mocks.put.mockResolvedValue({ code: 200, data: dashboard })
    const { putDataDashboard } = await import('./dataDocuments')

    await expect(putDataDashboard(1, dashboard)).resolves.toEqual(dashboard)
    expect(mocks.put).toHaveBeenCalledWith('/v1/data-documents/1/dashboards/d1', dashboard)
  })

  it('deleteDataDashboard deletes the dashboard by id', async () => {
    mocks.delete.mockResolvedValue({ code: 200, data: {} })
    const { deleteDataDashboard } = await import('./dataDocuments')

    await deleteDataDashboard(1, 'd1')
    expect(mocks.delete).toHaveBeenCalledWith('/v1/data-documents/1/dashboards/d1')
  })

  it('putDataDashboard and deleteDataDashboard encode a dashboard id with path-breaking characters', async () => {
    mocks.put.mockResolvedValue({ code: 200, data: dashboard })
    mocks.delete.mockResolvedValue({ code: 200, data: {} })
    const { putDataDashboard, deleteDataDashboard } = await import('./dataDocuments')
    const trickyDashboard = { ...dashboard, id: 'a/b c?d' }

    await putDataDashboard(1, trickyDashboard)
    expect(mocks.put).toHaveBeenCalledWith('/v1/data-documents/1/dashboards/a%2Fb%20c%3Fd', trickyDashboard)

    await deleteDataDashboard(1, 'a/b c?d')
    expect(mocks.delete).toHaveBeenCalledWith('/v1/data-documents/1/dashboards/a%2Fb%20c%3Fd')
  })
})
