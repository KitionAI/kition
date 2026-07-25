import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { DataAttachment, DataDocument, DataField, DataFieldType, DataRecord, DataTable, DataView } from '@/types/dataDocument'
import {
  type DataRecordWindow,
  type ImagePreviewState,
  type RecordContextMenuState,
} from '@/features/table/lib/tableEditorShared'
import { notify } from '@/lib/notify'
import { useTableRecordActions } from './useTableRecordActions'
import { useTableStructureActions } from './useTableStructureActions'

type UseTableEditorActionsArgs = {
  documentPath: string
  document: DataDocument | null
  activeTable: DataTable | null
  tableViews: DataView[]
  fields: DataField[]
  records: DataRecord[]
  groupField: DataField | null
  canReorderRows: boolean
  canMoveKanbanCards: boolean
  newFieldTitle: string
  newFieldType: DataFieldType
  selectedRecordIds: Set<number>
  importInputRef: RefObject<HTMLInputElement | null>
  setBusy: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string>>
  setDocument: Dispatch<SetStateAction<DataDocument | null>>
  setRecords: Dispatch<SetStateAction<DataRecord[]>>
  setSelectedRecord: Dispatch<SetStateAction<DataRecord | null>>
  setSelectedRecordIds: Dispatch<SetStateAction<Set<number>>>
  setRecordContextMenu: Dispatch<SetStateAction<RecordContextMenuState>>
  setEditingField: Dispatch<SetStateAction<DataField | null>>
  setNewFieldTitle: Dispatch<SetStateAction<string>>
  setViewCreateOpen: Dispatch<SetStateAction<boolean>>
  setActiveViewId: Dispatch<SetStateAction<number | null>>
  setImagePreview: Dispatch<SetStateAction<ImagePreviewState>>
  refreshDocument: (preferredTableId?: number | null, preferredViewId?: number | null) => Promise<void>
  loadRecords: (window?: DataRecordWindow) => Promise<void>
}

export function useTableEditorActions({
  documentPath,
  document,
  activeTable,
  tableViews,
  fields,
  records,
  groupField,
  canReorderRows,
  canMoveKanbanCards,
  newFieldTitle,
  newFieldType,
  selectedRecordIds,
  importInputRef,
  setBusy,
  setError,
  setDocument,
  setRecords,
  setSelectedRecord,
  setSelectedRecordIds,
  setRecordContextMenu,
  setEditingField,
  setNewFieldTitle,
  setViewCreateOpen,
  setActiveViewId,
  setImagePreview,
  refreshDocument,
  loadRecords,
}: UseTableEditorActionsArgs) {
  function setStatus(message: string) {
    notify.success(message)
  }

  function openAttachmentPreview(items: DataAttachment[], index: number) {
    if (!items.length) return
    const safeIndex = Math.min(Math.max(index, 0), items.length - 1)
    setImagePreview({ items, index: safeIndex })
  }

  async function copyTextToClipboard(text: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(text)
      setStatus(successMessage)
    } catch {
      setStatus(text)
    }
  }

  const structureActions = useTableStructureActions({
    documentPath,
    document,
    activeTable,
    tableViews,
    fields,
    records,
    newFieldTitle,
    newFieldType,
    importInputRef,
    setBusy,
    setError,
    setDocument,
    setRecords,
    setEditingField,
    setNewFieldTitle,
    setViewCreateOpen,
    setActiveViewId,
    refreshDocument,
    loadRecords,
    setStatus,
    copyTextToClipboard,
  })

  const recordActions = useTableRecordActions({
    document,
    activeTable,
    fields,
    records,
    groupField,
    canReorderRows,
    canMoveKanbanCards,
    selectedRecordIds,
    setBusy,
    setError,
    setRecords,
    setSelectedRecord,
    setSelectedRecordIds,
    setRecordContextMenu,
    loadRecords,
    setStatus,
    copyTextToClipboard,
  })

  return {
    ...structureActions,
    ...recordActions,
    copyTextToClipboard,
    openAttachmentPreview,
  }
}
