import { useEffect, type ClipboardEvent as ReactClipboardEvent, type Dispatch, type SetStateAction } from 'react'
import { createDataRecord, updateDataRecord, uploadDataAttachment } from '@/api/dataDocuments'
import type { DataField, DataRecord, DataRecordValue } from '@/types/dataDocument'
import {
  coerceValue,
  extractClipboardFiles,
  normalizeAttachmentValue,
  parsePastedTable,
  type DataInlineViewMode,
  type GridCellSelection,
} from '@/features/table/lib/tableEditorShared'

type UseTableClipboardArgs = {
  documentId?: number
  tableId?: number
  viewMode: DataInlineViewMode
  visibleFields: DataField[]
  sortedAndFilteredRecords: DataRecord[]
  records: DataRecord[]
  selectedGridCell: GridCellSelection
  setBusy: (busy: boolean) => void
  setError: (message: string) => void
  setStatus: (message: string) => void
  setRecords: Dispatch<SetStateAction<DataRecord[]>>
  reloadRecords: () => void
}

export function useTableClipboard({
  documentId,
  tableId,
  viewMode,
  visibleFields,
  sortedAndFilteredRecords,
  records,
  selectedGridCell,
  setBusy,
  setError,
  setStatus,
  setRecords,
  reloadRecords,
}: UseTableClipboardArgs) {
  function isEditablePasteTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false
    if (target.closest('.data-inline-longtext-cell')) return true
    if (target.closest('.data-inline-cell-input')) return true
    if (target.closest('.data-inline-grid')) return false
    if (target.closest('.data-inline-grid-canvas')) return false
    const tagName = target.tagName.toLowerCase()
    return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable
  }

  function getPasteStart(target: EventTarget | null) {
    if (target instanceof HTMLElement) {
      const cell = target.closest<HTMLElement>('[data-data-cell-record-id][data-data-cell-field-name]')
      if (cell) {
        const recordId = Number(cell.dataset.dataCellRecordId)
        const fieldName = cell.dataset.dataCellFieldName || ''
        if (fieldName) return { recordId: Number.isFinite(recordId) ? recordId : null, fieldName }
      }
    }
    return selectedGridCell
  }

  async function pasteAttachmentFiles(files: File[], target: EventTarget | null) {
    if (!documentId || !tableId || !files.length) return
    const start = getPasteStart(target)
    const field = start?.fieldName ? visibleFields.find((item) => item.name === start.fieldName) : null
    if (!field || field.type !== 'attachment' || field.readonly) return
    const targetRecord = start.recordId ? records.find((record) => record.id === start.recordId) : null
    setBusy(true)
    try {
      const uploaded = await Promise.all(files.map((file) => uploadDataAttachment(documentId, tableId, file)))
      if (targetRecord) {
        const nextValue = [...normalizeAttachmentValue(targetRecord.values?.[field.name] ?? null), ...uploaded]
        const updated = await updateDataRecord(documentId, tableId, targetRecord.id, { [field.name]: nextValue })
        setRecords((items) => items.map((record) => record.id === updated.id ? updated : record))
      } else {
        const created = await createDataRecord(documentId, tableId, { [field.name]: uploaded })
        setRecords((items) => [...items, created])
      }
      setStatus(`Added ${uploaded.length} attachment${uploaded.length === 1 ? '' : 's'}`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Attachment paste failed')
      reloadRecords()
    } finally {
      setBusy(false)
    }
  }

  async function applyPastedRows(rows: string[][], startRecordIndex: number, startFieldIndex: number) {
    if (!documentId || !tableId || !visibleFields.length) return
    setBusy(true)
    try {
      const existingUpdates: Array<{ record: DataRecord; values: Record<string, DataRecordValue> }> = []
      const newRows: Array<Record<string, DataRecordValue>> = []
      rows.forEach((row, rowIndex) => {
        const values = row.reduce<Record<string, DataRecordValue>>((payload, cell, cellIndex) => {
          const field = visibleFields[startFieldIndex + cellIndex]
          if (field && !field.readonly) {
            payload[field.name] = coerceValue(field, cell)
          }
          return payload
        }, {})
        if (!Object.keys(values).length) return
        const targetRecord = sortedAndFilteredRecords[startRecordIndex + rowIndex]
        if (targetRecord) existingUpdates.push({ record: targetRecord, values })
        else newRows.push(values)
      })

      const updatedRecords = await Promise.all(existingUpdates.map((item) => updateDataRecord(documentId, tableId, item.record.id, item.values)))
      const createdRecords = await Promise.all(newRows.map((values) => createDataRecord(documentId, tableId, values)))
      setRecords((items) => {
        const updatedById = new Map(updatedRecords.map((record) => [record.id, record]))
        return [...items.map((record) => updatedById.get(record.id) || record), ...createdRecords]
      })
      setStatus(`Pasted ${existingUpdates.length + createdRecords.length} row${existingUpdates.length + createdRecords.length === 1 ? '' : 's'}`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Paste import failed')
      reloadRecords()
    } finally {
      setBusy(false)
    }
  }

  function pasteFromClipboard(clipboardData: DataTransfer | null, target: EventTarget | null) {
    if (!documentId || !tableId || viewMode !== 'grid' || !visibleFields.length || isEditablePasteTarget(target)) return false
    const files = extractClipboardFiles(clipboardData)
    if (files.length) {
      const start = getPasteStart(target)
      const field = start?.fieldName ? visibleFields.find((item) => item.name === start.fieldName) : null
      if (field?.type === 'attachment' && !field.readonly) {
        void pasteAttachmentFiles(files, target)
        return true
      }
    }
    const text = clipboardData?.getData('text/plain') || ''
    if (!text.trim()) return false
    const rows = parsePastedTable(text)
    if (!rows.length) return false
    const start = getPasteStart(target)
    const startRecordIndex = start?.recordId ? sortedAndFilteredRecords.findIndex((record) => record.id === start.recordId) : sortedAndFilteredRecords.length
    const startFieldIndex = start?.fieldName ? visibleFields.findIndex((field) => field.name === start.fieldName) : 0
    void applyPastedRows(rows, Math.max(startRecordIndex, 0), Math.max(startFieldIndex, 0))
    return true
  }

  function pasteRecords(event: ReactClipboardEvent<HTMLDivElement>) {
    if (pasteFromClipboard(event.clipboardData, event.target)) {
      event.preventDefault()
    }
  }

  useEffect(() => {
    if (viewMode !== 'grid' || !documentId || !tableId) return
    function handleWindowPaste(event: globalThis.ClipboardEvent) {
      if (event.defaultPrevented) return
      if (pasteFromClipboard(event.clipboardData, event.target)) {
        event.preventDefault()
      }
    }
    window.addEventListener('paste', handleWindowPaste)
    return () => window.removeEventListener('paste', handleWindowPaste)
  }, [documentId, records, selectedGridCell, sortedAndFilteredRecords, tableId, viewMode, visibleFields])

  return { pasteRecords }
}
