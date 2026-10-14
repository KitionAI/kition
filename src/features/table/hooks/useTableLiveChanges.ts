import { useEffect, useRef } from 'react'

import { windowSessionOrigin } from '@/api/windowSession'
import { onTableChanged } from '@/services/runtimeBridge'
import type { TableChangedParams } from '@/api/generated/table-changed'

/** [tableId, rowKey] tuples, as `TableChange.recordsUpserted` and `.recordsDeleted` carry them. */
type TableLiveRowRefs = TableChangedParams['recordsUpserted']

export type TableLiveChangeHandlers = {
  onRecords?: (upserted: TableLiveRowRefs, deleted: TableLiveRowRefs) => void
  /** Table ids whose definition or fields changed (`TableChange.tables` and `.schema` combined). */
  onSchema?: (tableIds: number[]) => void
  onViews?: (viewIds: number[]) => void
  /** Table ids whose row order changed. */
  onReorder?: (tableIds: number[]) => void
  onDashboards?: () => void
}

/**
 * Subscribes to this document's `table/changed` events on the kit bridge
 * stream for as long as `documentId` is set, and dispatches them to
 * `handlers`. Events for another document, and events this window caused
 * itself (`origin` is this window's own `person:session:<uuid>`, already
 * applied locally), are ignored.
 *
 * `handlers` is read through a ref, so passing a new object on every render
 * does not resubscribe. Not wired into the table editor yet.
 */
export function useTableLiveChanges(documentId: number | string | null, handlers: TableLiveChangeHandlers) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (documentId == null) return undefined
    const expectedDocumentId = String(documentId)
    const ownOrigin = windowSessionOrigin()

    return onTableChanged((event) => {
      if (event.documentId !== expectedDocumentId) return
      if (event.origin === ownOrigin) return

      const current = handlersRef.current
      if (event.recordsUpserted.length > 0 || event.recordsDeleted.length > 0) {
        current.onRecords?.(event.recordsUpserted, event.recordsDeleted)
      }
      if (event.tables.length > 0 || event.schema.length > 0) {
        current.onSchema?.([...new Set([...event.tables, ...event.schema])])
      }
      if (event.views.length > 0) {
        current.onViews?.(event.views)
      }
      if (event.recordsReordered.length > 0) {
        current.onReorder?.(event.recordsReordered)
      }
      if (event.dashboards) {
        current.onDashboards?.()
      }
    })
  }, [documentId])
}
