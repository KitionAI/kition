import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'

import { WORKSPACE_BROWSER_TOOLBAR_HEIGHT } from '@/features/workspace/components/WorkspaceBrowserToolbar'
import {
  applyWorkspaceBrowserSessionSnapshot,
  findWorkspaceBrowserTabIdsForSnapshot,
  resolveWorkspaceBrowserTabNavigationURL,
  type WorkspaceBrowserTabPayload,
} from '@/features/workspace/lib/browserTabs'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import {
  browserSessionGoBack,
  browserSessionGoForward,
  browserSessionReload,
  browserSessionStop,
  ensureBrowserSessionWindow,
  getBrowserSessionPanelState,
  getBrowserSessionStatus,
  hideBrowserSessionPanel,
  registerBrowserSessionStateHandler,
  setBrowserSessionHostLayout,
  type BrowserSessionPanelState,
  type BrowserSessionRequest,
  type BrowserSessionStatus,
} from '@/services/desktop'

export type WorkspaceBrowserTab = Extract<WorkspaceTab, { type: 'browser' }>
export type WorkspaceBrowserPanelPhase = 'loading' | 'ready' | 'unavailable' | 'empty'

export type WorkspaceBrowserToolbarStatus = {
  url: string
  canGoBack?: boolean
  canGoForward?: boolean
  isLoading?: boolean
}

const WORKSPACE_BROWSER_TAB_CHROME_TOP_INSET = 98
const WORKSPACE_BROWSER_TAB_TOP_INSET =
  WORKSPACE_BROWSER_TAB_CHROME_TOP_INSET + WORKSPACE_BROWSER_TOOLBAR_HEIGHT
// Bound how often the poll loop re-attaches a detached BrowserView per tab so a
// session that keeps failing does not spin forever.
const WORKSPACE_BROWSER_TAB_REATTACH_LIMIT = 3
const WORKSPACE_BROWSER_POLL_INTERVAL_MS = 1500

// The native browser view must overlay the `.workspace-browser-tab` placeholder
// exactly. Measure its on-screen top so the view never starts below the
// placeholder, which would expose the placeholder's gradient as an empty strip.
function measureBrowserTabTopInset() {
  if (typeof document === 'undefined') {
    return WORKSPACE_BROWSER_TAB_TOP_INSET
  }
  const node = document.querySelector('.workspace-browser-tab')
  if (!node) {
    return WORKSPACE_BROWSER_TAB_TOP_INSET
  }
  const top = Math.round(node.getBoundingClientRect().top)
  return Number.isFinite(top) && top > 0 ? top : WORKSPACE_BROWSER_TAB_TOP_INSET
}

/**
 * Whether the poll loop should re-attach the BrowserView for `tab`. A tab with
 * no requested URL and no live page stays detached on the empty state; a
 * missing or hidden panel, or a requested URL the live page lost, re-attaches.
 */
export function shouldReattachBrowserTab(
  tab: Pick<WorkspaceBrowserTab, 'url'> | null,
  status?: Pick<BrowserSessionStatus, 'page_url' | 'panel_visible'> | null,
): boolean {
  if (!tab) return false
  const expectedUrl = String(tab.url || '').trim()
  const liveUrl = String(status?.page_url || '').trim()
  if (!expectedUrl && !liveUrl) return false
  if (!status) return true
  if (!status.panel_visible) return true
  return Boolean(expectedUrl && !liveUrl)
}

type UseWorkspaceBrowserPanelOptions = {
  activeBrowserTab: WorkspaceBrowserTab | null
  workspaceTabs: WorkspaceTab[]
  updateWorkspaceTab: (tabId: string, updater: (tab: WorkspaceTab) => WorkspaceTab) => void
  /** The workflow workbench covers the editor area; the BrowserView must hide behind it. */
  workflowOpen: boolean
  effectiveSidebarWidth: number
  agentSidebarWidth: number
  workspaceAgentOpen: boolean
}

/**
 * Drives the embedded browser for the active browser tab: attaches and lays
 * out the desktop BrowserView, mirrors its page title and URL back into the
 * tab, re-attaches it when the desktop process drops it, and exposes the
 * toolbar navigation commands. Nothing here touches other tab types.
 */
