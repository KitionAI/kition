import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/desktop', () => ({
  openExternalURL: vi.fn(),
  revealWorkspaceFolder: vi.fn(),
}))
vi.mock('@/features/account/hooks/useKitionAccount', () => ({ useKitionAccount: () => ({ state: { status: 'idle', session: null } }) }))
vi.mock('@/features/updates/UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('./WorkspaceSidebarPanel', () => ({ WorkspaceSidebarPanel: () => null }))

import { revealWorkspaceFolder } from '@/services/desktop'

import { buildWorkspaceSidebarPanelProps, type WorkspaceScreenSidebarInput } from './WorkspaceScreenSidebar'

function buildInput(overrides: Partial<WorkspaceScreenSidebarInput> = {}) {
  const treeActions = {
    dropWorkspaceNode: vi.fn(async () => undefined),
    duplicateDocumentNode: vi.fn(async () => undefined),
    importBrowserFiles: vi.fn(async () => undefined),
    moveWorkspaceNodeToFolder: vi.fn(async () => undefined),
    refreshWorkspaceDocuments: vi.fn(async () => true),
  }
  const input: WorkspaceScreenSidebarInput = {
    tree: {
      createMenuOpen: false,
      createMenuTriggerPath: '',
      expandedPaths: new Set(['docs']),
      loading: false,
      rootPath: '/vault',
      setWorkspaceItemIcon: vi.fn(),
      toggleFolder: vi.fn(),
      treeMetadata: { icons: { 'docs/a.md': 'star' } } as never,
      workspaceDisplayName: 'Vault',
    },
    treeNodes: [],
    moveTargets: [],
    activePath: 'docs/a.md',
    modifiedPaths: new Set(),
    createMenuActions: {} as never,
    treeActions: treeActions as never,
    rowActions: { handleTreeNodeDelete: vi.fn(), handleTreeNodeRename: vi.fn() } as never,
    chat: { addNodeToChat: vi.fn(async () => undefined), addNodeToNewChat: vi.fn(async () => undefined) } as never,
    chrome: { privateExpanded: true, onTogglePrivate: vi.fn(), onToggleSidebar: vi.fn() },
    desktop: true,
    browserTabEnabled: true,
    onCreateWorkflowForTable: vi.fn(),
    onOpen: vi.fn(),
    onRefreshed: vi.fn(),
    ...overrides,
  }
  return { input, treeActions }
}

describe('buildWorkspaceSidebarPanelProps', () => {
  it('offers desktop-only actions only on the desktop runtime', () => {
    const desktop = buildWorkspaceSidebarPanelProps(buildInput().input)
    expect(desktop.onRevealInOS).toBeDefined()
    expect(desktop.onImportFiles).toBeDefined()
    expect(desktop.onPasteFiles).toBeDefined()
    desktop.onRevealInOS!({ path: 'docs/a.md' } as never)
    expect(revealWorkspaceFolder).toHaveBeenCalledWith('docs/a.md')

    const web = buildWorkspaceSidebarPanelProps(buildInput({ desktop: false, browserTabEnabled: false }).input)
    expect(web.onRevealInOS).toBeUndefined()
    expect(web.onImportFiles).toBeUndefined()
    expect(web.onPasteFiles).toBeUndefined()
    expect(web.showBrowserTab).toBe(false)
  })

  it('reports a manual refresh only when it succeeded', async () => {
    const ok = buildInput()
    buildWorkspaceSidebarPanelProps(ok.input).onRefresh()
    await Promise.resolve()
    expect(ok.treeActions.refreshWorkspaceDocuments).toHaveBeenCalledWith(undefined, { silent: true, treeOnly: true })
    expect(ok.input.onRefreshed).toHaveBeenCalledTimes(1)

    const failed = buildInput()
    failed.treeActions.refreshWorkspaceDocuments.mockResolvedValue(false)
    buildWorkspaceSidebarPanelProps(failed.input).onRefresh()
    await Promise.resolve()
    expect(failed.input.onRefreshed).not.toHaveBeenCalled()
  })

  it('maps tree state and chrome onto the panel', () => {
    const { input } = buildInput()
    const props = buildWorkspaceSidebarPanelProps(input)
    expect(props.treeIcons).toEqual({ 'docs/a.md': 'star' })
    expect(props.treeExpandedPaths).toEqual(new Set(['docs']))
    expect(props.privateExpanded).toBe(true)
    expect(props.workspaceDisplayName).toBe('Vault')
    props.onTogglePrivate()
    expect(input.chrome.onTogglePrivate).toHaveBeenCalled()
  })
})
