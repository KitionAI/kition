import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/workspace/components/WorkspaceTopbar', () => ({ WorkspaceTopbar: () => null }))

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

import { buildWorkspaceTopbarProps, type WorkspaceScreenTopbarInput } from './WorkspaceScreenTopbar'

const portal = document.createElement('div')
const documentTab: WorkspaceTab = { id: 'doc', type: 'document', title: 'Plan', path: 'plan.md' }

function buildInput(overrides: Partial<WorkspaceScreenTopbarInput> = {}) {
  const chrome = {
    editorView: { textStyle: 'default' } as never,
    itemMenuOpen: true,
    setEditorView: vi.fn(),
    setItemMenuOpen: vi.fn(),
    sidebarCollapsed: false,
    toggleEditorPreference: vi.fn(),
    toggleSidebarCollapsed: vi.fn(),
  }
  const input: WorkspaceScreenTopbarInput = {
    tabsPortal: null,
    documentToolbarPortal: portal,
    importInputRef: { current: null },
    chrome: chrome as never,
    actions: { importMarkdownFile: vi.fn(async () => undefined), restoreSavedDraft: vi.fn(), runActiveDataTableAction: vi.fn(), setEditorMode: vi.fn() } as never,
    derived: { activeItemWordCount: 12, canImportSource: true },
    documentSession: {
      activeDocument: { path: 'plan.md', name: 'plan.md', content: '', updated_at: '2026-09-01T00:00:00Z' },
      activeDocumentFormat: 'markdown',
      hasUnsavedChanges: false,
      getOpenedDocumentDraftEntry: () => null,
    },
    tabs: { workspaceTabs: [documentTab], activeWorkspaceTab: documentTab, activeWorkspaceTabId: 'doc', activateWorkspaceTab: vi.fn(), closeTab: vi.fn() },
    workflowOpen: false,
    openExportDialog: vi.fn(),
    openWorkspaceFolder: vi.fn(),
    ...overrides,
  }
  return { input, chrome }
}

describe('buildWorkspaceTopbarProps', () => {
  it('mounts the document toolbar only while a document tab is active', () => {
    expect(buildWorkspaceTopbarProps(buildInput().input).documentToolbarPortal).toBe(portal)
    const table: WorkspaceTab = { id: 't', type: 'table', title: 'T', kitablePath: 'a.kitable', tableId: 1, format: 'data' }
    const { input } = buildInput()
    input.tabs = { ...input.tabs, activeWorkspaceTab: table }
    expect(buildWorkspaceTopbarProps(input).documentToolbarPortal).toBeNull()
  })

  it('closes the item menu before export and before revealing the folder', () => {
    const { input, chrome } = buildInput()
    const props = buildWorkspaceTopbarProps(input)
    props.onOpenExportDialog()
    expect(chrome.setItemMenuOpen).toHaveBeenCalledWith(false)
    expect(input.openExportDialog).toHaveBeenCalledTimes(1)
    props.onOpenWorkspaceFolder()
    expect(input.openWorkspaceFolder).toHaveBeenCalledWith('plan.md')

    const empty = buildInput({ documentSession: { activeDocument: null, activeDocumentFormat: 'markdown', hasUnsavedChanges: false, getOpenedDocumentDraftEntry: () => null } })
    const emptyProps = buildWorkspaceTopbarProps(empty.input)
    emptyProps.onOpenWorkspaceFolder()
    expect(empty.input.openWorkspaceFolder).not.toHaveBeenCalled()
    expect(emptyProps.hasActiveItem).toBe(false)
    expect(emptyProps.activeItemUpdatedAt).toBeUndefined()
  })

  it('updates the text style through the chrome state', () => {
    const { input, chrome } = buildInput()
    buildWorkspaceTopbarProps(input).onSetTextStyle('serif' as never)
    const updater = chrome.setEditorView.mock.calls[0][0] as (current: object) => object
    expect(updater({ textStyle: 'default', locked: true })).toEqual({ textStyle: 'serif', locked: true })
    expect(buildWorkspaceTopbarProps(input).itemWordCount).toBe(12)
  })
})
