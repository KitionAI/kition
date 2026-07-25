import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NodeCard } from './NodeCard'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  container.remove()
})

async function mount(element: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(element)
    await Promise.resolve()
  })
}

describe('NodeCard', () => {
  it('renders kind, title and description from props', async () => {
    await mount(
      createElement(NodeCard, {
        kind: 'trigger',
        rowLabel: 'Step 1',
        title: 'When a record is created',
        description: 'Object · Leads · No filter',
        status: 'green',
      }),
    )
    const node = container.querySelector('[data-testid="workflow-canvas-node"]')
    expect(node).toBeTruthy()
    expect(node!.getAttribute('data-node-role')).toBe('trigger')
    expect(node!.getAttribute('data-status')).toBe('green')
    expect(node!.textContent).toContain('When a record is created')
    expect(node!.textContent).toContain('Object · Leads · No filter')
  })

  it('exposes selection state as data-selected for parents to query in tests', async () => {
    await mount(
      createElement(NodeCard, {
        kind: 'action',
        rowLabel: 'Step 2',
        title: 'Send email',
        description: 'to x@y',
        status: 'red',
        selected: true,
      }),
    )
    expect(container.querySelector('[data-testid="workflow-canvas-node"]')!.getAttribute('data-selected')).toBe('true')
  })

  it('renders inline error and fires onFix when the Fix button is clicked', async () => {
    const handleFix = vi.fn()
    await mount(
      createElement(NodeCard, {
        kind: 'action',
        rowLabel: 'Step 2',
        title: 'Send email',
        description: 'to x@y',
        status: 'red',
        inlineError: { message: 'smtp host not configured', onFix: handleFix },
      }),
    )
    const error = container.querySelector('[data-testid="workflow-node-error"]')
    expect(error?.textContent).toContain('smtp host not configured')
    const fixButton = container.querySelector('[data-testid="workflow-node-fix"]') as HTMLButtonElement | null
    expect(fixButton).toBeTruthy()
    await act(async () => {
      fixButton!.click()
      await Promise.resolve()
    })
    expect(handleFix).toHaveBeenCalledTimes(1)
  })

  it('Fix button click does not bubble to the card select handler', async () => {
    const handleSelect = vi.fn()
    const handleFix = vi.fn()
    await mount(
      createElement(NodeCard, {
        kind: 'action',
        rowLabel: 'Step 2',
        title: 'Send email',
        description: 'to x@y',
        status: 'red',
        onSelect: handleSelect,
        inlineError: { message: 'failure', onFix: handleFix },
      }),
    )
    const fixButton = container.querySelector('[data-testid="workflow-node-fix"]') as HTMLButtonElement
    await act(async () => {
      fixButton.click()
      await Promise.resolve()
    })
    expect(handleFix).toHaveBeenCalled()
    expect(handleSelect).not.toHaveBeenCalled()
  })

  it('Ask AI pill is rendered only when onAskAI is wired', async () => {
    await mount(
      createElement(NodeCard, {
        kind: 'action',
        rowLabel: 'Step 2',
        title: 'Send email',
        description: 'to x@y',
        status: 'green',
      }),
    )
    expect(container.querySelector('[data-testid="workflow-node-ask-ai"]')).toBeNull()

    await mount(
      createElement(NodeCard, {
        kind: 'action',
        rowLabel: 'Step 2',
        title: 'Send email',
        description: 'to x@y',
        status: 'green',
        onAskAI: () => {},
      }),
    )
    expect(container.querySelector('[data-testid="workflow-node-ask-ai"]')).toBeTruthy()
  })

  it('exposes aria-pressed mirroring the selected state so screen readers can distinguish the active card', async () => {
    await mount(
      createElement(NodeCard, {
        kind: 'trigger',
        rowLabel: 'Step 1',
        title: 'T',
        description: 'd',
        status: 'green',
        selected: false,
      }),
    )
    let card = container.querySelector('[data-testid="workflow-canvas-node"]')!
    expect(card.getAttribute('aria-pressed')).toBe('false')
    expect(card.getAttribute('role')).toBe('button')
    expect(card.getAttribute('tabindex')).toBe('0')

    await mount(
      createElement(NodeCard, {
        kind: 'trigger',
        rowLabel: 'Step 1',
        title: 'T',
        description: 'd',
        status: 'green',
        selected: true,
      }),
    )
    card = container.querySelector('[data-testid="workflow-canvas-node"]')!
    expect(card.getAttribute('aria-pressed')).toBe('true')
  })

  it('uses aria-disabled (not the HTML disabled attribute) for "paused" cards so they stay keyboard-reachable', async () => {
    await mount(
      createElement(NodeCard, {
        kind: 'action',
        rowLabel: 'Step 2',
        title: 'Send email',
        description: 'd',
        status: 'muted',
        disabled: true,
      }),
    )
    const card = container.querySelector('[data-testid="workflow-canvas-node"]')!
    expect(card.getAttribute('aria-disabled')).toBe('true')
    // tabIndex is still 0 — disabled here is semantic ("paused"), not
    // structural ("non-interactive"). The user can still focus to
    // re-enable it from the drawer.
    expect(card.getAttribute('tabindex')).toBe('0')
  })
})
