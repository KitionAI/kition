import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkflowNodeCard } from './WorkflowNodeCard'

let container: HTMLDivElement; let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

describe('WorkflowNodeCard', () => {
  it('renders trigger card with title + subtitle + Trigger chip', async () => {
    await mount(createElement(WorkflowNodeCard, {
      role: 'trigger', title: '1. When record created', subtitle: 'When a record is created in Leads', status: 'ok',
    }))
    expect(container.textContent).toContain('When record created')
    expect(container.querySelector('[data-testid="node-role-chip"]')?.textContent).toBe('Trigger')
    expect(container.querySelector('[data-testid="node-status"]')?.textContent).toBe('✓')
  })

  it('renders action card with warn status', async () => {
    await mount(createElement(WorkflowNodeCard, {
      role: 'action', title: '2. Send email', subtitle: '...', status: 'warn',
    }))
    expect(container.querySelector('[data-testid="node-status"]')?.textContent).toBe('⚠')
  })

  it('calls onClick when card body is clicked', async () => {
    const onClick = vi.fn()
    await mount(createElement(WorkflowNodeCard, { role: 'action', title: 't', subtitle: 's', status: 'ok', onClick }))
    container.querySelector('[data-testid="node-card"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
