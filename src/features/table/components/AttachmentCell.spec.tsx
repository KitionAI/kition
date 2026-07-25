import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DataAttachment } from '@/types/dataDocument'

import { AttachmentCell } from './AttachmentCell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/services/desktop', () => ({
  resolvePublicFileURL: (path: string) => path,
}))

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

function makeAttachments(count: number, asImage = true): DataAttachment[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `file-${i}.${asImage ? 'png' : 'pdf'}`,
    url: `/uploads/file-${i}.${asImage ? 'png' : 'pdf'}`,
    mimeType: asImage ? 'image/png' : 'application/pdf',
  }))
}

describe('AttachmentCell', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('renders one thumbnail per attachment up to three', async () => {
    await mount(
      createElement(AttachmentCell, {
        attachments: makeAttachments(3),
        onPreview: vi.fn(),
      }),
    )
    const thumbs = container.querySelectorAll('[data-testid="attachment-thumb"]')
    expect(thumbs.length).toBe(3)
    expect(container.querySelector('[data-testid="attachment-overflow"]')).toBeNull()
  })

  it('caps thumbnails at 3 and shows +N overflow badge', async () => {
    await mount(
      createElement(AttachmentCell, {
        attachments: makeAttachments(5),
        onPreview: vi.fn(),
      }),
    )
    const thumbs = container.querySelectorAll('[data-testid="attachment-thumb"]')
    expect(thumbs.length).toBe(3)
    const overflow = container.querySelector('[data-testid="attachment-overflow"]')
    expect(overflow).not.toBeNull()
    expect(overflow!.textContent).toBe('+2')
  })

  it('exposes the expand affordance and routes its click through onPreview(0)', async () => {
    const onPreview = vi.fn()
    await mount(
      createElement(AttachmentCell, {
        attachments: makeAttachments(2),
        onPreview,
      }),
    )
    const expandBtn = container.querySelector(
      '[data-testid="attachment-expand"]',
    ) as HTMLButtonElement | null
    expect(expandBtn).not.toBeNull()
    await act(async () => {
      expandBtn!.click()
    })
    expect(onPreview).toHaveBeenCalledWith(0)
  })

  it('clicking a specific thumbnail fires onPreview with that index', async () => {
    const onPreview = vi.fn()
    await mount(
      createElement(AttachmentCell, {
        attachments: makeAttachments(3),
        onPreview,
      }),
    )
    const thumbs = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="attachment-thumb"]',
    )
    await act(async () => {
      thumbs[2].click()
    })
    expect(onPreview).toHaveBeenCalledWith(2)
  })

  it('renders nothing visible when there are no attachments', async () => {
    await mount(
      createElement(AttachmentCell, {
        attachments: [],
        onPreview: vi.fn(),
      }),
    )
    expect(container.querySelector('[data-testid="attachment-thumb"]')).toBeNull()
    expect(container.querySelector('[data-testid="attachment-expand"]')).toBeNull()
  })

  it('falls back to a file icon for non-image attachments', async () => {
    await mount(
      createElement(AttachmentCell, {
        attachments: makeAttachments(2, false),
        onPreview: vi.fn(),
      }),
    )
    const thumbs = container.querySelectorAll('[data-testid="attachment-thumb"]')
    expect(thumbs.length).toBe(2)
    // each thumb should contain an svg icon, not an img
    const imgs = container.querySelectorAll('[data-testid="attachment-thumb"] img')
    expect(imgs.length).toBe(0)
  })
})
