import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DataField, DataRecord } from '@/types/dataDocument'

import { GridView } from './TableEditorGridView'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const uploadDataAttachment = vi.hoisted(() => vi.fn())

vi.mock('@/api/dataDocuments', () => ({
  uploadDataAttachment,
}))

vi.mock('@/features/table/grid', async () => {
  const React = await import('react')
  const Grid = React.forwardRef(function GridMock(props: any, _ref) {
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

vi.mock('@/features/table/grid/configs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/table/grid/configs')>(),
  getGridTheme: () => ({}),
}))

vi.mock('@/features/table/hooks/useTableColumnWidths', () => ({
  useTableColumnWidths: () => ({ columnWidths: {}, resizeColumn: vi.fn() }),
}))

vi.mock('@/lib/useIsDark', () => ({
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
      root?.render(createElement(GridView, {
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
      }))
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
