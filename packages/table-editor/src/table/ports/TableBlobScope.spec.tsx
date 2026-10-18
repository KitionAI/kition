import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DataAttachment } from '../../types/dataDocument'
import { AttachmentCell } from '../components/AttachmentCell'
import { blobURL } from '../lib/blobAttachments'
import { findImageLikeString, normalizeAttachmentValue } from '../lib/tableEditorShared'
import { TableBlobScope, useTableBlobDocument } from './TableBlobScope'
import { TableDataSourceProvider, type TableDataSource } from './TableDataSource'
import { resolveTableFileURL, TableHostProvider, useTableHost, type TableHost } from './TableHost'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const HASH = 'a'.repeat(64)
const BLOB = blobURL(HASH)
const OLD_PATH = '/workspace-files/.kition/assets/sha256/ab/old.png'

let container: HTMLDivElement
let root: Root | null = null
let probe: TableHost = {}

async function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  })
}

/** Shows what the scoped host resolves the blob and an old path attachment to. */
function Probe({ documentId }: { documentId: number | null }) {
  useTableBlobDocument(documentId)
  probe = useTableHost()
  return createElement(
    'span',
    null,
    createElement('i', { 'data-testid': 'blob' }, resolveTableFileURL(probe, BLOB)),
    createElement('i', { 'data-testid': 'path' }, resolveTableFileURL(probe, OLD_PATH)),
  )
}

function text(testId: string) {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
}

function dataSource(attachments?: TableDataSource['attachments']) {
  return { attachments } as unknown as TableDataSource
}

function tree(source: TableDataSource, host: TableHost, documentId: number | null, child?: ReactNode) {
  return createElement(
    TableDataSourceProvider,
    { value: source },
    createElement(
      TableHostProvider,
      { value: host },
      createElement(TableBlobScope, null, createElement(Probe, { documentId }), child),
    ),
  )
}

describe('TableBlobScope', () => {
  const createObjectURL = vi.fn(() => 'blob:http://localhost/1')
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    Object.assign(URL, { createObjectURL, revokeObjectURL })
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    container?.remove()
    vi.clearAllMocks()
  })

  it('makes object URLs from the bytes the data source reads, and frees them after', async () => {
    const read = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', name: 'a.png' }))
    const host: TableHost = { resolveFileURL: (url) => `resolved:${url}` }
    await mount(tree(dataSource({ read, put: vi.fn() }), host, 7))
    await flush()
    expect(read).toHaveBeenCalledWith({ documentId: 7, hash: HASH })
    expect(read).toHaveBeenCalledTimes(1)
    expect(text('blob')).toBe('blob:http://localhost/1')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    // Old path attachments resolve as they always did.
    expect(text('path')).toBe(`resolved:${OLD_PATH}`)
    await act(async () => {
      root?.unmount()
    })
    root = null
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/1')
  })

  it("prefers the app's own blob URLs", async () => {
    const read = vi.fn()
    const host: TableHost = { resolveBlobURL: ({ documentId, hash }) => `/v1/data-documents/${documentId}/blobs/${hash}` }
    await mount(tree(dataSource({ read, put: vi.fn() }), host, 7))
    await flush()
    expect(text('blob')).toBe(`/v1/data-documents/7/blobs/${HASH}`)
    expect(read).not.toHaveBeenCalled()
    // Without an app resolver, a path attachment needs a URL that loads by itself.
    expect(text('path')).toBe('')
  })

  it('resolves nothing before the document is known, or when the blob cannot be read', async () => {
    const read = vi.fn(async () => {
      throw new Error('missing')
    })
    await mount(tree(dataSource({ read, put: vi.fn() }), {}, null))
    await flush()
    expect(text('blob')).toBe('')
    expect(read).not.toHaveBeenCalled()
    await act(async () => {
      root?.render(tree(dataSource({ read, put: vi.fn() }), {}, 7))
    })
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(text('blob')).toBe('')
  })

  it("uploads through the app, or else through the data source's attachments.put", async () => {
    const stored: DataAttachment = { name: 'a.png', url: BLOB, mimeType: 'image/png' }
    const put = vi.fn(async () => stored)
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    await mount(tree(dataSource({ read: vi.fn(), put }), {}, 7))
    await expect(probe.uploadAttachment?.({ documentId: 7, tableId: 2, file })).resolves.toBe(stored)
    expect(put).toHaveBeenCalledWith({ documentId: 7, tableId: 2, file })

    const own = vi.fn(async () => stored)
    await act(async () => {
      root?.render(tree(dataSource({ read: vi.fn(), put }), { uploadAttachment: own }, 7))
    })
    await probe.uploadAttachment?.({ documentId: 7, tableId: 2, file })
    expect(own).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledTimes(1)

    await act(async () => {
      root?.render(tree(dataSource(undefined), {}, 7))
    })
    expect(probe.uploadAttachment).toBeUndefined()
  })

  it('shows an image blob attachment as a thumbnail once its bytes are read', async () => {
    const read = vi.fn(async () => ({ data: new Uint8Array([1]), mimeType: 'image/png', name: 'a.png' }))
    const attachments = normalizeAttachmentValue([{ url: BLOB, name: 'a.png', mimeType: 'image/png', sha256: HASH }])
    expect(attachments[0].url).toBe(BLOB)
    await mount(tree(dataSource({ read, put: vi.fn() }), {}, 7, createElement(AttachmentCell, { attachments, onPreview: vi.fn() })))
    await flush()
    const image = container.querySelector<HTMLImageElement>('[data-testid="attachment-thumb"] img')
    expect(image?.getAttribute('src')).toBe('blob:http://localhost/1')
  })
})

describe('findImageLikeString', () => {
  it('takes a blob attachment for an image only when its type says so', () => {
    expect(findImageLikeString({ url: BLOB, mimeType: 'image/png' })).toBe(BLOB)
    expect(findImageLikeString({ url: BLOB, mimeType: 'application/pdf' })).toBe('')
    expect(findImageLikeString({ url: BLOB })).toBe('')
  })
})
