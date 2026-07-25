import { useCallback } from 'react'

import {
  setCollapsedGroupIds as writeCollapsedGroupIds,
  useCollapsedGroupIds,
} from '@/features/table/store/gridCollapsedGroupStore'

const FALLBACK_VIEW_ID = '__no_view__'

export function useGridCollapsedGroup(activeViewId: number | null) {
  const viewIdKey = activeViewId == null ? FALLBACK_VIEW_ID : String(activeViewId)
  const collapsedGroupIds = useCollapsedGroupIds(viewIdKey)
  const setCollapsedGroupIds = useCallback(
    (next: Set<string>) => {
      if (activeViewId == null) return
      writeCollapsedGroupIds(viewIdKey, next)
    },
    [viewIdKey, activeViewId],
  )
  return { collapsedGroupIds, setCollapsedGroupIds }
}
