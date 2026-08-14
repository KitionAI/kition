import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
      historyOpen: false,
      onToggleOpen,
      onCreateSession: vi.fn(),
      onDeleteSession: vi.fn(),
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
})
