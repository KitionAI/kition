import { useEffect, type ClipboardEvent as ReactClipboardEvent, type Dispatch, type SetStateAction } from 'react'
import { createDataRecord, transactDataDocument, updateDataRecord, uploadDataAttachment, type TableOp } from '@/api/dataDocuments'
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
  /** Refreshes the undo/redo toolbar state after a server write; optional so existing callers and tests keep working untouched. */
  refreshHistoryState?: () => void
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
  refreshHistoryState,
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
      refreshHistoryState?.()
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
      const writableUpdates = existingUpdates.filter((item) => item.record.row_key)
      if (!writableUpdates.length && !newRows.length) return

      // One transaction for the whole pasted block: existing cells via
      // cells.set, rows past the end of the table via records.create.
      const ops: TableOp[] = []
      if (writableUpdates.length) {
        ops.push({
          op: 'cells.set',
          tableId,
          records: writableUpdates.map((item) => ({ rowKey: item.record.row_key, values: item.values })),
        })
      }
      if (newRows.length) {
        ops.push({ op: 'records.create', tableId, at: null, records: newRows })
      }

      await transactDataDocument(documentId, ops)

      if (writableUpdates.length) {
        const patchByRecordId = new Map(writableUpdates.map((item) => [item.record.id, item.values]))
        setRecords((items) => items.map((item) => {
          const patch = patchByRecordId.get(item.id)
          return patch ? { ...item, values: { ...item.values, ...patch } } : item
        }))
      }
      if (newRows.length) {
        // The transaction only returns the new row keys, not full records,
        // so refetch to pick up the created rows (and their server ids).
        reloadRecords()
      }
      const total = writableUpdates.length + newRows.length
      setStatus(`Pasted ${total} row${total === 1 ? '' : 's'}`)
      refreshHistoryState?.()
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
