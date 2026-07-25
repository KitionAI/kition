import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  MouseEvent as ReactMouseEvent,
} from 'react'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import type {
  DataAttachment,
  DataField,
  DataRecord,
  DataRecordValue,
  DataViewType,
} from '@/types/dataDocument'
import {
  kanbanGroupToValue,
  type DataRecordWindow,
  type GridCellSelection,
  type RowDropPosition,
} from '@/features/table/lib/tableEditorShared'

import type { IGridRef } from '@/features/table/grid'
import { GridView } from './TableEditorGridView'
import {
  CalendarView,
  FormView,
  GalleryView,
  KanbanView,
} from './TableEditorViews'

export type TableEditorHandle = {
  focusRecord: (recordId: string, fieldId?: string) => void
  focusFieldHeader: (fieldId: string) => void
}

type TableEditorContentProps = {
  documentId: number
  tableId: number
  viewMode: DataViewType
  fields: DataField[]
  visibleFields: DataField[]
  groupField: DataField | null
  groupedRecords: Array<[string, DataRecord[]]>
  groupPoints: import('@/features/table/grid/interface').IGroupPoint[] | null
  groupCollection: import('@/features/table/grid/interface').IGroupCollection | null
  collapsedGroupIds: ReadonlySet<string>
  onCollapsedGroupChanged: (next: Set<string>) => void
  primaryField: DataField | null
  dateField: DataField | null
  coverField: DataField | null
  sortedAndFilteredRecords: DataRecord[]
  renderedGridRecords: DataRecord[]
  groupFieldName: string
  groupFieldNames: string[]
  selectedRecordIds: Set<number>
  selectedGridCell: GridCellSelection
  canMoveKanbanCards: boolean
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
  draggingRecordId: number | null
  dragOverRecordId: number | null
  dragOverGroup: string
  onDragStart: (recordId: number) => void
  onDragEnd: () => void
  onDragOverRecord: (recordId: number | null) => void
  onDragOverGroup: (group: string) => void
  onMoveKanbanRecord: (
    recordId: number,
    group: string,
    targetRecordId?: number,
  ) => void
  onAddRecord: (
    initialValues?: Record<string, DataRecordValue>,
  ) => void | Promise<void>
  onOpenRecord: (record: DataRecord) => void
  onOpenDocument?: (path: string) => void
  onPreviewAttachments: (items: DataAttachment[], index: number) => void
  onSubmitForm: (
    values: Record<string, DataRecordValue>,
  ) => void | Promise<void>
  onLoadWindow: (window: DataRecordWindow) => void
  onToggleAllSelected: () => void
  onToggleRecordSelected: (recordId: number, checked?: boolean) => void
  onSelectCell: (selection: GridCellSelection) => void
  onOpenRecordContextMenu: (
    record: DataRecord,
    event: Pick<
      ReactMouseEvent,
      'clientX' | 'clientY' | 'preventDefault' | 'stopPropagation'
    >,
  ) => void
  onOpenColumnHeaderMenu?: (
    field: DataField,
    position: { x: number; y: number },
  ) => void
  onReorderRecords: (
    sourceRecordId: number,
    targetRecordId: number,
    position: RowDropPosition,
  ) => void
  onUpdateCell: (
    record: DataRecord,
    field: DataField,
    value: DataRecordValue,
  ) => void
  onClearCells: (cells: Array<{ record: DataRecord; field: DataField }>) => void
  onPaste: (event: ReactClipboardEvent<HTMLDivElement>) => void
  onOpenFieldCreator: () => void
  onRegenerate?: (record: DataRecord, field: DataField) => void
  onUndo: () => void
  onRedo: () => void
}

