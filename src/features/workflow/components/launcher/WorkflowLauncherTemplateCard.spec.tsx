import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowLauncherTemplateCard } from './WorkflowLauncherTemplateCard'
import type { WorkflowTemplate } from '@/features/workflow/templates'

const tpl: WorkflowTemplate = {
  id: 'demo',
  name: 'Demo template',
  description: 'A demo',
  icons: [
    { kind: 'lucide', name: 'AlarmClock' },
    { kind: 'lucide', name: 'Send' },
  ],
  badgeCount: 1,
  draft: {} as never,
}

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

describe('WorkflowLauncherTemplateCard', () => {
  it('renders the template name and 2 icons', async () => {
    await mount(createElement(WorkflowLauncherTemplateCard, { template: tpl, onSelect: () => {} }))
    expect(container.textContent).toContain('Demo template')
    const icons = container.querySelectorAll('[data-testid="workflow-launcher-template-card-icon"]')
    expect(icons).toHaveLength(2)
  })

  it('renders the badge count chip when provided', async () => {
    await mount(createElement(WorkflowLauncherTemplateCard, { template: tpl, onSelect: () => {} }))
    expect(container.textContent).toContain('+1')
  })

  it('omits the badge chip when badgeCount is undefined', async () => {
    await mount(createElement(WorkflowLauncherTemplateCard, { template: { ...tpl, badgeCount: undefined }, onSelect: () => {} }))
    expect(container.textContent).not.toMatch(/^\+\d+$/)
  })

  it('fires onSelect when the card is clicked', async () => {
    const onSelect = vi.fn()
    await mount(createElement(WorkflowLauncherTemplateCard, { template: tpl, onSelect }))
    container.querySelector('[data-testid="workflow-launcher-template-card"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onSelect).toHaveBeenCalledWith(tpl)
  })

  it('disables interaction when busy=true', async () => {
    const onSelect = vi.fn()
    await mount(createElement(WorkflowLauncherTemplateCard, { template: tpl, onSelect, busy: true }))
    container.querySelector('[data-testid="workflow-launcher-template-card"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
