import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitionTableProviders } from '@/features/table/host/KitionTableProviders'

const apiMocks = vi.hoisted(() => ({
  createDataRecord: vi.fn(),
  transactDataDocument: vi.fn(),
  updateDataRecord: vi.fn(),
  uploadDataAttachment: vi.fn(),
}))

vi.mock('@/api/dataDocuments', () => apiMocks)

import type { DataField, DataRecord } from '@kition/table-editor/types/dataDocument'

import { useTableClipboard } from '@kition/table-editor/table/hooks/useTableClipboard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

type ClipboardArgs = Parameters<typeof useTableClipboard>[0]
type ClipboardActions = ReturnType<typeof useTableClipboard>

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mountClipboard(args: ClipboardArgs): Promise<ClipboardActions> {
  const ref: { current: ClipboardActions | null } = { current: null }
  function Harness() {
    ref.current = useTableClipboard(args)
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(createElement(KitionTableProviders, null, createElement(Harness)))
    await Promise.resolve()
  })
  return ref.current!
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

function field(id: number, name: string): DataField {
  return {
    id,
    name,
    title: name,
    type: 'text',
    is_primary: id === 1,
    readonly: false,
    options: {},
  } as unknown as DataField
}

function record(id: number, rowKey: string): DataRecord {
  return { id, row_key: rowKey, values: {}, order: id } as unknown as DataRecord
}

function makeClipboardEvent(text: string) {
  const clipboardData = {
    items: [] as DataTransferItem[],
    files: [] as unknown as FileList,
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  } as unknown as DataTransfer
  return {
    clipboardData,
    target: document.createElement('div'),
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent<HTMLDivElement>
}

describe('useTableClipboard paste', () => {
  beforeEach(() => {
    apiMocks.createDataRecord.mockReset()
    apiMocks.transactDataDocument.mockReset()
    apiMocks.updateDataRecord.mockReset()
    apiMocks.uploadDataAttachment.mockReset()
  })

  it('sends one transact call with cells.set and records.create for a 3x3 paste that overflows the table', async () => {
    const f1 = field(1, 'col_a')
    const f2 = field(2, 'col_b')
    const f3 = field(3, 'col_c')
    const r1 = record(100, 'row-1')
    const r2 = record(101, 'row-2')

    apiMocks.transactDataDocument.mockResolvedValue({ change: {} as any, created: ['row-3'] })
    const setRecords = vi.fn()
    const reloadRecords = vi.fn()

    const actions = await mountClipboard({
      documentId: 1,
      tableId: 11,
      viewMode: 'grid',
      visibleFields: [f1, f2, f3],
      sortedAndFilteredRecords: [r1, r2],
      records: [r1, r2],
      selectedGridCell: { recordId: r1.id, fieldName: f1.name },
      setBusy: vi.fn(),
      setError: vi.fn(),
      setStatus: vi.fn(),
      setRecords,
      reloadRecords,
    })

    const tsv = ['a1\tb1\tc1', 'a2\tb2\tc2', 'a3\tb3\tc3'].join('\n')
    await act(async () => {
      actions.pasteRecords(makeClipboardEvent(tsv))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(apiMocks.transactDataDocument).toHaveBeenCalledTimes(1)
    expect(apiMocks.transactDataDocument).toHaveBeenCalledWith(1, [
      {
        op: 'cells.set',
        tableId: 11,
        records: [
          { rowKey: 'row-1', values: { col_a: 'a1', col_b: 'b1', col_c: 'c1' } },
          { rowKey: 'row-2', values: { col_a: 'a2', col_b: 'b2', col_c: 'c2' } },
        ],
      },
      {
        op: 'records.create',
        tableId: 11,
        at: null,
        records: [{ col_a: 'a3', col_b: 'b3', col_c: 'c3' }],
      },
    ])
    expect(reloadRecords).toHaveBeenCalled()
  })
})
