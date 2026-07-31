import { describe, expect, it } from 'vitest'

import type { DataDashboard, DataField, DataTable } from '@/types/dataDocument'
import { createStarterDataDashboard } from './dashboardCreation'

function field(
  id: number,
  name: string,
  title: string,
  type: DataField['type'],
  order: number,
  options?: DataField['options'],
): DataField {
  return {
    id,
    user_id: 1,
    document_id: 7,
    table_id: 11,
    name,
    title,
    type,
    required: false,
    unique: false,
    readonly: false,
    is_primary: order === 0,
    order,
    options,
    created_at: '',
    updated_at: '',
  }
}

const table: DataTable = {
  id: 11,
  user_id: 1,
  document_id: 7,
  name: 'prospects',
  title: 'Prospects',
  description: '',
  order: 0,
  fields: [
    field(1, 'name', 'Name', 'text', 0),
    field(2, 'status', 'Status', 'single_select', 1, { choices: ['Open', 'Won'] }),
    field(3, 'important', 'Important', 'checkbox', 2),
    field(4, 'created', 'Created', 'date', 3),
  ],
  created_at: '',
  updated_at: '',
}

describe('dashboard creation', () => {
  it('builds a useful dashboard from the source table fields', () => {
    const dashboard = createStarterDataDashboard(table, [])

    expect(dashboard).toMatchObject({
      id: 'prospects-dashboard',
      title: 'Prospects Dashboard',
      order: 0,
      source_table_id: 11,
    })
    expect(dashboard.widgets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'total-records', type: 'metric' }),
      expect.objectContaining({
        id: 'checked-important',
        query: { aggregation: 'count_true', field_name: 'important' },
      }),
      expect.objectContaining({
        id: 'status-distribution',
        type: 'pie',
        config: { category_order: ['Open', 'Won'] },
      }),
      expect.objectContaining({ id: 'created-timeline', type: 'line' }),
      expect.objectContaining({
        id: 'records',
        type: 'table',
        query: {
          aggregation: 'count',
          columns: ['name', 'status', 'important', 'created'],
          limit: 10,
        },
      }),
    ]))
    expect(dashboard.layout).toHaveLength(dashboard.widgets.length)
  })

  it('uses unique titles, ids, and the next display order', () => {
    const existing = [{
      id: 'prospects-dashboard',
      title: 'Prospects Dashboard',
      order: 4,
      source_table_id: 11,
      layout: [],
      widgets: [],
    }] satisfies DataDashboard[]

    expect(createStarterDataDashboard(table, existing)).toMatchObject({
      id: 'prospects-dashboard-2',
      title: 'Prospects Dashboard 2',
      order: 5,
    })
  })

  it('falls back to record count and a record list for a simple table', () => {
    const dashboard = createStarterDataDashboard({
      ...table,
      fields: [field(1, 'name', 'Name', 'text', 0)],
    }, [])

    expect(dashboard.widgets.map((widget) => widget.id)).toEqual(['total-records', 'records'])
    expect(dashboard.layout.find((item) => item.widget_id === 'records')?.y).toBe(2)
  })
})
