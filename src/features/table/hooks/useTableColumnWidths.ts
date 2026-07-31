import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { listViewFields, patchViewField } from '@/api/dataDocuments'
import type { DataField } from '@/types/dataDocument'

const MIN_COLUMN_WIDTH = 100
const COLUMN_WIDTH_SAVE_DELAY_MS = 250
const EMPTY_COLUMN_WIDTHS: Record<string, number> = {}

type ColumnWidthState = {
  key: string
  widths: Record<string, number>
}

function normalizeColumnWidth(width: number) {
  return Math.max(MIN_COLUMN_WIDTH, Math.round(width))
}

export function useTableColumnWidths({
  documentId,
  tableId,
  viewId,
}: {
  documentId: number
  tableId: number
  viewId?: number | null
}) {
  const viewKey = viewId ? `${documentId}:${tableId}:${viewId}` : ''
  const [state, setState] = useState<ColumnWidthState>({ key: '', widths: {} })
  const persistTimersRef = useRef(new Map<string, number>())

  useEffect(() => {
    if (!viewId) {
      setState({ key: '', widths: {} })
      return
    }

    let cancelled = false
    setState({ key: viewKey, widths: {} })

    void listViewFields(documentId, tableId, viewId)
      .then((response) => {
        if (cancelled) return
        const loadedWidths = (Array.isArray(response.items) ? response.items : []).reduce(
          (widths, item) => {
            if (Number.isFinite(item.width) && item.width > 0) {
              widths[String(item.field_id)] = normalizeColumnWidth(item.width)
            }
            return widths
          },
          {} as Record<string, number>,
        )
        setState((current) => current.key === viewKey
          ? { key: viewKey, widths: { ...loadedWidths, ...current.widths } }
          : current)
      })
      .catch(() => {
        // The grid remains usable with its default widths when layout loading fails.
      })

    return () => {
      cancelled = true
    }
  }, [documentId, tableId, viewId, viewKey])

  const resizeColumn = useCallback((field: DataField, width: number) => {
    if (!viewId) return

    const normalizedWidth = normalizeColumnWidth(width)
    setState((current) => ({
      key: viewKey,
      widths: {
        ...(current.key === viewKey ? current.widths : {}),
        [String(field.id)]: normalizedWidth,
      },
    }))

    const persistKey = `${viewKey}:${field.id}`
    const existingTimer = persistTimersRef.current.get(persistKey)
    if (existingTimer != null) window.clearTimeout(existingTimer)

    const timer = window.setTimeout(() => {
      persistTimersRef.current.delete(persistKey)
      void patchViewField(documentId, tableId, viewId, field.id, {
        width: normalizedWidth,
      }).catch(() => {
        // Keep the locally resized column usable; a later resize can retry persistence.
      })
    }, COLUMN_WIDTH_SAVE_DELAY_MS)
    persistTimersRef.current.set(persistKey, timer)
  }, [documentId, tableId, viewId, viewKey])

  const columnWidths = useMemo(
    () => state.key === viewKey ? state.widths : EMPTY_COLUMN_WIDTHS,
    [state, viewKey],
  )

  return { columnWidths, resizeColumn }
}