export function useWorkspaceBrowserPanel({
  activeBrowserTab,
  workspaceTabs,
  updateWorkspaceTab,
  workflowOpen,
  effectiveSidebarWidth,
  agentSidebarWidth,
  workspaceAgentOpen,
}: UseWorkspaceBrowserPanelOptions) {
  const [browserPanelPhase, setBrowserPanelPhase] = useState<WorkspaceBrowserPanelPhase>('loading')
  const [browserNavState, setBrowserNavState] = useState<BrowserSessionPanelState | null>(null)

  const activeBrowserTabRef = useRef<WorkspaceBrowserTab | null>(null)
  activeBrowserTabRef.current = activeBrowserTab
  const workspaceTabsRef = useRef<WorkspaceTab[]>([])
  workspaceTabsRef.current = workspaceTabs
  const lastSyncedBrowserTabIdRef = useRef('')
  const browserTabReattachCountRef = useRef<Record<string, number>>({})

  const hostLayoutInsets = useCallback(() => ({
    leftInset: effectiveSidebarWidth,
    topInset: measureBrowserTabTopInset(),
    rightInset: workspaceAgentOpen ? agentSidebarWidth : 0,
  }), [agentSidebarWidth, effectiveSidebarWidth, workspaceAgentOpen])

  // Live page state from the desktop process: keep the toolbar and every tab
  // that shows the same session in sync.
  useEffect(() => {
    const syncSnapshotIntoTabs = (snapshot: WorkspaceBrowserTabPayload) => {
      const matchedIds = findWorkspaceBrowserTabIdsForSnapshot(workspaceTabsRef.current, snapshot)
      for (const tabId of matchedIds) {
        updateWorkspaceTab(tabId, (tab) => applyWorkspaceBrowserSessionSnapshot(tab, snapshot))
      }
    }

    return registerBrowserSessionStateHandler('generic-web', (state) => {
      setBrowserNavState((current) =>
        current?.provider === state.provider &&
        current.url === state.url &&
        current.canGoBack === state.canGoBack &&
        current.canGoForward === state.canGoForward &&
        current.isLoading === state.isLoading
          ? current
          : state,
      )
      syncSnapshotIntoTabs({ provider: 'generic-web', title: state.title, url: state.url })
    })
  }, [updateWorkspaceTab])

  useEffect(() => {
    setBrowserNavState(null)
    setBrowserPanelPhase(
      activeBrowserTab && !String(activeBrowserTab.url || '').trim() ? 'empty' : 'loading',
    )
    // Only re-seed the phase when switching tabs, not on every live URL update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBrowserTab?.id])

  useBrowserSessionSync({
    activeBrowserTab,
    workflowOpen,
    updateWorkspaceTab,
    hostLayoutInsets,
    setBrowserPanelPhase,
    lastSyncedBrowserTabIdRef,
    browserTabReattachCountRef,
  })

  const handleBrowserNavigate = useCallback(async (address: string) => {
    const tab = activeBrowserTabRef.current
    const target = String(address || '').trim()
    if (!tab || !target) return
    const request = { provider: tab.provider, profile_id: tab.profileId, host: tab.host }
    setBrowserPanelPhase('loading')
    const status = await ensureBrowserSessionWindow({ ...request, address: target }).catch(() => null)
    if (!status) {
      setBrowserPanelPhase('unavailable')
      return
    }
    lastSyncedBrowserTabIdRef.current = tab.id
    setBrowserNavState(getBrowserSessionPanelState(tab.provider, status))
    updateWorkspaceTab(tab.id, (current) =>
      applyWorkspaceBrowserSessionSnapshot(current, {
        provider: tab.provider,
        profile_id: tab.profileId,
        host: tab.host,
        title: status.page_title,
        url: status.page_url,
      }),
    )
    await setBrowserSessionHostLayout({ ...request, ...hostLayoutInsets() }).catch(() => null)
    setBrowserPanelPhase(status.panel_visible === false ? 'loading' : 'ready')
  }, [hostLayoutInsets, updateWorkspaceTab])

  const runBrowserNavCommand = useCallback(async (
    command: (request: BrowserSessionRequest) => Promise<BrowserSessionStatus>,
  ) => {
    const tab = activeBrowserTabRef.current
    if (!tab) return
    const status = await command({ provider: tab.provider, profile_id: tab.profileId, host: tab.host }).catch(() => null)
    if (!status) return
    setBrowserNavState(getBrowserSessionPanelState(tab.provider, status))
  }, [])

  const handleBrowserBack = useCallback(() => { void runBrowserNavCommand(browserSessionGoBack) }, [runBrowserNavCommand])
  const handleBrowserForward = useCallback(() => { void runBrowserNavCommand(browserSessionGoForward) }, [runBrowserNavCommand])
  const handleBrowserReload = useCallback(() => { void runBrowserNavCommand(browserSessionReload) }, [runBrowserNavCommand])
  const handleBrowserStop = useCallback(() => { void runBrowserNavCommand(browserSessionStop) }, [runBrowserNavCommand])

  const browserToolbarStatus = useMemo<WorkspaceBrowserToolbarStatus>(() => ({
    url: browserNavState?.url || String(activeBrowserTab?.url || ''),
    canGoBack: browserNavState?.canGoBack,
    canGoForward: browserNavState?.canGoForward,
    isLoading: browserNavState?.isLoading,
  }), [
    activeBrowserTab?.url,
    browserNavState?.url,
    browserNavState?.canGoBack,
    browserNavState?.canGoForward,
    browserNavState?.isLoading,
  ])

  return {
    browserPanelPhase,
    setBrowserPanelPhase,
    browserToolbarStatus,
    handleBrowserNavigate,
    handleBrowserBack,
    handleBrowserForward,
    handleBrowserReload,
    handleBrowserStop,
  }
}

type UseBrowserSessionSyncOptions = {
  activeBrowserTab: WorkspaceBrowserTab | null
  workflowOpen: boolean
  updateWorkspaceTab: UseWorkspaceBrowserPanelOptions['updateWorkspaceTab']
  hostLayoutInsets: () => { leftInset: number; topInset: number; rightInset: number }
  setBrowserPanelPhase: (phase: WorkspaceBrowserPanelPhase) => void
  lastSyncedBrowserTabIdRef: MutableRefObject<string>
  browserTabReattachCountRef: MutableRefObject<Record<string, number>>
}

/**
 * Keeps the desktop BrowserView attached to the active browser tab: attaches
 * on tab change, hides it behind the workflow workbench, mirrors page state
 * into the tab, and re-attaches (within a per-tab budget) when the desktop
 * process drops the view. Runs a poll while a browser tab is active.
 */
function useBrowserSessionSync({
  activeBrowserTab,
  workflowOpen,
  updateWorkspaceTab,
  hostLayoutInsets,
  setBrowserPanelPhase,
  lastSyncedBrowserTabIdRef,
  browserTabReattachCountRef,
}: UseBrowserSessionSyncOptions) {
  useEffect(() => {
    let cancelled = false

    const resetBrowserTabReattachBudget = (tabId: string) => {
      if (!tabId) return
      browserTabReattachCountRef.current = { ...browserTabReattachCountRef.current, [tabId]: 0 }
    }

    const refreshBrowserTabSnapshot = async () => {
      if (!activeBrowserTab) return
      const status = await getBrowserSessionStatus({
        provider: activeBrowserTab.provider,
        profile_id: activeBrowserTab.profileId,
        host: activeBrowserTab.host,
      }).catch(() => null)
      if (!status || cancelled) return
      if (status.panel_visible) {
        resetBrowserTabReattachBudget(activeBrowserTab.id)
        setBrowserPanelPhase('ready')
      }
      updateWorkspaceTab(activeBrowserTab.id, (tab) =>
        applyWorkspaceBrowserSessionSnapshot(tab, {
          provider: activeBrowserTab.provider,
          profile_id: activeBrowserTab.profileId,
          host: activeBrowserTab.host,
          title: status.page_title,
          url: status.page_url,
        }),
      )
      return status
    }

    const syncBrowserTab = async () => {
      if (workflowOpen) {
        lastSyncedBrowserTabIdRef.current = ''
        await hideBrowserSessionPanel({ provider: activeBrowserTab?.provider || 'generic-web' }).catch(() => null)
        if (!cancelled) setBrowserPanelPhase('empty')
        return
      }
      if (!activeBrowserTab) {
        lastSyncedBrowserTabIdRef.current = ''
        await hideBrowserSessionPanel({ provider: 'generic-web' }).catch(() => null)
        return
      }

      const currentStatus = await refreshBrowserTabSnapshot()
      const sameTabActive = lastSyncedBrowserTabIdRef.current === activeBrowserTab.id
      const targetURL = String(activeBrowserTab.url || '').trim()
      const liveURL = String(currentStatus?.page_url || '').trim()
      // No requested URL and no live page: keep the BrowserView detached and
      // show the empty state until the user (or agent) navigates somewhere.
      if (!targetURL && !(sameTabActive && liveURL)) {
        lastSyncedBrowserTabIdRef.current = ''
        await hideBrowserSessionPanel({ provider: activeBrowserTab.provider }).catch(() => null)
        if (!cancelled) setBrowserPanelPhase('empty')
        return
      }
      const keepLivePage = sameTabActive && Boolean(liveURL)
      const request = {
        provider: activeBrowserTab.provider,
        profile_id: activeBrowserTab.profileId,
        host: activeBrowserTab.host,
        url: resolveWorkspaceBrowserTabNavigationURL({
          tabURL: keepLivePage ? '' : activeBrowserTab.url,
          liveURL: currentStatus?.page_url,
        }),
      }
      const attachedStatus = await ensureBrowserSessionWindow(request)
      if (cancelled) return
      resetBrowserTabReattachBudget(activeBrowserTab.id)
      lastSyncedBrowserTabIdRef.current = activeBrowserTab.id
      updateWorkspaceTab(activeBrowserTab.id, (tab) =>
        applyWorkspaceBrowserSessionSnapshot(tab, {
          provider: activeBrowserTab.provider,
          profile_id: activeBrowserTab.profileId,
          host: activeBrowserTab.host,
          title: attachedStatus.page_title,
          url: attachedStatus.page_url,
        }),
      )
      await setBrowserSessionHostLayout({ ...request, ...hostLayoutInsets() })
      if (!cancelled) {
        setBrowserPanelPhase(attachedStatus.panel_visible === false ? 'loading' : 'ready')
      }
    }

    void syncBrowserTab().catch(() => {
      // The embedded browser is unavailable (for example a web build without
      // the desktop bridge): show the explanatory placeholder, not a spinner.
      if (!cancelled) setBrowserPanelPhase('unavailable')
    })

    if (workflowOpen || !activeBrowserTab) {
      return () => {
        cancelled = true
      }
    }

    const handleResize = () => {
      void syncBrowserTab().catch(() => {
        // Ignore browser tab resize sync errors.
      })
    }
    const pollTimer = window.setInterval(() => {
      void (async () => {
        const status = await refreshBrowserTabSnapshot().catch(() => null)
        if (cancelled || !activeBrowserTab) return
        if (!shouldReattachBrowserTab(activeBrowserTab, status)) return
        const reattachCount = browserTabReattachCountRef.current[activeBrowserTab.id] || 0
        if (reattachCount >= WORKSPACE_BROWSER_TAB_REATTACH_LIMIT) return
        browserTabReattachCountRef.current = {
          ...browserTabReattachCountRef.current,
          [activeBrowserTab.id]: reattachCount + 1,
        }
        await syncBrowserTab()
      })().catch(() => {
        // Ignore browser tab polling errors.
      })
    }, WORKSPACE_BROWSER_POLL_INTERVAL_MS)
    window.addEventListener('resize', handleResize)
    return () => {
      cancelled = true
      window.clearInterval(pollTimer)
      window.removeEventListener('resize', handleResize)
    }
  }, [activeBrowserTab, hostLayoutInsets, workflowOpen, updateWorkspaceTab])
}
