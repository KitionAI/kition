import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentArtifact,
  AgentBrowserContext,
  AgentEvent,
  AgentExecutionMode,
  AgentMessage,
  AgentSession,
  AgentTablePlanContext,
  AgentPaneContext,
  AgentTaskMode,
  AgentToolCall,
} from '@/api/agent'
import {
  createAgentSession,
  deleteAgentSession,
  listAgentEvents,
  listAgentMessages,
  listAgentSessions,
  listAgentToolCalls,
  streamAgentMessage,
} from '@/api/agent'
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
import { analyzeAgentBrowserIntent } from '@/features/agent/lib/agentBrowserIntent'
import {
  buildAgentModelOptions,
  resolveAgentModelKey,
} from '@/features/agent/lib/agentConfig'
import { ensurePortalAccountSessionRestored } from '@/services/portalAccount'
import { formatAgentToolName } from '@/features/agent/lib/agentTimeline'
import { getAgentTimelineDict } from '@/features/agent/lib/agentTimelineI18n'
import {
  isDesktopRuntime,
  listWorkspaceDocuments,
  type WorkspaceDocumentFormat,
} from '@/services/desktop'
import { saveDesktopSettings } from '@/services/desktopSettings'
import { notifyFromAgentEvent } from '@/services/desktopNotifications'
import type { DesktopSettingsState } from '@/types/desktopSettings'
import { trackProductEventOnce } from '@/features/analytics/lib/productAnalytics'
import { isWebPreviewMode } from '@/lib/runtimeMode'

type WorkspaceAgentTurnContext = {
  activeDocumentPath?: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  activeDataDocumentId?: number | null
  activeDataTableId?: number | null
  browserContext?: AgentBrowserContext
  taskMode?: AgentTaskMode
  browserEnabled?: boolean
  /** Active workbench tab type. Forwarded to streamAgentMessage so the
   *  backend can swap pane-specific instructions in the system prompt
   *  (e.g. don't suggest document_write when the pane is a workflow
   *  editor). Defaults to "document" upstream when omitted. */
  paneContext?: AgentPaneContext
  /** Workflow id (when pane is workflow) so the backend can inject a
   *  compact trigger/action/bound-table summary into the skill
   *  context. Frontend reads this from the active workflow tab. */
  activeWorkflowId?: string
}

type UseWorkspaceAgentOptions = {
  settings: DesktopSettingsState
  rootPath: string
  onError: (message: string) => void
  onFeedback: (message: string) => void
  ensureHostedAccountReady?: () => Promise<boolean>
  onSettingsSaved?: (settings: DesktopSettingsState) => void
  onWorkspaceArtifactsSaved?: (sessionId: number) => Promise<void>
  onTableMutated?: () => void | Promise<void>
  prepareBrowserContext?: (content: string) => Promise<AgentBrowserContext | undefined>
  silentInitialSessionLoad?: boolean
  getTurnContext?: () =>
    | WorkspaceAgentTurnContext
    | null
    | undefined
    | Promise<WorkspaceAgentTurnContext | null | undefined>
}

const TABLE_MUTATION_TOOL_NAMES = new Set([
  'data_table_add_fields',
  'data_table_add_records',
])

function getAgentModifiedPath(toolCall: AgentToolCall) {
  if (toolCall.tool_name !== 'document_write' || toolCall.status !== 'completed') {
    return ''
  }

  if (typeof toolCall.output_data?.path === 'string') {
    return toolCall.output_data.path
  }

  return typeof toolCall.input_data?.path === 'string' ? toolCall.input_data.path : ''
}

