import { useCallback, useEffect, useRef } from 'react'

import type { useWorkspaceAgent } from '@/features/agent/public'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'

type WorkspaceAgent = ReturnType<typeof useWorkspaceAgent>

type UseWorkspaceAgentChatEntryPointsOptions = {
  openPanel: () => void
  activeSessionId: number | null
  setActiveSessionId: (sessionId: number | null) => void
  createNewAgentChat: WorkspaceAgent['createNewAgentChat']
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
 * Every way a chat gets started from somewhere else in the workspace: an onboarding guide and a tree node
 * added as context.
 * They share one rule: open the panel, reuse the active session unless it
 * is busy, drafted, or a fresh chat was asked for, then seed the composer.
 */
export function useWorkspaceAgentChatEntryPoints({
  openPanel,
  activeSessionId,
  setActiveSessionId,
  createNewAgentChat,
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

  return { addNodeToChat, addNodeToNewChat }
}