export const TableEditorContent = forwardRef<TableEditorHandle, TableEditorContentProps>(
  function TableEditorContent(
    {
      documentId,
      tableId,
      viewMode,
      fields,
      visibleFields,
      groupField,
      groupedRecords,
      groupPoints,
      groupCollection,
      collapsedGroupIds,
      onCollapsedGroupChanged,
      primaryField,
      dateField,
      coverField,
      sortedAndFilteredRecords,
      renderedGridRecords,
      groupFieldName,
      groupFieldNames,
      selectedRecordIds,
      selectedGridCell,
      canMoveKanbanCards,
      canReorderRows,
      canUseVirtualGrid,
      gridVirtualCanvasHeight,
      gridVirtualBlockTop,
      gridTableStyle,
      recordOffset,
      recordTotal,
      pageSize,
      overscanRows,
      allVisibleSelected,
      resetScrollKey,
      rowHeight,
      freezeColumnCount,
      searchQuery,
      onColumnFreeze,
      draggingRecordId,
      dragOverRecordId,
      dragOverGroup,
      onDragStart,
      onDragEnd,
      onDragOverRecord,
      onDragOverGroup,
      onMoveKanbanRecord,
      onAddRecord,
      onOpenRecord,
      onOpenDocument,
      onPreviewAttachments,
      onSubmitForm,
      onLoadWindow,
      onToggleAllSelected,
      onToggleRecordSelected,
      onSelectCell,
      onOpenRecordContextMenu,
      onOpenColumnHeaderMenu,
      onReorderRecords,
      onUpdateCell,
      onClearCells,
      onPaste,
      onOpenFieldCreator,
      onRegenerate,
      onUndo,
      onRedo,
    },
    ref,
  ) {
    const gridRef = useRef<IGridRef | null>(null)
    const [_highlightedRow, setHighlightedRow] = useState<{
      recordId: string
      fieldId?: string
      until: number
    } | null>(null)
    const [_highlightedFieldHeader, setHighlightedFieldHeader] = useState<{
      fieldId: string
      until: number
    } | null>(null)

    useImperativeHandle(ref, () => ({
      focusRecord(recordId: string, fieldId?: string) {
        const idx = sortedAndFilteredRecords.findIndex(r => String(r.id) === recordId)
        if (idx < 0) return
        gridRef.current?.scrollToItem([0, idx])
        setHighlightedRow({ recordId, fieldId, until: Date.now() + 1500 })
      },
      focusFieldHeader(fieldId: string) {
        setHighlightedFieldHeader({ fieldId, until: Date.now() + 1500 })
      },
    }), [sortedAndFilteredRecords, gridRef, setHighlightedRow, setHighlightedFieldHeader])

    if (viewMode === 'kanban') {
      return (
        <KanbanView
          fields={visibleFields}
          groupField={groupField}
          groups={groupedRecords}
          primaryField={primaryField}
          canMoveCards={canMoveKanbanCards}
          draggingRecordId={draggingRecordId}
          dragOverRecordId={dragOverRecordId}
          dragOverGroup={dragOverGroup}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragOverRecord={onDragOverRecord}
          onDragOverGroup={onDragOverGroup}
          onMoveRecord={onMoveKanbanRecord}
          onAddRecord={(group) =>
            void onAddRecord(
              groupField
                ? { [groupField.name]: kanbanGroupToValue(groupField, group) }
                : undefined,
            )
          }
          onOpenRecord={onOpenRecord}
          onOpenDocument={onOpenDocument}
          onPreviewAttachments={onPreviewAttachments}
          tableId={tableId}
          onRegenerate={onRegenerate}
        />
      )
    }

    if (viewMode === 'calendar') {
      return (
        <CalendarView
          records={sortedAndFilteredRecords}
          fields={visibleFields}
          primaryField={primaryField}
          dateField={dateField}
          onAddRecord={() => void onAddRecord()}
          onOpenRecord={onOpenRecord}
          onOpenDocument={onOpenDocument}
          onPreviewAttachments={onPreviewAttachments}
          tableId={tableId}
          onRegenerate={onRegenerate}
        />
      )
    }

    if (viewMode === 'gallery') {
      return (
        <GalleryView
          records={sortedAndFilteredRecords}
          fields={visibleFields}
          primaryField={primaryField}
          coverField={coverField}
          onOpenRecord={onOpenRecord}
          onOpenDocument={onOpenDocument}
          onPreviewAttachments={onPreviewAttachments}
          tableId={tableId}
          onRegenerate={onRegenerate}
        />
      )
    }

    if (viewMode === 'form') {
      return (
        <FormView
          fields={fields}
          documentId={documentId}
          tableId={tableId}
          onPreviewAttachments={onPreviewAttachments}
          onOpenDocument={onOpenDocument}
          onSubmit={onSubmitForm}
        />
      )
    }

    return (
      <GridView
        ref={gridRef}
        documentId={documentId}
        tableId={tableId}
        fields={fields}
        visibleFields={visibleFields}
        groupedRecords={groupedRecords}
        groupFieldName={groupFieldName}
        groupFieldNames={groupFieldNames}
        groupPoints={groupPoints}
        groupCollection={groupCollection}
        collapsedGroupIds={collapsedGroupIds}
        onCollapsedGroupChanged={onCollapsedGroupChanged}
        selectedRecordIds={selectedRecordIds}
        selectedGridCell={selectedGridCell}
        sortedAndFilteredRecords={sortedAndFilteredRecords}
        renderedGridRecords={renderedGridRecords}
        canReorderRows={canReorderRows}
        canUseVirtualGrid={canUseVirtualGrid}
        gridVirtualCanvasHeight={gridVirtualCanvasHeight}
        gridVirtualBlockTop={gridVirtualBlockTop}
        gridTableStyle={gridTableStyle}
        recordOffset={recordOffset}
        recordTotal={recordTotal}
        pageSize={pageSize}
        overscanRows={overscanRows}
        allVisibleSelected={allVisibleSelected}
        resetScrollKey={resetScrollKey}
        rowHeight={rowHeight}
        freezeColumnCount={freezeColumnCount}
        searchQuery={searchQuery}
        onColumnFreeze={onColumnFreeze}
        onLoadWindow={onLoadWindow}
        onToggleAllSelected={onToggleAllSelected}
        onToggleRecordSelected={onToggleRecordSelected}
        onSelectCell={onSelectCell}
        onOpenRecord={onOpenRecord}
        onOpenDocument={onOpenDocument}
        onOpenRecordContextMenu={onOpenRecordContextMenu}
        onOpenColumnHeaderMenu={onOpenColumnHeaderMenu}
        onReorderRecords={onReorderRecords}
        onRegenerate={onRegenerate}
        onUpdateCell={onUpdateCell}
        onClearCells={onClearCells}
        onPreviewAttachments={onPreviewAttachments}
        onPaste={onPaste}
        onAddRecord={(initialValues) => void onAddRecord(initialValues)}
        onOpenFieldCreator={onOpenFieldCreator}
        onUndo={onUndo}
        onRedo={onRedo}
      />
    )
  },
)
