import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/agent/public', () => ({
  AgentFloatingLauncher: ({ visible }: { visible: boolean }) => createElement('div', { 'data-testid': 'launcher', 'data-visible': String(visible) }),
}))

type TabBarProps = Record<string, unknown>
let lastTabBarProps: TabBarProps = {}
vi.mock('@/features/workspace/components/WorkspaceAgentTabBar', () => ({
  WorkspaceAgentTabBar: (props: TabBarProps) => {
    lastTabBarProps = props
    return null
  },
}))

import type { AgentSession } from '@/api/agent'

import { agentSessionReference, WorkspaceAgentChrome, type WorkspaceAgentPanelState } from './WorkspaceAgentChrome'

const sessions = [{ id: 1, title: 'One' }, { id: 2, title: '' }, { id: 3, title: 'Three' }] as AgentSession[]

function buildPanel(overrides: Partial<WorkspaceAgentPanelState> = {}): WorkspaceAgentPanelState {
  return {
    open: true,
    setOpen: vi.fn(),
    historyOpen: false,
    setHistoryOpen: vi.fn(),
    activeSessionId: 2,
    setActiveSessionId: vi.fn(),
    activeSession: sessions[1],
    openSessions: sessions,
    toggle: vi.fn(),
    createChat: vi.fn(async () => undefined),
    showSession: vi.fn(),
    closeSessions: vi.fn(),
    ...overrides,
  } as WorkspaceAgentPanelState
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  lastTabBarProps = {}
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('WorkspaceAgentChrome', () => {
  it('routes close scopes through the panel and hides the launcher while the pane is open', async () => {
    const panel = buildPanel()
    await act(async () => {
      root!.render(createElement(WorkspaceAgentChrome, { portal: null, panel, sessions }))
    })
    const props = lastTabBarProps as {
      onCloseOtherSessions: (session: AgentSession) => void
      onCloseLeftSessions: (session: AgentSession) => void
      onCloseAllSessions: () => void
      onSelectSession: (session: AgentSession) => void
    }
    props.onCloseOtherSessions(sessions[1])
    expect(panel.closeSessions).toHaveBeenLastCalledWith([1, 3])
    props.onCloseLeftSessions(sessions[2])
    expect(panel.closeSessions).toHaveBeenLastCalledWith([1, 2])
    props.onCloseAllSessions()
    expect(panel.closeSessions).toHaveBeenLastCalledWith([1, 2, 3])
    props.onSelectSession(sessions[0])
    expect(panel.showSession).toHaveBeenCalledWith(1)
    expect(lastTabBarProps.activeSessionId).toBe(2)
    expect(container.querySelector('[data-testid="launcher"]')?.getAttribute('data-visible')).toBe('false')
  })

  it('shows the launcher when the pane is closed', async () => {
    await act(async () => {
      root!.render(createElement(WorkspaceAgentChrome, { portal: null, panel: buildPanel({ open: false, activeSession: null }), sessions }))
    })
    expect(container.querySelector('[data-testid="launcher"]')?.getAttribute('data-visible')).toBe('true')
    expect(lastTabBarProps.activeSessionId).toBeNull()
  })

  it('references a chat by title or number', () => {
    expect(agentSessionReference(sessions[0])).toBe('One')
    expect(agentSessionReference(sessions[1])).toBe('Chat #2')
  })
})
