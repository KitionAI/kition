import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/dataDocuments', () => ({
  listDataDocuments: vi.fn(),
}))

import { listDataDocuments } from '@/api/dataDocuments'

import { useWorkflowTableLabels } from './useWorkflowTableLabels'

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
  vi.mocked(listDataDocuments).mockReset()
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

async function settle(captured: { value: ReturnType<typeof useWorkflowTableLabels> | null }, until: () => boolean) {
  for (let i = 0; i < 16; i++) {
    await act(async () => { await Promise.resolve() })
    if (until()) return
  }
}

describe('useWorkflowTableLabels', () => {
  it('flattens data-documents into a tableId → TableLabel map and reports done', async () => {
    vi.mocked(listDataDocuments).mockResolvedValueOnce({
      items: [{
        id: 1,
        title: 'Leads workspace',
        path: 'crm.kitable',
        tables: [
          { id: 7, title: 'Leads', name: 'leads' },
          { id: 8, title: 'Companies', name: 'companies' },
        ],
      }],
    } as any)
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await settle(captured, () => captured.value?.status === 'done')
    expect(captured.value!.status).toBe('done')
    expect(captured.value!.labels['7']).toEqual({
      tableName: 'Leads',
      documentTitle: 'Leads workspace',
      documentId: '1',
      documentPath: 'crm.kitable',
    })
    expect(captured.value!.labels['8'].tableName).toBe('Companies')
  })

  it('falls back to placeholder titles when title / name fields are blank', async () => {
    vi.mocked(listDataDocuments).mockResolvedValueOnce({
      items: [{
        id: 1,
        title: '',
        path: '',
        tables: [{ id: 7, title: '', name: '' }],
      }],
    } as any)
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await settle(captured, () => captured.value?.status === 'done')
    expect(captured.value!.labels['7'].tableName).toBe('Untitled table')
    expect(captured.value!.labels['7'].documentTitle).toBe('Untitled doc')
  })

  it('prefers title over name when both are present (workspace doc display name)', async () => {
    vi.mocked(listDataDocuments).mockResolvedValueOnce({
      items: [{
        id: 1,
        title: 'Pretty title',
        path: 'workspace/raw_name.kitable',
        tables: [{ id: 7, title: 'Display name', name: 'raw_name' }],
      }],
    } as any)
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await settle(captured, () => captured.value?.status === 'done')
    expect(captured.value!.labels['7'].tableName).toBe('Display name')
    expect(captured.value!.labels['7'].documentTitle).toBe('Pretty title')
  })

  it('sets status=error when the fetch rejects, but keeps labels empty rather than throwing', async () => {
    vi.mocked(listDataDocuments).mockRejectedValueOnce(new Error('network down'))
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await settle(captured, () => captured.value?.status === 'error')
    expect(captured.value!.status).toBe('error')
    expect(captured.value!.labels).toEqual({})
  })

  it('starts in loading state before the fetch settles', async () => {
    let resolve!: (value: any) => void
    vi.mocked(listDataDocuments).mockImplementation(() => new Promise((r) => { resolve = r }) as any)
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    expect(captured.value!.status).toBe('loading')
    expect(captured.value!.labels).toEqual({})
    await act(async () => { resolve({ items: [] }) })
    await settle(captured, () => captured.value?.status === 'done')
    expect(captured.value!.status).toBe('done')
  })

  it('handles a document with no tables array without throwing', async () => {
    vi.mocked(listDataDocuments).mockResolvedValueOnce({
      items: [{ id: 1, title: 'Empty doc', path: '' }],
    } as any)
    const captured = { value: null as ReturnType<typeof useWorkflowTableLabels> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await settle(captured, () => captured.value?.status === 'done')
    expect(captured.value!.labels).toEqual({})
  })
})
