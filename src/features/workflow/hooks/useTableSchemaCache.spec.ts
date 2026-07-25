import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/workflow/lib/workflowTableSchema', () => ({
  fetchWorkflowTableSchema: vi.fn(),
}))

import { fetchWorkflowTableSchema } from '@/features/workflow/lib/workflowTableSchema'

import { useTableSchemaCache } from './useTableSchemaCache'

function HookSurface({ onResult }: { onResult: (r: ReturnType<typeof useTableSchemaCache>) => void }) {
  const result = useTableSchemaCache()
  useEffect(() => onResult(result), [result, onResult])
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(fetchWorkflowTableSchema).mockReset()
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

async function settle(captured: { value: ReturnType<typeof useTableSchemaCache> | null }, until: () => boolean) {
  for (let i = 0; i < 16; i++) {
    await act(async () => { await Promise.resolve() })
    if (until()) return
  }
}

describe('useTableSchemaCache', () => {
  it('starts with an empty schemas map', async () => {
    let captured: ReturnType<typeof useTableSchemaCache> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r } }))
    expect(captured!.schemas).toEqual({})
  })

  it('ensure() fetches a missing schema and stores it under tableId', async () => {
    const schema = { id: 'tbl_a', name: 'A', fields: [{ id: 'f1', name: 'Name', type: 'text' }] }
    vi.mocked(fetchWorkflowTableSchema).mockResolvedValueOnce(schema as any)
    const captured = { value: null as ReturnType<typeof useTableSchemaCache> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    let resolved: any
    await act(async () => { resolved = await captured.value!.ensure('doc_1', 'tbl_a', 'A') })
    expect(resolved).toEqual(schema)
    await settle(captured, () => captured.value?.schemas['tbl_a'] !== undefined)
    expect(captured.value!.schemas['tbl_a']).toEqual(schema)
    expect(vi.mocked(fetchWorkflowTableSchema)).toHaveBeenCalledWith('doc_1', 'tbl_a', 'A')
  })

  it('ensure() short-circuits on a cache hit without re-fetching', async () => {
    const schema = { id: 'tbl_a', name: 'A', fields: [] }
    vi.mocked(fetchWorkflowTableSchema).mockResolvedValueOnce(schema as any)
    const captured = { value: null as ReturnType<typeof useTableSchemaCache> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await act(async () => { await captured.value!.ensure('doc_1', 'tbl_a') })
    // Second call — must reuse the cached value, not call the fetcher again.
    await act(async () => { await captured.value!.ensure('doc_1', 'tbl_a') })
    expect(vi.mocked(fetchWorkflowTableSchema)).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent ensure() calls on the same uncached tableId', async () => {
    const schema = { id: 'tbl_a', name: 'A', fields: [] }
    let resolveFetch!: (s: any) => void
    vi.mocked(fetchWorkflowTableSchema).mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve }) as any)
    const captured = { value: null as ReturnType<typeof useTableSchemaCache> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    // Two parallel ensures — both should share the same in-flight promise
    // so the fetcher is only invoked once.
    let p1!: Promise<any>; let p2!: Promise<any>
    await act(async () => {
      p1 = captured.value!.ensure('doc_1', 'tbl_a')
      p2 = captured.value!.ensure('doc_1', 'tbl_a')
    })
    expect(vi.mocked(fetchWorkflowTableSchema)).toHaveBeenCalledTimes(1)
    await act(async () => { resolveFetch(schema); await p1; await p2 })
    expect(await p1).toEqual(schema)
    expect(await p2).toEqual(schema)
  })

  it('ensure() resolves to null on fetch failure and does not cache the failure', async () => {
    vi.mocked(fetchWorkflowTableSchema).mockRejectedValueOnce(new Error('network down'))
    const captured = { value: null as ReturnType<typeof useTableSchemaCache> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    let resolved: any
    await act(async () => { resolved = await captured.value!.ensure('doc_1', 'tbl_a') })
    expect(resolved).toBeNull()
    expect(captured.value!.schemas['tbl_a']).toBeUndefined()
    // The failed fetch shouldn't be cached — a later ensure() should
    // be allowed to re-try the fetcher (recovery from transient errors).
    vi.mocked(fetchWorkflowTableSchema).mockResolvedValueOnce({ id: 'tbl_a', name: 'A', fields: [] } as any)
    await act(async () => { await captured.value!.ensure('doc_1', 'tbl_a') })
    expect(vi.mocked(fetchWorkflowTableSchema)).toHaveBeenCalledTimes(2)
  })

  it('defaults tableName to "Table" when the caller omits it', async () => {
    vi.mocked(fetchWorkflowTableSchema).mockResolvedValueOnce({ id: 'tbl_a', name: 'A', fields: [] } as any)
    const captured = { value: null as ReturnType<typeof useTableSchemaCache> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await act(async () => { await captured.value!.ensure('doc_1', 'tbl_a') })
    expect(vi.mocked(fetchWorkflowTableSchema)).toHaveBeenCalledWith('doc_1', 'tbl_a', 'Table')
  })

  it('caches schemas per tableId independently', async () => {
    vi.mocked(fetchWorkflowTableSchema)
      .mockResolvedValueOnce({ id: 'tbl_a', name: 'A', fields: [] } as any)
      .mockResolvedValueOnce({ id: 'tbl_b', name: 'B', fields: [] } as any)
    const captured = { value: null as ReturnType<typeof useTableSchemaCache> | null }
    await mount(createElement(HookSurface, { onResult: (r) => { captured.value = r } }))
    await act(async () => { await captured.value!.ensure('doc_1', 'tbl_a') })
    await act(async () => { await captured.value!.ensure('doc_1', 'tbl_b') })
    await settle(captured, () => captured.value?.schemas['tbl_b'] !== undefined)
    expect(captured.value!.schemas['tbl_a'].name).toBe('A')
    expect(captured.value!.schemas['tbl_b'].name).toBe('B')
  })
})
