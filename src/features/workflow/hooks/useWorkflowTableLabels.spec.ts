import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/kitTables', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, listTableFiles: vi.fn() }
})

import { listTableFiles, notifyTableFilesChanged } from '@/api/kitTables'

import { tableFileTitle, useWorkflowTableLabels } from './useWorkflowTableLabels'

function HookSurface({ onResult }: { onResult: (r: ReturnType<typeof useWorkflowTableLabels>) => void }) {
  const result = useWorkflowTableLabels()
  useEffect(() => onResult(result), [result, onResult])
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(listTableFiles).mockReset()
})
afterEach(() => {
  root?.unmount()
  container.remove()
})

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function settle(until: () => boolean) {
  for (let i = 0; i < 16; i++) {
    await act(async () => { await Promise.resolve() })
    if (until()) return
  }
}

function file(path: string, tables: Array<{ id: string; name: string; title: string }>, documentId: string | null = null) {
  return { path, documentId, tables: tables.map((table) => ({ ...table, fields: [], meta: {} })), dashboards: [] }
}

describe('useWorkflowTableLabels', () => {
  it('flattens table files into a map keyed by path and table id, and reports done', async () => {
    vi.mocked(listTableFiles).mockResolvedValueOnce({
      files: [
        file('crm.ktable', [
          { id: '1', title: 'Leads', name: 'leads' },
          { id: '2', title: 'Companies', name: 'companies' },
        ], 'kdm-crm'),
        file('Sales/pipeline.ktable', [{ id: '1', title: 'Deals', name: 'deals' }]),
      ],
      unreadable: [],
    })
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await settle(() => captured.value?.status === 'done')
    expect(captured.value!.status).toBe('done')
    expect(captured.value!.labels['crm.ktable#1']).toEqual({
      tableId: '1',
      tableName: 'Leads',
      documentTitle: 'crm',
      documentId: 'kdm-crm',
      documentPath: 'crm.ktable',
    })
    expect(captured.value!.labels['crm.ktable#2'].tableName).toBe('Companies')
    // Table ids repeat across files; the key keeps both.
    expect(captured.value!.labels['Sales/pipeline.ktable#1']).toEqual({
      tableId: '1',
      tableName: 'Deals',
      documentTitle: 'pipeline',
      documentId: '',
      documentPath: 'Sales/pipeline.ktable',
    })
  })

  it('falls back to a placeholder table name when title and name are blank', async () => {
    vi.mocked(listTableFiles).mockResolvedValueOnce({
      files: [file('crm.ktable', [{ id: '7', title: '', name: '' }])],
      unreadable: [],
    })
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await settle(() => captured.value?.status === 'done')
    expect(captured.value!.labels['crm.ktable#7'].tableName).toBe('Untitled table')
  })

  it('reloads when a table file changes', async () => {
    vi.mocked(listTableFiles)
      .mockResolvedValueOnce({ files: [], unreadable: [] })
      .mockResolvedValueOnce({ files: [file('new.ktable', [{ id: '1', title: 'Table', name: 'table' }])], unreadable: [] })
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await settle(() => captured.value?.status === 'done')
    expect(captured.value!.labels).toEqual({})
    await act(async () => { notifyTableFilesChanged('new.ktable') })
    await settle(() => Boolean(captured.value?.labels['new.ktable#1']))
    expect(captured.value!.labels['new.ktable#1'].tableName).toBe('Table')
    expect(listTableFiles).toHaveBeenCalledTimes(2)
  })

  it('sets status=error when the fetch rejects, but keeps labels empty rather than throwing', async () => {
    vi.mocked(listTableFiles).mockRejectedValueOnce(new Error('network down'))
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await settle(() => captured.value?.status === 'error')
    expect(captured.value!.status).toBe('error')
    expect(captured.value!.labels).toEqual({})
  })

  it('starts in loading state before the fetch settles', async () => {
    let resolve!: (value: any) => void
    vi.mocked(listTableFiles).mockImplementation(() => new Promise((r) => { resolve = r }) as any)
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    expect(captured.value!.status).toBe('loading')
    expect(captured.value!.labels).toEqual({})
    await act(async () => { resolve({ files: [], unreadable: [] }) })
    await settle(() => captured.value?.status === 'done')
    expect(captured.value!.status).toBe('done')
  })
})

describe('tableFileTitle', () => {
  it('drops the folders and the .ktable extension', () => {
    expect(tableFileTitle('Sales/Lead Follow-up.ktable')).toBe('Lead Follow-up')
    expect(tableFileTitle('crm.KTABLE')).toBe('crm')
  })
})
