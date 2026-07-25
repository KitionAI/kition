import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkflowStatusToggle } from './WorkflowStatusToggle'

let container: HTMLDivElement
let root: Root | null = null
async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

describe('WorkflowStatusToggle', () => {
  it('calls onToggle with the next state', async () => {
    const onToggle = vi.fn()
    await mount(createElement(WorkflowStatusToggle, { enabled: false, onToggle }))
    container.querySelector('[data-testid="status-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('uses the same compact switch presentation wherever it is mounted', async () => {
    await mount(createElement(WorkflowStatusToggle, {
      enabled: true,
      testId: 'sidebar-workflow-toggle',
      onToggle: vi.fn(),
    }))

    const toggle = container.querySelector('[data-testid="sidebar-workflow-toggle"]')
    expect(toggle?.className).toContain('h-5')
    expect(toggle?.className).toContain('w-9')
    expect(toggle?.getAttribute('aria-label')).toBe('Disable workflow')
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
  })
})
