import type { ComponentProps, RefObject } from 'react'

import { WorkspaceTopbar } from '@/features/workspace/components/WorkspaceTopbar'
import { editorTextStyleOptions, type useWorkspaceChrome } from '@/features/workspace/hooks/useWorkspaceChrome'
import type { useWorkspaceDerivedState } from '@/features/workspace/hooks/useWorkspaceDerivedState'
import type { useWorkspaceTopbarActions } from '@/features/workspace/hooks/useWorkspaceTopbarActions'
import { formatWorkspaceTime, type WorkspaceTab } from '@/features/workspace/lib/workspace'
import { buildWorkspaceTabStripProps } from '@/features/workspace/lib/workspaceTabStripActions'
import type { WorkspaceDocument, WorkspaceDocumentFormat } from '@/services/desktop'

type TopbarProps = ComponentProps<typeof WorkspaceTopbar>

/** What the topbar needs, as the bundles the workspace hooks already return. */
export type WorkspaceScreenTopbarInput = {
  tabsPortal: HTMLElement | null
  documentToolbarPortal: HTMLElement | null
  importInputRef: RefObject<HTMLInputElement | null>
  chrome: Pick<
    ReturnType<typeof useWorkspaceChrome>,
    'editorView' | 'itemMenuOpen' | 'setEditorView' | 'setItemMenuOpen' | 'sidebarCollapsed'
    | 'toggleEditorPreference' | 'toggleSidebarCollapsed'
  >
  actions: ReturnType<typeof useWorkspaceTopbarActions>
  derived: Pick<ReturnType<typeof useWorkspaceDerivedState>, 'activeItemWordCount' | 'canImportSource'>
  documentSession: {
    activeDocument: WorkspaceDocument | null
    activeDocumentFormat: WorkspaceDocumentFormat
    hasUnsavedChanges: boolean
    getOpenedDocumentDraftEntry: (path: string) => unknown
  }
  tabs: {
    workspaceTabs: WorkspaceTab[]
    activeWorkspaceTab: WorkspaceTab | undefined
    activeWorkspaceTabId: string
    activateWorkspaceTab: (tab: WorkspaceTab) => Promise<void> | void
    closeTab: (tabId: string) => void
  }
  workflowOpen: boolean
  onCloseWorkflow?: () => void
  onCloseProfile?: () => void
  openExportDialog: () => void
  openWorkspaceFolder: (path: string) => unknown
}

export function buildWorkspaceTopbarProps(input: WorkspaceScreenTopbarInput): TopbarProps {
  const { chrome, actions, derived, documentSession, tabs } = input
  const { activeDocument } = documentSession
  return {
    tabsPortal: input.tabsPortal,
    documentToolbarPortal: tabs.activeWorkspaceTab?.type === 'document' ? input.documentToolbarPortal : null,
    tabStripProps: buildWorkspaceTabStripProps({
      tabs: tabs.workspaceTabs,
      activeTabId: tabs.activeWorkspaceTabId,
      activeDocumentPath: activeDocument?.path,
      hasUnsavedChanges: documentSession.hasUnsavedChanges,
      getOpenedDocumentDraftEntry: documentSession.getOpenedDocumentDraftEntry,
      workflowOpen: input.workflowOpen,
      closeTab: tabs.closeTab,
      activateTab: tabs.activateWorkspaceTab,
      onCloseWorkflow: input.onCloseWorkflow,
      onCloseProfile: input.onCloseProfile,
      sidebarCollapsed: chrome.sidebarCollapsed,
      onToggleSidebar: chrome.toggleSidebarCollapsed,
    }),
    importInputRef: input.importInputRef,
    itemMenuOpen: chrome.itemMenuOpen,
    activeItemFormat: documentSession.activeDocumentFormat,
    editorView: chrome.editorView,
    editorTextStyleOptions,
    hasActiveItem: Boolean(activeDocument),
    hasUnsavedChanges: documentSession.hasUnsavedChanges,
    itemWordCount: derived.activeItemWordCount,
    activeItemUpdatedAt: activeDocument?.updated_at,
    canImportSource: derived.canImportSource,
    onFileChange: (file) => void actions.importMarkdownFile(file),
    onToggleItemMenu: () => chrome.setItemMenuOpen((value) => !value),
    onCloseItemMenu: () => chrome.setItemMenuOpen(false),
    onSetEditorMode: actions.setEditorMode,
    onSetTextStyle: (style) => chrome.setEditorView((current) => ({ ...current, textStyle: style })),
    onToggleEditorPreference: chrome.toggleEditorPreference,
    onRestoreSavedDraft: actions.restoreSavedDraft,
    onTriggerImport: () => input.importInputRef.current?.click(),
    onOpenExportDialog: () => {
      chrome.setItemMenuOpen(false)
      input.openExportDialog()
    },
    onOpenWorkspaceFolder: () => {
      chrome.setItemMenuOpen(false)
      if (activeDocument) void input.openWorkspaceFolder(activeDocument.path)
    },
    onRunActiveDataTableAction: actions.runActiveDataTableAction,
    formatTime: formatWorkspaceTime,
  }
}

/** The topbar: the tab strip, the document item menu, and the toolbar slot. */
export function WorkspaceScreenTopbar(input: WorkspaceScreenTopbarInput) {
  return <WorkspaceTopbar {...buildWorkspaceTopbarProps(input)} />
}
