/**
 * Opens or focuses an embedded browser tab when something dispatches the
 * open-browser-tab event (the Agent, the sites panel, a table action).
 * The origin falls back to the table the Agent last worked on, so a tab
 * opened from a table keeps pointing back at it.
 */
import { useEffect } from 'react'

import {
  buildWorkspaceBrowserTab,
  buildWorkspaceBrowserTabId,
  findWorkspaceBrowserTabIdsForSnapshot,
  OPEN_WORKSPACE_BROWSER_TAB_EVENT,
  resolveWorkspaceBrowserTabOrigin,
  workspaceBrowserTabUpsertOptions,
  type WorkspaceBrowserTabPayload,
} from '@/features/workspace/lib/browserTabs'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import type { UpsertTabOptions } from '@/features/workspace/state/tabs'
import { WEB_BROWSER_ENABLED } from '@/lib/productFeatures'

export type WorkspaceBrowserTabOriginFallback = {
  documentPath?: string
  tableId?: number | null
  originLabel?: string
}

type UseWorkspaceBrowserTabEventsOptions = {
  upsertWorkspaceTab: (tab: WorkspaceTab, options?: UpsertTabOptions) => void
  /** Current tabs, read at event time. */
  getTabs: () => WorkspaceTab[]
  /** Origin to use when the payload names none, read at event time. */
  getOriginFallback: () => WorkspaceBrowserTabOriginFallback
}

/** Resolves one request to the tab to upsert, or null when it names no provider. */
export function resolveBrowserTabOpenRequest(
  payload: WorkspaceBrowserTabPayload | undefined,
  tabs: WorkspaceTab[],
  fallback: WorkspaceBrowserTabOriginFallback,
) {
  if (!payload?.provider) return null
  const origin = resolveWorkspaceBrowserTabOrigin(payload, fallback)
  const snapshot = {
    ...payload,
    origin_tab_id: origin.originTabId,
    origin_document_path: origin.originDocumentPath,
    origin_table_id: origin.originTableId,
    origin_label: origin.originLabel,
  }
  const [existingId] = findWorkspaceBrowserTabIdsForSnapshot(tabs, snapshot)
  return {
    tab: buildWorkspaceBrowserTab(payload, origin, existingId || buildWorkspaceBrowserTabId(snapshot)),
    options: workspaceBrowserTabUpsertOptions(payload),
  }
}

export function useWorkspaceBrowserTabEvents({
  upsertWorkspaceTab,
  getTabs,
  getOriginFallback,
}: UseWorkspaceBrowserTabEventsOptions) {
  useEffect(() => {
    if (!WEB_BROWSER_ENABLED) return
    const handleOpenBrowserTab = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceBrowserTabPayload>).detail
      const request = resolveBrowserTabOpenRequest(detail, getTabs(), getOriginFallback())
      if (request) upsertWorkspaceTab(request.tab, request.options)
    }
    window.addEventListener(OPEN_WORKSPACE_BROWSER_TAB_EVENT, handleOpenBrowserTab)
    return () => window.removeEventListener(OPEN_WORKSPACE_BROWSER_TAB_EVENT, handleOpenBrowserTab)
    // The getters read refs; only the upsert function identity matters.
  }, [getOriginFallback, getTabs, upsertWorkspaceTab])
}
