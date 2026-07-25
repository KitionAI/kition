import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DataField } from '@/types/dataDocument'

import { TableColumnHeaderMenu } from './TableColumnHeaderMenu'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
}

function makeField(overrides: Partial<DataField> = {}): DataField {
  return {
    id: 1,
    user_id: 1,
    document_id: 1,
    table_id: 1,
    name: 'title',
    title: 'Title',
    type: 'text',
    required: false,
    unique: false,
    readonly: false,
    is_primary: false,
    order: 1,
    options: {},
    ai_config: null,
    created_at: '2026-06-11T00:00:00Z',
    updated_at: '2026-06-11T00:00:00Z',
    ...overrides,
  }
}

function noopHandlers() {
  return {
    onClose: vi.fn(),
    onEditField: vi.fn(),
    onDuplicateField: vi.fn(),
    onRunAIBatch: vi.fn(),
    onDownloadAllFiles: vi.fn(),
    onAddColumnToChat: vi.fn(),
    onInsertField: vi.fn(),
    onAddFilterForField: vi.fn(),
    onAddSortForField: vi.fn(),
    onSetGroupField: vi.fn(),
    onFreezeUpTo: vi.fn(),
    onHideField: vi.fn(),
    onDeleteField: vi.fn(),
  }
}

function labels(): string[] {
  return Array.from(
    container.querySelectorAll('.data-inline-record-menu-item'),
  ).map((node) => (node.textContent ?? '').trim())
}

describe('TableColumnHeaderMenu', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('renders nothing without a menu position', async () => {
    const handlers = noopHandlers()
    await mount(
      createElement(TableColumnHeaderMenu, {
        menu: null,
        field: makeField(),
        busy: false,
        ...handlers,
      }),
    )
    expect(container.querySelector('[data-testid="kitable-column-header-menu"]')).toBeNull()
  })

  it('hides AI items when ai_config is disabled and field is not attachment', async () => {
    const handlers = noopHandlers()
    await mount(
      createElement(TableColumnHeaderMenu, {
        menu: { x: 100, y: 80 },
        field: makeField(),
        busy: false,
        ...handlers,
      }),
    )
    const items = labels()
    expect(items).not.toContain('Generate')
    expect(items).not.toContain('Add to Chat')
    expect(items).not.toContain('Download all files')
    expect(items).toContain('Edit field')
    expect(items).toContain('Duplicate field')
    expect(items).toContain('Insert left')
    expect(items).toContain('Insert right')
    expect(items).toContain('Delete field')
  })

  it('shows Download all files for attachment fields', async () => {
    const handlers = noopHandlers()
    await mount(
      createElement(TableColumnHeaderMenu, {
        menu: { x: 100, y: 80 },
        field: makeField({ type: 'attachment' }),
        busy: false,
        ...handlers,
      }),
    )
    expect(labels()).toContain('Download all files')
  })

  it('shows Generate and Add to chat when ai_config.enabled is true', async () => {
    const handlers = noopHandlers()
    await mount(
      createElement(TableColumnHeaderMenu, {
        menu: { x: 100, y: 80 },
        field: makeField({
          ai_config: {
            type: 'customize',
            enabled: true,
            auto_update: false,
            prompt: 'do something',
          } as DataField['ai_config'],
        }),
        busy: false,
        ...handlers,
      }),
    )
    const items = labels()
    expect(items).toContain('Generate')
    expect(items).toContain('Add to chat')
  })

  it('disables Hide field and Delete field on primary fields', async () => {
    const handlers = noopHandlers()
    await mount(
      createElement(TableColumnHeaderMenu, {
        menu: { x: 100, y: 80 },
        field: makeField({ is_primary: true }),
        busy: false,
        ...handlers,
      }),
    )
    const hide = Array.from(container.querySelectorAll<HTMLButtonElement>('.data-inline-record-menu-item')).find(
      (node) => (node.textContent ?? '').includes('Hide field'),
    )
    const remove = Array.from(container.querySelectorAll<HTMLButtonElement>('.data-inline-record-menu-item')).find(
      (node) => (node.textContent ?? '').includes('Delete field'),
    )
    expect(hide?.disabled).toBe(true)
    expect(remove?.disabled).toBe(true)
  })

  it('invokes the matching handler and closes when an item is clicked', async () => {
    const handlers = noopHandlers()
    const field = makeField()
    await mount(
      createElement(TableColumnHeaderMenu, {
        menu: { x: 100, y: 80 },
        field,
        busy: false,
        ...handlers,
      }),
    )
    const duplicate = Array.from(container.querySelectorAll<HTMLButtonElement>('.data-inline-record-menu-item')).find(
      (node) => (node.textContent ?? '').includes('Duplicate field'),
    )
    expect(duplicate).toBeTruthy()
    await act(async () => {
      duplicate?.click()
      await Promise.resolve()
    })
    expect(handlers.onDuplicateField).toHaveBeenCalledWith(field)
    expect(handlers.onClose).toHaveBeenCalled()
  })

  it('invokes onInsertField with the correct side', async () => {
    const handlers = noopHandlers()
    const field = makeField()
    await mount(
      createElement(TableColumnHeaderMenu, {
        menu: { x: 100, y: 80 },
        field,
        busy: false,
        ...handlers,
      }),
    )
    const insertRight = Array.from(container.querySelectorAll<HTMLButtonElement>('.data-inline-record-menu-item')).find(
      (node) => (node.textContent ?? '').includes('Insert right'),
    )
    await act(async () => {
      insertRight?.click()
      await Promise.resolve()
    })
    expect(handlers.onInsertField).toHaveBeenCalledWith('after', field)
  })
})
