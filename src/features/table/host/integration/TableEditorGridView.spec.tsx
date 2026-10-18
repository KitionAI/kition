import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KitionTableProviders } from '@/features/table/host/KitionTableProviders'

import type { DataField, DataRecord } from '@kition/table-editor/types/dataDocument'

import { GridView } from '@kition/table-editor/table/components/TableEditorGridView'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const uploadDataAttachment = vi.hoisted(() => vi.fn())

vi.mock('@/api/dataDocuments', () => ({
  uploadDataAttachment,
}))

const fillSelectionTrigger = vi.hoisted(() => ({ current: null as null | ((ranges: unknown, targetRow: number) => void) }))

vi.mock('@kition/table-editor/table/grid', async () => {
  const React = await import('react')
  const Grid = React.forwardRef(function GridMock(props: any, _ref) {
    fillSelectionTrigger.current = props.onFillSelection ?? null
    return React.createElement('button', {
      type: 'button',
      'data-testid': 'mock-grid-add-attachment',
      onClick: () => props.getCellContent([0, 0]).onAdd?.(),
    })
  })
  return {
    DraggableType: { All: 'all', Column: 'column' },
    Grid,
    RowControlType: { Drag: 'drag', Checkbox: 'checkbox', Expand: 'expand' },
  }
})

vi.mock('@kition/table-editor/table/grid/configs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kition/table-editor/table/grid/configs')>(),
  getGridTheme: () => ({}),
}))

vi.mock('@kition/table-editor/table/hooks/useTableColumnWidths', () => ({
  useTableColumnWidths: () => ({ columnWidths: {}, resizeColumn: vi.fn() }),
}))

vi.mock('@kition/table-editor/lib/useIsDark', () => ({
  useIsDark: () => false,
}))

vi.mock('@/lib/notify', () => ({
  notify: { error: vi.fn() },
}))

let container: HTMLDivElement
let root: Root | null = null

async function unmount() {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
}

