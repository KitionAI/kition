import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/dataDocuments', () => ({
  listViewFields: vi.fn(),
  patchViewField: vi.fn(),
}))

import { listViewFields, patchViewField } from '@/api/dataDocuments'
import type { DataField } from '@/types/dataDocument'

import { useTableColumnWidths } from './useTableColumnWidths'

type HookResult = ReturnType<typeof useTableColumnWidths>

let container: HTMLDivElement
let root: Root | null = null
let latest: HookResult | null = null

function HookSurface() {
  const result = useTableColumnWidths({ documentId: 1, tableId: 11, viewId: 201 })
  useEffect(() => {
    latest = result
  }, [result])
  return null
}

async function mountAndSettle() {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(HookSurface))
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
  return latest!
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  latest = null
  vi.mocked(listViewFields).mockReset()
  vi.mocked(patchViewField).mockReset()
  vi.mocked(patchViewField).mockResolvedValue({} as never)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.useRealTimers()
})

describe('useTableColumnWidths', () => {
  it('loads saved widths for the active view', async () => {
    vi.mocked(listViewFields).mockResolvedValue({
      items: [
        { view_id: 201, field_id: 101, visible: true, width: 244, position: 0, frozen: true },
        { view_id: 201, field_id: 102, visible: true, width: 186, position: 1, frozen: false },
      ],
    })

    const result = await mountAndSettle()

    expect(result.columnWidths).toEqual({ '101': 244, '102': 186 })
  })

  it('updates immediately and persists only the final debounced width', async () => {
    vi.mocked(listViewFields).mockResolvedValue({ items: [] })
    await mountAndSettle()
    const field = { id: 102 } as DataField

    act(() => {
      latest!.resizeColumn(field, 240.4)
      latest!.resizeColumn(field, 287.6)
    })

    expect(latest!.columnWidths).toEqual({ '102': 288 })
    expect(patchViewField).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(patchViewField).toHaveBeenCalledTimes(1)
    expect(patchViewField).toHaveBeenCalledWith(1, 11, 201, 102, { width: 288 })
  })
})
