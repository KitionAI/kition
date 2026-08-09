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
        onDuplicateView: vi.fn(),
        onDeleteView: vi.fn(),
        busy: false,
      } as never))
    })

    expect(container.querySelector<HTMLButtonElement>('[aria-label="Grid view"]')).toBeTruthy()
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="data-view-menu-31"]')?.click()
    })
    expect(container.querySelector<HTMLInputElement>('[data-testid="data-view-rename-31"]')).toBeNull()
    expect(Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent)).toEqual([
      'Rename view',
      'Duplicate view',
      'Delete view',
    ])
    act(() => {
      document.body.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click()
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

  it('duplicates and deletes a view from the three-dot menu', () => {
    const onDuplicateView = vi.fn()
    const onDeleteView = vi.fn()

    act(() => {
      root = createRoot(container)
      root.render(createElement(TableEditorToolbarHeader, {
        tableViews: [
          { id: 31, title: 'Grid view', type: 'grid' },
          { id: 32, title: 'Gallery view', type: 'gallery' },
        ],
        activeViewId: 31,
        onSelectView: vi.fn(),
        viewCreateOpen: false,
        onToggleViewCreate: vi.fn(),
        onCloseViewCreate: vi.fn(),
        onCreateView: vi.fn(),
        onRenameView: vi.fn(),
        onDuplicateView,
        onDeleteView,
        busy: false,
      } as never))
    })

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="data-view-menu-31"]')?.click()
    })
    act(() => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((item) => item.textContent === 'Duplicate view')
        ?.click()
    })
    expect(onDuplicateView).toHaveBeenCalledWith(31)

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="data-view-menu-31"]')?.click()
    })
    act(() => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((item) => item.textContent === 'Delete view')
        ?.click()
    })
    expect(onDeleteView).toHaveBeenCalledWith(31)
  })

  it('keeps delete disabled when the table has only one view', () => {
    act(() => {
      root = createRoot(container)
      root.render(createElement(TableEditorToolbarHeader, {
        tableViews: [{ id: 31, title: 'Grid view', type: 'grid' }],
        activeViewId: 31,
        onSelectView: vi.fn(),
        viewCreateOpen: false,
        onToggleViewCreate: vi.fn(),
        onCloseViewCreate: vi.fn(),
        onCreateView: vi.fn(),
        onRenameView: vi.fn(),
        onDuplicateView: vi.fn(),
        onDeleteView: vi.fn(),
        busy: false,
      } as never))
    })

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="data-view-menu-31"]')?.click()
    })
    const deleteItem = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === 'Delete view')
    expect(deleteItem?.disabled).toBe(true)
  })
})
