import type { TableLiveChangeHandlers } from '@/features/table/hooks/useTableLiveChanges'

/**
 * Builds the `useTableLiveChanges` handlers for the table editor: wires
 * each kind of remote change to the right refetch, scoped to the
 * currently open table/view so an edit to a table the user isn't looking
 * at doesn't trigger a refetch. Kept as a pure builder (no React) so it is
 * easy to unit test the dispatch rules without mounting `TableEditor`.
 */
export function buildTableLiveChangeHandlers({
  activeTableId,
  activeViewId,
  loadRecords,
  refreshDocument,
  refreshHistoryState,
}: {
  activeTableId: number | null
  activeViewId: number | null
  /** Refetches the active table's records (the mocks and the runtime don't support filtering by row key yet, so a full table refetch is the accepted fallback). */
  loadRecords: () => void
  /** Reloads the whole document (tables, fields, views). */
  refreshDocument: () => void
  refreshHistoryState: () => void
}): TableLiveChangeHandlers {
  function touchesActiveTable(tableIds: readonly number[]) {
    return activeTableId != null && tableIds.includes(activeTableId)
  }

  return {
    onRecords: (upserted, deleted) => {
      const touched = [...upserted, ...deleted].some(([tableId]) => tableId === activeTableId)
      if (touched) loadRecords()
      refreshHistoryState()
    },
    onSchema: (tableIds) => {
      if (touchesActiveTable(tableIds)) refreshDocument()
      refreshHistoryState()
    },
    onViews: (viewIds) => {
      if (activeViewId != null && viewIds.includes(activeViewId)) refreshDocument()
      refreshHistoryState()
    },
    onReorder: (tableIds) => {
      if (touchesActiveTable(tableIds)) loadRecords()
      refreshHistoryState()
    },
    onDashboards: () => {
      refreshHistoryState()
    },
    onResync: () => {
      refreshDocument()
      loadRecords()
      refreshHistoryState()
    },
  }
}
