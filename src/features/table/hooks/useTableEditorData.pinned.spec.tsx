import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/dataDocuments', () => ({
  getDataDocument: vi.fn(),
  listDataDocuments: vi.fn(),
  listDataRecords: vi.fn(),
  openDataDocumentByPath: vi.fn(),
}))

import { openDataDocumentByPath } from '@/api/dataDocuments'

import { useTableEditorData } from './useTableEditorData'

function HookSurface({
  documentPath,
  pinnedTableId,
  onResult,
}: {
  documentPath: string
  pinnedTableId?: number
  onResult: (r: ReturnType<typeof useTableEditorData>) => void
}) {
  const result = useTableEditorData({
    documentPath,
    markerContent: '',
    pinnedTableId,
  })
  useEffect(() => onResult(result), [result, onResult])
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  container.remove()
  vi.restoreAllMocks()
})

async function mountAndSettle(documentPath: string, pinnedTableId?: number) {
  let captured: ReturnType<typeof useTableEditorData> | null = null
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(HookSurface, {
      documentPath,
      pinnedTableId,
      onResult: (r) => { captured = r },
    }))
    await Promise.resolve()
  })
  for (let i = 0; i < 16; i++) {
    await act(async () => { await Promise.resolve() })
    if (!captured?.loading) break
  }
  return captured!
}

describe('useTableEditorData pinnedTableId', () => {
  it('resolves activeTableId to pinnedTableId when present (no tables[0] fallback)', async () => {
    vi.mocked(openDataDocumentByPath).mockResolvedValueOnce({
      id: 1,
      path: 'Leads.kitable',
      tables: [
        { id: 7, title: 'Leads', views: [{ id: 1 }] },
        { id: 8, title: 'Companies', views: [{ id: 2 }] },
      ],
    } as any)
    const result = await mountAndSettle('Leads.kitable', 8)
    expect(result.activeTableId).toBe(8)
  })

  it('returns activeTableId=null when pinnedTableId is no longer present', async () => {
    vi.mocked(openDataDocumentByPath).mockResolvedValueOnce({
      id: 1,
      path: 'Leads.kitable',
      tables: [{ id: 7, title: 'Leads', views: [{ id: 1 }] }],
    } as any)
    const result = await mountAndSettle('Leads.kitable', 999)
    expect(result.activeTableId).toBeNull()
  })

  it('falls back to tables[0] when pinnedTableId is undefined (legacy path)', async () => {
    vi.mocked(openDataDocumentByPath).mockResolvedValueOnce({
      id: 1,
      path: 'Leads.kitable',
      tables: [
        { id: 7, title: 'Leads', views: [{ id: 1 }] },
        { id: 8, title: 'Companies', views: [{ id: 2 }] },
      ],
    } as any)
    const result = await mountAndSettle('Leads.kitable', undefined)
    expect(result.activeTableId).toBe(7)
  })
})
