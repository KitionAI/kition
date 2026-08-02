import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__APP_VERSION__ = 'test'
;(globalThis as any).__APP_COMMIT__ = 'test'
;(globalThis as any).__APP_BUILD_IDENTITY__ = 'test'
;(globalThis as any).__APP_BUILD_AT__ = '2026-08-02T00:00:00.000Z'

const updateStateMock = vi.hoisted(() => vi.fn<() => any>(() => ({ phase: 'idle' })))

vi.mock('@/features/emailProviders/EmailProvidersPane', () => ({
  EmailProvidersPane: () => <div data-testid="mock-email-providers-pane">Email providers pane</div>,
}))

vi.mock('@/features/account/components/KitionAccountPanel', () => ({
  KitionAccountPanel: () => <div data-testid="mock-account-panel">Account panel</div>,
}))

vi.mock('@/features/analytics/components/ProductAnalyticsInspector', () => ({
  ProductAnalyticsInspector: () => <div data-testid="mock-analytics-inspector">Analytics inspector</div>,
}))

vi.mock('@/services/desktop', () => ({
  getDesktopBackendStatus: vi.fn().mockResolvedValue(null),
  getDesktopBootstrapStatus: vi.fn().mockRejectedValue(new Error('desktop bootstrap status is unavailable')),
  getDesktopInfo: vi.fn().mockResolvedValue(null),
  getSecureValue: vi.fn().mockResolvedValue(''),
  isDesktopRuntime: () => false,
  openExternalURL: vi.fn(),
  openRuntimePath: vi.fn(),
  retryDesktopBackendStart: vi.fn(),
  setSecureValue: vi.fn().mockResolvedValue(undefined),
  deleteSecureValue: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/desktop', () => ({ discoverProviderModels: vi.fn() }))
vi.mock('@/services/desktopUpdates', () => ({
  checkForUpdates: vi.fn(async () => ({ phase: 'up-to-date', currentVersion: '1.0.0' })),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  setBetaChannel: vi.fn(),
  setAutoCheckUpdates: vi.fn(),
}))

vi.mock('@/features/updates/useUpdateState', () => ({
  useUpdateState: () => updateStateMock(),
}))
vi.mock('@/features/settings/OnboardingGuidesPanel', () => ({ OnboardingGuidesPanel: () => null }))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  vi.clearAllMocks()
  updateStateMock.mockReturnValue({ phase: 'idle' })
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

async function renderSettings(initialSection: 'general' | 'connections' | 'account' | 'about' = 'connections') {
  const { DesktopSettingsPage } = await import('./DesktopSettingsPage')
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(DesktopSettingsPage, { initialSection }))
    await Promise.resolve()
  })
}

function clickButton(label: string) {
  const target = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === label)
  if (!target) throw new Error(`button not found: ${label}`)
  act(() => target.click())
}

describe('DesktopSettingsPage information architecture', () => {
  it('renders Email Providers as a dedicated settings destination', async () => {
    await renderSettings()
    expect(container.textContent).toContain('Email Providers')
    expect(container.querySelector('[data-testid="mock-email-providers-pane"]')?.textContent).toContain('Email providers pane')
  })

  it('keeps common destinations primary and technical panes inside Advanced', async () => {
    await renderSettings()

    expect(container.textContent).toContain('Account')
    expect(container.textContent).toContain('Advanced')
    expect(container.textContent).not.toContain('Shortcuts')
    expect(container.textContent).not.toContain('MCP')
    expect(container.textContent).not.toContain('Hooks')
    expect(container.textContent).not.toContain('Notifications')
    expect(container.querySelectorAll('.settings-nav-button.is-active')).toHaveLength(1)
    for (const button of container.querySelectorAll<HTMLButtonElement>('.settings-nav-button')) {
      expect(button.type).toBe('button')
    }

    clickButton('Advanced')
    expect(container.textContent).toContain('Network')
    expect(container.textContent).toContain('Data')
    expect(container.textContent).toContain('Developer')
    expect(container.textContent).not.toContain('Shortcuts')
    expect(container.textContent).not.toContain('MCP')
    expect(container.textContent).not.toContain('Hooks')
    expect(container.querySelectorAll('.settings-nav-button.is-active')).toHaveLength(1)
  })

  it('reveals matching Advanced children through search', async () => {
    await renderSettings()
    const search = container.querySelector('input[type="search"]') as HTMLInputElement

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'Network')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.textContent).toContain('Advanced')
    expect(container.textContent).toContain('Network')
    expect(container.textContent).not.toContain('Data')
  })

  it('does not expose notification settings in General', async () => {
    await renderSettings('general')

    expect(container.textContent).not.toContain('Enable notifications')
    expect(container.textContent).not.toContain('Enable system notifications')
  })

  it('opens Kition Account as a first-class settings pane', async () => {
    await renderSettings('account')
    expect(container.querySelector('[data-testid="mock-account-panel"]')?.textContent).toContain('Account panel')
    expect(container.querySelector('.settings-nav-button.is-active')?.textContent).toContain('Account')
  })

  it('shows a safe update message instead of a raw network error', async () => {
    updateStateMock.mockReturnValue({
      phase: 'error',
      message: 'net::ERR_CONNECTION_CLOSED',
      errorKind: 'network',
      phaseAtError: 'checking',
    })

    await renderSettings('about')

    expect(container.textContent).toContain('Network unavailable')
    expect(container.textContent).not.toContain('ERR_CONNECTION_CLOSED')
  })
})
