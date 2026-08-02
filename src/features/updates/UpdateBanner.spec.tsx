import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useUpdateState = vi.fn()
const downloadUpdate = vi.fn()
const installUpdate = vi.fn()
const openExternalURL = vi.fn()

vi.mock('./useUpdateState', () => ({ useUpdateState }))
vi.mock('@/services/desktopUpdates', () => ({ downloadUpdate, installUpdate }))
vi.mock('@/services/desktop', () => ({ openExternalURL }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  useUpdateState.mockReset()
  downloadUpdate.mockReset()
  installUpdate.mockReset()
  openExternalURL.mockReset()
  window.localStorage.clear()
})

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount() })
    root = null
  }
  container?.remove()
  vi.resetModules()
})

async function mountBanner() {
  const { UpdateBanner } = await import('./UpdateBanner')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(UpdateBanner))
    await Promise.resolve()
  })
  return container
}

function findButton(label: RegExp): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'))
  const match = buttons.find((btn) => label.test(btn.textContent || ''))
  if (!match) throw new Error(`button matching ${label} not found in ${buttons.map((b) => b.textContent).join(', ')}`)
  return match as HTMLButtonElement
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

describe('UpdateBanner', () => {
  it('renders nothing for idle/checking/up-to-date/unsupported', async () => {
    for (const phase of ['idle', 'checking', 'up-to-date', 'unsupported']) {
      useUpdateState.mockReturnValue({ phase, currentVersion: '1.0.0', reason: 'x' })
      const c = await mountBanner()
      expect(c.textContent).toBe('')
      if (root) {
        await act(async () => { root!.unmount() })
        root = null
      }
      container.remove()
    }
  })

  it('renders the available phase with Download and Later actions', async () => {
    useUpdateState.mockReturnValue({ phase: 'available', version: '1.0.1' })
    const c = await mountBanner()
    expect(c.textContent).toMatch(/1\.0\.1/)
    expect(findButton(/download/i)).toBeDefined()
    expect(findButton(/later/i)).toBeDefined()
  })

  it('clicking Download triggers downloadUpdate', async () => {
    useUpdateState.mockReturnValue({ phase: 'available', version: '1.0.1' })
    await mountBanner()
    await click(findButton(/download/i))
    expect(downloadUpdate).toHaveBeenCalled()
  })

  it('opens release notes in the public Kition repository', async () => {
    useUpdateState.mockReturnValue({ phase: 'available', version: '1.0.1' })
    await mountBanner()
    await click(findButton(/release notes/i))
    expect(openExternalURL).toHaveBeenCalledWith('https://github.com/KitionAI/kition/releases/tag/v1.0.1')
  })

  it('renders downloading percent', async () => {
    useUpdateState.mockReturnValue({ phase: 'downloading', percent: 42, transferred: 100, total: 1000, bytesPerSecond: 10 })
    const c = await mountBanner()
    expect(c.textContent).toMatch(/42/)
  })

  it('renders downloaded with Restart and install', async () => {
    useUpdateState.mockReturnValue({ phase: 'downloaded', version: '1.0.1' })
    await mountBanner()
    await click(findButton(/restart/i))
    expect(installUpdate).toHaveBeenCalled()
  })

  it('keeps background update errors out of the global workspace banner', async () => {
    useUpdateState.mockReturnValue({
      phase: 'error',
      message: 'net::ERR_CONNECTION_CLOSED',
      errorKind: 'network',
      phaseAtError: 'checking',
    })
    const c = await mountBanner()
    expect(c.textContent).toBe('')
    expect(document.documentElement.dataset.updateBanner).toBeUndefined()
  })

  it('Later dismisses the available banner for that version', async () => {
    useUpdateState.mockReturnValue({ phase: 'available', version: '1.0.1' })
    const c = await mountBanner()
    await click(findButton(/later/i))
    expect(c.textContent).toBe('')
  })
})
