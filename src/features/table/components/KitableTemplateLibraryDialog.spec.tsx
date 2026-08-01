import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KitableTemplateLibraryDialog } from './KitableTemplateLibraryDialog'

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
    root.render(createElement(KitableTemplateLibraryDialog, {
      open: true,
      onOpenChange: vi.fn(),
      onSelect,
    }))
    await Promise.resolve()
  })
  return onSelect
}

describe('KitableTemplateLibraryDialog', () => {
  it('renders the categorized template center and a blank option', async () => {
    await mount()

    expect(document.body.textContent).toContain('Template Center')
    const dialog = document.querySelector('[data-testid="kitable-template-library-dialog"]')
    expect(dialog?.className).toContain('md:w-[min(1040px')
    expect(dialog?.className).not.toContain('md:w-full')
    expect(document.body.textContent).toContain('New table workspace')
    expect(document.querySelectorAll('button[data-testid^="workspace-template-category-"]').length).toBe(4)
    expect(document.querySelector('[data-testid="kitable-template-task-tracker"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-email-inbox-sync"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-product-launch-website"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-blank"]')).not.toBeNull()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('shows the email inbox template with its full-sync automation resource', async () => {
    await mount()

    const card = document.querySelector('[data-testid="kitable-template-email-inbox-sync"]') as HTMLButtonElement
    expect(card.closest('article')?.textContent).toContain('Email Inbox Sync')
    expect(card.closest('article')?.textContent).toContain('complete history')
    expect(card.querySelector('img')?.getAttribute('src')).toBe('/templates/table-covers/email-inbox-sync.webp')

    await act(async () => {
      card.click()
      await Promise.resolve()
    })

    expect(document.querySelector('[data-testid="kitable-template-resource-inbox"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-resource-full-inbox-sync"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Structure only')
  })

  it('keeps the business catalog focused on active templates', async () => {
    await mount()

    await act(async () => {
      const category = document.querySelector('[data-testid="workspace-template-category-business"]') as HTMLButtonElement
      category.click()
      await Promise.resolve()
    })

    expect(document.querySelector('[data-testid="kitable-template-ecommerce-orders-returns"]')).toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-recruitment-pipeline"]')).toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-product-launch-website"]')).not.toBeNull()
  })

  it('shows the generated thumbnail template cover and only the source table resource', async () => {
    await mount()

    const card = document.querySelector('[data-testid="kitable-template-thumbnail-generator"]') as HTMLButtonElement
    const preview = card.querySelector('img')
    expect(preview?.getAttribute('src')).toBe(
      '/templates/table-covers/thumbnail-generator.webp',
    )

    await act(async () => {
      card.click()
      await Promise.resolve()
    })

    expect(document.querySelector('[data-testid="kitable-template-resource-thumbnail-workbench"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Thumbnail generation')
  })

  it('shows the generated product design template cover', async () => {
    await mount()

    await act(async () => {
      const category = document.querySelector('[data-testid="workspace-template-category-business"]') as HTMLButtonElement
      category.click()
      await Promise.resolve()
    })

    const card = document.querySelector('[data-testid="kitable-template-batch-product-designer"]') as HTMLButtonElement
    const preview = card.querySelector('img')
    expect(preview?.getAttribute('src')).toBe(
      '/templates/table-covers/batch-product-designer.webp',
    )
  })

  it('opens a read-only resource preview before using the selected package', async () => {
    const onSelect = await mount()

    await act(async () => {
      const card = document.querySelector('[data-testid="kitable-template-simple-client-crm"]') as HTMLButtonElement
      card.click()
      await Promise.resolve()
    })

    expect(onSelect).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="kitable-template-detail"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-resource-clients"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Read-only preview')

    await act(async () => {
      const useButton = document.querySelector('[data-testid="kitable-template-use"]') as HTMLButtonElement
      useButton.click()
      await Promise.resolve()
    })

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      id: 'simple-client-crm',
      snapshot: expect.objectContaining({
        includeData: true,
        defaultResourceId: 'clients',
      }),
      tables: expect.arrayContaining([
        expect.objectContaining({ title: 'Clients', records: expect.any(Array) }),
        expect.objectContaining({ title: 'Quotes', records: expect.any(Array) }),
      ]),
    }))
  })
})
