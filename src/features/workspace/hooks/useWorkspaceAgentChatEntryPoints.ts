import { useCallback, useEffect, useRef } from 'react'

import type { useWorkspaceAgent } from '@/features/agent/public'
import type { DocumentAskAgentRequest } from '@/features/document/public'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'

type WorkspaceAgent = ReturnType<typeof useWorkspaceAgent>

type UseWorkspaceAgentChatEntryPointsOptions = {
  openPanel: () => void
  activeSessionId: number | null
  setActiveSessionId: (sessionId: number | null) => void
  createNewAgentChat: WorkspaceAgent['createNewAgentChat']
  agentBusySessions: WorkspaceAgent['agentBusySessions']
  agentDrafts: WorkspaceAgent['agentDrafts']
  setAgentDraft: WorkspaceAgent['setAgentDraft']
  addAgentDocumentContext: WorkspaceAgent['addAgentDocumentContext']
  activeWorkspaceDocumentPath: string
  openDocument: (path: string) => Promise<void>
}

function focusComposer(deferred = false) {
  const dispatch = () => window.dispatchEvent(new CustomEvent('kition:agent:focus-composer'))
  if (deferred) window.requestAnimationFrame(dispatch)
  else dispatch()
}

/**
 * Every way a chat gets started from somewhere else in the workspace: a
 * document's "ask the Agent" action, an onboarding guide, a tree node added
 * as context, a workflow node's "ask AI" pill, and the AI workflow builder.
 * They share one rule: open the panel, reuse the active session unless it
 * is busy, drafted, or a fresh chat was asked for, then seed the composer.
 */
export function useWorkspaceAgentChatEntryPoints({
  openPanel,
  activeSessionId,
  setActiveSessionId,
  createNewAgentChat,
  agentBusySessions,
  agentDrafts,
  setAgentDraft,
  addAgentDocumentContext,
  activeWorkspaceDocumentPath,
  openDocument,
}: UseWorkspaceAgentChatEntryPointsOptions) {
  // Latest values for event listeners that must not re-subscribe on every render.
  const latestRef = useRef({ activeSessionId, agentDrafts })
  latestRef.current = { activeSessionId, agentDrafts }

  /** Returns the session to use, creating one when required or when none is active. */
  const ensureSession = useCallback(async (options: { forceNew?: boolean; documentPaths?: string[] } = {}) => {
    openPanel()
    let sessionId = options.forceNew ? null : latestRef.current.activeSessionId
    if (!sessionId) {
      const session = await createNewAgentChat({ focusTab: true, documentPaths: options.documentPaths ?? [] })
      sessionId = session?.id ?? null
      if (sessionId) setActiveSessionId(sessionId)
    }
    return sessionId
  }, [createNewAgentChat, openPanel, setActiveSessionId])

  const handleDocumentAskAgent = useCallback(async (request: DocumentAskAgentRequest) => {
    const current = latestRef.current.activeSessionId
    const reuse = Boolean(current)
      && !agentBusySessions.has(current as number)
      && !latestRef.current.agentDrafts[current as number]?.trim()
    const sessionId = await ensureSession({
      forceNew: !reuse,
      documentPaths: request.documentPath ? [request.documentPath] : [],
    })
    if (!sessionId) return
    if (reuse && request.documentPath) {
      addAgentDocumentContext(sessionId, request.documentPath, activeWorkspaceDocumentPath)
    }
    setAgentDraft(sessionId, request.prompt)
    focusComposer(true)
  }, [activeWorkspaceDocumentPath, addAgentDocumentContext, agentBusySessions, ensureSession, setAgentDraft])

  const attachNodeMention = useCallback(async (node: WorkspaceTreeNode, { forceNew }: { forceNew: boolean }) => {
    const sessionId = await ensureSession({ forceNew, documentPaths: [node.path] })
    if (!sessionId) return
    if (!forceNew) addAgentDocumentContext(sessionId, node.path, activeWorkspaceDocumentPath)
    focusComposer()
  }, [activeWorkspaceDocumentPath, addAgentDocumentContext, ensureSession])

  const addNodeToChat = useCallback((node: WorkspaceTreeNode) => attachNodeMention(node, { forceNew: false }), [attachNodeMention])
  const addNodeToNewChat = useCallback((node: WorkspaceTreeNode) => attachNodeMention(node, { forceNew: true }), [attachNodeMention])

  // Onboarding guides open a document and start a chat with a prompt.
  useEffect(() => {
    function startOnboardingAgent(event: Event) {
      const detail = (event as CustomEvent<{ documentPath?: string; prompt?: string }>).detail
      const documentPath = String(detail?.documentPath || '').trim()
      const prompt = String(detail?.prompt || '').trim()
      void (async () => {
        if (documentPath) await openDocument(documentPath)
        const sessionId = await ensureSession({ forceNew: true, documentPaths: documentPath ? [documentPath] : [] })
        if (!sessionId) return
        if (prompt) setAgentDraft(sessionId, prompt)
        focusComposer()
      })()
    }
    window.addEventListener('kition:onboarding:start-agent', startOnboardingAgent)
    return () => window.removeEventListener('kition:onboarding:start-agent', startOnboardingAgent)
  }, [ensureSession, openDocument, setAgentDraft])

  // A workflow node's "ask AI" pill appends a pre-rendered prompt to the draft.
  // The prompt builder is loaded lazily so the workflow feature is not part of
  // the initial bundle for workspaces that never open a workflow.
  const askAIPromptBuilderRef = useRef<((payload: unknown) => string) | null>(null)
  useEffect(() => {
    let cancelled = false
    void import('@/features/workflow/public').then((mod) => {
      if (!cancelled) askAIPromptBuilderRef.current = mod.buildWorkflowNodeAskAIPrompt as (payload: unknown) => string
    })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    async function handler(event: Event) {
      const detail = (event as CustomEvent).detail
      if (!detail) return
      const sessionId = await ensureSession()
      if (!sessionId) return
      const build = askAIPromptBuilderRef.current
      const prompt = build
        ? build(detail)
        : `Help me with the ${detail.nodeKind} node ${detail.nodeId} of workflow ${detail.workflow?.name}.`
      const current = latestRef.current.agentDrafts[sessionId] || ''
      const separator = current && !/\s$/.test(current) ? '\n\n' : ''
      setAgentDraft(sessionId, `${current}${separator}${prompt}`)
    }
    window.addEventListener('kition:workflow-node:ask-ai', handler as EventListener)
    return () => window.removeEventListener('kition:workflow-node:ask-ai', handler as EventListener)
  }, [ensureSession, setAgentDraft])

  // AI workflow generation seeds the composer with the user's initial prompt
  // so follow-ups are immediately possible while the canvas fills in. Only
  // seeds an empty composer so manual typing is never clobbered.
  useEffect(() => {
    async function handler(event: Event) {
      const detail = (event as CustomEvent).detail as { prompt?: string } | undefined
      if (!detail?.prompt) return
      const sessionId = await ensureSession()
      if (!sessionId) return
      if ((latestRef.current.agentDrafts[sessionId] || '').trim()) return
      setAgentDraft(sessionId, detail.prompt)
    }
    window.addEventListener('kition:workflow-ai-build:open', handler as EventListener)
    return () => window.removeEventListener('kition:workflow-ai-build:open', handler as EventListener)
  }, [ensureSession, setAgentDraft])

  return { handleDocumentAskAgent, addNodeToChat, addNodeToNewChat }
}
