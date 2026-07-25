import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowLauncherTemplateGrid } from './WorkflowLauncherTemplateGrid'
import type { WorkflowTemplate } from '@/features/workflow/templates'

function makeTpls(count: number): WorkflowTemplate[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    name: `T${i}`,
    description: '',
    icons: [{ kind: 'lucide' as const, name: 'Send' as const }],
    draft: {} as never,
  }))
}

const baseProps = {
  onSelect: () => {},
  onExploreMore: () => {},
  onAgentClick: () => {},
}

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

describe('WorkflowLauncherTemplateGrid', () => {
  it('with exactly 5 templates: renders 3 cards inline + ExploreMore in slot 3 + Agent in slot 5', async () => {
    await mount(createElement(WorkflowLauncherTemplateGrid, { ...baseProps, templates: makeTpls(5) }))
    const cards = container.querySelectorAll('[data-testid="workflow-launcher-template-card"]')
    expect(cards).toHaveLength(3)
    expect(container.querySelector('[data-testid="workflow-launcher-explore-more"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="workflow-launcher-agent-card"]')).not.toBeNull()
  })

  it('with 3 templates: hides ExploreMore and uses slot 3 for builtins[2]', async () => {
    await mount(createElement(WorkflowLauncherTemplateGrid, { ...baseProps, templates: makeTpls(3) }))
    const cards = container.querySelectorAll('[data-testid="workflow-launcher-template-card"]')
    expect(cards).toHaveLength(3)
    expect(container.querySelector('[data-testid="workflow-launcher-explore-more"]')).toBeNull()
    expect(container.querySelector('[data-testid="workflow-launcher-agent-card"]')).not.toBeNull()
  })

  it('AgentCard always renders even when templates is empty', async () => {
    await mount(createElement(WorkflowLauncherTemplateGrid, { ...baseProps, templates: [] }))
    const cards = container.querySelectorAll('[data-testid="workflow-launcher-template-card"]')
    expect(cards).toHaveLength(0)
    expect(container.querySelector('[data-testid="workflow-launcher-agent-card"]')).not.toBeNull()
  })

  it('clicking ExploreMore card fires onExploreMore', async () => {
    const onExploreMore = vi.fn()
    await mount(createElement(WorkflowLauncherTemplateGrid, { ...baseProps, templates: makeTpls(5), onExploreMore }))
    container.querySelector('[data-testid="workflow-launcher-explore-more"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onExploreMore).toHaveBeenCalled()
  })
})
