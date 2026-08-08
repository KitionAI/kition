import { forwardRef, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  MouseEvent as ReactMouseEvent,
} from 'react'
import type { DataAttachment, DataField, DataRecord, DataRecordValue } from '@/types/dataDocument'
import {
  normalizeAttachmentValue,
  type DataRecordWindow,
  type GridCellSelection,
  type RowDropPosition,
} from '@/features/table/lib/tableEditorShared'
import { cn } from '@/lib/utils'

import { Grid } from '@/features/table/grid'
import { getGridTheme } from '@/features/table/grid/configs'
import { useIsDark } from '@/lib/useIsDark'
import {
  DraggableType,
  RowControlType,
  type CombinedSelection,
  type IAIOverlayCell,
  type IGridRef,
  type IGroupCollection,
  type IGroupPoint,
  type IPosition,
  type IRange,
  type IRowControlItem,
} from '@/features/table/grid'
import { useGridAdapter } from '@/features/table/grid/useGridAdapter'
import { useTableColumnWidths } from '@/features/table/hooks/useTableColumnWidths'
import { buildCellKey } from '@/features/table/store/aiCellGenerationStore'
import { serializeTableSelection } from '@/features/table/lib/tableClipboard'
import { uploadDataAttachment } from '@/api/dataDocuments'
import { notify } from '@/lib/notify'

type GridViewProps = {
  documentId: number
  tableId: number
  viewId?: number
  fields: DataField[]
  visibleFields: DataField[]
  groupedRecords: Array<[string, DataRecord[]]>
  groupFieldName: string
  groupFieldNames: string[]
  groupPoints: IGroupPoint[] | null
  groupCollection: IGroupCollection | null
  collapsedGroupIds: ReadonlySet<string>
  onCollapsedGroupChanged: (next: Set<string>) => void
  selectedRecordIds: Set<number>
  selectedGridCell: GridCellSelection
  sortedAndFilteredRecords: DataRecord[]
  renderedGridRecords: DataRecord[]
  canReorderRows: boolean
  canUseVirtualGrid: boolean
  gridVirtualCanvasHeight: number
  gridVirtualBlockTop: number
  gridTableStyle: CSSProperties
  recordOffset: number
  recordTotal: number
  pageSize: number
  overscanRows: number
  allVisibleSelected: boolean
  resetScrollKey: string
  rowHeight?: number
  freezeColumnCount?: number
  searchQuery?: string
  onColumnFreeze?: (count: number) => void
  onLoadWindow: (window: DataRecordWindow) => void
  onToggleAllSelected: () => void
  onToggleRecordSelected: (recordId: number, checked?: boolean) => void
  onSelectCell: (selection: GridCellSelection) => void
  onOpenRecord: (record: DataRecord) => void
  onOpenDocument?: (path: string) => void
  onOpenRecordContextMenu: (
    record: DataRecord,
    event: Pick<ReactMouseEvent, 'clientX' | 'clientY' | 'preventDefault' | 'stopPropagation'>
  ) => void
  onOpenColumnHeaderMenu?: (field: DataField, position: { x: number; y: number }) => void
  onReorderField: (field: DataField, fromIndex: number, dropIndex: number) => void
  onReorderRecords: (sourceRecordId: number, targetRecordId: number, position: RowDropPosition) => void
  onRegenerate?: (record: DataRecord, field: DataField) => void
  onUpdateCell: (record: DataRecord, field: DataField, value: DataRecordValue) => void
  onClearCells: (cells: Array<{ record: DataRecord; field: DataField }>) => void
  onPreviewAttachments: (items: DataAttachment[], index: number) => void
  onPaste: (event: ReactClipboardEvent<HTMLDivElement>) => void
  onAddRecord: (initialValues?: Record<string, DataRecordValue>) => void
  onOpenFieldCreator: () => void
  onUndo: () => void
  onRedo: () => void
}

