import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WhiteboardTemplateLibraryDialog } from './WhiteboardTemplateLibraryDialog'

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

async function mount(onSelect = vi.fn().mockResolvedValue(true)) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(WhiteboardTemplateLibraryDialog, {
      open: true,
      onOpenChange: vi.fn(),
      onSelect,
    }))
    await Promise.resolve()
  })
  return onSelect
}

describe('WhiteboardTemplateLibraryDialog', () => {
  it('renders the Board template center before a Board is created', async () => {
    await mount()

    expect(document.body.textContent).toContain('Board template center')
    expect(document.querySelector('[data-testid="whiteboard-template-library-dialog"]')).not.toBeNull()
    expect(document.querySelectorAll('button[data-testid^="workspace-template-category-"]')).toHaveLength(4)
    expect(document.querySelector('[data-testid="whiteboard-template-blank"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="whiteboard-template-create-mind-map"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="whiteboard-template-create-flowchart"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="whiteboard-template-create-kanban-board"]')).not.toBeNull()
  })

  it('creates a blank Board without a template selection', async () => {
    const onSelect = await mount()

    await act(async () => {
      const blank = document.querySelector('[data-testid="whiteboard-template-blank"]') as HTMLButtonElement
      blank.click()
      await Promise.resolve()
    })

    expect(onSelect).toHaveBeenCalledWith()
  })

  it('creates localized editable Board records from the selected template', async () => {
    const onSelect = await mount()

    await act(async () => {
      const flowchart = document.querySelector(
        '[data-testid="whiteboard-template-create-flowchart"]',
      ) as HTMLButtonElement
      flowchart.click()
      await Promise.resolve()
    })

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      templateId: 'flowchart',
      title: 'Flowchart',
      template: expect.objectContaining({
        bindings: expect.any(Array),
        elements: expect.arrayContaining([
          expect.objectContaining({ kind: 'rectangle', text: 'Collect requirements' }),
          expect.objectContaining({ kind: 'connector' }),
        ]),
      }),
    }))
  })

  it('filters templates by category', async () => {
    await mount()

    await act(async () => {
      const category = document.querySelector(
        '[data-testid="workspace-template-category-presentation"]',
      ) as HTMLButtonElement
      category.click()
      await Promise.resolve()
    })

    expect(document.querySelector('[data-testid="whiteboard-template-create-presentation-storyboard"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="whiteboard-template-create-mind-map"]')).toBeNull()
    expect(document.querySelector('[data-testid="whiteboard-template-blank"]')).toBeNull()
  })
})
