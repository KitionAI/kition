import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getUpdateState = vi.fn()
const subscribeToUpdates = vi.fn()
vi.mock('@/services/desktopUpdates', () => ({ getUpdateState, subscribeToUpdates }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let listener: ((s: any) => void) | null = null
let container: HTMLDivElement
let roots: Root[] = []

beforeEach(() => {
  getUpdateState.mockReset()
  subscribeToUpdates.mockReset()
  listener = null
  subscribeToUpdates.mockImplementation((cb) => { listener = cb; return () => { listener = null } })
})

afterEach(async () => {
  await act(async () => {
    for (const r of roots) r.unmount()
  })
  roots = []
  container?.remove()
  vi.resetModules()
})

async function mountProbe() {
  const { useUpdateState } = await import('./useUpdateState')
  function Probe() {
    const state = useUpdateState()
    return createElement('div', { 'data-testid': 'phase' }, state.phase)
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(Probe))
    await Promise.resolve()
  })
  // Allow the bootstrap promise to flush
  await act(async () => { await Promise.resolve() })
  return container
}

describe('useUpdateState', () => {
  it('seeds from getUpdateState on first mount', async () => {
    getUpdateState.mockResolvedValue({ phase: 'up-to-date', currentVersion: '1.0.0' })
    const root = await mountProbe()
    expect(root.querySelector('[data-testid="phase"]')?.textContent).toBe('up-to-date')
  })

  it('updates when subscribe callback fires', async () => {
    getUpdateState.mockResolvedValue({ phase: 'idle' })
    const root = await mountProbe()
    await act(async () => { listener?.({ phase: 'available', version: '1.0.1' }) })
    expect(root.querySelector('[data-testid="phase"]')?.textContent).toBe('available')
  })

  it('bootstraps subscription only once across multiple consumers', async () => {
    getUpdateState.mockResolvedValue({ phase: 'idle' })
    await mountProbe()
    await mountProbe()
    expect(subscribeToUpdates).toHaveBeenCalledTimes(1)
  })
})