export const GridView = forwardRef<IGridRef, GridViewProps>(function GridView(props, gridRef) {
  const { t } = useTranslation('table')
  const {
    tableId,
    viewId,
    visibleFields,
    selectedRecordIds,
    sortedAndFilteredRecords,
    canReorderRows,
    rowHeight,
    freezeColumnCount,
    searchQuery,
    onColumnFreeze,
    onToggleRecordSelected,
    onSelectCell,
    onOpenRecord,
    onOpenDocument,
    onOpenRecordContextMenu,
    onOpenColumnHeaderMenu,
    onReorderField,
    onReorderRecords,
    onRegenerate,
    onUpdateCell,
    onClearCells,
    onPaste,
    onAddRecord,
    onOpenFieldCreator,
    onPreviewAttachments,
    onUndo,
    onRedo,
    groupPoints,
    groupCollection,
    groupFieldNames,
    collapsedGroupIds,
    onCollapsedGroupChanged,
  } = props

  const { columnWidths, resizeColumn } = useTableColumnWidths({
    documentId: props.documentId,
    tableId,
    viewId,
  })
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentTargetRef = useRef<{ record: DataRecord; field: DataField } | null>(null)
  const attachmentUploadInProgressRef = useRef(false)

  const openAttachmentPicker = useCallback((record: DataRecord, field: DataField) => {
    if (field.readonly || attachmentUploadInProgressRef.current) return
    attachmentTargetRef.current = { record, field }
    attachmentInputRef.current?.click()
  }, [])

  const handleAttachmentFiles = useCallback(async (files: File[]) => {
    const target = attachmentTargetRef.current
    attachmentTargetRef.current = null
    if (!target || !files.length || attachmentUploadInProgressRef.current) return
    attachmentUploadInProgressRef.current = true
    try {
      const uploaded = await Promise.all(
        files.map((file) => uploadDataAttachment(props.documentId, tableId, file)),
      )
      const current = normalizeAttachmentValue(target.record.values?.[target.field.name] ?? null)
      onUpdateCell(target.record, target.field, [...current, ...uploaded])
    } catch (error) {
      notify.error(t('cell.uploadFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      attachmentUploadInProgressRef.current = false
    }
  }, [onUpdateCell, props.documentId, t, tableId])

  const adapter = useGridAdapter({
    visibleFields,
    sortedAndFilteredRecords,
    columnWidths,
    tableId,
    onCellEdited: (record, field, value) => onUpdateCell(record, field, value),
    onRowExpand: (record) => onOpenRecord(record),
    onOpenDocument,
                                                       
                                                           
    onRowAppend: (targetIndex) => {
      if (!groupFieldNames.length) return onAddRecord()
      const anchor =
        typeof targetIndex === 'number' ? sortedAndFilteredRecords[targetIndex] : null
      if (!anchor) return onAddRecord()
      const initialValues: Record<string, DataRecordValue> = {}
      for (const name of groupFieldNames) {
        initialValues[name] = (anchor.values?.[name] ?? null) as DataRecordValue
      }
      onAddRecord(initialValues)
    },
    onColumnAppend: () => onOpenFieldCreator(),
    onColumnResize: resizeColumn,
    onColumnOrdered: onReorderField,
    onRowOrdered: (sourceRecords, targetRecord) => {
      if (!canReorderRows || !targetRecord || !sourceRecords.length) return
      onReorderRecords(sourceRecords[0].id, targetRecord.id, 'before')
    },
    onPreviewAttachment: (record, field, index) => {
      const attachments = normalizeAttachmentValue(record.values?.[field.name] ?? null)
      if (attachments.length) onPreviewAttachments(attachments, index)
    },
    onAddAttachment: openAttachmentPicker,
    onCellAIAction: onRegenerate ? (record, field) => onRegenerate(record, field) : undefined,
  })

  const aiOverlayCells = useMemo<IAIOverlayCell[]>(() => {
    const cells: IAIOverlayCell[] = []
    for (let columnIndex = 0; columnIndex < visibleFields.length; columnIndex++) {
      const field = visibleFields[columnIndex]
      if (!field.ai_config?.enabled) continue
      for (let rowIndex = 0; rowIndex < sortedAndFilteredRecords.length; rowIndex++) {
        const record = sortedAndFilteredRecords[rowIndex]
        cells.push({
          cellItem: [columnIndex, rowIndex],
          cellKey: buildCellKey(tableId, record.id, field.id),
        })
      }
    }
    return cells
  }, [visibleFields, sortedAndFilteredRecords, tableId])

  const handleSelectionChanged = useCallback(
    (selection: CombinedSelection) => {
      if (selection.isCellSelection) {
        const range = selection.ranges[0] as IRange | undefined
        if (!range) return
        const [columnIndex, rowIndex] = range
        const record = sortedAndFilteredRecords[rowIndex]
        const field = visibleFields[columnIndex]
        if (record && field) onSelectCell({ recordId: record.id, fieldName: field.name })
        return
      }
      if (selection.isRowSelection) {
        const next = new Set<number>()
        for (const range of selection.ranges) {
          const [a, b] = range
          const lo = Math.min(a, b)
          const hi = Math.max(a, b)
          for (let i = lo; i <= hi; i++) {
            const record = sortedAndFilteredRecords[i]
            if (record) next.add(record.id)
          }
        }
        for (const id of next) {
          if (!selectedRecordIds.has(id)) onToggleRecordSelected(id, true)
        }
        for (const id of selectedRecordIds) {
          if (!next.has(id)) onToggleRecordSelected(id, false)
        }
        return
      }
      if (selection.isNoneSelection && selectedRecordIds.size > 0) {
        for (const id of selectedRecordIds) onToggleRecordSelected(id, false)
      }
    },
    [
      sortedAndFilteredRecords,
      visibleFields,
      selectedRecordIds,
      onSelectCell,
      onToggleRecordSelected,
    ]
  )

  const handleContextMenu = useCallback(
    (selection: CombinedSelection, position: IPosition) => {
      const range = selection.ranges[0] as IRange | undefined
      if (!range) return
      const rowIndex = selection.isCellSelection ? range[1] : range[0]
      const record = sortedAndFilteredRecords[rowIndex]
      if (!record) return
      if (selection.isCellSelection) {
        const field = visibleFields[range[0]]
        if (field) onSelectCell({ recordId: record.id, fieldName: field.name })
      }
      onOpenRecordContextMenu(record, {
        clientX: position.x,
        clientY: position.y,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      })
    },
    [sortedAndFilteredRecords, visibleFields, onOpenRecordContextMenu, onSelectCell]
  )

                                                                    
                                                                                      
  const handleDelete = useCallback(
    (selection: CombinedSelection) => {
      const cells: Array<{ record: DataRecord; field: DataField }> = []
      if (selection.isCellSelection) {
        const [a, b] = selection.ranges
        if (!a || !b) return
        const minCol = Math.min(a[0], b[0])
        const maxCol = Math.max(a[0], b[0])
        const minRow = Math.min(a[1], b[1])
        const maxRow = Math.max(a[1], b[1])
        for (let r = minRow; r <= maxRow; r++) {
          const record = sortedAndFilteredRecords[r]
          if (!record) continue
          for (let c = minCol; c <= maxCol; c++) {
            const field = visibleFields[c]
            if (field) cells.push({ record, field })
          }
        }
      } else if (selection.isRowSelection) {
        for (const range of selection.ranges) {
          const lo = Math.min(range[0], range[1])
          const hi = Math.max(range[0], range[1])
          for (let r = lo; r <= hi; r++) {
            const record = sortedAndFilteredRecords[r]
            if (!record) continue
            for (const field of visibleFields) cells.push({ record, field })
          }
        }
      } else if (selection.isColumnSelection) {
        for (const range of selection.ranges) {
          const lo = Math.min(range[0], range[1])
          const hi = Math.max(range[0], range[1])
          for (let c = lo; c <= hi; c++) {
            const field = visibleFields[c]
            if (!field) continue
            for (const record of sortedAndFilteredRecords) cells.push({ record, field })
          }
        }
      }
      if (cells.length) onClearCells(cells)
    },
    [sortedAndFilteredRecords, visibleFields, onClearCells],
  )

  const handleCopy = useCallback(
    (selection: CombinedSelection, event: ReactClipboardEvent) => {
      const text = serializeTableSelection(selection, visibleFields, sortedAndFilteredRecords)
      if (!text) return
      event.clipboardData.setData('text/plain', text)
      event.clipboardData.setData('text/tab-separated-values', text)
      event.preventDefault()
    },
    [sortedAndFilteredRecords, visibleFields],
  )

  const getClipboardText = useCallback(
    (selection: CombinedSelection) =>
      serializeTableSelection(selection, visibleFields, sortedAndFilteredRecords),
    [sortedAndFilteredRecords, visibleFields],
  )

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const handleColumnHeaderMenuClick = useCallback(
    (colIndex: number, bounds: { x: number; y: number; width: number; height: number }) => {
      const field = visibleFields[colIndex]
      if (!field || !onOpenColumnHeaderMenu) return
      const canvasRect = canvasRef.current?.getBoundingClientRect()
      const offsetX = canvasRect?.left ?? 0
      const offsetY = canvasRect?.top ?? 0
      onOpenColumnHeaderMenu(field, {
        x: offsetX + bounds.x + bounds.width,
        y: offsetY + bounds.y + bounds.height,
      })
    },
    [visibleFields, onOpenColumnHeaderMenu]
  )

  const draggable = useMemo<DraggableType>(
    () => (canReorderRows ? DraggableType.All : DraggableType.Column),
    [canReorderRows]
  )

                                                                                 
                                                                          
                                                  
                                                         
  const rowControls = useMemo<IRowControlItem[]>(() => {
    const controls: IRowControlItem[] = []
    if (canReorderRows) controls.push({ type: RowControlType.Drag })
    controls.push({ type: RowControlType.Checkbox })
    controls.push({ type: RowControlType.Expand })
    return controls
  }, [canReorderRows])

  const searchHits = useMemo(() => {
    const needle = (searchQuery ?? '').trim().toLowerCase()
    if (!needle) return [] as { fieldId: string; recordId: string }[]
    const hits: { fieldId: string; recordId: string }[] = []
    for (const record of sortedAndFilteredRecords) {
      for (const field of visibleFields) {
        const raw = record.values?.[field.name]
        if (raw == null) continue
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
        if (text.toLowerCase().includes(needle)) {
          hits.push({ fieldId: String(field.id), recordId: String(record.id) })
        }
      }
    }
    return hits
  }, [searchQuery, sortedAndFilteredRecords, visibleFields])

  // Pick the canvas theme based on the current `<html>.dark` state. Memoised
  // so the prop identity stays stable across renders and only flips when the
  // theme actually toggles — Grid uses the prop's identity to invalidate its
  // internal paint cache.
  const isDark = useIsDark()
  const gridTheme = useMemo(() => getGridTheme(isDark), [isDark])

  return (
    <div ref={canvasRef} className={cn('data-inline-grid-canvas relative flex-1 min-h-0')} onPaste={onPaste}>
      <Grid
        ref={gridRef}
        {...adapter}
        theme={gridTheme}
        draggable={draggable}
        rowControls={rowControls}
        rowHeight={rowHeight}
        freezeColumnCount={freezeColumnCount}
        searchHitIndex={searchHits}
        aiOverlayCells={aiOverlayCells}
        groupPoints={groupPoints ?? undefined}
        groupCollection={groupCollection ?? undefined}
        collapsedGroupIds={collapsedGroupIds.size > 0 ? (collapsedGroupIds as Set<string>) : undefined}
        onCollapsedGroupChanged={onCollapsedGroupChanged}
        onColumnFreeze={onColumnFreeze}
        onSelectionChanged={handleSelectionChanged}
        onContextMenu={handleContextMenu}
        getClipboardText={getClipboardText}
        onCopy={handleCopy}
        onDelete={handleDelete}
        onUndo={onUndo}
        onRedo={onRedo}
        onColumnHeaderMenuClick={onOpenColumnHeaderMenu ? handleColumnHeaderMenuClick : undefined}
      />
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        hidden
        data-testid="table-grid-attachment-input"
        onChange={(event) => {
          const files = Array.from(event.target.files || [])
          event.target.value = ''
          void handleAttachmentFiles(files)
        }}
      />
    </div>
  )
})
