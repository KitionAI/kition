import { useEffect, useRef, useState } from 'react'
import {
  getDataDocument,
  listDataDocuments,
  listDataRecords,
  openDataDocumentByPath,
  updateDataField,
} from '@/api/dataDocuments'
import type { DataDocument, DataRecord } from '@/types/dataDocument'
import { parseMarker, type DataRecordWindow } from '@/features/table/lib/tableEditorShared'

async function removeRequiredFieldConstraints(document: DataDocument) {
  const requiredFields = (document.tables || []).flatMap((table) =>
    (table.fields || [])
      .filter((field) => field.required)
      .map((field) => ({ tableId: table.id, field })),
  )
  if (!requiredFields.length) return document

  await Promise.all(requiredFields.map(({ tableId, field }) =>
    updateDataField(document.id, tableId, field.id, { required: false }),
  ))
  const requiredKeys = new Set(
    requiredFields.map(({ tableId, field }) => `${tableId}:${field.id}`),
  )
  return {
    ...document,
    tables: document.tables?.map((table) => ({
      ...table,
      fields: table.fields?.map((field) => (
        requiredKeys.has(`${table.id}:${field.id}`)
          ? { ...field, required: false }
          : field
      )),
    })),
  }
}

export function useTableEditorData({
  documentPath,
  markerContent,
  pinnedTableId,
  onRecordsLoaded,
}: {
  documentPath: string
  markerContent: string
  pinnedTableId?: number
  onRecordsLoaded?: () => void
}) {
  const pendingRecordWindowRef = useRef('')
  const [document, setDocument] = useState<DataDocument | null>(null)
  const [resolvedActiveTableId, setResolvedActiveTableId] = useState<number | null>(null)
  const [resolvedActiveViewId, setResolvedActiveViewId] = useState<number | null>(null)
  const [records, setRecords] = useState<DataRecord[]>([])
  const [recordTotal, setRecordTotal] = useState(0)
  const [recordOffset, setRecordOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function loadDocument() {
    setLoading(true)
    setError('')
    try {
      const markerId = parseMarker(markerContent)
      let nextDocument: DataDocument | null = null
      if (markerId) {
        try {
          nextDocument = await getDataDocument(markerId)
        } catch {
          nextDocument = null
        }
      }
      if (!nextDocument) {
        try {
          nextDocument = await openDataDocumentByPath({ path: documentPath })
        } catch {
          const result = await listDataDocuments({ query: documentPath })
          nextDocument = result.items.find((item) => item.path === documentPath) || null
        }
      }
      if (nextDocument) {
        nextDocument = await removeRequiredFieldConstraints(nextDocument)
      }
      setDocument(nextDocument)
      setResolvedActiveTableId((current) => {
        const tables = nextDocument?.tables ?? []
        if (pinnedTableId != null) {
          return tables.some((table) => table.id === pinnedTableId) ? pinnedTableId : null
        }
        if (current && tables.some((table) => table.id === current)) {
          return current
        }
        return tables[0]?.id ?? null
      })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load table')
    } finally {
      setLoading(false)
    }
  }

  async function refreshDocument(preferredTableId = resolvedActiveTableId, preferredViewId = resolvedActiveViewId) {
    if (!document) return
    const nextDocument = await removeRequiredFieldConstraints(
      await getDataDocument(document.id),
    )
    setDocument(nextDocument)
    const tables = nextDocument?.tables ?? []
    const resolvedId = pinnedTableId != null
      ? (tables.some((table) => table.id === pinnedTableId) ? pinnedTableId : null)
      : (preferredTableId && tables.some((table) => table.id === preferredTableId)
          ? preferredTableId
          : tables[0]?.id ?? null)
    setResolvedActiveTableId(resolvedId)
    const nextTable = resolvedId
      ? tables.find((table) => table.id === resolvedId)
      : (pinnedTableId != null ? undefined : tables[0])
    setResolvedActiveViewId(
      preferredViewId && nextTable?.views?.some((view) => view.id === preferredViewId)
        ? preferredViewId
        : nextTable?.views?.[0]?.id ?? null,
    )
  }

  async function loadRecords(window?: DataRecordWindow) {
    if (!document || !resolvedActiveTableId) {
      setRecords([])
      setRecordTotal(0)
      setRecordOffset(0)
      return
    }
    const windowKey = `${document.id}:${resolvedActiveTableId}:${window?.limit || 0}:${window?.offset || 0}`
    if (pendingRecordWindowRef.current === windowKey) return
    pendingRecordWindowRef.current = windowKey
    try {
      const result = await listDataRecords(document.id, resolvedActiveTableId, window)
      setRecords(result.items)
      setRecordTotal(result.total)
      setRecordOffset(result.offset || 0)
      onRecordsLoaded?.()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load records')
    } finally {
      if (pendingRecordWindowRef.current === windowKey) {
        pendingRecordWindowRef.current = ''
      }
    }
  }

  useEffect(() => {
    void loadDocument()
  }, [documentPath, markerContent, pinnedTableId])

  return {
    document,
    setDocument,
    activeTableId: resolvedActiveTableId,
    setActiveTableId: setResolvedActiveTableId,
    activeViewId: resolvedActiveViewId,
    setActiveViewId: setResolvedActiveViewId,
    records,
    setRecords,
    recordTotal,
    setRecordTotal,
    recordOffset,
    setRecordOffset,
    loading,
    setLoading,
    error,
    setError,
    loadDocument,
    refreshDocument,
    loadRecords,
  }
}