function attachmentField(): DataField {
  return {
    id: 101,
    user_id: 1,
    document_id: 1,
    table_id: 11,
    name: 'image',
    title: 'Image',
    type: 'attachment',
    required: false,
    unique: false,
    readonly: false,
    is_primary: false,
    order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function record(): DataRecord {
  return {
    id: 201,
    user_id: 1,
    document_id: 1,
    table_id: 11,
    row_key: 'row_201',
    order: 0,
    values: {
      image: [{ name: 'existing.png', url: '/uploads/existing.png' }],
    },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

describe('GridView attachment picker', () => {
  beforeEach(async () => {
    await unmount()
    uploadDataAttachment.mockReset()
  })

  it('opens the hidden file input, uploads local files, and appends them to the cell', async () => {
    const field = attachmentField()
    const row = record()
    const onUpdateCell = vi.fn()
    uploadDataAttachment.mockResolvedValue({
      name: 'selected.png',
      url: '/uploads/selected.png',
      mimeType: 'image/png',
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(createElement(KitionTableProviders, null, createElement(GridView, {
        documentId: 1,
        tableId: 11,
        fields: [field],
        visibleFields: [field],
        groupedRecords: [],
        groupFieldName: '',
        groupFieldNames: [],
        groupPoints: null,
        groupCollection: null,
        collapsedGroupIds: new Set<string>(),
        onCollapsedGroupChanged: vi.fn(),
        selectedRecordIds: new Set<number>(),
        selectedGridCell: null,
        sortedAndFilteredRecords: [row],
        renderedGridRecords: [row],
        canReorderRows: false,
        canUseVirtualGrid: false,
        gridVirtualCanvasHeight: 0,
        gridVirtualBlockTop: 0,
        gridTableStyle: {},
        recordOffset: 0,
        recordTotal: 1,
        pageSize: 100,
        overscanRows: 20,
        allVisibleSelected: false,
        resetScrollKey: 'test',
        onLoadWindow: vi.fn(),
        onToggleAllSelected: vi.fn(),
        onToggleRecordSelected: vi.fn(),
        onSelectCell: vi.fn(),
        onOpenRecord: vi.fn(),
        onOpenRecordContextMenu: vi.fn(),
        onReorderField: vi.fn(),
        onReorderRecords: vi.fn(),
        onUpdateCell,
        onClearCells: vi.fn(),
        onPreviewAttachments: vi.fn(),
        onPaste: vi.fn(),
        onAddRecord: vi.fn(),
        onOpenFieldCreator: vi.fn(),
        onUndo: vi.fn(),
        onRedo: vi.fn(),
      })))
    })

    const input = container.querySelector(
      '[data-testid="table-grid-attachment-input"]',
    ) as HTMLInputElement
    const addButton = container.querySelector(
      '[data-testid="mock-grid-add-attachment"]',
    ) as HTMLButtonElement
    const clickInput = vi.spyOn(input, 'click')
    await act(async () => {
      addButton.click()
    })
    expect(clickInput).toHaveBeenCalledTimes(1)

    const selected = new File(['image'], 'selected.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { configurable: true, value: [selected] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(uploadDataAttachment).toHaveBeenCalledWith(1, 11, selected)
    expect(onUpdateCell).toHaveBeenCalledWith(row, field, [
      { name: 'existing.png', url: '/uploads/existing.png' },
      { name: 'selected.png', url: '/uploads/selected.png', mimeType: 'image/png' },
    ])
  })
})

function textField(id: number, name: string): DataField {
  return {
    id,
    user_id: 1,
    document_id: 1,
    table_id: 11,
    name,
    title: name,
    type: 'text',
    required: false,
    unique: false,
    readonly: false,
    is_primary: id === 1,
    order: id,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function textRecord(id: number, rowKey: string, values: Record<string, unknown>): DataRecord {
  return {
    id,
    user_id: 1,
    document_id: 1,
    table_id: 11,
    row_key: rowKey,
    order: id,
    values,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as unknown as DataRecord
}

describe('GridView fill handle', () => {
  beforeEach(async () => {
    await unmount()
    fillSelectionTrigger.current = null
  })

  it('wires onFillSelection to onFillCells, cycling the selected rows and skipping readonly fields', async () => {
    const titleField = textField(1, 'title')
    const readonlyField = { ...textField(2, 'locked'), readonly: true }
    const rowA = textRecord(201, 'row-a', { title: 'A', locked: 'x' })
    const rowB = textRecord(202, 'row-b', { title: 'B', locked: 'y' })
    const rowC = textRecord(203, 'row-c', { title: '', locked: '' })
    const onFillCells = vi.fn()

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(createElement(KitionTableProviders, null, createElement(GridView, {
        documentId: 1,
        tableId: 11,
        fields: [titleField, readonlyField],
        visibleFields: [titleField, readonlyField],
        groupedRecords: [],
        groupFieldName: '',
        groupFieldNames: [],
        groupPoints: null,
        groupCollection: null,
        collapsedGroupIds: new Set<string>(),
        onCollapsedGroupChanged: vi.fn(),
        selectedRecordIds: new Set<number>(),
        selectedGridCell: null,
        sortedAndFilteredRecords: [rowA, rowB, rowC],
        renderedGridRecords: [rowA, rowB, rowC],
        canReorderRows: false,
        canUseVirtualGrid: false,
        gridVirtualCanvasHeight: 0,
        gridVirtualBlockTop: 0,
        gridTableStyle: {},
        recordOffset: 0,
        recordTotal: 3,
        pageSize: 100,
        overscanRows: 20,
        allVisibleSelected: false,
        resetScrollKey: 'test',
        onLoadWindow: vi.fn(),
        onToggleAllSelected: vi.fn(),
        onToggleRecordSelected: vi.fn(),
        onSelectCell: vi.fn(),
        onOpenRecord: vi.fn(),
        onOpenRecordContextMenu: vi.fn(),
        onReorderField: vi.fn(),
        onReorderRecords: vi.fn(),
        onUpdateCell: vi.fn(),
        onClearCells: vi.fn(),
        onFillCells,
        onPreviewAttachments: vi.fn(),
        onPaste: vi.fn(),
        onAddRecord: vi.fn(),
        onOpenFieldCreator: vi.fn(),
        onUndo: vi.fn(),
        onRedo: vi.fn(),
      })))
    })

    // Selection covers row A (both columns); fill extends down to row C
    // (real row index 2).
    await act(async () => {
      fillSelectionTrigger.current?.([[0, 0], [1, 0]], 2)
    })

    expect(onFillCells).toHaveBeenCalledTimes(1)
    expect(onFillCells).toHaveBeenCalledWith([
      { record: rowB, field: titleField, value: 'A' },
      { record: rowC, field: titleField, value: 'A' },
    ])
  })
})
