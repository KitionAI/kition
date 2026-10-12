import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import i18next from 'i18next'
import type {
  AgentExecutionMode,
  AgentLocalSource,
  AgentSession,
  AgentShellApprovalDecision,
  AgentShellApprovalRequest,
  AgentShellApprovalResponse,
  AgentTablePlanContext,
  AgentPaneContext,
  AgentTaskMode,
} from '@/api/agent'
import {
  createAgentSession,
  deleteAgentSession,
  listAgentSessionEvents,
  listAgentSessions,
  streamAgentMessage,
} from '@/api/agent'
import { AgentStreamInterruptedError, type AgentStreamNotification } from '@/api/agentStream'
import {
  applySessionEvent,
  applyStatus,
  emptyAgentSessionView,
  markInterrupted,
  type AgentSessionView,
} from '@/features/agent/lib/agentSessionView'
import { stepAgentSession, type AgentEffect } from '@/features/agent/lib/agentEventEffects'
import { getCurrentLocale, getLanguageNameForLocale } from '@/i18n'
import {
  buildAgentDocumentMentionPromptContext,
  extractAgentDocumentMentionTokens,
  flattenMentionableWorkspaceDocuments,
  isBinaryAttachmentMention,
  resolveAgentDocumentMentions,
  type AgentMentionableDocument,
} from '@/features/agent/lib/documentMentions'
import { resolveAgentDocumentTarget } from '@/features/agent/lib/agentDocumentTargeting'
import {
  normalizeAgentDocumentContextPaths,
  readAgentDocumentContextsForWorkspace,
  resolveAgentDocumentContextPath,
  resolveAgentDocumentContextPaths,
  writeAgentDocumentContextsForSession,
  type AgentDocumentContextPaths,
} from '@/features/agent/lib/agentDocumentContexts'
import {
  readAgentLocalSourcesForWorkspace,
  writeAgentLocalSourcesForSession,
} from '@/features/agent/lib/agentLocalSources'
import {
  buildAgentModelOptions,
  resolveAgentModelKey,
} from '@/features/agent/lib/agentConfig'
import {
  buildAgentDocumentEditingPromptContext,
  prepareAgentDocumentForTurn,
} from '@/features/agent/lib/agentDocumentEditing'
import { ensurePortalAccountSessionRestored } from '@/services/portalAccount'
import {
  isDesktopRuntime,
  listWorkspaceDocuments,
  type WorkspaceDocumentFormat,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import { saveDesktopSettings } from '@/services/desktopSettings'
import { notifyFromAgentEvent } from '@/services/desktopNotifications'
import type { DesktopSettingsState } from '@/types/desktopSettings'
import type {
  AgentImageGenerationIntent,
} from '@/types/imageGeneration'
import type { AgentWhiteboardContext } from '@/types/whiteboardAgent'
import type { AgentWhiteboardPatch } from '@/types/whiteboardAgent'
import { trackProductEventOnce } from '@/features/analytics/lib/productAnalytics'
import { isWebPreviewMode } from '@/lib/runtimeMode'
import {
  buildCompletedTableFileImportPromptContext,
  isTableFileImportRequest,
} from '@/features/agent/lib/tableFileImportIntent'
import { importWorkspaceFileIntoDataTable } from '@/features/table/lib/importWorkspaceFileIntoDataTable'
import { buildAgentShellApprovalFollowup } from '@/features/agent/lib/agentShellApproval'
import { retryWhileSessionBusy } from '@/features/agent/lib/agentSendRetry'
import type { AgentDesignContext, AgentDesignPatch } from '@/types/designAgent'
import type { MarkdownImageInsertionContext } from '@/features/document/editor/editor/markdown-image-insertion'

type WorkspaceAgentTurnContext = {
  activeDocumentPath?: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  activeDataDocumentId?: number | null
  activeDataTableId?: number | null
  taskMode?: AgentTaskMode
  /** Active workbench tab type. Forwarded to streamAgentMessage so the
   *  backend can swap pane-specific instructions in the system prompt
   *  (e.g. don't suggest document_write when the pane is a workflow
   *  editor). Defaults to "document" upstream when omitted. */
  paneContext?: AgentPaneContext
  /** Workflow id (when pane is workflow) so the backend can inject a
   *  compact trigger/action/bound-table summary into the skill
   *  context. Frontend reads this from the active workflow tab. */
  activeWorkflowId?: string
  whiteboardContext?: AgentWhiteboardContext
  designContext?: AgentDesignContext
  markdownImageInsertionContext?: MarkdownImageInsertionContext
}

type UseWorkspaceAgentOptions = {
  settings: DesktopSettingsState
  rootPath: string
  workspaceTreeItems?: WorkspaceDocumentTreeItem[]
  onError: (message: string) => void
  onFeedback: (message: string) => void
  ensureHostedAccountReady?: () => Promise<boolean>
  onSettingsSaved?: (settings: DesktopSettingsState) => void
  onWorkspaceArtifactsSaved?: (sessionId: number) => Promise<void>
  onWorkspaceDocumentsModified?: (paths: string[], sessionId: number) => void | Promise<void>
  onTableMutated?: () => void | Promise<void>
  onWhiteboardPatch?: (input: {
    boardPath: string
    patch: AgentWhiteboardPatch
    provisional: boolean
    sessionId: number
  }) => void
  onWhiteboardPatchCancelled?: (input: {
    boardPath: string
    sessionId: number
  }) => void
  onDesignPatch?: (input: {
    designPath: string
    patch: AgentDesignPatch
    provisional: boolean
    sessionId: number
  }) => void
  onDesignPatchCancelled?: (input: { designPath: string; sessionId: number }) => void
  prepareActiveDocument?: () => Promise<boolean>
  silentInitialSessionLoad?: boolean
  getTurnContext?: () =>
    | WorkspaceAgentTurnContext
    | null
    | undefined
    | Promise<WorkspaceAgentTurnContext | null | undefined>
}

/**
 * One page of `GET /session-events` at most; a shorter page is the end of the
 * log. The contract states it as the page's `maxItems` (generated types carry
 * no value) and the runtime as `EVENT_PAGE_LIMIT` in `kition-agent`'s `log.rs`.
 */
const SESSION_EVENTS_PAGE = 500

/** The desktop notification a live session event raises. */
function notificationOf(notification: AgentStreamNotification) {
  if (notification.method !== 'session.event') return null
  const { event } = notification.params
  const t = (key: string) => i18next.t(key, { ns: 'agent' })
  if (event.type === 'approval/asked') {
    return { event_type: 'user.input_needed', label: event.reason || '' }
  }
  if (event.type !== 'turn/end') return null
  if (event.reason === 'completed') return { event_type: 'task.completed', label: t('timeline.event.taskCompleted') }
  if (event.reason === 'failed' || event.reason === 'step-limit') {
    return { event_type: 'task.failed', label: event.error || t('timeline.event.taskFailed') }
  }
  return null
}

export function useWorkspaceAgent({
  settings,
  rootPath,
  workspaceTreeItems,
  onError,
  onFeedback,
  ensureHostedAccountReady,
  onSettingsSaved,
  onWorkspaceArtifactsSaved,
  onWorkspaceDocumentsModified,
  onTableMutated,
  onWhiteboardPatch,
  onWhiteboardPatchCancelled,
  onDesignPatch,
  onDesignPatchCancelled,
  prepareActiveDocument,
  silentInitialSessionLoad = !isDesktopRuntime(),
  getTurnContext,
}: UseWorkspaceAgentOptions) {
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([])
  const agentSessionsRevisionRef = useRef(0)
  // Each session's view, reduced from its session events and live stream.
  // The ref is the source of truth so notifications reduce in arrival order
  // outside React's updaters; state mirrors it for rendering.
  const [agentSessionViews, setAgentSessionViews] = useState<Record<number, AgentSessionView>>({})
  const agentSessionViewsRef = useRef<Record<number, AgentSessionView>>({})
  const agentSessionSyncs = useRef<Map<number, Promise<void>>>(new Map())
  // The text a visible send shows until its `user/message` arrives.
  const [agentPendingUserText, setAgentPendingUserText] = useState<Record<number, string>>({})
  const [agentDrafts, setAgentDrafts] = useState<Record<number, string>>({})
  const [agentModifiedDocumentPaths, setAgentModifiedDocumentPaths] = useState<Set<string>>(new Set())
  // Per-session busy set. Was `agentBusySessionId: number | null` until
  // we hit the cross-session silent-skip: a stale id from session A
  // satisfied the "if (agentBusySessionId)" guard in sendAgentMessage,
  // so a click on Send in session B fell through with no POST and no
  // loading/error feedback because the button's `busy` check was
  // per-session and stayed false on B. Tracking busy per-session lets
  // independent chat tabs run concurrently AND keeps the disabled /
  // stop affordance scoped to the session that actually has a stream
  // in flight.
  const [agentBusySessions, setAgentBusySessions] = useState<Set<number>>(() => new Set())
  const markSessionBusy = useCallback((sessionId: number, busy: boolean) => {
    setAgentBusySessions((current) => {
      if (busy ? current.has(sessionId) : !current.has(sessionId)) return current
      const next = new Set(current)
      if (busy) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }, [])
  const [pendingFocusedSessionId, setPendingFocusedSessionId] = useState<number | null>(null)
  const [selectedAgentModelKey, setSelectedAgentModelKey] = useState('')
  const [fallbackMentionableDocuments, setFallbackMentionableDocuments] = useState<AgentMentionableDocument[]>([])
  const liveMentionableDocuments = useMemo(
    () => workspaceTreeItems === undefined
      ? []
      : flattenMentionableWorkspaceDocuments(workspaceTreeItems),
    [workspaceTreeItems],
  )
  const mentionableDocuments = workspaceTreeItems === undefined
    ? fallbackMentionableDocuments
    : liveMentionableDocuments
  const [agentLocalSources, setAgentLocalSources] = useState<Record<number, AgentLocalSource[]>>({})
  const [agentDocumentContexts, setAgentDocumentContexts] = useState<
    Record<number, AgentDocumentContextPaths>
  >({})
  const agentDocumentContextsRef = useRef<Record<number, AgentDocumentContextPaths>>({})
  const agentAbortControllers = useRef<Record<number, AbortController>>({})
  const agentSendInFlightSessions = useRef<Set<number>>(new Set())
  // The delayed log read after Stop, per session; cleared when the session
  // or the workspace goes away.
  const agentResyncTimers = useRef<Map<number, number>>(new Map())
  const clearResyncTimers = useCallback((sessionId?: number) => {
    for (const [id, timer] of agentResyncTimers.current) {
      if (sessionId !== undefined && id !== sessionId) continue
      window.clearTimeout(timer)
      agentResyncTimers.current.delete(id)
    }
  }, [])
  useEffect(() => () => clearResyncTimers(), [clearResyncTimers])

  const commitSessionView = useCallback((sessionId: number, view: AgentSessionView) => {
    if (agentSessionViewsRef.current[sessionId] === view) return
    agentSessionViewsRef.current = { ...agentSessionViewsRef.current, [sessionId]: view }
    setAgentSessionViews(agentSessionViewsRef.current)
  }, [])

  const dropSessionView = useCallback((sessionId: number) => {
    if (!(sessionId in agentSessionViewsRef.current)) return
    const next = { ...agentSessionViewsRef.current }
    delete next[sessionId]
    agentSessionViewsRef.current = next
    setAgentSessionViews(next)
  }, [])

  const setPendingUserText = useCallback((sessionId: number, text: string) => {
    setAgentPendingUserText((current) => {
      if ((current[sessionId] || '') === text) return current
      const next = { ...current }
      if (text) next[sessionId] = text
      else delete next[sessionId]
      return next
    })
  }, [])

  /**
   * Reads the session log after the view's cursor, page by page, into the
   * view. Synced events fire no effects: they already happened. One read
   * per session runs at a time; a second call joins it.
   */
  const syncSessionEvents = useCallback((sessionId: number) => {
    const running = agentSessionSyncs.current.get(sessionId)
    if (running) return running
    const sync = (async () => {
      for (;;) {
        const cursor = (agentSessionViewsRef.current[sessionId] ?? emptyAgentSessionView()).cursor
        const page = await listAgentSessionEvents(sessionId, cursor)
        const items = page.items || []
        const view = items.reduce(applySessionEvent, agentSessionViewsRef.current[sessionId] ?? emptyAgentSessionView())
        commitSessionView(sessionId, view)
        if (items.length < SESSION_EVENTS_PAGE || view.cursor === cursor) return
      }
    })().finally(() => agentSessionSyncs.current.delete(sessionId))
    agentSessionSyncs.current.set(sessionId, sync)
    return sync
  }, [commitSessionView])

  const agentModelOptions = useMemo(() => buildAgentModelOptions(settings), [settings])
  const resolvedAgentModelKey = useMemo(
    () => resolveAgentModelKey(settings, agentModelOptions, selectedAgentModelKey),
    [agentModelOptions, selectedAgentModelKey, settings],
  )
  const selectedAgentModel = agentModelOptions.find((option) => option.key === resolvedAgentModelKey) || null

  const setAgentDraft = useCallback((sessionId: number, value: string) => {
    setAgentDrafts((current) => ({ ...current, [sessionId]: value }))
  }, [])

  const addAgentDocumentContext = useCallback((
    sessionId: number,
    path: string,
    automaticPath = '',
  ) => {
    const normalizedPath = String(path || '').trim()
    if (!normalizedPath) {
      return
    }
    const existing = Object.prototype.hasOwnProperty.call(
      agentDocumentContextsRef.current,
      sessionId,
    )
      ? agentDocumentContextsRef.current[sessionId] || []
      : normalizeAgentDocumentContextPaths([automaticPath])
    const nextPaths = normalizeAgentDocumentContextPaths([...existing, normalizedPath])
    const next = { ...agentDocumentContextsRef.current, [sessionId]: nextPaths }
    agentDocumentContextsRef.current = next
    setAgentDocumentContexts(next)
    writeAgentDocumentContextsForSession(rootPath, sessionId, nextPaths)
  }, [rootPath])

  const removeAgentDocumentContext = useCallback((sessionId: number, path: string) => {
    const normalizedPath = String(path || '').trim()
    const nextPaths = (agentDocumentContextsRef.current[sessionId] || []).filter(
      (candidate) => candidate !== normalizedPath,
    )
    const next = { ...agentDocumentContextsRef.current, [sessionId]: nextPaths }
    agentDocumentContextsRef.current = next
    setAgentDocumentContexts(next)
    writeAgentDocumentContextsForSession(rootPath, sessionId, nextPaths)
  }, [rootPath])

  const resolveAgentDocumentContext = useCallback((sessionId: number, automaticPath: string) => (
    resolveAgentDocumentContextPath(agentDocumentContexts, sessionId, automaticPath)
  ), [agentDocumentContexts])

  const resolveAgentDocumentContexts = useCallback((sessionId: number, automaticPath: string) => (
    resolveAgentDocumentContextPaths(agentDocumentContexts, sessionId, automaticPath)
  ), [agentDocumentContexts])

  const addAgentLocalSource = useCallback((sessionId: number, source: AgentLocalSource) => {
    setAgentLocalSources((current) => {
      const existing = current[sessionId] || []
      if (existing.some((item) => item.root_path === source.root_path)) {
        return current
      }
      const nextSources = [...existing, source].slice(0, 8)
      writeAgentLocalSourcesForSession(rootPath, sessionId, nextSources)
      return { ...current, [sessionId]: nextSources }
    })
  }, [rootPath])

  const removeAgentLocalSource = useCallback((sessionId: number, sourceId: string) => {
    setAgentLocalSources((current) => {
      const nextSources = (current[sessionId] || []).filter((item) => item.id !== sourceId)
      if (nextSources.length === (current[sessionId] || []).length) {
        return current
      }
      if (nextSources.length) {
        writeAgentLocalSourcesForSession(rootPath, sessionId, nextSources)
        return { ...current, [sessionId]: nextSources }
      }
      writeAgentLocalSourcesForSession(rootPath, sessionId, [])
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [rootPath])

  const refreshMentionableDocuments = useCallback(async () => {
    try {
      const response = await listWorkspaceDocuments()
      setFallbackMentionableDocuments(flattenMentionableWorkspaceDocuments(response.items || []))
    } catch {
      setFallbackMentionableDocuments([])
    }
  }, [])

  const clearModifiedDocumentPath = useCallback((path: string) => {
    if (!path) {
      return
    }

    setAgentModifiedDocumentPaths((current) => {
      if (!current.has(path)) {
        return current
      }
      const next = new Set(current)
      next.delete(path)
      return next
    })
  }, [])

  const handleAgentModelChange = useCallback(async (value: string) => {
    setSelectedAgentModelKey(value)
    const option = agentModelOptions.find((item) => item.key === value)
    if (!option) {
      return
    }

    const next = structuredClone(settings)
    next.models.activeProvider = option.providerKind
    next.models.selectedModelByProvider[option.providerKind] = option.modelName
    const saved = await saveDesktopSettings(next)
    onSettingsSaved?.(saved)
  }, [agentModelOptions, onSettingsSaved, settings])

  const refreshAgentSessions = useCallback(async (
    preferredSessionId?: number,
    options: { silent?: boolean } = {},
  ) => {
    const revisionAtStart = agentSessionsRevisionRef.current
    try {
      const response = await listAgentSessions()
      if (agentSessionsRevisionRef.current !== revisionAtStart) {
        return
      }
      const sessions = response.items || []
      setAgentSessions(sessions)
      if (preferredSessionId) {
        setPendingFocusedSessionId(preferredSessionId)
      }
    } catch (requestError: any) {
      if (!options.silent) {
        onError(requestError?.message || 'Failed to load agent sessions')
      }
    }
  }, [onError])

  // Reset every per-session cache when the workspace root changes so the
  // right-side chat tab bar (and downstream state) tracks the active
  // workspace. Backend listSessions already filters by workspace_root, but
  // WorkspaceScreen doesn't remount on workspace switch — without this reset
  // the previous workspace's sessions/messages/streams stay in React state
  // until the user manually closes them. Initial mount also goes through
  // here, so we drop the redundant mount-time refresh from the caller.
  const lastLoadedRootPathRef = useRef<string | null>(null)
  useEffect(() => {
    const nextRoot = rootPath || ''
    if (lastLoadedRootPathRef.current === nextRoot) {
      return
    }
    lastLoadedRootPathRef.current = nextRoot
    agentSessionsRevisionRef.current += 1

    for (const controller of Object.values(agentAbortControllers.current)) {
      controller?.abort()
    }
    agentAbortControllers.current = {}
    agentSendInFlightSessions.current.clear()
    clearResyncTimers()

    setAgentSessions([])
    agentSessionViewsRef.current = {}
    agentSessionSyncs.current.clear()
    setAgentSessionViews({})
    setAgentPendingUserText({})
    setAgentDrafts({})
    setAgentModifiedDocumentPaths(new Set())
    setAgentBusySessions(new Set())
    setPendingFocusedSessionId(null)
    setFallbackMentionableDocuments([])
    setAgentLocalSources(readAgentLocalSourcesForWorkspace(nextRoot))
    const nextDocumentContexts = readAgentDocumentContextsForWorkspace(nextRoot)
    agentDocumentContextsRef.current = nextDocumentContexts
    setAgentDocumentContexts(nextDocumentContexts)

    if (!nextRoot || isWebPreviewMode()) {
      return
    }
    void refreshAgentSessions(undefined, { silent: silentInitialSessionLoad })
    if (workspaceTreeItems === undefined) {
      void refreshMentionableDocuments()
    }
  }, [clearResyncTimers, refreshAgentSessions, refreshMentionableDocuments, rootPath, silentInitialSessionLoad, workspaceTreeItems])

  const openAgentSession = useCallback(async (session: AgentSession) => {
    if (agentSessionViewsRef.current[session.id]) return
    try {
      await syncSessionEvents(session.id)
    } catch (requestError: any) {
      onError(requestError?.message || 'Failed to load agent messages')
    }
  }, [onError, syncSessionEvents])

  const createNewAgentChat = useCallback(async (options?: {
    focusTab?: boolean
    documentPaths?: string[]
  }) => {
    onError('')
    onFeedback('')

    try {
      const session = await createAgentSession()
      agentSessionsRevisionRef.current += 1
      setAgentSessions((current) => [session, ...current.filter((item) => item.id !== session.id)])
      commitSessionView(session.id, emptyAgentSessionView())
      const initialDocumentPaths = normalizeAgentDocumentContextPaths(options?.documentPaths || [])
      if (initialDocumentPaths.length) {
        const next = {
          ...agentDocumentContextsRef.current,
          [session.id]: initialDocumentPaths,
        }
        agentDocumentContextsRef.current = next
        setAgentDocumentContexts(next)
        writeAgentDocumentContextsForSession(rootPath, session.id, initialDocumentPaths)
      }
      if (options?.focusTab) {
        setPendingFocusedSessionId(session.id)
      }
      return session
    } catch (requestError: any) {
      onError(requestError?.message || 'Failed to create agent session')
      return null
    }
  }, [commitSessionView, onError, onFeedback, rootPath])

  const deleteAgentChat = useCallback(async (sessionId: number) => {
    agentAbortControllers.current[sessionId]?.abort()
    delete agentAbortControllers.current[sessionId]
    clearResyncTimers(sessionId)

    try {
      await deleteAgentSession(sessionId)
    } catch (requestError: any) {
      onError(requestError?.message || 'Failed to delete agent session')
      return
    }

    agentSessionsRevisionRef.current += 1
    setAgentSessions((current) => current.filter((item) => item.id !== sessionId))
    const dropSession = <T,>(current: Record<number, T>) => {
      if (!(sessionId in current)) {
        return current
      }
      const next = { ...current }
      delete next[sessionId]
      return next
    }
    dropSessionView(sessionId)
    setAgentPendingUserText(dropSession)
    setAgentDrafts(dropSession)
    setAgentLocalSources(dropSession)
    setAgentDocumentContexts((current) => {
      const next = dropSession(current)
      agentDocumentContextsRef.current = next
      return next
    })
    writeAgentLocalSourcesForSession(rootPath, sessionId, [])
    writeAgentDocumentContextsForSession(rootPath, sessionId, undefined)
    agentSendInFlightSessions.current.delete(sessionId)
    markSessionBusy(sessionId, false)
  }, [clearResyncTimers, dropSessionView, markSessionBusy, onError, rootPath])

  const markAgentModifiedDocuments = useCallback((paths: string[], sessionId: number) => {
    setAgentModifiedDocumentPaths((current) => {
      const next = new Set(current)
      paths.forEach((path) => next.add(path))
      return next
    })
    void onWorkspaceDocumentsModified?.(paths, sessionId)
  }, [onWorkspaceDocumentsModified])

  const sendAgentMessage = useCallback(async (
    sessionId: number,
    followup?: {
      content?: string
      hideUserMessage?: boolean
      executionMode?: AgentExecutionMode
      tablePlanContext?: AgentTablePlanContext
      imageGenerationIntent?: AgentImageGenerationIntent
      localSources?: AgentLocalSource[]
      shellApproval?: AgentShellApprovalResponse
    },
  ) => {
    const content = (followup?.content ?? agentDrafts[sessionId] ?? '').trim()
    // Block double-sends for THIS session only — other sessions remain
    // free to run independently. The bare `if (agentBusySessionId)`
    // form was the cross-session silent-skip bug; a click on another
    // session's Send fell through here with no POST and no feedback.
    if (
      !content ||
      agentBusySessions.has(sessionId) ||
      agentSendInFlightSessions.current.has(sessionId)
    ) {
      return
    }

    const runtimeModel = selectedAgentModel?.runtimeModel
    if (!runtimeModel || !selectedAgentModel) {
      onError('Select and configure a text model in Settings before using the agent.')
      return
    }
    agentSendInFlightSessions.current.add(sessionId)

    const documentPrepared = await prepareAgentDocumentForTurn({
      prepare: agentDocumentContextsRef.current[sessionId]?.length === 0
        ? undefined
        : prepareActiveDocument,
      onError,
    })
    if (!documentPrepared) {
      agentSendInFlightSessions.current.delete(sessionId)
      return
    }

    setAgentDrafts((current) => ({
      ...current,
      [sessionId]: current[sessionId]?.trim() === content ? '' : current[sessionId] || '',
    }))
    if (!followup?.hideUserMessage) setPendingUserText(sessionId, content)
    onError('')
    onFeedback('')

    const rollbackPendingSend = () => {
      setPendingUserText(sessionId, '')
      if (followup?.content === undefined) {
        setAgentDrafts((current) => ({
          ...current,
          [sessionId]: current[sessionId]?.trim() ? current[sessionId] : content,
        }))
      }
    }

    if (selectedAgentModel.providerKind === 'kition_console') {
      try {
        if (ensureHostedAccountReady) {
          const ready = await ensureHostedAccountReady()
          if (!ready) {
            agentSendInFlightSessions.current.delete(sessionId)
            rollbackPendingSend()
            return
          }
        } else {
          await ensurePortalAccountSessionRestored()
        }
      } catch (error) {
        agentSendInFlightSessions.current.delete(sessionId)
        rollbackPendingSend()
        onError(error instanceof Error ? error.message : 'Sign in to Kition before using Kition Cloud models.')
        return
      }
    }
    markSessionBusy(sessionId, true)
    trackProductEventOnce('agent_first_request_started')
    // Catch up with the log first, so live events continue from its end.
    await syncSessionEvents(sessionId).catch(() => undefined)

    const abortController = new AbortController()
    agentAbortControllers.current[sessionId] = abortController
    let tableMutated = false
    let documentsChanged = false
    let whiteboardPathForTurn = ''
    let designPathForTurn = ''
    // Whether a provisional preview is on the canvas. A final patch waits
    // for Accept, so a failed or stopped stream cancels only a preview.
    let whiteboardPreviewOpen = false
    let designPreviewOpen = false

    const runEffect = (effect: AgentEffect) => {
      switch (effect.type) {
        case 'documents-modified':
          documentsChanged = true
          markAgentModifiedDocuments(effect.paths, sessionId)
          return
        case 'deliverables-saved':
          // Refresh the tree as soon as a file is saved, so the sidebar shows
          // it even if the turn later fails.
          void onWorkspaceArtifactsSaved?.(sessionId)
          void refreshMentionableDocuments()
          return
        case 'table-mutated':
          tableMutated = true
          return
        case 'connections-changed':
          // The workflow drawer refreshes its connection list on this signal.
          window.dispatchEvent(new CustomEvent('kition:connections:changed', { detail: effect.detail }))
          return
        case 'whiteboard-patch':
          whiteboardPreviewOpen = effect.provisional
          if (whiteboardPathForTurn) {
            onWhiteboardPatch?.({ boardPath: whiteboardPathForTurn, patch: effect.patch, provisional: effect.provisional, sessionId })
          }
          return
        case 'whiteboard-patch-cancelled':
          whiteboardPreviewOpen = false
          if (whiteboardPathForTurn) onWhiteboardPatchCancelled?.({ boardPath: whiteboardPathForTurn, sessionId })
          return
        case 'design-patch':
          designPreviewOpen = effect.provisional
          if (designPathForTurn) {
            onDesignPatch?.({ designPath: designPathForTurn, patch: effect.patch, provisional: effect.provisional, sessionId })
          }
          return
        case 'design-patch-cancelled':
          designPreviewOpen = false
          if (designPathForTurn) onDesignPatchCancelled?.({ designPath: designPathForTurn, sessionId })
      }
    }

    const onNotification = (notification: AgentStreamNotification) => {
      const before = agentSessionViewsRef.current[sessionId] ?? emptyAgentSessionView()
      const step = stepAgentSession(before, notification)
      if (step.gap) {
        // Events went missing: read the log, then follow the stream again.
        void syncSessionEvents(sessionId).catch(() => undefined)
        return
      }
      commitSessionView(sessionId, step.view)
      if (notification.method === 'session.event' && notification.params.event.type === 'user/message') {
        setPendingUserText(sessionId, '')
      }
      step.effects.forEach(runEffect)
      const desktopNotification = step.view.cursor > before.cursor ? notificationOf(notification) : null
      if (desktopNotification) void notifyFromAgentEvent(desktopNotification)
    }

    try {
      const turnContext = (await getTurnContext?.()) || undefined
      whiteboardPathForTurn = String(
        turnContext?.whiteboardContext?.board.path || '',
      ).trim()
      designPathForTurn = String(turnContext?.designContext?.design.path || '').trim()
      const automaticActiveDocumentPath = String(turnContext?.activeDocumentPath || '').trim()
      const documentContextPaths = resolveAgentDocumentContextPaths(
        agentDocumentContextsRef.current,
        sessionId,
        automaticActiveDocumentPath,
      )
      const draftMentionTokens = extractAgentDocumentMentionTokens(content)
      const mentionTokens = Array.from(new Set([
        ...draftMentionTokens,
        ...documentContextPaths,
      ]))
      let availableMentionableDocuments = mentionableDocuments
      if (mentionTokens.length && !availableMentionableDocuments.length) {
        try {
          const response = await listWorkspaceDocuments()
          availableMentionableDocuments = flattenMentionableWorkspaceDocuments(response.items || [])
          setFallbackMentionableDocuments(availableMentionableDocuments)
        } catch {
          availableMentionableDocuments = []
        }
      }
      const documentsByPath = new Map(
        availableMentionableDocuments.map((document) => [document.path, document]),
      )
      const activeDocumentPath = documentContextPaths.find((path) => (
        path === automaticActiveDocumentPath || documentsByPath.get(path)?.kind !== 'folder'
      )) || ''
      const contextReferencePaths = documentContextPaths.filter(
        (path) => path !== activeDocumentPath,
      )
      const activeDocumentFormat = activeDocumentPath === automaticActiveDocumentPath
        ? turnContext?.activeDocumentFormat
        : documentsByPath.get(activeDocumentPath)?.format
      const mentionResolution = resolveAgentDocumentMentions({
        content: [
          content,
          ...contextReferencePaths.map((path) => `@{${path}}`),
        ].join('\n'),
        documents: availableMentionableDocuments,
      })
      const referencedImportFile = mentionResolution.resolved.find((document) => (
        document.kind === 'file'
        && /\.(?:csv|tsv|xlsx|xls)$/i.test(document.path)
      ))
      const shouldImportReferencedFile = followup?.hideUserMessage !== true
        && turnContext?.paneContext === 'table'
        && Number(turnContext.activeDataDocumentId) > 0
        && Number(turnContext.activeDataTableId) > 0
        && referencedImportFile
        && isTableFileImportRequest(content)
      let promptContext = buildAgentDocumentMentionPromptContext({
        activeDocumentPath,
        activeDocumentFormat,
        referencedDocuments: shouldImportReferencedFile
          ? mentionResolution.resolved.filter((document) => document.path !== referencedImportFile.path)
          : mentionResolution.resolved,
        unresolvedTokens: mentionResolution.unresolved,
      })
      promptContext = [
        promptContext,
        buildAgentDocumentEditingPromptContext({
          activeDocumentPath,
          activeDocumentFormat,
          markdownImageInsertionContext: turnContext?.markdownImageInsertionContext,
        }),
      ].filter(Boolean).join('\n\n')
      let executionMode = followup?.executionMode
      if (shouldImportReferencedFile && referencedImportFile) {
        const imported = await importWorkspaceFileIntoDataTable({
          documentId: Number(turnContext?.activeDataDocumentId),
          path: referencedImportFile.path,
          tableId: Number(turnContext?.activeDataTableId),
        })
        tableMutated = true
        executionMode = 'preview'
        promptContext = [
          promptContext,
          buildCompletedTableFileImportPromptContext({
            fieldCount: imported.fieldCount,
            fields: imported.inferredFields,
            path: referencedImportFile.path,
            recordCount: imported.created,
          }),
        ].filter(Boolean).join('\n\n')
        onFeedback(`Imported ${imported.created} records with ${imported.fieldCount} fields`)
      }
      const attachmentPaths = Array.from(new Set([
        ...(isBinaryAttachmentMention(activeDocumentFormat, activeDocumentPath)
          ? [activeDocumentPath]
          : []),
        ...mentionResolution.resolved
          .filter(
            (document) => document.kind !== 'folder'
              && isBinaryAttachmentMention(document.format, document.path)
              && document.path !== referencedImportFile?.path,
          )
          .map((document) => document.path),
      ]))
      const { requestActiveDocumentPath, saveMarkdown } =
        resolveAgentDocumentTarget({
          currentDocumentPath: activeDocumentPath,
          referencedDocuments: mentionResolution.resolved,
          bindDocumentContext: Boolean(activeDocumentPath),
          allowSaveMarkdown: true,
        })

      await retryWhileSessionBusy(() => streamAgentMessage({
        sessionId,
        content,
        promptContext,
        attachmentPaths,
        localSources: followup?.localSources ?? agentLocalSources[sessionId] ?? [],
        activeDocumentPath: requestActiveDocumentPath,
        activeDataDocumentId: turnContext?.activeDataDocumentId ?? 0,
        activeDataTableId: turnContext?.activeDataTableId ?? 0,
        activeWorkflowId: turnContext?.activeWorkflowId,
        paneContext: turnContext?.paneContext,
        whiteboardContext: turnContext?.whiteboardContext,
        designContext: turnContext?.designContext,
        taskMode: turnContext?.taskMode,
        imageGenerationIntent: followup?.imageGenerationIntent,
        executionMode,
        tablePlanContext: followup?.tablePlanContext,
        shellApproval: followup?.shellApproval,
        hideUserMessage: followup?.hideUserMessage === true,
        modelId: selectedAgentModel.key,
        runtimeModel,
        saveMarkdown,
        language: getLanguageNameForLocale(getCurrentLocale()),
        signal: abortController.signal,
        onNotification,
      }), { signal: abortController.signal })

      if (tableMutated) {
        await onTableMutated?.()
      }
      if (tableMutated || documentsChanged) {
        await refreshMentionableDocuments()
      }
      void refreshAgentSessions(undefined, { silent: true })
      setPendingFocusedSessionId(sessionId)
      const delivered = agentSessionViewsRef.current[sessionId]?.turns.at(-1)?.deliverables.at(-1)
      if (delivered) onFeedback(`Agent saved an artifact: ${delivered.path}`)
      trackProductEventOnce('agent_first_request_completed', { result: 'success' })
    } catch (requestError: any) {
      // A preview whose turn never settled must not stay on the canvas.
      if (whiteboardPreviewOpen && whiteboardPathForTurn) onWhiteboardPatchCancelled?.({ boardPath: whiteboardPathForTurn, sessionId })
      if (designPreviewOpen && designPathForTurn) onDesignPatchCancelled?.({ designPath: designPathForTurn, sessionId })
      const canceled = requestError?.name === 'AbortError'
      const view = agentSessionViewsRef.current[sessionId] ?? emptyAgentSessionView()
      commitSessionView(sessionId, canceled || requestError instanceof AgentStreamInterruptedError
        ? markInterrupted(view)
        : applyStatus(view, 'idle'))
      if (canceled) {
        // The runtime logs the stopped turn a moment after the stream closes.
        clearResyncTimers(sessionId)
        agentResyncTimers.current.set(sessionId, window.setTimeout(() => {
          agentResyncTimers.current.delete(sessionId)
          void syncSessionEvents(sessionId).catch(() => undefined)
        }, 1000))
      } else if (requestError instanceof AgentStreamInterruptedError) {
        onError(i18next.t('timeline.activity.interruptedDetail', { ns: 'agent' }))
      } else {
        onError(requestError?.message || i18next.t('timeline.event.taskFailed', { ns: 'agent' }))
      }
    } finally {
      delete agentAbortControllers.current[sessionId]
      setPendingUserText(sessionId, '')
      await syncSessionEvents(sessionId).catch(() => undefined)
      agentSendInFlightSessions.current.delete(sessionId)
      markSessionBusy(sessionId, false)
    }
  }, [
    agentBusySessions,
    agentDrafts,
    clearResyncTimers,
    commitSessionView,
    ensureHostedAccountReady,
    getTurnContext,
    mentionableDocuments,
    agentLocalSources,
    markAgentModifiedDocuments,
    onError,
    onFeedback,
    onWorkspaceArtifactsSaved,
    onTableMutated,
    onWhiteboardPatch,
    onWhiteboardPatchCancelled,
    onDesignPatch,
    onDesignPatchCancelled,
    prepareActiveDocument,
    refreshAgentSessions,
    refreshMentionableDocuments,
    selectedAgentModel,
    setPendingUserText,
    syncSessionEvents,
    markSessionBusy,
  ])

  const sendAiComposerMessage = useCallback((
    sessionId: number,
    localSources?: AgentLocalSource[],
    imageGenerationIntent?: AgentImageGenerationIntent,
  ) => {
    void sendAgentMessage(sessionId, { content: imageGenerationIntent?.instruction, imageGenerationIntent, localSources })
  }, [sendAgentMessage])

  const respondToAgentShellApproval = useCallback((
    sessionId: number,
    request: AgentShellApprovalRequest,
    decision: AgentShellApprovalDecision,
  ) => {
    void sendAgentMessage(sessionId, {
      content: buildAgentShellApprovalFollowup(decision, request.command),
      hideUserMessage: true,
      shellApproval: {
        call_id: request.call_id,
        decision,
      },
    })
  }, [sendAgentMessage])

  const sendAgentContextAction = useCallback((
    sessionId: number,
    input: {
      content: string
      executionMode?: AgentExecutionMode
      tablePlanContext?: AgentTablePlanContext
      imageGenerationIntent?: AgentImageGenerationIntent
    },
  ) => {
    void sendAgentMessage(sessionId, {
      content: input.content,
      hideUserMessage: true,
      executionMode: input.executionMode,
      tablePlanContext: input.tablePlanContext,
      imageGenerationIntent: input.imageGenerationIntent,
    })
  }, [sendAgentMessage])

  const stopAgentMessage = useCallback((sessionId: number) => {
    agentAbortControllers.current[sessionId]?.abort()
    delete agentAbortControllers.current[sessionId]
    markSessionBusy(sessionId, false)
    onFeedback('Agent task stopped')
  }, [markSessionBusy, onFeedback])

  return {
    agentBusySessions,
    agentDrafts,
    agentDocumentContexts,
    agentLocalSources,
    mentionableDocuments,
    agentModelOptions,
    agentModifiedDocumentPaths,
    agentPendingUserText,
    agentSessions,
    agentSessionViews,
    clearPendingFocusedSessionId: () => setPendingFocusedSessionId(null),
    createNewAgentChat,
    addAgentLocalSource,
    clearModifiedDocumentPath,
    deleteAgentChat,
    handleAgentModelChange,
    openAgentSession,
    pendingFocusedSessionId,
    refreshAgentSessions,
    removeAgentDocumentContext,
    resolvedAgentModelKey,
    resolveAgentDocumentContext,
    resolveAgentDocumentContexts,
    removeAgentLocalSource,
    respondToAgentShellApproval,
    selectedAgentModel,
    sendAiComposerMessage,
    sendAgentContextAction,
    addAgentDocumentContext,
    setAgentDraft,
    setAgentModifiedDocumentPaths,
    stopAgentMessage,
  }
}
