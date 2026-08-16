import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSession } from '@/api/agent'
import { WorkspaceAgentTabBar } from './WorkspaceAgentTabBar'

let container: HTMLDivElement
let portal: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  portal = document.createElement('div')
  document.body.append(container, portal)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  portal.remove()
})

function renderTabBar(open: boolean, onToggleOpen = vi.fn()) {
  act(() => {
    root = createRoot(container)
    root.render(createElement(WorkspaceAgentTabBar, {
      portal,
      open,
      activeSessionId: null,
      sessions: [],
      openSessions: [],
      historyOpen: false,
      onToggleOpen,
      onCreateSession: vi.fn(),
      onCloseSession: vi.fn(),
      onSelectSession: vi.fn(),
      onToggleHistory: vi.fn(),
    }))
  })
}

describe('WorkspaceAgentTabBar', () => {
  it('leaves the topbar empty while the floating launcher owns the closed state', () => {
    renderTabBar(false)

    expect(portal.childElementCount).toBe(0)
  })

  it('collapses the open panel from the double-chevron control', () => {
    const onToggleOpen = vi.fn()
    renderTabBar(true, onToggleOpen)

    const collapse = portal.querySelector<HTMLButtonElement>('[data-testid="workspace-agent-collapse"]')
    expect(collapse?.querySelector('.lucide-chevrons-right')).toBeTruthy()

    act(() => collapse?.click())
    expect(onToggleOpen).toHaveBeenCalledTimes(1)
  })

  it('closes a chat tab without requesting session deletion', () => {
    const onCloseSession = vi.fn()
    const session: AgentSession = {
      id: 7,
      user_id: 1,
      title: 'Saved chat',
      status: 'idle',
      created_at: '2026-08-16T10:00:00.000Z',
      updated_at: '2026-08-16T10:00:00.000Z',
    }

    act(() => {
      root = createRoot(container)
      root.render(createElement(WorkspaceAgentTabBar, {
        portal,
        open: true,
        activeSessionId: session.id,
        sessions: [session],
        openSessions: [session],
        historyOpen: false,
        onToggleOpen: vi.fn(),
        onCreateSession: vi.fn(),
        onCloseSession,
        onSelectSession: vi.fn(),
        onToggleHistory: vi.fn(),
      }))
    })

    const close = portal.querySelector<HTMLButtonElement>('.workspace-agent-tab-close')
    act(() => close?.click())

    expect(onCloseSession).toHaveBeenCalledWith(session)
  })

  it('keeps a closed tab available in chat history', () => {
    const session: AgentSession = {
      id: 8,
      user_id: 1,
      title: 'Retained chat',
      status: 'idle',
      created_at: '2026-08-16T10:00:00.000Z',
      updated_at: new Date().toISOString(),
    }

    act(() => {
      root = createRoot(container)
      root.render(createElement(WorkspaceAgentTabBar, {
        portal,
        open: true,
        activeSessionId: null,
        sessions: [session],
        openSessions: [],
        historyOpen: true,
        onToggleOpen: vi.fn(),
        onCreateSession: vi.fn(),
        onCloseSession: vi.fn(),
        onSelectSession: vi.fn(),
        onToggleHistory: vi.fn(),
      }))
    })

    expect(portal.querySelector('[role="tab"]')).toBeNull()
    expect(portal.querySelector('.workspace-agent-sidebar-history-item')?.textContent)
      .toContain('Retained chat')
  })
})
