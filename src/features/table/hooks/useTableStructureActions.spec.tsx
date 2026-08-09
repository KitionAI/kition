import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DataDocument, DataTable, DataView } from '@/types/dataDocument'

const apiMocks = vi.hoisted(() => ({
  createDataView: vi.fn(),
  deleteDataView: vi.fn(),
  listViewFields: vi.fn(),
  patchViewField: vi.fn(),
}))
const confirmMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/dataDocuments', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/dataDocuments')>(),
  ...apiMocks,
}))

vi.mock('@/components/confirm', () => ({
  useConfirm: () => confirmMock,
}))

import { useTableStructureActions } from './useTableStructureActions'

let container: HTMLDivElement
let root: Root | null = null
let actions: ReturnType<typeof useTableStructureActions>

const views = [
  {
    id: 31,
    title: 'Grid view',
    type: 'grid',
    order: 1,
    locked: false,
    config: { frozen_column_count: 1 },
  },
  {
    id: 32,
    title: 'Gallery view',
    type: 'gallery',
    order: 2,
    locked: false,
    config: null,
  },
] as DataView[]

const table = {
  id: 21,
  title: 'Receipts',
  views,
  fields: [],
} as DataTable

const baseDocument = {
  id: 11,
  title: 'Receipts',
  path: 'Receipts.kitable',
  tables: [table],
} as DataDocument

function Harness({ overrides = {} }: { overrides?: Record<string, unknown> }) {
  actions = useTableStructureActions({
    documentPath: 'Receipts.kitable',
    document: baseDocument,
    activeTable: table,
    tableViews: views,
    fields: [],
    records: [],
    newFieldTitle: '',
    newFieldType: 'text',
    importInputRef: createRef<HTMLInputElement>(),
    setBusy: vi.fn(),
    setError: vi.fn(),
    setDocument: vi.fn(),
    setRecords: vi.fn(),
    setEditingField: vi.fn(),
    setNewFieldTitle: vi.fn(),
    setViewCreateOpen: vi.fn(),
    setActiveViewId: vi.fn(),
    refreshDocument: vi.fn(),
    loadRecords: vi.fn(),
    setStatus: vi.fn(),
    copyTextToClipboard: vi.fn(),
    ...overrides,
  } as never)
  return null
}

async function mount(overrides: Record<string, unknown> = {}) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness, { overrides }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  apiMocks.createDataView.mockReset()
  apiMocks.deleteDataView.mockReset()
  apiMocks.listViewFields.mockReset()
  apiMocks.patchViewField.mockReset()
  confirmMock.mockReset()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('useTableStructureActions view actions', () => {
  it('duplicates the view config and field layout, then activates the copy', async () => {
    const createdView = {
      ...views[0],
      id: 33,
      title: 'Grid view copy',
      order: 3,
    } as DataView
    const setActiveViewId = vi.fn()
    apiMocks.listViewFields.mockResolvedValue({
      items: [{ view_id: 31, field_id: 41, visible: true, width: 280, position: 0, frozen: true }],
    })
    apiMocks.createDataView.mockResolvedValue(createdView)
    apiMocks.patchViewField.mockResolvedValue({})
    await mount({ setActiveViewId })

    await act(async () => {
      await actions.duplicateView(31)
    })

    expect(apiMocks.createDataView).toHaveBeenCalledWith(11, 21, {
      title: 'Grid view copy',
      type: 'grid',
      config: { frozen_column_count: 1 },
    })
    expect(apiMocks.patchViewField).toHaveBeenCalledWith(11, 21, 33, 41, {
      visible: true,
      width: 280,
      position: 0,
      frozen: true,
    })
    expect(setActiveViewId).toHaveBeenCalledWith(33)
  })

  it('deletes the active view and activates the nearest remaining view', async () => {
    const setActiveViewId = vi.fn()
    confirmMock.mockResolvedValue(true)
    apiMocks.deleteDataView.mockResolvedValue(undefined)
    await mount({ setActiveViewId })

    await act(async () => {
      await actions.deleteView(31)
    })

    expect(confirmMock).toHaveBeenCalled()
    expect(apiMocks.deleteDataView).toHaveBeenCalledWith(11, 21, 31)
    expect(setActiveViewId).toHaveBeenCalledWith(32)
  })
})
