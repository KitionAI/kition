import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getDataDocumentHistoryState,
  redoDataDocument,
  undoDataDocument,
  type TableChange,
} from '@/api/dataDocuments'

/**
 * Server-backed undo/redo for the table editor: the runtime owns the
 * history stack (one `transactDataDocument` call is one undo step), this
 * hook just calls `/undo`, `/redo`, and `/history-state` and tracks the
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
    return getDataDocumentHistoryState(documentId)
      .then((state) => {
        setCanUndo(state.canUndo)
        setCanRedo(state.canRedo)
      })
      .catch(() => {
        // A transient failure here just leaves the previous enabled state;
        // the next action, undo/redo, or live event will refresh it again.
      })
  }, [documentId])

  useEffect(() => {
    void refreshHistoryState()
  }, [refreshHistoryState])

  const runHistoryStep = useCallback(
    async (direction: 'undo' | 'redo') => {
      if (documentId == null) return false
      setHistoryBusy(true)
      try {
        const result = direction === 'undo'
          ? await undoDataDocument(documentId)
          : await redoDataDocument(documentId)
        if (result.done) {
          await onApplyChangeRef.current?.(result.change)
        }
        return result.done
      } finally {
        await refreshHistoryState()
        setHistoryBusy(false)
      }
    },
    [documentId, refreshHistoryState],
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
