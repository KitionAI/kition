import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDefaultDesktopProxyState } from '@/types/desktopProxy'

vi.mock('@/services/desktopProxy', async () => {
  const types: any = await vi.importActual('@/types/desktopProxy')
  return {
    getProxyState: vi.fn(async () => types.createDefaultDesktopProxyState()),
    saveProxyState: vi.fn(async () => ({ state: types.createDefaultDesktopProxyState(), requiresRestart: false })),
    testProxy: vi.fn(async () => ({ ok: true, latencyMs: 12 })),
    restartBackend: vi.fn(async () => ({ ok: true })),
  }
})

import { NetworkSettings } from './NetworkSettings'
import * as desktopProxy from '@/services/desktopProxy'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(node)
  })
  // Two flushes: useEffect → setState from getProxyState → re-render.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('NetworkSettings', () => {
  beforeEach(async () => {
    await act(async () => { root?.unmount() })
    root = null
    container?.remove()
    vi.clearAllMocks()
  })

  it('renders the proxy section with the enable toggle defaulting off', async () => {
    await mount(createElement(NetworkSettings))
    const toggles = container.querySelectorAll('[role="switch"]')
    expect(toggles.length).toBeGreaterThanOrEqual(1)
    const enabledToggle = toggles[0] as HTMLButtonElement
    expect(enabledToggle.getAttribute('aria-checked')).toBe('false')
  })

  it('disables the Test button until proxy is enabled', async () => {
    await mount(createElement(NetworkSettings))
    const testButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Test') || b.getAttribute('aria-label') === 'Test',
    )
    expect(testButton).toBeTruthy()
    expect(testButton?.hasAttribute('disabled')).toBe(true)
  })

  it('calls getProxyState on mount', async () => {
    await mount(createElement(NetworkSettings))
    expect(desktopProxy.getProxyState).toHaveBeenCalled()
  })

  it('payload helpers produce the expected default state shape', () => {
    const state = createDefaultDesktopProxyState()
    expect(state.enabled).toBe(false)
    expect(state.scheme).toBe('http')
    expect(state.hasPassword).toBe(false)
    expect(state.noProxy).toContain('localhost')
  })
})
