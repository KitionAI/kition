import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteDataDashboard, listDataDashboards, openDataDocumentByPath, putDataDashboard } from '@/api/dataDocuments'
import {
  createDataDashboardByPath,
  deleteDataDashboardByPath,
  openDataDashboardByPath,
  updateDataDashboard,
} from './dashboards'

vi.mock('@/api/dataDocuments', () => ({
  deleteDataDashboard: vi.fn(),
  listDataDashboards: vi.fn(),
  openDataDocumentByPath: vi.fn(),
  putDataDashboard: vi.fn(),
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
    vi.mocked(listDataDashboards).mockReset()
    vi.mocked(putDataDashboard).mockReset()
    vi.mocked(deleteDataDashboard).mockReset()
    vi.mocked(openDataDocumentByPath).mockResolvedValue(document as never)
    vi.mocked(listDataDashboards).mockResolvedValue({ items: [dashboard], total: 1 } as never)
    vi.mocked(putDataDashboard).mockImplementation(async (_documentId, saved) => saved as never)
  })

  it('opens a dashboard through the dashboards route', async () => {
    await expect(openDataDashboardByPath('Tasks.kitable', 'task-dashboard')).resolves.toEqual({
      dashboard,
      document,
    })
    expect(listDataDashboards).toHaveBeenCalledWith(7)
  })

  it('persists a changed dashboard by putting it, not rewriting the whole document', async () => {
    const changed = { ...dashboard, title: 'Delivery Dashboard' }
    await updateDataDashboard(document as never, changed)

    expect(putDataDashboard).toHaveBeenCalledWith(7, changed)
  })

  it('creates a generated dashboard for the selected source table', async () => {
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
    expect(putDataDashboard).toHaveBeenCalledWith(7, created.dashboard)
  })

  it('requires a table before creating a dashboard', async () => {
    vi.mocked(openDataDocumentByPath).mockResolvedValue({ ...document, tables: [] } as never)

    await expect(createDataDashboardByPath('Tasks.kitable')).rejects.toThrow(
      'Create a table before adding a dashboard.',
    )
  })

  it('deletes a dashboard through the dashboards route', async () => {
    await deleteDataDashboardByPath('Tasks.kitable', 'task-dashboard')

    expect(deleteDataDashboard).toHaveBeenCalledWith(7, 'task-dashboard')
  })
})
