import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/dataDocuments', () => ({
  listDataDocuments: vi.fn(),
}))

vi.mock('@/features/workflow/api', () => ({
  listWorkflows: vi.fn(),
}))

import { listDataDocuments } from '@/api/dataDocuments'
import { listWorkflows } from '@/features/workflow/api'

import { useKitableChildrenIndex } from './useKitableChildrenIndex'

function HookSurface({ onResult }: { onResult: (r: ReturnType<typeof useKitableChildrenIndex>) => void }) {
  const result = useKitableChildrenIndex()
  useEffect(() => onResult(result), [result, onResult])
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(listDataDocuments).mockReset()
  vi.mocked(listWorkflows).mockReset()
  vi.mocked(listWorkflows).mockResolvedValue([])
})

afterEach(() => {
  root?.unmount()
  container.remove()
  vi.restoreAllMocks()
})

async function mountAndSettle(): Promise<ReturnType<typeof useKitableChildrenIndex>> {
  let captured: ReturnType<typeof useKitableChildrenIndex> | null = null
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(HookSurface, { onResult: (r) => { captured = r } }))
    await Promise.resolve()
  })
  for (let i = 0; i < 16; i++) {
    await act(async () => { await Promise.resolve() })
    if (captured?.status === 'done' || captured?.status === 'error') break
  }
  return captured!
}

describe('useKitableChildrenIndex', () => {
  it('builds tablesByKitablePath keyed by kitable file path, with table.order preserved', async () => {
    vi.mocked(listDataDocuments).mockResolvedValueOnce({
      items: [
        {
          id: 1,
          path: 'Leads.kitable',
          meta: {
            dashboards: [{
              id: 'sales-dashboard',
              title: 'Sales Dashboard',
              order: 0,
              source_table_id: 7,
              layout: [],
              widgets: [],
            }],
          },
          tables: [
            { id: 7, title: 'Leads', order: 10, primary_field_id: 100 },
            { id: 8, title: 'Companies', order: 20, primary_field_id: 101 },
          ],
        },
        {
          id: 2,
          path: 'Projects.kitable',
          tables: [{ id: 9, title: 'Projects', order: 10, primary_field_id: 102 }],
        },
        { id: 3, path: 'notes.md', tables: [] },
      ],
    } as any)

    const result = await mountAndSettle()

    expect(result.status).toBe('done')
    expect(result.tablesByKitablePath).toEqual({
      'Leads.kitable': [
        { id: 7, title: 'Leads', order: 10, primaryFieldId: 100 },
        { id: 8, title: 'Companies', order: 20, primaryFieldId: 101 },
      ],
      'Projects.kitable': [
        { id: 9, title: 'Projects', order: 10, primaryFieldId: 102 },
      ],
    })
    expect(result.docIdByKitablePath).toEqual({
      'Leads.kitable': '1',
      'Projects.kitable': '2',
    })
    expect(result.dashboardsByKitablePath).toEqual({
      'Leads.kitable': [
        { id: 'sales-dashboard', title: 'Sales Dashboard', order: 0 },
      ],
      'Projects.kitable': [],
    })
  })

  it('ignores non-.kitable documents', async () => {
    vi.mocked(listDataDocuments).mockResolvedValueOnce({
      items: [{ id: 1, path: 'plain.md', tables: [{ id: 1, title: 'X', order: 0 }] }],
    } as any)
    const result = await mountAndSettle()
    expect(result.tablesByKitablePath).toEqual({})
  })

  it('reports error state with message when the fetch throws', async () => {
    vi.mocked(listDataDocuments).mockRejectedValueOnce(new Error('docs down'))
    const result = await mountAndSettle()
    expect(result.status).toBe('error')
    expect(result.error).toBe('docs down')
    expect(result.tablesByKitablePath).toEqual({})
  })

  it('refresh() re-fetches and updates the map', async () => {
    vi.mocked(listDataDocuments)
      .mockResolvedValueOnce({
        items: [{ id: 1, path: 'A.kitable', tables: [{ id: 1, title: 'A1', order: 0, primary_field_id: null }] }],
      } as any)
      .mockResolvedValueOnce({
        items: [
          { id: 1, path: 'A.kitable', tables: [{ id: 1, title: 'A1', order: 0, primary_field_id: null }] },
          { id: 2, path: 'B.kitable', tables: [{ id: 2, title: 'B1', order: 0, primary_field_id: null }] },
        ],
      } as any)

    let captured: ReturnType<typeof useKitableChildrenIndex> | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(HookSurface, { onResult: (r) => { captured = r } }))
      await Promise.resolve()
    })
    for (let i = 0; i < 16; i++) {
      await act(async () => { await Promise.resolve() })
      if (captured?.status === 'done') break
    }
    expect(Object.keys(captured!.tablesByKitablePath)).toEqual(['A.kitable'])

    await act(async () => { await captured!.refresh() })
    for (let i = 0; i < 16; i++) {
      await act(async () => { await Promise.resolve() })
      if (Object.keys(captured!.tablesByKitablePath).length === 2) break
    }
    expect(Object.keys(captured!.tablesByKitablePath).sort()).toEqual(['A.kitable', 'B.kitable'])
  })

  it('groups record and scheduled add-record workflows under their kitable', async () => {
    vi.mocked(listDataDocuments).mockResolvedValueOnce({
      items: [{ id: 1, path: 'Leads.kitable', tables: [{ id: 1, title: 'Leads', order: 0, primary_field_id: null }] }],
    } as any)
    vi.mocked(listWorkflows).mockResolvedValueOnce([
      { id: 'a1', name: 'Lead alert', enabled: true, trigger: { documentId: '1' } },
      { id: 'a2', name: 'Welcome email', enabled: false, trigger: { documentId: '1' } },
      {
        id: 'a4',
        name: 'Daily planner',
        enabled: true,
        trigger: { type: 'scheduled_time', documentId: '' },
        action: { addRecord: { targetDocumentId: '1', targetTableId: '1' } },
      },
      { id: 'a3', name: 'Orphan', enabled: true, trigger: { documentId: '999' } },
    ] as any)

    const result = await mountAndSettle()

    expect(result.workflowsByKitablePath).toEqual({
      'Leads.kitable': [
        { id: 'a1', name: 'Lead alert', enabled: true },
        { id: 'a2', name: 'Welcome email', enabled: false },
        { id: 'a4', name: 'Daily planner', enabled: true },
      ],
    })
  })

  it('still resolves tables when listWorkflows rejects', async () => {
    vi.mocked(listDataDocuments).mockResolvedValueOnce({
      items: [{ id: 1, path: 'A.kitable', tables: [{ id: 1, title: 'A1', order: 0, primary_field_id: null }] }],
    } as any)
    vi.mocked(listWorkflows).mockRejectedValueOnce(new Error('workflows api down'))

    const result = await mountAndSettle()

    expect(result.status).toBe('done')
    expect(Object.keys(result.tablesByKitablePath)).toEqual(['A.kitable'])
    expect(result.workflowsByKitablePath).toEqual({})
  })
})
