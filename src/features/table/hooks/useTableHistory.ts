import { useCallback, useEffect, useRef, useState } from 'react'
import { useTableDataSource, type TableChange } from '@/features/table/ports/TableDataSource'

/**
 * Document-backed undo/redo for the table editor: the data source owns the
 * history stack (one `transact` call is one undo step), this hook just calls
 * its `undo`, `redo`, and `historyState` and tracks the
 * resulting enabled state for the toolbar. Replaces the removed
 * `useTableCellHistory`, which tracked cell edits locally.
 */
export function useTableHistory({
  documentId,
  onApplyChange,
}: {
  documentId: number | null | undefined
  /** Called with the server's `change` after a successful (non-no-op) undo or redo, so the caller can refetch what changed. */
  onApplyChange?: (change: TableChange) => void | Promise<void>
}) {
  const dataSource = useTableDataSource()
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [historyBusy, setHistoryBusy] = useState(false)
  const onApplyChangeRef = useRef(onApplyChange)
  onApplyChangeRef.current = onApplyChange

  const refreshHistoryState = useCallback(() => {
    if (documentId == null) {
      setCanUndo(false)
      setCanRedo(false)
      return Promise.resolve()
    }
    return dataSource.historyState({ documentId })
      .then((state) => {
        setCanUndo(state.canUndo)
        setCanRedo(state.canRedo)
      })
      .catch(() => {
        // A transient failure here just leaves the previous enabled state;
        // the next action, undo/redo, or live event will refresh it again.
      })
  }, [dataSource, documentId])

  useEffect(() => {
    void refreshHistoryState()
  }, [refreshHistoryState])

  const runHistoryStep = useCallback(
    async (direction: 'undo' | 'redo') => {
      if (documentId == null) return false
      setHistoryBusy(true)
      try {
        const result = direction === 'undo'
          ? await dataSource.undo({ documentId })
          : await dataSource.redo({ documentId })
        if (result.done) {
          await onApplyChangeRef.current?.(result.change)
        }
        return result.done
      } finally {
        await refreshHistoryState()
        setHistoryBusy(false)
      }
    },
    [dataSource, documentId, refreshHistoryState],
  )

  const undo = useCallback(() => runHistoryStep('undo'), [runHistoryStep])
  const redo = useCallback(() => runHistoryStep('redo'), [runHistoryStep])

  return {
    canUndo,
    canRedo,
    historyBusy,
    refreshHistoryState,
    undo,
    redo,
  }
}
