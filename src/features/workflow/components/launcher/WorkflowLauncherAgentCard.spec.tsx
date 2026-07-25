import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowLauncherAgentCard } from './WorkflowLauncherAgentCard'

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

describe('WorkflowLauncherAgentCard', () => {
  it('renders the localized agent-card label', async () => {
    await mount(createElement(WorkflowLauncherAgentCard, { onClick: () => {} }))
    expect(container.textContent).toContain('AI Agent is Here')
  })

  it('fires onClick when the button is clicked', async () => {
    const onClick = vi.fn()
    await mount(createElement(WorkflowLauncherAgentCard, { onClick }))
    container.querySelector('[data-testid="workflow-launcher-agent-card"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClick).toHaveBeenCalled()
  })

  it('exposes a localized tooltip title for the assistant entrypoint', async () => {
    await mount(createElement(WorkflowLauncherAgentCard, { onClick: () => {} }))
    const button = container.querySelector('[data-testid="workflow-launcher-agent-card"]')
    expect(button?.getAttribute('title')).toBe('Open Ask AI')
  })
})
