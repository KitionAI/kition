import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  restorePortalAccountSession: vi.fn(),
  getDesktopInfo: vi.fn(),
  getDesktopBackendStatus: vi.fn(),
  listWorkspaceDocuments: vi.fn(),
  moveWorkspaceDocument: vi.fn(),
  readWorkspaceDocument: vi.fn(),
  writeWorkspaceDocument: vi.fn(),
  openWorkspaceWindow: vi.fn(),
  chooseParentDirectory: vi.fn(),
  addVault: vi.fn(),
  removeVault: vi.fn(),
  renameVault: vi.fn(),
  setActiveVault: vi.fn(),
  refreshVaults: vi.fn(),
  WorkspaceScreen: vi.fn(() => null),
  maybeSeedOnboardingPack: vi.fn(),
  reconcileOnboardingWelcome: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/features/onboarding/maybeSeedOnboardingPack', () => ({
  maybeSeedOnboardingPack: mocks.maybeSeedOnboardingPack,
}))

vi.mock('@/features/onboarding/reconcileOnboardingWelcome', () => ({
  reconcileOnboardingWelcome: mocks.reconcileOnboardingWelcome,
}))

vi.mock('@kition/tessera-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kition/tessera-ui')>()
  return { ...actual, toast: { ...actual.toast, error: mocks.toastError } }
})

vi.mock('@/services/portalAccount', () => ({
  restorePortalAccountSession: mocks.restorePortalAccountSession,
}))

vi.mock('@/features/history/public', () => ({
  DocumentHistoryHost: () => null,
}))

vi.mock('@/features/collab/public', () => ({
  CollabDialogs: () => null,
  requestOpenSharedDocument: vi.fn(),
  requestSyncedDocuments: vi.fn(),
  startCollab: () => () => undefined,
  useCollabAvailable: () => false,
}))

vi.mock('@/services/desktop', () => ({
  getDesktopInfo: mocks.getDesktopInfo,
  getDesktopBackendStatus: mocks.getDesktopBackendStatus,
  listWorkspaceDocuments: mocks.listWorkspaceDocuments,
  moveWorkspaceDocument: mocks.moveWorkspaceDocument,
  readWorkspaceDocument: mocks.readWorkspaceDocument,
  writeWorkspaceDocument: mocks.writeWorkspaceDocument,
  openWorkspaceWindow: mocks.openWorkspaceWindow,
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
    refresh: mocks.refreshVaults,
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

vi.mock('@/features/workspace/components/WorkspaceOpenModeDialog', () => ({
  WorkspaceOpenModeDialog: () => null,
}))

vi.mock('@/lib/cn', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}))

vi.mock('@/lib/windowChrome', () => ({
  handleDesktopChromeDoubleClick: vi.fn(),
}))

let AppShell: typeof import('./Shell').AppShell

beforeAll(async () => {
  ({ AppShell } = await import('./Shell'))
})

describe('AppShell portal restore', () => {
  beforeEach(() => {
    mocks.restorePortalAccountSession.mockReset()
    mocks.restorePortalAccountSession.mockResolvedValue(null)
    mocks.getDesktopInfo.mockReset()
    mocks.getDesktopInfo.mockResolvedValue({ platform: 'darwin', app_version: '1.0.0' })
    mocks.getDesktopBackendStatus.mockReset()
    mocks.getDesktopBackendStatus.mockResolvedValue({ runtime_label: '' })
    mocks.listWorkspaceDocuments.mockReset()
    mocks.listWorkspaceDocuments.mockResolvedValue({ items: [] })
    mocks.moveWorkspaceDocument.mockReset()
    mocks.readWorkspaceDocument.mockReset()
    mocks.writeWorkspaceDocument.mockReset()
    mocks.WorkspaceScreen.mockClear()
    mocks.maybeSeedOnboardingPack.mockReset()
    mocks.maybeSeedOnboardingPack.mockResolvedValue('')
    mocks.reconcileOnboardingWelcome.mockReset()
    mocks.reconcileOnboardingWelcome.mockResolvedValue('')
    mocks.toastError.mockReset()
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

  it('reports a failed Getting Started setup in plain words, keeps the internal error out of the toast, and offers Retry', async () => {
    const failure = new Error('not used')
    mocks.maybeSeedOnboardingPack.mockRejectedValueOnce(failure).mockResolvedValueOnce('')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(AppShell))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const [title, options] = mocks.toastError.mock.calls[0] as [string, { description?: string; action?: { label: string; onClick: () => void } } | undefined]
    expect(title).not.toContain('not used')
    expect(options?.description ?? '').not.toContain('not used')
    expect(options?.action?.label).toBeTruthy()
    expect(logged).toHaveBeenCalledWith(expect.any(String), failure)

    await act(async () => {
      options!.action!.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.maybeSeedOnboardingPack).toHaveBeenCalledTimes(2)
    expect(mocks.maybeSeedOnboardingPack).toHaveBeenLastCalledWith('/tmp/kition-vault')

    logged.mockRestore()
    await act(async () => root?.unmount())
    container.remove()
  })
})
