import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowLauncherTemplateSheet } from './WorkflowLauncherTemplateSheet'
import type { WorkflowTemplate } from '@/features/workflow/templates'

const tpls: WorkflowTemplate[] = [
  { id: 'a', name: 'Alpha template', description: 'Greek letter', icons: [{ kind: 'lucide', name: 'Send' }], draft: {} as never },
  { id: 'b', name: 'Beta template', description: 'Second letter', icons: [{ kind: 'lucide', name: 'Send' }], draft: {} as never },
  { id: 'c', name: 'Gamma template', description: 'Third letter', icons: [{ kind: 'lucide', name: 'Send' }], draft: {} as never },
]
const baseProps = { templates: tpls, onSelect: () => {}, onClose: () => {} }

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}

function queryByTestId(id: string) {
  return container.querySelector(`[data-testid="${id}"]`)
}

function getAllByTestId(id: string) {
  return Array.from(container.querySelectorAll(`[data-testid="${id}"]`))
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { root?.unmount(); container.remove() })

describe('WorkflowLauncherTemplateSheet', () => {
  it('renders nothing when open=false', async () => {
    await mount(createElement(WorkflowLauncherTemplateSheet, { ...baseProps, open: false }))
    expect(queryByTestId('workflow-launcher-template-sheet')).toBeNull()
  })

  it('renders all templates when open=true', async () => {
    await mount(createElement(WorkflowLauncherTemplateSheet, { ...baseProps, open: true }))
    expect(getAllByTestId('workflow-launcher-template-card').length).toBe(3)
  })

  it('filters by name on search', async () => {
    await mount(createElement(WorkflowLauncherTemplateSheet, { ...baseProps, open: true }))
    const input = queryByTestId('workflow-launcher-template-search') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'beta')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    const cards = getAllByTestId('workflow-launcher-template-card')
    expect(cards.length).toBe(1)
    expect(container.textContent).toContain('Beta template')
  })

  it('search is case-insensitive and matches description', async () => {
    await mount(createElement(WorkflowLauncherTemplateSheet, { ...baseProps, open: true }))
    const input = queryByTestId('workflow-launcher-template-search') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'GREEK')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    const cards = getAllByTestId('workflow-launcher-template-card')
    expect(cards.length).toBe(1)
    expect(container.textContent).toContain('Alpha template')
  })

  it('Esc closes the sheet', async () => {
    const onClose = vi.fn()
    await mount(createElement(WorkflowLauncherTemplateSheet, { ...baseProps, open: true, onClose }))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalled()
  })
})