export function useWorkspaceAgent({
  settings,
  rootPath,
  onError,
  onFeedback,
  ensureHostedAccountReady,
  onSettingsSaved,
  onWorkspaceArtifactsSaved,
  onTableMutated,
  prepareBrowserContext,
  silentInitialSessionLoad = !isDesktopRuntime(),
  getTurnContext,
}: UseWorkspaceAgentOptions) {
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([])
  const [agentMessages, setAgentMessages] = useState<Record<number, AgentMessage[]>>({})
  const [agentToolCalls, setAgentToolCalls] = useState<Record<number, AgentToolCall[]>>({})
  const [agentEvents, setAgentEvents] = useState<Record<number, AgentEvent[]>>({})
  const [agentDrafts, setAgentDrafts] = useState<Record<number, string>>({})
  const [agentStreamingText, setAgentStreamingText] = useState<Record<number, string>>({})
  const [agentArtifacts, setAgentArtifacts] = useState<Record<number, AgentArtifact[]>>({})
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
  const [mentionableDocuments, setMentionableDocuments] = useState<AgentMentionableDocument[]>([])
  const agentAbortControllers = useRef<Record<number, AbortController>>({})
  const agentSendInFlightSessions = useRef<Set<number>>(new Set())

  const agentModelOptions = useMemo(() => buildAgentModelOptions(settings), [settings])
  const resolvedAgentModelKey = useMemo(
    () => resolveAgentModelKey(settings, agentModelOptions, selectedAgentModelKey),
    [agentModelOptions, selectedAgentModelKey, settings],
  )
  const selectedAgentModel = agentModelOptions.find((option) => option.key === resolvedAgentModelKey) || null

  const setAgentDraft = useCallback((sessionId: number, value: string) => {
    setAgentDrafts((current) => ({ ...current, [sessionId]: value }))
  }, [])

  const refreshMentionableDocuments = useCallback(async () => {
    try {
      const response = await listWorkspaceDocuments()
      setMentionableDocuments(flattenMentionableWorkspaceDocuments(response.items || []))
    } catch {
      setMentionableDocuments([])
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
    try {
      const response = await listAgentSessions()
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

    for (const controller of Object.values(agentAbortControllers.current)) {
      controller?.abort()
    }
    agentAbortControllers.current = {}
    agentSendInFlightSessions.current.clear()

    setAgentSessions([])
    setAgentMessages({})
    setAgentToolCalls({})
    setAgentEvents({})
    setAgentDrafts({})
    setAgentStreamingText({})
    setAgentArtifacts({})
    setAgentModifiedDocumentPaths(new Set())
    setAgentBusySessions(new Set())
    setPendingFocusedSessionId(null)
    setMentionableDocuments([])

    if (!nextRoot || isWebPreviewMode()) {
      return
    }
    void refreshAgentSessions(undefined, { silent: silentInitialSessionLoad })
    void refreshMentionableDocuments()
  }, [refreshAgentSessions, refreshMentionableDocuments, rootPath, silentInitialSessionLoad])

  const openAgentSession = useCallback(async (session: AgentSession) => {
    if (!agentMessages[session.id]) {
      try {
        const response = await listAgentMessages(session.id)
        setAgentMessages((current) => ({ ...current, [session.id]: response.items || [] }))
      } catch (requestError: any) {
        onError(requestError?.message || 'Failed to load agent messages')
      }
    }

    if (!agentToolCalls[session.id]) {
      try {
        const response = await listAgentToolCalls(session.id)
        setAgentToolCalls((current) => ({ ...current, [session.id]: response.items || [] }))
      } catch (requestError: any) {
        onError(requestError?.message || 'Failed to load agent tool calls')
      }
    }

    if (!agentEvents[session.id]) {
      try {
        const response = await listAgentEvents(session.id)
        setAgentEvents((current) => ({ ...current, [session.id]: response.items || [] }))
      } catch (requestError: any) {
        onError(requestError?.message || 'Failed to load agent events')
      }
    }
  }, [agentEvents, agentMessages, agentToolCalls, onError])

  const createNewAgentChat = useCallback(async (options?: { focusTab?: boolean }) => {
    onError('')
    onFeedback('')

    try {
      const session = await createAgentSession({ language: getLanguageNameForLocale(getCurrentLocale()) })
      setAgentSessions((current) => [session, ...current.filter((item) => item.id !== session.id)])
      setAgentMessages((current) => ({ ...current, [session.id]: [] }))
      setAgentToolCalls((current) => ({ ...current, [session.id]: [] }))
      setAgentEvents((current) => ({ ...current, [session.id]: [] }))
      if (options?.focusTab) {
        setPendingFocusedSessionId(session.id)
      }
      return session
    } catch (requestError: any) {
      onError(requestError?.message || 'Failed to create agent session')
      return null
    }
  }, [onError, onFeedback])

  const deleteAgentChat = useCallback(async (sessionId: number) => {
    agentAbortControllers.current[sessionId]?.abort()
    delete agentAbortControllers.current[sessionId]

    try {
      await deleteAgentSession(sessionId)
    } catch (requestError: any) {
      onError(requestError?.message || 'Failed to delete agent session')
      return
    }

    setAgentSessions((current) => current.filter((item) => item.id !== sessionId))
    const dropSession = <T,>(current: Record<number, T>) => {
      if (!(sessionId in current)) {
        return current
      }
      const next = { ...current }
      delete next[sessionId]
      return next
    }
    setAgentMessages(dropSession)
    setAgentToolCalls(dropSession)
    setAgentEvents(dropSession)
    setAgentDrafts(dropSession)
    setAgentStreamingText(dropSession)
    setAgentArtifacts(dropSession)
    agentSendInFlightSessions.current.delete(sessionId)
    markSessionBusy(sessionId, false)
  }, [markSessionBusy, onError])

  const markAgentModifiedDocument = useCallback((toolCall: AgentToolCall) => {
    const path = getAgentModifiedPath(toolCall)
    if (!path) {
      return
    }

    setAgentModifiedDocumentPaths((current) => {
      const next = new Set(current)
      next.add(path)
      return next
    })
  }, [])

  const sendAgentMessage = useCallback(async (
    sessionId: number,
    followup?: {
      content?: string
      hideUserMessage?: boolean
      executionMode?: AgentExecutionMode
      tablePlanContext?: AgentTablePlanContext
      browserAutoContinue?: boolean
    },
  ) => {
    const content = (followup?.content ?? agentDrafts[sessionId] ?? '').trim()
    const browserIntent = analyzeAgentBrowserIntent(content)
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

    const optimisticUserMessage: AgentMessage = {
      id: Date.now() * -1,
      session_id: sessionId,
      user_id: 0,
      role: 'user',
      content,
      status: 'completed',
      created_at: new Date().toISOString(),
    }

    setAgentDrafts((current) => ({
      ...current,
      [sessionId]: current[sessionId]?.trim() === content ? '' : current[sessionId] || '',
    }))
    setAgentMessages((current) => ({
      ...current,
      [sessionId]: followup?.hideUserMessage
        ? current[sessionId] || []
        : [...(current[sessionId] || []), optimisticUserMessage],
    }))
    setAgentStreamingText((current) => ({ ...current, [sessionId]: '' }))
    onError('')
    onFeedback('')

    const rollbackPendingSend = () => {
      if (!followup?.hideUserMessage) {
        setAgentMessages((current) => {
          const remaining = (current[sessionId] || []).filter(
            (message) => message.id !== optimisticUserMessage.id,
          )
          if (remaining.length) {
            return { ...current, [sessionId]: remaining }
          }
          const next = { ...current }
          delete next[sessionId]
          return next
        })
      }
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

    const abortController = new AbortController()
    agentAbortControllers.current[sessionId] = abortController
    let tableMutated = false

    try {
      let preparedBrowserContext: AgentBrowserContext | undefined
      if (
        browserIntent.browserEnabled &&
        followup?.browserAutoContinue !== true &&
        prepareBrowserContext
      ) {
        preparedBrowserContext = await prepareBrowserContext(content).catch(() => undefined)
      }
      const turnContext = (await getTurnContext?.()) || undefined
      const activeDocumentPath = String(turnContext?.activeDocumentPath || '').trim()
      const mentionTokens = extractAgentDocumentMentionTokens(content)
      let availableMentionableDocuments = mentionableDocuments
      if (mentionTokens.length && !availableMentionableDocuments.length) {
        try {
          const response = await listWorkspaceDocuments()
          availableMentionableDocuments = flattenMentionableWorkspaceDocuments(response.items || [])
          setMentionableDocuments(availableMentionableDocuments)
        } catch {
          availableMentionableDocuments = []
        }
      }
      const mentionResolution = resolveAgentDocumentMentions({
        content,
        documents: availableMentionableDocuments,
      })
      const promptContext = buildAgentDocumentMentionPromptContext({
        activeDocumentPath,
        activeDocumentFormat: turnContext?.activeDocumentFormat,
        referencedDocuments: mentionResolution.resolved,
        unresolvedTokens: mentionResolution.unresolved,
      })
      const attachmentPaths = Array.from(new Set([
        ...(isBinaryAttachmentMention(turnContext?.activeDocumentFormat, activeDocumentPath)
          ? [activeDocumentPath]
          : []),
        ...mentionResolution.resolved
          .filter(
            (document) => document.kind !== 'folder'
              && isBinaryAttachmentMention(document.format, document.path),
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

      const done = await streamAgentMessage({
        sessionId,
        content,
        promptContext,
        attachmentPaths,
        activeDocumentPath: requestActiveDocumentPath,
        activeDataDocumentId: turnContext?.activeDataDocumentId ?? 0,
        activeDataTableId: turnContext?.activeDataTableId ?? 0,
        activeWorkflowId: turnContext?.activeWorkflowId,
        paneContext: turnContext?.paneContext,
        taskMode: turnContext?.taskMode,
        browserEnabled:
          turnContext?.browserEnabled === true || browserIntent.browserEnabled,
        browserContext: preparedBrowserContext || turnContext?.browserContext,
        executionMode: followup?.executionMode,
        tablePlanContext: followup?.tablePlanContext,
        hideUserMessage: followup?.hideUserMessage === true,
        modelId: selectedAgentModel.key,
        runtimeModel,
        saveMarkdown,
        language: getLanguageNameForLocale(getCurrentLocale()),
        signal: abortController.signal,
        onEvent: (event) => {
          if (event.type === 'user_message' && event.chat_message) {
            setAgentMessages((current) => ({
              ...current,
              [sessionId]: [...(current[sessionId] || []).filter((item) => item.id !== optimisticUserMessage.id), event.chat_message!],
            }))
          }

          if (event.type === 'model_delta' && event.delta) {
            setAgentStreamingText((current) => ({ ...current, [sessionId]: `${current[sessionId] || ''}${event.delta}` }))
            setAgentEvents((current) => {
              const existing = current[sessionId] || []
              const eventId = -100000000 - sessionId
              const previous = existing.find((item) => item.id === eventId)
              const previousText = typeof previous?.data?.preview === 'string' ? previous.data.preview : ''
              const nextText = `${previousText}${event.delta}`.slice(-4000)
              const nextEvent: AgentEvent = {
                id: eventId,
                session_id: sessionId,
                user_id: 0,
                message_id: event.chat_message?.id,
                event_type: 'model.delta',
                stage: 'model',
                status: 'running',
                label: 'AI backend content',
                message: `Returned ${Array.from(nextText).length} characters`,
                data: {
                  ...(previous?.data || {}),
                  ...(event.extra_data || {}),
                  preview: nextText,
                  chars: Array.from(nextText).length,
                },
                created_at: previous?.created_at || new Date().toISOString(),
              }

              return {
                ...current,
                [sessionId]: existing.some((item) => item.id === eventId)
                  ? existing.map((item) => item.id === eventId ? nextEvent : item)
                  : [...existing, nextEvent],
              }
            })
          }

          if (event.type === 'model_tool_call_delta' || event.type === 'model_tool_call_ready') {
            setAgentEvents((current) => {
              const existing = current[sessionId] || []
              const turn = Number(event.extra_data?.turn || 1)
              const index = Number(event.extra_data?.tool_call_index || 0)
              const eventId = -110000000 - (sessionId * 1000) - (turn * 100) - index
              const previous = existing.find((item) => item.id === eventId)
              const previousArguments = typeof previous?.data?.arguments === 'string' ? previous.data.arguments : ''
              const delta = typeof event.extra_data?.arguments_delta === 'string' ? event.extra_data.arguments_delta : ''
              const argumentsText = typeof event.extra_data?.arguments === 'string' && event.extra_data.arguments
                ? event.extra_data.arguments
                : `${previousArguments}${delta}`
              const toolName = String(event.extra_data?.tool_name || previous?.data?.tool_name || 'tool')
              const completed = event.type === 'model_tool_call_ready'
              const nextEvent: AgentEvent = {
                id: eventId,
                session_id: sessionId,
                user_id: 0,
                event_type: completed ? 'model.tool_call.ready' : 'model.tool_call.delta',
                stage: 'model',
                status: completed ? 'completed' : 'running',
                label: completed ? 'Tool call generated' : 'Generating tool arguments',
                message: completed
                  ? getAgentTimelineDict().event.toolCallGenerated(formatAgentToolName(toolName))
                  : getAgentTimelineDict().event.generatingToolArgs(formatAgentToolName(toolName)),
                data: {
                  ...(previous?.data || {}),
                  ...(event.extra_data || {}),
                  tool_name: toolName,
                  arguments: argumentsText,
                },
                created_at: previous?.created_at || new Date().toISOString(),
              }

              return {
                ...current,
                [sessionId]: existing.some((item) => item.id === eventId)
                  ? existing.map((item) => item.id === eventId ? nextEvent : item)
                  : [...existing, nextEvent],
              }
            })
          }

          if (event.type === 'artifact' && event.artifact) {
            setAgentArtifacts((current) => ({
              ...current,
              [sessionId]: [...(current[sessionId] || []), event.artifact!],
            }))
            // Refresh the workspace tree as soon as the artifact is saved, so the
            // sidebar reflects the new file even if the agent later fails (e.g. a
            // hosted image_generation succeeds but the next Responses turn errors).
            void onWorkspaceArtifactsSaved?.(sessionId)
            void refreshMentionableDocuments()
          }

          if (event.type === 'agent_event' && event.event?.event_type === 'artifact.created') {
            // Hosted tools (image_generation, etc.) record the artifact via an
            // agent event instead of a dedicated stream artifact frame, so mirror
            // the refresh here.
            void onWorkspaceArtifactsSaved?.(sessionId)
            void refreshMentionableDocuments()
          }

          if ((event.type === 'tool_call' || event.type === 'tool_error' || event.type === 'artifact') && event.tool_call) {
            markAgentModifiedDocument(event.tool_call)
            if (
              event.tool_call.status === 'completed' &&
              TABLE_MUTATION_TOOL_NAMES.has(event.tool_call.tool_name)
            ) {
              tableMutated = true
            }
            // Broadcast a connections-changed signal whenever the SMTP
            // configure tool completes so the WorkflowHomePage drawer can
            // refresh its connection dropdown without polling. The agent
            // panel itself stays unaware of workflow internals — it just
            // forwards the success notification on the same bus the rest
            // of the app uses for workflow state. We attach the tool's
            // output payload so listeners can also pick up the new
            // connection id + whether the tool attached it to an workflow
            // in the same call (saves a second roundtrip on the UI side).
            if (
              event.tool_call.status === 'completed' &&
              event.tool_call.tool_name === 'configure_smtp_connection' &&
              typeof window !== 'undefined'
            ) {
              const output = (event.tool_call.output_data || {}) as {
                id?: string
                workflow_id?: string
                workflow_attached?: boolean
              }
              window.dispatchEvent(new CustomEvent('kition:connections:changed', {
                detail: {
                  source: 'configure_smtp_connection',
                  connectionId: output.id || '',
                  workflowId: output.workflow_id || '',
                  workflowAttached: Boolean(output.workflow_attached),
                },
              }))
            }
            setAgentToolCalls((current) => {
              const existing = current[sessionId] || []
              const next = existing.some((item) => item.id === event.tool_call!.id)
                ? existing.map((item) => item.id === event.tool_call!.id ? event.tool_call! : item)
                : [...existing, event.tool_call!]
              return { ...current, [sessionId]: next }
            })
          }

          if (event.type === 'agent_event' && event.event) {
            const nextEvent =
              event.event.event_type === 'browser.open_required' &&
              browserIntent.continueAfterOpen &&
              followup?.browserAutoContinue !== true
                ? {
                    ...event.event,
                    data: {
                      ...(event.event.data || {}),
                      client_auto_continue: true,
                      client_original_request: content,
                    },
                  }
                : event.event
            setAgentEvents((current) => {
              const existing = current[sessionId] || []
              const next = existing.some((item) => item.id === nextEvent.id)
                ? existing.map((item) => item.id === nextEvent.id ? nextEvent : item)
                : [...existing, nextEvent]
              return { ...current, [sessionId]: next }
            })
            void notifyFromAgentEvent({
              event_type: event.event.event_type,
              label: event.event.label,
              message: event.event.message,
            })
          }
        },
      })

      const assistantMessage = done?.extra_data?.message
      const artifact = done?.extra_data?.artifact
      const nextSession = done?.extra_data?.session

      if (assistantMessage) {
        setAgentMessages((current) => ({
          ...current,
          [sessionId]: (current[sessionId] || []).some((item) => item.id === assistantMessage.id)
            ? (current[sessionId] || [])
            : [...(current[sessionId] || []), assistantMessage],
        }))
      }

      if (artifact) {
        setAgentArtifacts((current) => ({
          ...current,
          [sessionId]: [...(current[sessionId] || []).filter((item) => item.id !== artifact.id), artifact],
        }))
        await onWorkspaceArtifactsSaved?.(sessionId)
        await refreshMentionableDocuments()
        onFeedback(`Agent saved an artifact: ${artifact.path}`)
      }

      if (nextSession) {
        setAgentSessions((current) => [nextSession, ...current.filter((item) => item.id !== nextSession.id)])
        setPendingFocusedSessionId(nextSession.id)
      }

      if (tableMutated) {
        await onTableMutated?.()
      }
      trackProductEventOnce('agent_first_request_completed', { result: 'success' })
    } catch (requestError: any) {
      if (requestError?.name === 'AbortError') {
        onFeedback('Agent task stopped')
      } else {
        onError(requestError?.message || 'Agent execution failed')
      }
    } finally {
      delete agentAbortControllers.current[sessionId]
      agentSendInFlightSessions.current.delete(sessionId)
      setAgentStreamingText((current) => ({ ...current, [sessionId]: '' }))
      markSessionBusy(sessionId, false)
    }
  }, [
    agentBusySessions,
    agentDrafts,
    agentSessions,
    ensureHostedAccountReady,
    getTurnContext,
    mentionableDocuments,
    markAgentModifiedDocument,
    onError,
    onFeedback,
    onWorkspaceArtifactsSaved,
    onTableMutated,
    prepareBrowserContext,
    refreshMentionableDocuments,
    selectedAgentModel,
    markSessionBusy,
  ])

  const sendAiComposerMessage = useCallback((sessionId: number) => {
    void sendAgentMessage(sessionId)
  }, [sendAgentMessage])

  const sendAgentContextAction = useCallback((
    sessionId: number,
    input: {
      content: string
      executionMode?: AgentExecutionMode
      tablePlanContext?: AgentTablePlanContext
      browserAutoContinue?: boolean
    },
  ) => {
    void sendAgentMessage(sessionId, {
      content: input.content,
      hideUserMessage: true,
      executionMode: input.executionMode,
      tablePlanContext: input.tablePlanContext,
      browserAutoContinue: input.browserAutoContinue,
    })
  }, [sendAgentMessage])

  const stopAgentMessage = useCallback((sessionId: number) => {
    agentAbortControllers.current[sessionId]?.abort()
    delete agentAbortControllers.current[sessionId]
    setAgentStreamingText((current) => ({ ...current, [sessionId]: '' }))
    markSessionBusy(sessionId, false)
    onFeedback('Agent task stopped')
  }, [markSessionBusy, onFeedback])

  return {
    agentArtifacts,
    agentBusySessions,
    agentDrafts,
    agentEvents,
    agentMessages,
    mentionableDocuments,
    agentModelOptions,
    agentModifiedDocumentPaths,
    agentSessions,
    agentStreamingText,
    agentToolCalls,
    clearPendingFocusedSessionId: () => setPendingFocusedSessionId(null),
    createNewAgentChat,
    clearModifiedDocumentPath,
    deleteAgentChat,
    handleAgentModelChange,
    openAgentSession,
    pendingFocusedSessionId,
    refreshAgentSessions,
    resolvedAgentModelKey,
    selectedAgentModel,
    sendAiComposerMessage,
    sendAgentContextAction,
    setAgentDraft,
    setAgentModifiedDocumentPaths,
    stopAgentMessage,
  }
}
