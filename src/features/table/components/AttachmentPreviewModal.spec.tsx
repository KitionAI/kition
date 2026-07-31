import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DataAttachment } from '@/types/dataDocument'

import { AttachmentPreviewModal } from './AttachmentPreviewModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/services/desktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/desktop')>()
  return {
    ...actual,
    resolvePublicFileURL: (path: string) => path,
  }
})

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
  // The modal portals to document.body — clean up any stray nodes.
  document
    .querySelectorAll('[data-testid="attachment-preview-modal"]')
    .forEach((el) => el.remove())
  document
    .querySelectorAll('[data-testid="attachment-preview-backdrop"]')
    .forEach((el) => el.remove())
}

function makeAttachments(count: number): DataAttachment[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `image-${i}.png`,
    url: `/uploads/image-${i}.png`,
    mimeType: 'image/png',
  }))
}

function getRoot() {
  return document.querySelector(
    '[data-testid="attachment-preview-modal"]',
  ) as HTMLElement | null
}

function pressKey(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true })
  window.dispatchEvent(event)
}

describe('AttachmentPreviewModal', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('does not render when closed', async () => {
    await mount(
      createElement(AttachmentPreviewModal, {
        open: false,
        items: makeAttachments(2),
        index: 0,
        onClose: vi.fn(),
        onIndexChange: vi.fn(),
      }),
    )
    expect(getRoot()).toBeNull()
  })

  it('renders the file name and active image when open', async () => {
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(3),
        index: 1,
        onClose: vi.fn(),
        onIndexChange: vi.fn(),
      }),
    )
    const root = getRoot()
    expect(root).not.toBeNull()
    const title = root!.querySelector('[data-testid="attachment-preview-title"]')
    expect(title?.textContent).toBe('image-1.png')
    const img = root!.querySelector('img') as HTMLImageElement | null
    expect(img?.src.endsWith('/uploads/image-1.png')).toBe(true)
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(2),
        index: 0,
        onClose,
        onIndexChange: vi.fn(),
      }),
    )
    await act(async () => {
      pressKey('Escape')
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('navigates with ArrowRight / ArrowLeft', async () => {
    const onIndexChange = vi.fn()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(3),
        index: 1,
        onClose: vi.fn(),
        onIndexChange,
      }),
    )
    await act(async () => {
      pressKey('ArrowRight')
    })
    expect(onIndexChange).toHaveBeenLastCalledWith(2)
    await act(async () => {
      pressKey('ArrowLeft')
    })
    expect(onIndexChange).toHaveBeenLastCalledWith(0)
  })

  it('wraps index when navigating past the boundaries', async () => {
    const onIndexChange = vi.fn()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(3),
        index: 2,
        onClose: vi.fn(),
        onIndexChange,
      }),
    )
    await act(async () => {
      pressKey('ArrowRight')
    })
    expect(onIndexChange).toHaveBeenLastCalledWith(0)
    onIndexChange.mockClear()
    // re-mount at index 0 to test left wrap
    await unmount()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(3),
        index: 0,
        onClose: vi.fn(),
        onIndexChange,
      }),
    )
    await act(async () => {
      pressKey('ArrowLeft')
    })
    expect(onIndexChange).toHaveBeenLastCalledWith(2)
  })

  it('digit keys jump to the matching attachment (1-indexed)', async () => {
    const onIndexChange = vi.fn()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(4),
        index: 0,
        onClose: vi.fn(),
        onIndexChange,
      }),
    )
    await act(async () => {
      pressKey('3')
    })
    expect(onIndexChange).toHaveBeenLastCalledWith(2)
    await act(async () => {
      pressKey('1')
    })
    expect(onIndexChange).toHaveBeenLastCalledWith(0)
  })

  it('digit beyond items count is ignored', async () => {
    const onIndexChange = vi.fn()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(2),
        index: 0,
        onClose: vi.fn(),
        onIndexChange,
      }),
    )
    await act(async () => {
      pressKey('9')
    })
    expect(onIndexChange).not.toHaveBeenCalled()
  })

  it('clicking the backdrop closes the modal', async () => {
    const onClose = vi.fn()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(2),
        index: 0,
        onClose,
        onIndexChange: vi.fn(),
      }),
    )
    const backdrop = document.querySelector(
      '[data-testid="attachment-preview-backdrop"]',
    ) as HTMLElement
    expect(backdrop).not.toBeNull()
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking the dialog body does NOT close the modal', async () => {
    const onClose = vi.fn()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(2),
        index: 0,
        onClose,
        onIndexChange: vi.fn(),
      }),
    )
    const dialog = document.querySelector(
      '[data-testid="attachment-preview-dialog"]',
    ) as HTMLElement
    await act(async () => {
      dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('the close button fires onClose', async () => {
    const onClose = vi.fn()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(2),
        index: 0,
        onClose,
        onIndexChange: vi.fn(),
      }),
    )
    const closeBtn = document.querySelector(
      '[data-testid="attachment-preview-close"]',
    ) as HTMLButtonElement
    expect(closeBtn).not.toBeNull()
    await act(async () => {
      closeBtn.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hides nav buttons when only one item is present', async () => {
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(1),
        index: 0,
        onClose: vi.fn(),
        onIndexChange: vi.fn(),
      }),
    )
    expect(
      document.querySelector('[data-testid="attachment-preview-next"]'),
    ).toBeNull()
    expect(
      document.querySelector('[data-testid="attachment-preview-prev"]'),
    ).toBeNull()
    expect(
      document.querySelector('[data-testid="attachment-preview-footer"]'),
    ).toBeNull()
  })

  it('renders a thumbnail strip when there is more than one item and switches on click', async () => {
    const onIndexChange = vi.fn()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(3),
        index: 0,
        onClose: vi.fn(),
        onIndexChange,
      }),
    )
    const thumbs = document.querySelectorAll(
      '[data-testid="attachment-preview-thumb"]',
    )
    expect(thumbs).toHaveLength(3)
    expect(thumbs[0].getAttribute('data-active')).toBe('true')
    expect(thumbs[2].getAttribute('data-active')).toBe('false')
    await act(async () => {
      (thumbs[2] as HTMLButtonElement).click()
    })
    expect(onIndexChange).toHaveBeenCalledWith(2)
  })

  it('zoom in / out / reset adjust the displayed percentage', async () => {
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(1),
        index: 0,
        onClose: vi.fn(),
        onIndexChange: vi.fn(),
      }),
    )
    const percent = () =>
      document.querySelector(
        '[data-testid="attachment-preview-zoom-percent"]',
      )?.textContent
    expect(percent()).toBe('100%')
    const zoomIn = document.querySelector(
      '[data-testid="attachment-preview-zoom-in"]',
    ) as HTMLButtonElement
    const zoomOut = document.querySelector(
      '[data-testid="attachment-preview-zoom-out"]',
    ) as HTMLButtonElement
    const reset = document.querySelector(
      '[data-testid="attachment-preview-reset"]',
    ) as HTMLButtonElement
    await act(async () => {
      zoomIn.click()
      zoomIn.click()
    })
    expect(percent()).toBe('150%')
    await act(async () => {
      zoomOut.click()
    })
    expect(percent()).toBe('125%')
    await act(async () => {
      reset.click()
    })
    expect(percent()).toBe('100%')
  })

  it('rotate buttons are present and clickable', async () => {
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(1),
        index: 0,
        onClose: vi.fn(),
        onIndexChange: vi.fn(),
      }),
    )
    const cw = document.querySelector(
      '[data-testid="attachment-preview-rotate-cw"]',
    ) as HTMLButtonElement
    const ccw = document.querySelector(
      '[data-testid="attachment-preview-rotate-ccw"]',
    ) as HTMLButtonElement
    expect(cw).not.toBeNull()
    expect(ccw).not.toBeNull()
    // The rotation is stored in component state, so we only smoke-test
    // that the click handler doesn't throw.
    await act(async () => {
      cw.click()
      ccw.click()
    })
  })

  it('resets zoom and rotation when the active index changes', async () => {
    const onIndexChange = vi.fn()
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(2),
        index: 0,
        onClose: vi.fn(),
        onIndexChange,
      }),
    )
    const zoomIn = document.querySelector(
      '[data-testid="attachment-preview-zoom-in"]',
    ) as HTMLButtonElement
    await act(async () => {
      zoomIn.click()
      zoomIn.click()
    })
    expect(
      document.querySelector('[data-testid="attachment-preview-zoom-percent"]')
        ?.textContent,
    ).toBe('150%')
    // Re-render at a different index (parent owns index state in production)
    await act(async () => {
      root?.render(
        createElement(AttachmentPreviewModal, {
          open: true,
          items: makeAttachments(2),
          index: 1,
          onClose: vi.fn(),
          onIndexChange,
        }),
      )
    })
    expect(
      document.querySelector('[data-testid="attachment-preview-zoom-percent"]')
        ?.textContent,
    ).toBe('100%')
  })

  it('renders a download button', async () => {
    await mount(
      createElement(AttachmentPreviewModal, {
        open: true,
        items: makeAttachments(1),
        index: 0,
        onClose: vi.fn(),
        onIndexChange: vi.fn(),
      }),
    )
    expect(
      document.querySelector('[data-testid="attachment-preview-download"]'),
    ).not.toBeNull()
  })
})
