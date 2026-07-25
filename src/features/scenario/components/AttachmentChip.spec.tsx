import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScenarioDraftAttachment } from '@/features/scenario/types'

import { AttachmentChip } from './AttachmentChip'

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

function makeImageAttachment(): ScenarioDraftAttachment {
  return {
    id: 'att-1',
    file: new File(['hello'], 'photo.png', { type: 'image/png' }),
    previewUrl: 'blob:mock-image-url',
  }
}

function makeNonImageAttachment(): ScenarioDraftAttachment {
  return {
    id: 'att-2',
    file: new File(['hello'], 'report.pdf', { type: 'application/pdf' }),
    previewUrl: null,
  }
}

describe('AttachmentChip', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('renders the file name', async () => {
    await mount(
      createElement(AttachmentChip, {
        attachment: makeImageAttachment(),
        onRemove: vi.fn(),
      }),
    )
    expect(container.textContent).toContain('photo.png')
  })

  it('renders an image thumbnail when previewUrl is non-null', async () => {
    await mount(
      createElement(AttachmentChip, {
        attachment: makeImageAttachment(),
        onRemove: vi.fn(),
      }),
    )
    const img = container.querySelector(
      '[data-testid="scenario-chip-thumb"]',
    ) as HTMLImageElement | null
    expect(img).not.toBeNull()
    expect(img!.tagName).toBe('IMG')
    expect(img!.src).toBe('blob:mock-image-url')
  })

  it('renders a fallback file icon when previewUrl is null', async () => {
    await mount(
      createElement(AttachmentChip, {
        attachment: makeNonImageAttachment(),
        onRemove: vi.fn(),
      }),
    )
    expect(
      container.querySelector('[data-testid="scenario-chip-thumb"]'),
    ).toBeNull()
    expect(
      container.querySelector('[data-testid="scenario-chip-fallback-icon"]'),
    ).not.toBeNull()
  })

  it('invokes onRemove when the × button is clicked', async () => {
    const onRemove = vi.fn()
    await mount(
      createElement(AttachmentChip, {
        attachment: makeImageAttachment(),
        onRemove,
      }),
    )
    const closeBtn = container.querySelector(
      '[data-testid="scenario-chip-remove"]',
    ) as HTMLButtonElement | null
    expect(closeBtn).not.toBeNull()
    await act(async () => {
      closeBtn!.click()
    })
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
