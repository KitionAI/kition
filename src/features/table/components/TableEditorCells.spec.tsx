import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DataField } from '@/types/dataDocument'
import { aiCellStore, buildCellKey } from '@/features/table/store/aiCellGenerationStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/services/desktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/desktop')>()
  return {
    ...actual,
    resolvePublicFileURL: (url: string) => url,
  }
})

import { DataCellDisplay } from './TableEditorCells'

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

const attachmentField = {
  id: 9,
  name: 'image',
  title: 'Image',
  type: 'attachment',
  required: false,
  readonly: false,
  options: {},
  ai_config: {
    type: 'image_generation',
    enabled: true,
    auto_update: false,
    source_field_id: 1,
    n: 1,
    quality: 'medium',
    aspect_ratio: '1:1',
    resolution: '1K',
  },
} as unknown as DataField

describe('DataCellDisplay attachment+ai_config', () => {
  beforeEach(async () => {
    await unmount()
    aiCellStore._resetForTests()
  })

  it('shows "Not generated yet" hint when value is empty and idle', async () => {
    await mount(
      createElement(DataCellDisplay, {
        field: attachmentField,
        value: null,
        tableId: 1,
        recordId: 2,
        onPreviewAttachments: () => {},
      } as any),
    )
    expect(container.textContent).toMatch(/Not generated/)
  })

  it('shows spinner when store says pending and value is empty', async () => {
    const key = buildCellKey(1, 2, 9)
    aiCellStore.start(key, 'image_generation', new AbortController())
    await mount(
      createElement(DataCellDisplay, {
        field: attachmentField,
        value: null,
        tableId: 1,
        recordId: 2,
        onPreviewAttachments: () => {},
      } as any),
    )
    expect(container.textContent).toMatch(/Generating/)
  })

  it('shows error message when store says error', async () => {
    const key = buildCellKey(1, 2, 9)
    aiCellStore.fail(key, 'rate limit')
    await mount(
      createElement(DataCellDisplay, {
        field: attachmentField,
        value: null,
        tableId: 1,
        recordId: 2,
        onPreviewAttachments: () => {},
      } as any),
    )
    expect(container.textContent).toMatch(/rate limit/)
  })

  it('renders thumbnails when value has attachments and idle', async () => {
    await mount(
      createElement(DataCellDisplay, {
        field: attachmentField,
        value: [{ name: 'a.png', url: '/a.png', mimeType: 'image/png' }] as any,
        tableId: 1,
        recordId: 2,
        onPreviewAttachments: () => {},
      } as any),
    )
    const thumbs = container.querySelectorAll('[data-testid="attachment-thumb"]')
    expect(thumbs.length).toBe(1)
  })

  it('overlays spinner on top of thumbnails when pending and value present', async () => {
    const key = buildCellKey(1, 2, 9)
    aiCellStore.start(key, 'image_generation', new AbortController())
    await mount(
      createElement(DataCellDisplay, {
        field: attachmentField,
        value: [{ name: 'a.png', url: '/a.png', mimeType: 'image/png' }] as any,
        tableId: 1,
        recordId: 2,
        onPreviewAttachments: () => {},
      } as any),
    )
    expect(container.textContent).toMatch(/Generating/)
  })
})

describe('DataCellDisplay document links', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('opens a workspace Markdown path instead of an external URL', async () => {
    const onOpenDocument = vi.fn()
    await mount(createElement(DataCellDisplay, {
      field: { ...attachmentField, type: 'document_link', name: 'document', ai_config: null },
      value: 'Mail/Messages/project-update.md',
      onOpenDocument,
    } as any))

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click()
    })
    expect(onOpenDocument).toHaveBeenCalledWith('Mail/Messages/project-update.md')
  })
})
