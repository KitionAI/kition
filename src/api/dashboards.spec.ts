import { beforeEach, describe, expect, it, vi } from 'vitest'

import { openDataDocumentByPath, updateDataDocument } from '@/api/dataDocuments'
import {
  createDataDashboardByPath,
  openDataDashboardByPath,
  updateDataDashboard,
} from './dashboards'

vi.mock('@/api/dataDocuments', () => ({
  openDataDocumentByPath: vi.fn(),
  updateDataDocument: vi.fn(),
}))

const dashboard = {
  id: 'task-dashboard',
  title: 'Task Dashboard',
  order: 0,
  source_table_id: 11,
  layout: [],
  widgets: [],
}

const document = {
  id: 7,
  path: 'Tasks.kitable',
  meta: { dashboards: [dashboard] },
  tables: [{
    id: 11,
    title: 'Tasks',
    name: 'tasks',
    order: 0,
    fields: [{
      id: 21,
      name: 'title',
      title: 'Title',
      type: 'text',
      order: 0,
    }],
  }],
}

describe('dashboard API', () => {
  beforeEach(() => {
    vi.mocked(openDataDocumentByPath).mockReset()
    vi.mocked(updateDataDocument).mockReset()
    vi.mocked(openDataDocumentByPath).mockResolvedValue(document as never)
    vi.mocked(updateDataDocument).mockResolvedValue(document as never)
  })

  it('opens a dashboard stored in document metadata', async () => {
    await expect(openDataDashboardByPath('Tasks.kitable', 'task-dashboard')).resolves.toEqual({
      dashboard,
      document,
    })
  })

  it('persists a changed dashboard without discarding existing metadata', async () => {
    const changed = { ...dashboard, title: 'Delivery Dashboard' }
    await updateDataDashboard(document as never, changed)

    expect(updateDataDocument).toHaveBeenCalledWith(7, {
      meta: {
        dashboards: [changed],
      },
    })
  })

  it('creates a generated dashboard for the selected source table', async () => {
    vi.mocked(updateDataDocument).mockImplementation(async (_documentId, payload) => ({
      ...document,
      meta: payload.meta,
    }) as never)

    const created = await createDataDashboardByPath('Tasks.kitable', 11)

    expect(created.dashboard).toMatchObject({
      id: 'tasks-dashboard',
      title: 'Tasks Dashboard',
      order: 1,
      source_table_id: 11,
    })
    expect(created.dashboard.widgets.map((widget) => widget.id)).toEqual([
      'total-records',
      'records',
    ])
    expect(updateDataDocument).toHaveBeenCalledWith(7, {
      meta: {
        dashboards: [dashboard, created.dashboard],
      },
    })
  })

  it('requires a table before creating a dashboard', async () => {
    vi.mocked(openDataDocumentByPath).mockResolvedValue({ ...document, tables: [] } as never)

    await expect(createDataDashboardByPath('Tasks.kitable')).rejects.toThrow(
      'Create a table before adding a dashboard.',
    )
  })
})
