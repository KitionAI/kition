import { useCallback, useEffect, useRef } from 'react'

import type { AgentEvent } from '@/api/agent'
import {
  buildAgentBrowserTabPayload,
  buildBrowserAutoContinuePrompt,
  buildBrowserUnavailablePrompt,
  dispatchOpenWorkspaceBrowserTab,
  extractAgentBrowserContinuationContext,
  extractAgentWebTarget,
  findLatestBrowserContinuationRequest,
  MAX_BROWSER_AUTO_CONTINUE_ATTEMPTS,
  preflightAgentBrowserContext,
  readBrowserOpenRequest,
  type AgentBrowserOpenRequest,
  type AgentTurnContext,
  type useWorkspaceAgent,
} from '@/features/agent/public'
import type { WorkspaceBrowserPanelPhase, WorkspaceBrowserTab } from '@/features/workspace/hooks/useWorkspaceBrowserPanel'
import type { WorkspaceTableAgentContext } from '@/features/workspace/hooks/useWorkspaceTableAgentContext'
import { resolveWorkspaceBrowserHost } from '@/features/workspace/lib/browserTabs'
import { WEB_BROWSER_ENABLED } from '@/lib/productFeatures'
import type { BrowserSessionProvider } from '@/services/desktop'

type WorkspaceAgent = ReturnType<typeof useWorkspaceAgent>

type UseWorkspaceAgentBrowserAutomationOptions = {
  activeWorkspaceAgentSession: WorkspaceAgent['agentSessions'][number] | null
  agentEvents: WorkspaceAgent['agentEvents']
  agentBusySessions: WorkspaceAgent['agentBusySessions']
  sendAgentContextAction: WorkspaceAgent['sendAgentContextAction']
  activeBrowserTab: WorkspaceBrowserTab | null
  browserPanelPhase: WorkspaceBrowserPanelPhase
  setBrowserPanelPhase: (phase: WorkspaceBrowserPanelPhase) => void
  setAgentBrowserEnabled: (enabled: boolean) => void
  /** Latest task mode from the turn context; read at call time. */
  getTaskMode: () => AgentTurnContext['taskMode']
  tableAgentContext: WorkspaceTableAgentContext | null
  tableAgentDocumentPath: string
}

/**
 * The Agent side of the embedded browser: opens the tab a turn asks for
 * (`browser.open_required` events), runs the pre-turn preflight when a
 * prompt names a site, and continues a paused turn once the requested page
 * is showing, giving up after the attempt budget. Returns the preflight so
 * the Agent composer can call it before sending.
 */
