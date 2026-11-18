import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  applyDesktopAppearance: vi.fn(),
  configureProductAnalytics: vi.fn(),
  dispatchOnQuit: vi.fn(),
  dispatchSessionStarted: vi.fn().mockResolvedValue(true),
  ensureNotificationPolicyLoaded: vi.fn().mockResolvedValue({}),
  getDesktopInfo: vi.fn().mockResolvedValue(null),
  isDesktopRuntime: vi.fn().mockReturnValue(false),
  setAutoCheckUpdates: vi.fn().mockResolvedValue(undefined),
  setBetaChannel: vi.fn().mockResolvedValue(undefined),
  setCurrentLocale: vi.fn(),
  subscribeDesktopSettingsUpdated: vi.fn().mockReturnValue(() => {}),
  trackProductEvent: vi.fn().mockReturnValue(false),
}))

vi.mock('@/services/desktopSettings', () => ({
  applyDesktopAppearance: mocks.applyDesktopAppearance,
  loadDesktopSettings: vi.fn().mockResolvedValue({
    general: {
      theme: 'dark',
      language: 'en-US',
      updateBetaChannel: false,
      autoCheckUpdates: true,
      shareUsageData: false,
    },
  }),
  subscribeDesktopSettingsUpdated: mocks.subscribeDesktopSettingsUpdated,
}))
vi.mock('@/services/desktopNotifications', () => ({
  dispatchOnQuit: mocks.dispatchOnQuit,
  dispatchSessionStarted: mocks.dispatchSessionStarted,
  ensureNotificationPolicyLoaded: mocks.ensureNotificationPolicyLoaded,
}))
vi.mock('@/services/desktopUpdates', () => ({
  setAutoCheckUpdates: mocks.setAutoCheckUpdates,
  setBetaChannel: mocks.setBetaChannel,
}))
vi.mock('@/services/desktop', () => ({
  getDesktopInfo: mocks.getDesktopInfo,
  isDesktopRuntime: mocks.isDesktopRuntime,
}))
vi.mock('@/i18n', () => ({ setCurrentLocale: mocks.setCurrentLocale }))
vi.mock('@/features/analytics/lib/productAnalytics', () => ({
  configureProductAnalytics: mocks.configureProductAnalytics,
  trackProductEvent: mocks.trackProductEvent,
}))
vi.mock('./Shell', () => ({ AppShell: () => <div data-testid="app-shell" /> }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__APP_VERSION__ = 'test'
;(globalThis as any).__APP_BUILD_IDENTITY__ = 'dev'
;(globalThis as any).__APP_ANALYTICS_ENDPOINT__ = ''
;(globalThis as any).__APP_WEB_PREVIEW__ = false

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  vi.clearAllMocks()
  mocks.dispatchSessionStarted.mockResolvedValue(true)
  mocks.ensureNotificationPolicyLoaded.mockResolvedValue({})
  mocks.getDesktopInfo.mockResolvedValue(null)
  mocks.isDesktopRuntime.mockReturnValue(false)
  mocks.setAutoCheckUpdates.mockResolvedValue(undefined)
  mocks.setBetaChannel.mockResolvedValue(undefined)
  mocks.subscribeDesktopSettingsUpdated.mockReturnValue(() => {})
  mocks.trackProductEvent.mockReturnValue(false)
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

async function renderApp() {
  const { App } = await import('./App')
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(App))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('App desktop-only lifecycle', () => {
  it('does not call desktop notification or Hook lifecycle APIs in web preview', async () => {
    await renderApp()

    expect(mocks.ensureNotificationPolicyLoaded).not.toHaveBeenCalled()
    expect(mocks.dispatchSessionStarted).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('beforeunload'))
    expect(mocks.dispatchOnQuit).not.toHaveBeenCalled()
  })

  it('loads notification policy and dispatches lifecycle Hooks in desktop', async () => {
    mocks.isDesktopRuntime.mockReturnValue(true)
    await renderApp()

    expect(mocks.ensureNotificationPolicyLoaded).toHaveBeenCalledTimes(1)
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.dispatchSessionStarted).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('beforeunload'))
    expect(mocks.dispatchOnQuit).toHaveBeenCalledTimes(1)
  })
})
