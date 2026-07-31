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
    expect(document.querySelectorAll('button[data-testid^="workspace-template-category-"]').length).toBe(8)
    expect(document.querySelector('[data-testid="kitable-template-task-tracker"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-email-inbox-sync"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-product-launch-website"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-blank"]')).not.toBeNull()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('shows the email inbox template with its full-sync automation resource', async () => {
    await mount()

    const card = document.querySelector('[data-testid="kitable-template-email-inbox-sync"]') as HTMLButtonElement
    expect(card.textContent).toContain('Email Inbox Sync')
    expect(card.textContent).toContain('Full history first')

    await act(async () => {
      card.click()
      await Promise.resolve()
    })

    expect(document.querySelector('[data-testid="kitable-template-resource-inbox"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-resource-full-inbox-sync"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Structure only')
  })

  it('filters the catalog by the selected operational category', async () => {
    await mount()

    await act(async () => {
      const category = document.querySelector('[data-testid="workspace-template-category-human-resources"]') as HTMLButtonElement
      category.click()
      await Promise.resolve()
    })

    expect(document.querySelector('[data-testid="kitable-template-recruitment-pipeline"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-employee-attendance"]')).toBeNull()
    expect(document.querySelector('[data-testid="kitable-template-task-tracker"]')).toBeNull()
  })

  it('shows the bundled thumbnail output and only the source table resource', async () => {
    await mount()

    const card = document.querySelector('[data-testid="kitable-template-thumbnail-generator"]') as HTMLButtonElement
    const preview = card.querySelector('img')
    expect(preview?.getAttribute('src')).toBe(
      '/templates/youtube-tiktok-thumbnail-generator/records/record-01/thumbnail-16x9-01.png',
    )

    await act(async () => {
      card.click()
      await Promise.resolve()
    })

    expect(document.querySelector('[data-testid="kitable-template-resource-thumbnail-workbench"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Thumbnail generation')
  })

  it('shows an original bundled product design image in the designer preview', async () => {
    await mount()

    await act(async () => {
      const category = document.querySelector('[data-testid="workspace-template-category-popular"]') as HTMLButtonElement
      category.click()
      await Promise.resolve()
    })

    const card = document.querySelector('[data-testid="kitable-template-batch-product-designer"]') as HTMLButtonElement
    const preview = card.querySelector('img')
    expect(preview?.getAttribute('src')).toBe(
      '/templates/batch-product-designer/records/record-01/style-board-01.png',
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
