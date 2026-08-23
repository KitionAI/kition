import { useMemo, useRef, useSyncExternalStore } from 'react'

import { BoardCommandRegistry } from '../lib/boardCommands'
import { createBoardBaseRecords } from '../lib/boardRecords'
import { BoardStore } from '../lib/boardStore'

export function useBoardEditorStore() {
  const storeRef = useRef<BoardStore | null>(null)
  if (!storeRef.current) {
    storeRef.current = new BoardStore(createBoardBaseRecords())
  }
  const store = storeRef.current
  const commands = useMemo(() => new BoardCommandRegistry(store), [store])
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )

  return {
    commands,
    elements: store.getCurrentPageElements(),
    records: store.getRecords(),
    snapshot,
    store,
  }
}
