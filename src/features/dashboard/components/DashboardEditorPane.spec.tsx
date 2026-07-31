import { act, createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-grid-layout/legacy', () => ({
  Responsive: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  WidthProvider: (Component: ComponentType<any>) => Component,
}))

vi.mock('recharts', () => {
  const Component = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  return {
    Bar: Component,
    BarChart: Component,
    CartesianGrid: Component,
    Cell: Component,
    Line: Component,
    LineChart: Component,
    Pie: Component,
    PieChart: Component,
    ResponsiveContainer: Component,
    Tooltip: Component,
    XAxis: Component,
    YAxis: Component,
  }
})

vi.mock('@/api/dashboards', () => ({
  openDataDashboardByPath: vi.fn(),
  updateDataDashboard: vi.fn(),
}))

vi.mock('@/api/dataDocuments', () => ({
  listDataRecords: vi.fn(),
}))

import { listDataRecords } from '@/api/dataDocuments'
import { openDataDashboardByPath } from '@/api/dashboards'
import { DashboardEditorPane } from './DashboardEditorPane'

let container: HTMLDivElement
let root: Root | null = null

const table = {
  id: 11,
  title: 'Task Management',
  fields: [
    { name: 'task_description', title: 'Task Description' },
    { name: 'progress', title: 'Progress' },
  ],
}

const dashboard = {
  id: 'task-dashboard',
  title: 'Task Dashboard',
  order: 0,
  source_table_id: 11,
  layout: [
    { widget_id: 'total', x: 0, y: 0, w: 3, h: 2 },
    { widget_id: 'completed', x: 3, y: 0, w: 3, h: 2 },
  ],
  widgets: [
    { id: 'total', title: 'Total tasks', type: 'metric', query: { aggregation: 'count' } },
    {
      id: 'completed',
      title: 'Completed',
      type: 'metric',
      query: {
        aggregation: 'count',
        filters: [{ field_name: 'progress', operator: 'equals', value: 'Completed' }],
      },
    },
  ],
}

const dataDocument = {
  id: 7,
  path: 'Tasks.kitable',
  meta: { dashboards: [dashboard] },
  tables: [table],
}

beforeEach(() => {
  container = documentNode()
  document.body.appendChild(container)
  vi.mocked(openDataDashboardByPath).mockReset()
  vi.mocked(listDataRecords).mockReset()
  vi.mocked(openDataDashboardByPath).mockResolvedValue({ dashboard, document: dataDocument } as never)
  vi.mocked(listDataRecords).mockResolvedValue({
    items: [
      { id: 1, values: { progress: 'Completed' } },
      { id: 2, values: { progress: 'In Progress' } },
      { id: 3, values: { progress: 'In Progress' } },
    ],
    total: 3,
  } as never)
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
})

describe('DashboardEditorPane', () => {
  it('loads live records and renders metric widgets', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(DashboardEditorPane, {
        dashboardId: 'task-dashboard',
        documentPath: 'Tasks.kitable',
      }))
      await Promise.resolve()
    })
    for (let index = 0; index < 12; index += 1) {
      await act(async () => { await Promise.resolve() })
      if (container.querySelector('[data-testid="dashboard-editor-pane"]')) break
    }

    expect(container.textContent).toContain('Task Dashboard')
    expect(container.textContent).toContain('3 records')
    expect(container.querySelector('[data-testid="dashboard-widget-total"]')?.textContent).toContain('3')
    expect(container.querySelector('[data-testid="dashboard-widget-completed"]')?.textContent).toContain('1')
  })

  it('reloads when the source table dispatches a record change', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(DashboardEditorPane, {
        dashboardId: 'task-dashboard',
        documentPath: 'Tasks.kitable',
      }))
      await Promise.resolve()
    })
    for (let index = 0; index < 12; index += 1) {
      await act(async () => { await Promise.resolve() })
      if (vi.mocked(openDataDashboardByPath).mock.calls.length === 1) break
    }

    await act(async () => {
      window.dispatchEvent(new CustomEvent('kition:data-document:record:upsert', {
        detail: { vaultPath: 'Tasks.kitable', tableId: 11 },
      }))
      await Promise.resolve()
    })

    expect(openDataDashboardByPath).toHaveBeenCalledTimes(2)
    expect(listDataRecords).toHaveBeenCalledTimes(2)
  })
})

function documentNode() {
  return window.document.createElement('div')
}
