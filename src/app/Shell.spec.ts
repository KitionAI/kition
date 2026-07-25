import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  restorePortalAccountSession: vi.fn(),
  getDesktopInfo: vi.fn(),
  getDesktopBackendStatus: vi.fn(),
  chooseParentDirectory: vi.fn(),
  addVault: vi.fn(),
  removeVault: vi.fn(),
  renameVault: vi.fn(),
  setActiveVault: vi.fn(),
  WorkspaceScreen: vi.fn(() => null),
}))

vi.mock('@/services/portalAccount', () => ({
  restorePortalAccountSession: mocks.restorePortalAccountSession,
}))

vi.mock('@/services/desktop', () => ({
  getDesktopInfo: mocks.getDesktopInfo,
  getDesktopBackendStatus: mocks.getDesktopBackendStatus,
  // Shell pulls in ScenarioRoute → TableEditor → @/api/dataDocuments,
  // which calls getApiBaseURL() at module-evaluation time. With
  // vi.resetModules() we need to surface enough of the desktop module
  // surface for that import chain to evaluate without ReferenceError.
  getApiBaseURL: () => 'http://localhost:3000',
  resolveApiURL: (path: string) => `http://localhost:3000${path}`,
}))

vi.mock('@/features/workspace/hooks/useWorkspaceVaults', () => ({
  useWorkspaceVaults: () => ({
    vaults: [],
    activeVaultPath: '/tmp/kition-vault',
    loaded: true,
    error: '',
    chooseParentDirectory: mocks.chooseParentDirectory,
    addVault: mocks.addVault,
    removeVault: mocks.removeVault,
    renameVault: mocks.renameVault,
    setActiveVault: mocks.setActiveVault,
  }),
}))

vi.mock('@/app/components/CommandPalette', () => ({
  CommandPalette: () => null,
}))

vi.mock('@/app/ConsoleCreditsExhaustedBanner', () => ({
  ConsoleCreditsExhaustedBanner: () => null,
}))

vi.mock('@/app/PortalAccountControl', () => ({
  PortalProfileDialog: () => null,
}))

vi.mock('@/features/settings/DesktopSettingsPage', () => ({
  DesktopSettingsPage: () => null,
}))

vi.mock('@/features/workspace/components/WorkspaceScreen', () => ({
  WorkspaceScreen: mocks.WorkspaceScreen,
}))

vi.mock('@/features/workspace/components/WorkspaceLauncherScreen', () => ({
  WorkspaceLauncherScreen: () => null,
}))

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}))

vi.mock('@/lib/windowChrome', () => ({
  handleDesktopChromeDoubleClick: vi.fn(),
}))

let AppShell: typeof import('./Shell').AppShell
let resolveSettingsSection: typeof import('./Shell').resolveSettingsSection
let normalizeAppPathname: typeof import('./Shell').normalizeAppPathname

beforeAll(async () => {
  ({ AppShell, normalizeAppPathname, resolveSettingsSection } = await import('./Shell'))
})

describe('settings section routing', () => {
  it('keeps legacy provider links pointed at the models pane', () => {
    expect(resolveSettingsSection('providers')).toBe('models')
    expect(resolveSettingsSection('ai-providers')).toBe('models')
    expect(resolveSettingsSection('email-providers')).toBe('connections')
  })

  it('keeps old demo and advanced links pointed at their new parent panes', () => {
    expect(resolveSettingsSection('demos')).toBe('general')
    expect(resolveSettingsSection('advanced')).toBe('developer')
    expect(resolveSettingsSection('runtime')).toBe('runtime')
    expect(resolveSettingsSection('shortcuts')).toBe('general')
    expect(resolveSettingsSection('mcp')).toBe('general')
    expect(resolveSettingsSection('hooks')).toBe('general')
    expect(resolveSettingsSection('notifications')).toBe('general')
  })

  it('falls back to general for unknown sections', () => {
    expect(resolveSettingsSection('missing')).toBe('general')
  })
})

describe('app route normalization', () => {
  it('keeps file-level workspace routes', () => {
    expect(normalizeAppPathname('/workflow/new')).toBe('/workflow/new')
    expect(normalizeAppPathname('/settings')).toBe('/settings')
  })

  it('returns removed routes to the document workspace', () => {
    expect(normalizeAppPathname('/writing/wechat_article')).toBe('/documents')
    expect(normalizeAppPathname('/image')).toBe('/documents')
  })
})

describe('AppShell portal restore', () => {
  beforeEach(() => {
    mocks.restorePortalAccountSession.mockReset()
    mocks.restorePortalAccountSession.mockResolvedValue(null)
    mocks.getDesktopInfo.mockReset()
    mocks.getDesktopInfo.mockResolvedValue({ platform: 'darwin', app_version: '1.0.0' })
    mocks.getDesktopBackendStatus.mockReset()
    mocks.getDesktopBackendStatus.mockResolvedValue({ runtime_label: '' })
    mocks.WorkspaceScreen.mockClear()
    window.history.replaceState(null, '', '/documents')
  })

  it('restores the portal account session on mount', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(AppShell))
      await Promise.resolve()
    })

    expect(mocks.restorePortalAccountSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('shows the local runtime label reported by the desktop backend', async () => {
    mocks.getDesktopBackendStatus.mockResolvedValue({ runtime_label: 'local-runtime' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(AppShell))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="runtime-source-label"]')?.textContent).toBe('local-runtime')

    await act(async () => root?.unmount())
    container.remove()
  })

  it('does not show a runtime label for formal builds', async () => {
    mocks.getDesktopBackendStatus.mockResolvedValue({ runtime_label: '' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(AppShell))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="runtime-source-label"]')).toBeNull()

    await act(async () => root?.unmount())
    container.remove()
  })

  it('hosts workflow routes inside WorkspaceScreen instead of a full-screen overlay', async () => {
    window.history.replaceState(null, '', '/workflow')
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(AppShell))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="workflow-route-overlay"]')).toBeNull()
    expect(mocks.WorkspaceScreen).toHaveBeenCalled()
    const props = (mocks.WorkspaceScreen.mock.calls as unknown as Array<[Record<string, unknown>]>).at(-1)![0]
    expect(props.workflowOpen).toBe(true)
    expect(props.workflowContext).toBeNull()
    expect(typeof props.workflowSchemaLookup).toBe('function')
    expect(typeof props.onCloseWorkflow).toBe('function')

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })
})
