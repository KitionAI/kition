import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/dataDocuments', () => ({
  openDataDocumentByPath: vi.fn(),
}))

import { openDataDocumentByPath } from '@/api/dataDocuments'

import { findUnregisteredKitables, useKitableRegistration } from './useKitableRegistration'

const files = [
  { type: 'file', path: 'Leads.kitable' },
  { type: 'file', path: 'notes/Todo.md' },
  { type: 'folder', path: 'Archive.kitable' },
  { type: 'file', path: 'Archive/Old.KITABLE' },
]

describe('findUnregisteredKitables', () => {
  it('returns only .kitable files that are neither indexed nor attempted', () => {
    expect(findUnregisteredKitables(files, { 'Leads.kitable': '7' }, new Set())).toEqual(['Archive/Old.KITABLE'])
    expect(findUnregisteredKitables(files, {}, new Set(['Archive/Old.KITABLE']))).toEqual(['Leads.kitable'])
  })
})

describe('useKitableRegistration', () => {
  let container: HTMLDivElement
  let root: Root | null = null
  const refresh = vi.fn(async () => {})

  function Harness({ status, docIds }: { status: 'idle' | 'loading' | 'done' | 'error'; docIds: Record<string, string> }) {
    useKitableRegistration(files, { status, docIdByKitablePath: docIds, refresh })
    return null
  }

  async function render(props: { status: 'idle' | 'loading' | 'done' | 'error'; docIds: Record<string, string> }) {
    await act(async () => {
      root ??= createRoot(container)
      root.render(createElement(Harness, props))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.mocked(openDataDocumentByPath).mockReset()
    refresh.mockClear()
  })

  afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    container.remove()
  })

  it('does nothing until the index has loaded', async () => {
    await render({ status: 'loading', docIds: {} })
    expect(openDataDocumentByPath).not.toHaveBeenCalled()
  })

  it('registers unseen .kitable files once and refreshes the index when one succeeds', async () => {
    vi.mocked(openDataDocumentByPath)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('corrupt'))

    await render({ status: 'done', docIds: {} })

    expect(vi.mocked(openDataDocumentByPath).mock.calls.map(([input]) => input.path)).toEqual([
      'Leads.kitable',
      'Archive/Old.KITABLE',
    ])
    expect(refresh).toHaveBeenCalledTimes(1)

    // The index refetched but the corrupt file still has no id: no retry.
    await render({ status: 'done', docIds: { 'Leads.kitable': '7' } })
    expect(openDataDocumentByPath).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not refresh when every registration fails', async () => {
    vi.mocked(openDataDocumentByPath).mockRejectedValue(new Error('corrupt'))
    await render({ status: 'done', docIds: {} })
    expect(openDataDocumentByPath).toHaveBeenCalledTimes(2)
    expect(refresh).not.toHaveBeenCalled()
  })
})
