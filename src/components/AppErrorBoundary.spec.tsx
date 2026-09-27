import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppErrorBoundary } from './AppErrorBoundary'

let container: HTMLDivElement
let root: Root | null = null
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  // React logs every caught render error; keep the test output readable.
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
  consoleErrorSpy.mockRestore()
})

let shouldThrow = true

function Bomb({ label }: { label: string }) {
  if (shouldThrow) {
    throw new Error(`boom: ${label}`)
  }
  return createElement('p', { 'data-testid': 'child' }, `child ${label}`)
}

async function mount(node: ReactNode) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

function query(selector: string) {
  return container.querySelector<HTMLElement>(selector)
}

describe('AppErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = true
  })

  it('renders a recoverable fallback instead of unmounting the tree', async () => {
    await mount(
      createElement(AppErrorBoundary, { scope: 'pane', label: 'Document' },
        createElement(Bomb, { label: 'doc' })),
    )

    const fallback = query('[data-testid="app-error-boundary"]')
    expect(fallback).not.toBeNull()
    expect(fallback?.getAttribute('data-scope')).toBe('pane')
    expect(fallback?.textContent).toContain('Document')
    expect(fallback?.textContent).toContain('boom: doc')
    expect(query('[data-testid="child"]')).toBeNull()
  })

  it('reports the error through onError', async () => {
    const onError = vi.fn()
    await mount(
      createElement(AppErrorBoundary, { scope: 'pane', onError },
        createElement(Bomb, { label: 'report' })),
    )

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect((onError.mock.calls[0][0] as Error).message).toBe('boom: report')
  })

  it('retry re-renders the children', async () => {
    await mount(
      createElement(AppErrorBoundary, { scope: 'pane' },
        createElement(Bomb, { label: 'retry' })),
    )
    expect(query('[data-testid="child"]')).toBeNull()

    shouldThrow = false
    await act(async () => {
      query('[data-testid="app-error-boundary-retry"]')?.click()
      await Promise.resolve()
    })

    expect(query('[data-testid="app-error-boundary"]')).toBeNull()
    expect(query('[data-testid="child"]')?.textContent).toBe('child retry')
  })

  it('resets automatically when resetKeys change', async () => {
    function Harness({ tabId }: { tabId: string }) {
      return createElement(AppErrorBoundary, { scope: 'pane', resetKeys: [tabId] },
        createElement(Bomb, { label: tabId }))
    }

    await mount(createElement(Harness, { tabId: 'a' }))
    expect(query('[data-testid="app-error-boundary"]')).not.toBeNull()

    shouldThrow = false
    await act(async () => {
      root?.render(createElement(Harness, { tabId: 'b' }))
      await Promise.resolve()
    })

    expect(query('[data-testid="app-error-boundary"]')).toBeNull()
    expect(query('[data-testid="child"]')?.textContent).toBe('child b')
  })

  it('offers a reload action only at app scope', async () => {
    await mount(
      createElement(AppErrorBoundary, { scope: 'app' },
        createElement(Bomb, { label: 'app' })),
    )
    expect(query('[data-testid="app-error-boundary-reload"]')).not.toBeNull()

    await act(async () => {
      root?.unmount()
    })
    root = null

    await mount(
      createElement(AppErrorBoundary, { scope: 'pane' },
        createElement(Bomb, { label: 'pane' })),
    )
    expect(query('[data-testid="app-error-boundary-reload"]')).toBeNull()
  })
})
