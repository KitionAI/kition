import { Bot, ChevronsRight, History, Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { AgentSession } from '@/api/agent'
import { WorkspaceTabContextMenu, type WorkspaceTabContextMenuItem } from '@/features/workspace/components/WorkspaceTabContextMenu'
import { formatWorkspaceTime } from '@/features/workspace/lib/workspace'
import { cn } from '@/lib/utils'

type SessionHistoryGroupKey = 'today' | 'week' | 'older'

const sessionHistoryGroupOrder: SessionHistoryGroupKey[] = ['today', 'week', 'older']
const sessionHistoryGroupLabelKeys: Record<SessionHistoryGroupKey, string> = {
  today: 'agentTabs.history.today',
  week: 'agentTabs.history.week',
  older: 'agentTabs.history.older',
}

function getSessionHistoryGroup(value: string): SessionHistoryGroupKey {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekStart = new Date(today)
  weekStart.setDate(weekStart.getDate() - 7)

  const date = new Date(value)
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (targetDay.getTime() >= today.getTime()) {
    return 'today'
  }
  if (targetDay.getTime() >= weekStart.getTime()) {
    return 'week'
  }
  return 'older'
}

export function WorkspaceAgentTabBar({
  portal,
  open,
  activeSessionId,
  sessions,
  openSessions,
  historyOpen,
  onToggleOpen,
  onCreateSession,
  onCloseSession,
  onCloseOtherSessions,
  onCloseAllSessions,
  onCloseLeftSessions,
  onCloseRightSessions,
  onCopySessionRef,
  onSelectSession,
  onToggleHistory,
}: {
  portal: HTMLElement | null
  open: boolean
  activeSessionId: number | null
  sessions: AgentSession[]
  openSessions: AgentSession[]
  historyOpen: boolean
  onToggleOpen: () => void
  onCreateSession: () => void
  onCloseSession: (session: AgentSession) => void
  onCloseOtherSessions?: (session: AgentSession) => void
  onCloseAllSessions?: () => void
  onCloseLeftSessions?: (session: AgentSession) => void
  onCloseRightSessions?: (session: AgentSession) => void
  onCopySessionRef?: (session: AgentSession) => void
  onSelectSession: (session: AgentSession) => void
  onToggleHistory: () => void
}) {
  const [historyQuery, setHistoryQuery] = useState('')
  const { t } = useTranslation('workspace')
  const [contextMenu, setContextMenu] = useState<{ sessionId: number; x: number; y: number } | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const historyButtonRef = useRef<HTMLButtonElement | null>(null)
  const tabsCleanupRef = useRef<(() => void) | null>(null)
  const deferredHistoryQuery = useMemo(() => historyQuery.trim().toLowerCase(), [historyQuery])

  const filteredSessions = useMemo(() => {
    if (!deferredHistoryQuery) {
      return sessions
    }
    return sessions.filter((session) =>
      (session.title || t('agentTabs.chat')).toLowerCase().includes(deferredHistoryQuery),
    )
  }, [deferredHistoryQuery, sessions])

  const groupedSessions = useMemo(() => {
    const groups = new Map<SessionHistoryGroupKey, AgentSession[]>()
    for (const session of filteredSessions) {
      const key = getSessionHistoryGroup(session.updated_at)
      const existing = groups.get(key)
      if (existing) {
        existing.push(session)
      } else {
        groups.set(key, [session])
      }
    }
    return sessionHistoryGroupOrder
      .map((key) => ({
        key,
        label: t(sessionHistoryGroupLabelKeys[key]),
        items: groups.get(key) || [],
      }))
      .filter((group) => group.items.length > 0)
  }, [filteredSessions])

  const tabsRef = (node: HTMLDivElement | null) => {
    tabsCleanupRef.current?.()
    tabsCleanupRef.current = null
    if (!node) {
      return
    }

    function handleWheel(event: WheelEvent) {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
        return
      }
      if (node.scrollWidth <= node.clientWidth) {
        return
      }
      event.preventDefault()
      node.scrollLeft += event.deltaY
    }

    node.addEventListener('wheel', handleWheel, { passive: false })
    tabsCleanupRef.current = () => node.removeEventListener('wheel', handleWheel)
  }

  useEffect(() => {
    if (!historyOpen) {
      setHistoryQuery('')
      return
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null
      if (
        target &&
        (popoverRef.current?.contains(target) || historyButtonRef.current?.contains(target))
      ) {
        return
      }
      onToggleHistory()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onToggleHistory()
      }
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [historyOpen, onToggleHistory])

  if (!portal) {
    return null
  }

  function openContextMenu(event: React.MouseEvent, sessionId: number) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ sessionId, x: event.clientX, y: event.clientY })
  }

  function buildContextMenuItems(sessionId: number): WorkspaceTabContextMenuItem[] {
    const session = openSessions.find((item) => item.id === sessionId)
    if (!session) {
      return []
    }
    const index = openSessions.findIndex((item) => item.id === sessionId)
    const hasLeft = index > 0
    const hasRight = index >= 0 && index < openSessions.length - 1
    const hasOthers = openSessions.length > 1
    return [
      {
        key: 'close',
        label: t('tabs.close'),
        shortcut: '⌘W',
        onSelect: () => onCloseSession(session),
      },
      {
        key: 'close-others',
        label: t('tabs.closeOthers'),
        disabled: !hasOthers || !onCloseOtherSessions,
        onSelect: () => onCloseOtherSessions?.(session),
      },
      {
        key: 'close-all',
        label: t('tabs.closeAll'),
        disabled: !openSessions.length || !onCloseAllSessions,
        onSelect: () => onCloseAllSessions?.(),
      },
      {
        key: 'close-unmodified',
        label: t('tabs.closeUnmodified'),
        disabled: true,
      },
      {
        key: 'close-left',
        label: t('tabs.closeLeft'),
        disabled: !hasLeft || !onCloseLeftSessions,
        onSelect: () => onCloseLeftSessions?.(session),
      },
      {
        key: 'close-right',
        label: t('tabs.closeRight'),
        disabled: !hasRight || !onCloseRightSessions,
        onSelect: () => onCloseRightSessions?.(session),
      },
      {
        key: 'close-readonly',
        label: t('tabs.closeReadOnly'),
        disabled: true,
      },
      { key: 'sep', label: '', separator: true },
      {
        key: 'copy-ref',
        label: t('tabs.copyReference'),
        disabled: !onCopySessionRef,
        onSelect: () => onCopySessionRef?.(session),
      },
    ]
  }

  if (!open) {
    return null
  }

  return createPortal(
    <div className="workspace-agent-topbar">
      <div className="workspace-agent-tabs" role="tablist" ref={tabsRef}>
        {openSessions.length ? (
          openSessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'workspace-agent-tab',
                activeSessionId === session.id && 'is-active',
              )}
              onContextMenu={(event) => openContextMenu(event, session.id)}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeSessionId === session.id}
                className="workspace-agent-tab-label"
                title={session.title || t('agentTabs.newChatTitle')}
                onClick={() => onSelectSession(session)}
              >
                {session.title || t('agentTabs.newChatTitle')}
              </button>
              <button
                type="button"
                className="workspace-agent-tab-close"
                title={t('agentTabs.closeChat')}
                aria-label={t('agentTabs.closeChat')}
                onClick={(event) => {
                  event.stopPropagation()
                  onCloseSession(session)
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          ))
        ) : (
          <span className="workspace-agent-tabs-empty">{t('agentTabs.emptyTitle')}</span>
        )}
      </div>
      <div className="workspace-agent-topbar-actions">
        <button
          type="button"
          className="workspace-agent-sidebar-icon"
          onClick={onCreateSession}
          title={t('agentTabs.newChat')}
          aria-label={t('agentTabs.newChat')}
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          ref={historyButtonRef}
          className={cn('workspace-agent-sidebar-icon', historyOpen && 'is-active')}
          onClick={onToggleHistory}
          title={t('agentTabs.viewHistory')}
          aria-label={t('agentTabs.viewHistory')}
        >
          <History className="size-4" />
        </button>
        <button
          type="button"
          className="workspace-agent-sidebar-icon"
          onClick={onToggleOpen}
          title={t('agentTabs.collapseChat')}
          aria-label={t('agentTabs.collapseChat')}
          data-testid="workspace-agent-collapse"
        >
          <ChevronsRight className="size-4" />
        </button>
      </div>

      {historyOpen ? (
        <div
          ref={popoverRef}
          className="workspace-agent-sidebar-history-popover"
          role="dialog"
          aria-label={t('agentTabs.agentHistory')}
        >
          <div className="workspace-agent-sidebar-history-search">
            <Search className="size-4" />
            <input
              type="search"
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
              placeholder={t('agentTabs.searchChats')}
              autoFocus
            />
          </div>

          <div className="workspace-agent-sidebar-history-list">
            {groupedSessions.length ? (
              groupedSessions.map((group) => (
                <div key={group.key} className="workspace-agent-sidebar-history-group">
                  <div className="workspace-agent-sidebar-history-label">{group.label}</div>
                  <div className="workspace-agent-sidebar-history-group-items">
                    {group.items.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        className={cn(
                          'workspace-agent-sidebar-history-item',
                          activeSessionId === session.id && 'is-active',
                        )}
                        onClick={() => onSelectSession(session)}
                      >
                        <strong>{session.title || t('agentTabs.chat')}</strong>
                        <small>{formatWorkspaceTime(session.updated_at)}</small>
                      </button>
                    ))}
                  </div>
                </div>
              ))
            ) : sessions.length ? (
              <div className="workspace-agent-sidebar-empty">
                <Bot className="size-5" />
                <span>{t('agentTabs.noMatchingChats')}</span>
              </div>
            ) : (
              <div className="workspace-agent-sidebar-empty">
                <Bot className="size-5" />
                <span>{t('agentTabs.noChatsYet')}</span>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {contextMenu ? (
        <WorkspaceTabContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          items={buildContextMenuItems(contextMenu.sessionId)}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>,
    portal,
  )
}
