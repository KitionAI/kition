import { useEffect, useRef } from 'react'

import { useTableDataSource, type TableLiveChange } from './TableDataSource'

/** [tableId, rowKey] tuples, as `TableChange.recordsUpserted` and `.recordsDeleted` carry them. */
type TableLiveRowRefs = TableLiveChange['recordsUpserted']

export type TableLiveChangeHandlers = {
  onRecords?: (upserted: TableLiveRowRefs, deleted: TableLiveRowRefs) => void
  /** Table ids whose definition or fields changed (`TableChange.tables` and `.schema` combined). */
  onSchema?: (tableIds: number[]) => void
  onViews?: (viewIds: number[]) => void
  /** Table ids whose row order changed. */
  onReorder?: (tableIds: number[]) => void
  onDashboards?: () => void
  /**
   * The bridge stream reconnected after the first time: events may have
   * been lost while it was down, so the editor should refetch rather than
   * trust its last known state.
   */
  onResync?: () => void
}

/**
 * Subscribes to the changes others make to this document (`TableDataSource.onChange`) for
 * as long as `documentId` is set, and dispatches them to `handlers`.
 *
 * `handlers` is read through a ref, so passing a new object on every render
 * does not resubscribe.
 */
export function useTableLiveChanges(documentId: number | null, handlers: TableLiveChangeHandlers) {
  const dataSource = useTableDataSource()
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (documentId == null) return undefined
    return dataSource.onChange(documentId, (event) => {
      const current = handlersRef.current
      if (event.type === 'resync') {
        current.onResync?.()
        return
      }
      const change = event.change
      if (change.recordsUpserted.length > 0 || change.recordsDeleted.length > 0) {
        current.onRecords?.(change.recordsUpserted, change.recordsDeleted)
      }
      if (change.tables.length > 0 || change.schema.length > 0) {
        current.onSchema?.([...new Set([...change.tables, ...change.schema])])
      }
      if (change.views.length > 0) {
        current.onViews?.(change.views)
      }
      if (change.recordsReordered.length > 0) {
        current.onReorder?.(change.recordsReordered)
      }
      if (change.dashboards) {
        current.onDashboards?.()
      }
    })
  }, [dataSource, documentId])
}
