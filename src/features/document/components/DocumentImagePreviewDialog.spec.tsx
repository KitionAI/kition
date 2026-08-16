import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocumentImagePreviewDialog } from './DocumentImagePreviewDialog'

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
  vi.restoreAllMocks()
})

async function mount(onClose = vi.fn()) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(DocumentImagePreviewDialog, {
      image: { src: 'https://example.com/image.png', alt: 'Diagram' },
      onClose,
    }))
    await Promise.resolve()
  })
  return onClose
}

describe('DocumentImagePreviewDialog', () => {
  it('renders the selected image in a modal preview', async () => {
    await mount()

    const dialog = document.querySelector('[role="dialog"]')
    const image = dialog?.querySelector('img')
    expect(dialog?.getAttribute('aria-label')).toContain('Diagram')
    expect(image?.getAttribute('src')).toBe('https://example.com/image.png')
  })

  it('closes from the button and Escape key', async () => {
    const onClose = await mount()

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="document-image-preview-close"]')?.click()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
