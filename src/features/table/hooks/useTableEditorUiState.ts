import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { DataField, DataRecord } from '@/types/dataDocument'
import type {
  ColumnHeaderMenuState,
  GridCellSelection,
  ImagePreviewState,
  RecordContextMenuState,
  ToolbarPanel,
} from '@/features/table/lib/tableEditorShared'

type RecordContextMenuEvent = Pick<ReactMouseEvent, 'clientX' | 'clientY' | 'preventDefault' | 'stopPropagation'>

export function useTableEditorUiState() {
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<number>>(new Set())
  const [selectedRecord, setSelectedRecord] = useState<DataRecord | null>(null)
  const [selectedGridCell, setSelectedGridCell] = useState<GridCellSelection>(null)
  const [editingField, setEditingField] = useState<DataField | null>(null)
  const [kanbanDraggingRecordId, setKanbanDraggingRecordId] = useState<number | null>(null)
  const [kanbanDragOverRecordId, setKanbanDragOverRecordId] = useState<number | null>(null)
  const [kanbanDragOverGroup, setKanbanDragOverGroup] = useState('')
  const [recordContextMenu, setRecordContextMenu] = useState<RecordContextMenuState>(null)
  const [columnHeaderMenu, setColumnHeaderMenu] = useState<ColumnHeaderMenuState>(null)
  const [toolbarPanel, setToolbarPanel] = useState<ToolbarPanel>(null)
  const [imagePreview, setImagePreview] = useState<ImagePreviewState>(null)

  function resetSelectedRecordIds() {
    setSelectedRecordIds(new Set())
  }

  function toggleAllSelected(recordIds: number[], allVisibleSelected: boolean) {
    setSelectedRecordIds(allVisibleSelected ? new Set() : new Set(recordIds))
  }

  function toggleRecordSelected(recordId: number, checked?: boolean) {
    setSelectedRecordIds((current) => {
      const next = new Set(current)
      if (checked === undefined) {
        if (next.has(recordId)) next.delete(recordId)
        else next.add(recordId)
      } else if (checked) {
        next.add(recordId)
      } else {
        next.delete(recordId)
      }
      return next
    })
  }

  function openRecordContextMenu(record: DataRecord, event: RecordContextMenuEvent) {
    event.preventDefault()
    event.stopPropagation()
    setSelectedRecordIds((current) => current.has(record.id) ? current : new Set([record.id]))
    setRecordContextMenu({ recordId: record.id, x: event.clientX, y: event.clientY })
  }

  function openColumnHeaderMenu(field: DataField, position: { x: number; y: number }) {
    setColumnHeaderMenu({ fieldId: field.id, x: position.x, y: position.y })
  }

  function closeColumnHeaderMenu() {
    setColumnHeaderMenu(null)
  }

  function clearKanbanDrag() {
    setKanbanDraggingRecordId(null)
    setKanbanDragOverRecordId(null)
    setKanbanDragOverGroup('')
  }

  return {
    clearKanbanDrag,
    closeColumnHeaderMenu,
    columnHeaderMenu,
    editingField,
    imagePreview,
    kanbanDragOverGroup,
    kanbanDragOverRecordId,
    kanbanDraggingRecordId,
    openColumnHeaderMenu,
    openRecordContextMenu,
    recordContextMenu,
    resetSelectedRecordIds,
    selectedGridCell,
    selectedRecord,
    selectedRecordIds,
    setColumnHeaderMenu,
    setEditingField,
    setImagePreview,
    setKanbanDragOverGroup,
    setKanbanDragOverRecordId,
    setKanbanDraggingRecordId,
    setRecordContextMenu,
    setSelectedGridCell,
    setSelectedRecord,
    setSelectedRecordIds,
    setToolbarPanel,
    toggleAllSelected,
    toggleRecordSelected,
    toolbarPanel,
  }
}