export function useWorkspaceAgentBrowserAutomation({
  activeWorkspaceAgentSession,
  agentEvents,
  agentBusySessions,
  sendAgentContextAction,
  activeBrowserTab,
  browserPanelPhase,
  setBrowserPanelPhase,
  setAgentBrowserEnabled,
  getTaskMode,
  tableAgentContext,
  tableAgentDocumentPath,
}: UseWorkspaceAgentBrowserAutomationOptions) {
  const tableContextPayload = useCallback(() => ({
    activeDocument: tableAgentContext?.activeDocument ?? null,
    documentPath: tableAgentDocumentPath,
    activeTable: tableAgentContext?.activeTable ?? null,
  }), [tableAgentContext, tableAgentDocumentPath])

  const openBrowserFromRequest = useCallback((request: AgentBrowserOpenRequest) => {
    if (!WEB_BROWSER_ENABLED) return
    dispatchOpenWorkspaceBrowserTab(buildAgentBrowserTabPayload({
      provider: (request.provider as BrowserSessionProvider) || 'generic-web',
      taskMode: getTaskMode(),
      host: request.host,
      url: request.url,
      query: request.query,
      ...tableContextPayload(),
    }))
  }, [getTaskMode, tableContextPayload])

  const runPreflight = useCallback(async (content: string) => {
    if (!WEB_BROWSER_ENABLED) return undefined
    const target = extractAgentWebTarget(content)
    if (!target) return undefined
    const provider: BrowserSessionProvider = 'generic-web'
    setAgentBrowserEnabled(true)
    setBrowserPanelPhase('loading')
    dispatchOpenWorkspaceBrowserTab(buildAgentBrowserTabPayload({
      provider,
      taskMode: getTaskMode(),
      host: target.host,
      url: target.url,
      ...tableContextPayload(),
    }))
    const context = await preflightAgentBrowserContext({ target, provider })
    setBrowserPanelPhase('ready')
    return context
  }, [getTaskMode, setAgentBrowserEnabled, setBrowserPanelPhase, tableContextPayload])

  // Auto-open: the first view of a session seeds the handled id, so opening,
  // switching, or reloading never reopens a historical handoff. Only events
  // that arrive live open a tab.
  const autoOpenSessionRef = useRef<number | null>(null)
  const autoOpenEventIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (!activeWorkspaceAgentSession) return
    const sessionId = activeWorkspaceAgentSession.id
    let latest: AgentEvent | null = null
    for (const event of agentEvents[sessionId] || []) {
      if (event.event_type === 'browser.open_required') latest = event
    }
    const latestId = latest ? latest.id : null
    if (autoOpenSessionRef.current !== sessionId) {
      autoOpenSessionRef.current = sessionId
      autoOpenEventIdRef.current = latestId
      return
    }
    if (!latest || autoOpenEventIdRef.current === latestId) return
    autoOpenEventIdRef.current = latestId
    openBrowserFromRequest(readBrowserOpenRequest(latest))
  }, [activeWorkspaceAgentSession, agentEvents, openBrowserFromRequest])

  // Auto-continue: once the requested page is showing (or the browser is
  // known to be unavailable), answer the paused turn exactly once per event.
  const autoContinueEventKeysRef = useRef(new Set<string>())
  useEffect(() => {
    if (
      !activeWorkspaceAgentSession
      || !activeBrowserTab
      || (browserPanelPhase !== 'ready' && browserPanelPhase !== 'unavailable')
      || agentBusySessions.has(activeWorkspaceAgentSession.id)
    ) {
      return
    }
    const sessionId = activeWorkspaceAgentSession.id
    const continuation = findLatestBrowserContinuationRequest(agentEvents[sessionId] || [])
    if (!continuation) return
    const { eventId: latestEventId, request: latestRequest } = continuation
    const eventKey = `${sessionId}:${latestEventId}`
    if (autoContinueEventKeysRef.current.has(eventKey)) return
    const requestedHost = resolveWorkspaceBrowserHost({ host: latestRequest.host, url: latestRequest.url })
    const activeHost = resolveWorkspaceBrowserHost(activeBrowserTab)
    if (requestedHost && requestedHost !== activeHost) return

    autoContinueEventKeysRef.current.add(eventKey)
    setAgentBrowserEnabled(true)
    const originalRequest = latestRequest.originalRequest || ''
    const attempt = latestRequest.autoContinueAttempt || 1
    const giveUp = () => sendAgentContextAction(sessionId, {
      content: buildBrowserUnavailablePrompt(originalRequest),
      browserAutoContinue: true,
      browserAutoContinueAttempt: attempt,
      browserAutoContinueFinal: true,
      browserOriginalRequest: originalRequest,
    })
    if (
      browserPanelPhase !== 'ready'
      || latestRequest.autoContinueExhausted
      || attempt > MAX_BROWSER_AUTO_CONTINUE_ATTEMPTS
    ) {
      giveUp()
      return
    }
    void extractAgentBrowserContinuationContext({
      target: { provider: activeBrowserTab.provider, profileId: activeBrowserTab.profileId, host: activeBrowserTab.host },
      request: latestRequest,
    }).then((browserContext) => {
      sendAgentContextAction(sessionId, {
        content: buildBrowserAutoContinuePrompt(originalRequest),
        browserAutoContinue: true,
        browserAutoContinueAttempt: attempt,
        browserOriginalRequest: originalRequest,
        browserContext,
      })
    }).catch(giveUp)
  }, [
    activeBrowserTab,
    activeWorkspaceAgentSession,
    agentBusySessions,
    agentEvents,
    browserPanelPhase,
    sendAgentContextAction,
    setAgentBrowserEnabled,
  ])

  return { runPreflight }
}
