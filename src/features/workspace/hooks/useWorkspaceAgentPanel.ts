import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { useWorkspaceAgent } from '@/features/agent/public'
import {
  readWorkspaceAgentActiveSessionId,
  writeWorkspaceAgentActiveSessionId,
} from '@/features/workspace/lib/workspacePersistence'

type WorkspaceAgent = ReturnType<typeof useWorkspaceAgent>

type UseWorkspaceAgentPanelOptions = {
  rootPath: string
  agentSessions: WorkspaceAgent['agentSessions']
  refreshAgentSessions: WorkspaceAgent['refreshAgentSessions']
  createNewAgentChat: WorkspaceAgent['createNewAgentChat']
  openAgentSession: WorkspaceAgent['openAgentSession']
  pendingFocusedSessionId: WorkspaceAgent['pendingFocusedSessionId']
  clearPendingFocusedSessionId: WorkspaceAgent['clearPendingFocusedSessionId']
  /** Document a new chat should start with as context. */
  activeWorkspaceDocumentPath: string
  agentSidebarWidth: number
}

function without(set: Set<number>, id: number) {
  if (!set.has(id)) return set
  const next = new Set(set)
  next.delete(id)
  return next
}

/**
 * The Agent sidebar as a panel: open/closed and history state, which
 * sessions show as tabs (closed ones are hidden, not deleted), which one is
 * active, and the per-workspace persistence of that choice. Also creates a
 * first chat when the panel opens on an empty workspace and publishes the
 * sidebar width as a CSS variable for the layout.
 */
export function useWorkspaceAgentPanel({
  rootPath,
  agentSessions,
  refreshAgentSessions,
  createNewAgentChat,
  openAgentSession,
  pendingFocusedSessionId,
  clearPendingFocusedSessionId,
  activeWorkspaceDocumentPath,
  agentSidebarWidth,
}: UseWorkspaceAgentPanelOptions) {
  const [open, setOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)
  const [closedSessionIds, setClosedSessionIds] = useState<Set<number>>(() => new Set())

  const openSessions = useMemo(
    () => agentSessions.filter((session) => !closedSessionIds.has(session.id)),
    [agentSessions, closedSessionIds],
  )
  const activeSession = activeSessionId
    ? agentSessions.find((session) => session.id === activeSessionId) || null
    : null

  useEffect(() => {
    if (!open) {
      setHistoryOpen(false)
      return
    }
    void refreshAgentSessions()
  }, [refreshAgentSessions, open])

  // Opening the panel on a workspace with no chats starts one, once per open.
  const autoCreatedChatRef = useRef(false)
  useEffect(() => {
    if (!open) {
      autoCreatedChatRef.current = false
      return
    }
    if (activeSession || agentSessions.length > 0 || autoCreatedChatRef.current) return
    autoCreatedChatRef.current = true
    void createNewAgentChat({
      focusTab: true,
      documentPaths: activeWorkspaceDocumentPath ? [activeWorkspaceDocumentPath] : [],
    })
  }, [open, activeSession, agentSessions.length, createNewAgentChat, activeWorkspaceDocumentPath])

  useEffect(() => {
    const root = document.documentElement
    if (open) {
      root.style.setProperty('--workspace-agent-sidebar-width', `${agentSidebarWidth}px`)
    } else {
      root.style.removeProperty('--workspace-agent-sidebar-width')
    }
    return () => {
      root.style.removeProperty('--workspace-agent-sidebar-width')
    }
  }, [open, agentSidebarWidth])

  const showSession = useCallback((sessionId: number) => {
    setOpen(true)
    setHistoryOpen(false)
    setClosedSessionIds((current) => without(current, sessionId))
    setActiveSessionId(sessionId)
  }, [])

  // Another surface asked to focus a session (for example a table cell's "open chat").
  useEffect(() => {
    if (!pendingFocusedSessionId) return
    showSession(pendingFocusedSessionId)
    clearPendingFocusedSessionId()
  }, [clearPendingFocusedSessionId, pendingFocusedSessionId, showSession])

  // Rehydrate the per-workspace focus when the root changes. The session list
  // itself resets inside useWorkspaceAgent.
  useEffect(() => {
    if (typeof window === 'undefined') return
    setClosedSessionIds(new Set())
    const stored = readWorkspaceAgentActiveSessionId(rootPath)
    setActiveSessionId(stored && stored > 0 ? stored : null)
  }, [rootPath])

  useEffect(() => {
    if (activeSessionId && openSessions.some((session) => session.id === activeSessionId)) return
    setActiveSessionId(openSessions[0]?.id || null)
  }, [activeSessionId, openSessions])

  useEffect(() => {
    writeWorkspaceAgentActiveSessionId(rootPath, activeSessionId)
  }, [activeSessionId, rootPath])

  useEffect(() => {
    if (!activeSession) return
    void openAgentSession(activeSession)
  }, [activeSession, openAgentSession])

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false)
      setHistoryOpen(false)
      return
    }
    const sessionToRestore = activeSession || openSessions[0] || agentSessions[0] || null
    if (sessionToRestore) {
      setClosedSessionIds((current) => without(current, sessionToRestore.id))
      setActiveSessionId(sessionToRestore.id)
    }
    setOpen(true)
  }, [activeSession, agentSessions, open, openSessions])

  const createChat = useCallback(async () => {
    setOpen(true)
    setHistoryOpen(false)
    await createNewAgentChat({
      focusTab: true,
      documentPaths: activeWorkspaceDocumentPath ? [activeWorkspaceDocumentPath] : [],
    })
  }, [activeWorkspaceDocumentPath, createNewAgentChat])

  /** Hides the given session tabs; picks a neighbour when the active one closes; closes the panel when none remain. */
  const closeSessions = useCallback((sessionIds: number[]) => {
    const closingIds = new Set(sessionIds)
    if (!closingIds.size) return
    const activeIndex = openSessions.findIndex((session) => session.id === activeSessionId)
    const remaining = openSessions.filter((session) => !closingIds.has(session.id))
    setClosedSessionIds((current) => {
      const next = new Set(current)
      closingIds.forEach((sessionId) => next.add(sessionId))
      return next
    })
    if (activeSessionId && closingIds.has(activeSessionId)) {
      const nextIndex = Math.min(Math.max(activeIndex, 0), remaining.length - 1)
      setActiveSessionId(remaining[nextIndex]?.id || null)
    }
    if (!remaining.length) {
      setOpen(false)
      setHistoryOpen(false)
    }
  }, [activeSessionId, openSessions])

  return {
    open,
    setOpen,
    historyOpen,
    setHistoryOpen,
    activeSessionId,
    setActiveSessionId,
    activeSession,
    openSessions,
    toggle,
    createChat,
    showSession,
    closeSessions,
  }
}
