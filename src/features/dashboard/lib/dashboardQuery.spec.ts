import { describe, expect, it } from 'vitest'

import type { DataDashboardWidget, DataField, DataRecord } from '@/types/dataDocument'
import { executeDashboardWidgetQuery } from './dashboardQuery'

const fields = [
  { name: 'task', title: 'Task' },
  { name: 'progress', title: 'Progress' },
  { name: 'important', title: 'Important' },
] as DataField[]

const records = [
  { id: 1, values: { task: 'One', progress: 'Completed', important: true } },
  { id: 2, values: { task: 'Two', progress: 'In Progress', important: true } },
  { id: 3, values: { task: 'Three', progress: 'In Progress' } },
] as unknown as DataRecord[]

describe('executeDashboardWidgetQuery', () => {
  it('counts filtered and boolean metric values', () => {
    const completed: DataDashboardWidget = {
      id: 'completed',
      title: 'Completed',
      type: 'metric',
      query: {
        aggregation: 'count',
        filters: [{ field_name: 'progress', operator: 'equals', value: 'Completed' }],
      },
    }
    const important: DataDashboardWidget = {
      id: 'important',
      title: 'Important',
      type: 'metric',
      query: { aggregation: 'count_true', field_name: 'important' },
    }

    expect(executeDashboardWidgetQuery(completed, records, fields)).toEqual({
      kind: 'metric',
      value: 1,
    })
    expect(executeDashboardWidgetQuery(important, records, fields)).toEqual({
      kind: 'metric',
      value: 2,
    })
  })

  it('groups records in the configured category order', () => {
    const widget: DataDashboardWidget = {
      id: 'progress',
      title: 'Progress',
      type: 'pie',
      query: { aggregation: 'count', group_by_field_name: 'progress' },
      config: { category_order: ['Completed', 'In Progress', 'Not Started'] },
    }

    expect(executeDashboardWidgetQuery(widget, records, fields)).toEqual({
      kind: 'series',
      points: [
        { label: 'Completed', value: 1 },
        { label: 'In Progress', value: 2 },
      ],
    })
  })

  it('returns requested columns for table widgets', () => {
    const widget: DataDashboardWidget = {
      id: 'important-table',
      title: 'Important tasks',
      type: 'table',
      query: {
        aggregation: 'count',
        filters: [{ field_name: 'important', operator: 'truthy' }],
        columns: ['task', 'progress'],
      },
    }

    expect(executeDashboardWidgetQuery(widget, records, fields)).toMatchObject({
      kind: 'table',
      columns: [
        { name: 'task', title: 'Task' },
        { name: 'progress', title: 'Progress' },
      ],
      rows: [{ id: 1 }, { id: 2 }],
    })
  })
})
