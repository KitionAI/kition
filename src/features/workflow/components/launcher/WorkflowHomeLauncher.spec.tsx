import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkflowHomeLauncher } from './WorkflowHomeLauncher'
import type { WorkflowHomeLauncherProps } from './WorkflowHomeLauncher'

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

function queryByTestId(id: string) {
  return container.querySelector(`[data-testid="${id}"]`)
}

function makeProps(overrides: Partial<WorkflowHomeLauncherProps> = {}): WorkflowHomeLauncherProps {
  return {
    onGenerateWithAi: vi.fn(),
    onStartFromScratch: vi.fn(),
    onTemplateSelect: vi.fn(),
    onAgentClick: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  container.remove()
})

describe('WorkflowHomeLauncher', () => {
  it('renders gallery hero with both CTAs', async () => {
    await mount(createElement(WorkflowHomeLauncher, makeProps()))
    expect(container.textContent).toContain('Automate any task with workflows')
    expect(queryByTestId('workflow-home-launcher-cta-ai')).not.toBeNull()
    expect(queryByTestId('workflow-home-launcher-cta-scratch')).not.toBeNull()
  })

  it('fires onGenerateWithAi when the AI CTA is clicked', async () => {
    const onGenerateWithAi = vi.fn()
    await mount(createElement(WorkflowHomeLauncher, makeProps({ onGenerateWithAi })))
    await act(async () => {
      queryByTestId('workflow-home-launcher-cta-ai')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onGenerateWithAi).toHaveBeenCalledTimes(1)
  })

  it('fires onStartFromScratch when the scratch CTA is clicked', async () => {
    const onStartFromScratch = vi.fn()
    await mount(createElement(WorkflowHomeLauncher, makeProps({ onStartFromScratch })))
    await act(async () => {
      queryByTestId('workflow-home-launcher-cta-scratch')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onStartFromScratch).toHaveBeenCalledTimes(1)
  })

  it('fires onTemplateSelect with the template when a card is clicked', async () => {
    const onTemplateSelect = vi.fn()
    await mount(createElement(WorkflowHomeLauncher, makeProps({ onTemplateSelect })))
    const card = container.querySelector('[data-testid="workflow-launcher-template-card"]')
    expect(card).not.toBeNull()
    await act(async () => {
      card!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onTemplateSelect).toHaveBeenCalledTimes(1)
    expect(onTemplateSelect.mock.calls[0][0]).toHaveProperty('id')
  })

  it('fires onAgentClick when the agent card is clicked', async () => {
    const onAgentClick = vi.fn()
    await mount(createElement(WorkflowHomeLauncher, makeProps({ onAgentClick })))
    const agentCard = container.querySelector('[data-testid="workflow-launcher-agent-card"]')
    expect(agentCard).not.toBeNull()
    await act(async () => {
      agentCard!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onAgentClick).toHaveBeenCalledTimes(1)
  })

  it('disables both CTAs while a busyAction is in flight', async () => {
    await mount(createElement(WorkflowHomeLauncher, makeProps({ busyAction: 'scratch' })))
    const aiBtn = queryByTestId('workflow-home-launcher-cta-ai') as HTMLButtonElement
    const scratchBtn = queryByTestId('workflow-home-launcher-cta-scratch') as HTMLButtonElement
    expect(aiBtn.disabled).toBe(true)
    expect(scratchBtn.disabled).toBe(true)
  })

  it('renders the inline error message when errorMessage is set', async () => {
    await mount(createElement(WorkflowHomeLauncher, makeProps({ errorMessage: 'boom' })))
    const err = queryByTestId('workflow-home-launcher-error')
    expect(err).not.toBeNull()
    expect(err?.textContent).toContain('boom')
  })

  it('opens the template sheet when Explore more is clicked', async () => {
    await mount(createElement(WorkflowHomeLauncher, makeProps()))
    expect(queryByTestId('workflow-launcher-template-sheet')).toBeNull()
    const explore = queryByTestId('workflow-launcher-explore-more')
    expect(explore).not.toBeNull()
    await act(async () => {
      explore!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(queryByTestId('workflow-launcher-template-sheet')).not.toBeNull()
  })

  it('renders scope-specific hero copy when scopeLabel is provided', async () => {
    await mount(createElement(WorkflowHomeLauncher, makeProps({ scopeLabel: 'Sales pipeline' })))
    expect(container.textContent).toContain('Automate Sales pipeline')
    expect(container.textContent).toContain('No workflows yet for Sales pipeline')
    expect(queryByTestId('workflow-home-launcher')?.getAttribute('data-scope-label')).toBe('Sales pipeline')
  })
})
