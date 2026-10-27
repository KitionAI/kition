import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceWorkflowCreateModeDialog } from './WorkspaceWorkflowCreateModeDialog'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.clearAllMocks()
})

describe('WorkspaceWorkflowCreateModeDialog template picker', () => {
  it('creates a workflow from a built-in template', async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WorkspaceWorkflowCreateModeDialog, {
        open: true,
        onOpenChange: vi.fn(),
        context: null,
        onSelect,
      }))
      await Promise.resolve()
    })

    await act(async () => {
      (document.querySelector('[data-testid="create-mode-template"]') as HTMLButtonElement).click()
    })
    const cards = document.querySelectorAll<HTMLButtonElement>('[data-testid="workflow-launcher-template-card"]')
    expect(cards.length).toBeGreaterThan(0)

    await act(async () => cards[0].click())
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'template', context: null }))
  })
})
