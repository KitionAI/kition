import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_WHITEBOARD_VIEWPORT } from './useWhiteboardCamera'
import { resolveActivePageId, useBoardViewState } from './useBoardViewState'

type HookResult = ReturnType<typeof useBoardViewState>

let container: HTMLDivElement
let root: Root | null = null
let latest: HookResult | null = null

function HookSurface({ docId }: { docId: string | null }) {
  const result = useBoardViewState(docId)
  useEffect(() => {
    latest = result
  }, [result])
  return null
}

async function mount(docId: string | null) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(HookSurface, { docId }))
    await Promise.resolve()
  })
  return latest!
}

async function rerender(docId: string | null) {
  await act(async () => {
    root!.render(createElement(HookSurface, { docId }))
    await Promise.resolve()
  })
  return latest!
}

async function unmount() {
  await act(async () => root?.unmount())
  root = null
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  latest = null
})

afterEach(async () => {
  await unmount()
  container.remove()
  window.localStorage.clear()
  vi.useRealTimers()
})

describe('useBoardViewState', () => {
  it('starts from the editor default viewport and no active page when nothing is stored', async () => {
    const result = await mount('doc-1')
    expect(result.viewport).toEqual(DEFAULT_WHITEBOARD_VIEWPORT)
    expect(result.activePageId).toBeNull()
  })

  it('writes the viewport under the per-document storage key, debounced by 300ms', async () => {
    const result = await mount('doc-1')

    await act(async () => {
      result.setViewport({ x: 10, y: 20, zoom: 2 })
    })
    expect(window.localStorage.getItem('kition.board.view.doc-1')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299)
    })
    expect(window.localStorage.getItem('kition.board.view.doc-1')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    const stored = JSON.parse(window.localStorage.getItem('kition.board.view.doc-1')!)
    expect(stored.viewport).toEqual({ x: 10, y: 20, zoom: 2 })
  })

  it('coalesces rapid viewport updates into a single debounced write', async () => {
    const result = await mount('doc-1')

    await act(async () => {
      result.setViewport({ x: 1, y: 1, zoom: 1 })
      await vi.advanceTimersByTimeAsync(200)
      result.setViewport({ x: 2, y: 2, zoom: 1 })
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(window.localStorage.getItem('kition.board.view.doc-1')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    const stored = JSON.parse(window.localStorage.getItem('kition.board.view.doc-1')!)
    expect(stored.viewport).toEqual({ x: 2, y: 2, zoom: 1 })
  })

  it('flushes a pending debounced viewport write on unmount', async () => {
    const result = await mount('doc-1')

    await act(async () => {
      result.setViewport({ x: 7, y: 8, zoom: 1.5 })
    })
    expect(window.localStorage.getItem('kition.board.view.doc-1')).toBeNull()

    await unmount()
    const stored = JSON.parse(window.localStorage.getItem('kition.board.view.doc-1')!)
    expect(stored.viewport).toEqual({ x: 7, y: 8, zoom: 1.5 })
  })

  it('writes the active page id immediately, without debouncing', async () => {
    const result = await mount('doc-1')

    await act(async () => {
      result.setActivePageId('page-2')
    })
    const stored = JSON.parse(window.localStorage.getItem('kition.board.view.doc-1')!)
    expect(stored.activePageId).toBe('page-2')
  })

  it('persists viewport and active page across remounts for the same document id', async () => {
    const first = await mount('doc-1')
    await act(async () => {
      first.setViewport({ x: 42, y: 24, zoom: 3 })
      first.setActivePageId('page-9')
      await vi.advanceTimersByTimeAsync(300)
    })

    await unmount()
    container = document.createElement('div')
    document.body.appendChild(container)

    const second = await mount('doc-1')
    expect(second.viewport).toEqual({ x: 42, y: 24, zoom: 3 })
    expect(second.activePageId).toBe('page-9')
  })

  it('keeps state independent per document id', async () => {
    const docA = await mount('doc-a')
    await act(async () => {
      docA.setViewport({ x: 100, y: 0, zoom: 1 })
      docA.setActivePageId('page-a')
      await vi.advanceTimersByTimeAsync(300)
    })
    await unmount()

    container = document.createElement('div')
    document.body.appendChild(container)
    const docB = await mount('doc-b')
    expect(docB.viewport).toEqual(DEFAULT_WHITEBOARD_VIEWPORT)
    expect(docB.activePageId).toBeNull()

    await act(async () => {
      docB.setViewport({ x: -50, y: 50, zoom: 0.5 })
      docB.setActivePageId('page-b')
      await vi.advanceTimersByTimeAsync(300)
    })

    const storedA = JSON.parse(window.localStorage.getItem('kition.board.view.doc-a')!)
    const storedB = JSON.parse(window.localStorage.getItem('kition.board.view.doc-b')!)
    expect(storedA.viewport).toEqual({ x: 100, y: 0, zoom: 1 })
    expect(storedA.activePageId).toBe('page-a')
    expect(storedB.viewport).toEqual({ x: -50, y: 50, zoom: 0.5 })
    expect(storedB.activePageId).toBe('page-b')
  })

  it('reloads stored state for the new document id when docId changes on an existing mount', async () => {
    window.localStorage.setItem('kition.board.view.doc-z', JSON.stringify({
      viewport: { x: 9, y: 9, zoom: 4 },
      activePageId: 'page-z',
    }))

    await mount('doc-1')
    const result = await rerender('doc-z')
    expect(result.viewport).toEqual({ x: 9, y: 9, zoom: 4 })
    expect(result.activePageId).toBe('page-z')
  })

  it('ignores invalid stored JSON and falls back to the default viewport', async () => {
    window.localStorage.setItem('kition.board.view.doc-1', '{not valid json')
    const result = await mount('doc-1')
    expect(result.viewport).toEqual(DEFAULT_WHITEBOARD_VIEWPORT)
    expect(result.activePageId).toBeNull()
  })

  it('ignores a stored value with the wrong shape and falls back to the default viewport', async () => {
    window.localStorage.setItem('kition.board.view.doc-1', JSON.stringify([1, 2, 3]))
    const result = await mount('doc-1')
    expect(result.viewport).toEqual(DEFAULT_WHITEBOARD_VIEWPORT)
    expect(result.activePageId).toBeNull()
  })

  it('ignores a stored viewport with the wrong field types', async () => {
    window.localStorage.setItem('kition.board.view.doc-1', JSON.stringify({
      viewport: { x: 'nope', y: 0, zoom: 1 },
      activePageId: 'page-1',
    }))
    const result = await mount('doc-1')
    expect(result.viewport).toEqual(DEFAULT_WHITEBOARD_VIEWPORT)
    expect(result.activePageId).toBe('page-1')
  })

  it('keeps a null document id in memory only, never touching localStorage', async () => {
    const result = await mount(null)

    await act(async () => {
      result.setViewport({ x: 1, y: 2, zoom: 3 })
      result.setActivePageId('page-1')
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(latest!.viewport).toEqual({ x: 1, y: 2, zoom: 3 })
    expect(latest!.activePageId).toBe('page-1')
    expect(window.localStorage.length).toBe(0)
  })
})

describe('resolveActivePageId', () => {
  it('keeps the stored page id when it still exists', () => {
    expect(resolveActivePageId('page-2', ['page-1', 'page-2', 'page-3'])).toBe('page-2')
  })

  it('falls back to the first page when the stored id is gone', () => {
    expect(resolveActivePageId('page-missing', ['page-1', 'page-2'])).toBe('page-1')
  })

  it('falls back to the first page when nothing is stored', () => {
    expect(resolveActivePageId(null, ['page-1', 'page-2'])).toBe('page-1')
  })

  it('returns null when there are no pages at all', () => {
    expect(resolveActivePageId('page-missing', [])).toBeNull()
  })
})
