import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TableEditorToolbarHeader } from './TableEditorToolbarHeader'

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
  vi.unstubAllGlobals()
})

describe('TableEditorToolbarHeader', () => {
  it('normalizes the legacy inbox view and renames it from the view menu', () => {
    const onRenameView = vi.fn()

    act(() => {
      root = createRoot(container)
      root.render(createElement(TableEditorToolbarHeader, {
        tableViews: [{ id: 31, title: 'All messages', type: 'grid' }],
        activeViewId: 31,
        onSelectView: vi.fn(),
        viewCreateOpen: false,
        onToggleViewCreate: vi.fn(),
        onCloseViewCreate: vi.fn(),
        onCreateView: vi.fn(),
        onRenameView,
        busy: false,
      } as never))
    })

    expect(container.querySelector<HTMLButtonElement>('[aria-label="Grid view"]')).toBeTruthy()
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="data-view-menu-31"]')?.click()
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click()
    })
    const renameInput = container.querySelector<HTMLInputElement>('[data-testid="data-view-rename-31"]')
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(renameInput, 'Inbox grid')
      renameInput?.dispatchEvent(new Event('input', { bubbles: true }))
      renameInput?.blur()
    })

    expect(onRenameView).toHaveBeenCalledWith(31, 'Inbox grid')
  })
})
