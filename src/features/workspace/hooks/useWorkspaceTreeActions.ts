import type { Dispatch, SetStateAction } from 'react'
import type { DocumentSnapshot } from '@/features/document/lib/documentSnapshots'
import type { DocumentPlatform } from '@/features/document/lib/documentCreation'
import { useWorkspaceTreeCreateActions } from '@/features/workspace/hooks/useWorkspaceTreeCreateActions'
import { useWorkspaceTreeLoader } from '@/features/workspace/hooks/useWorkspaceTreeLoader'
import { useWorkspaceTreeNodeActions } from '@/features/workspace/hooks/useWorkspaceTreeNodeActions'
import type { ApplyWorkspaceDocument } from '@/features/workspace/hooks/workspaceTreeActionShared'
import type { UseWorkspaceTreeStateResult } from '@/features/workspace/hooks/useWorkspaceTreeState'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import type { WorkspaceDocument } from '@/services/desktop'

type UseWorkspaceTreeActionsOptions = {
  activeDocument: WorkspaceDocument | null
  activeResourcePath: string
  applyWorkspaceDocument: ApplyWorkspaceDocument
  clearActiveDocumentSession: () => void
  filterWorkspaceTabs: (predicate: (tab: WorkspaceTab) => boolean) => void
  hasDocumentSnapshot: (path: string) => boolean
  hasUnsavedChanges: boolean
  persistActiveDocument: (reason?: 'auto' | 'shortcut') => Promise<boolean>
  pruneOpenedDocumentDrafts: (predicate: (path: string) => boolean) => void
  rememberDocumentSnapshot: (document: WorkspaceDocument, content: string, reason: string) => void
  remapWorkspaceTabPaths: (sourcePath: string, targetPath: string) => void
  renameWorkspaceTabPath: (fromPath: string, toPath: string) => void
  renameKitableChildrenIndexPath?: (fromPath: string, toPath: string) => void
  setActiveResourcePath: Dispatch<SetStateAction<string>>
  setActiveWorkspaceTabId: (tabId: string) => void
  setAgentModifiedDocumentPaths: Dispatch<SetStateAction<Set<string>>>
  setEditorMode: (mode: 'rich' | 'split') => void
  setError: (message: string) => void
  setFeedback: (message: string) => void
  setSaving: Dispatch<SetStateAction<boolean>>
  setSelectedPlatform: Dispatch<SetStateAction<DocumentPlatform>>
  treeState: UseWorkspaceTreeStateResult
  updateSnapshots: (nextSnapshots: DocumentSnapshot[]) => void
}

export function useWorkspaceTreeActions({
  activeDocument,
  activeResourcePath,
  applyWorkspaceDocument,
  clearActiveDocumentSession,
  filterWorkspaceTabs,
  hasDocumentSnapshot,
  hasUnsavedChanges,
  persistActiveDocument,
  pruneOpenedDocumentDrafts,
  rememberDocumentSnapshot,
  remapWorkspaceTabPaths,
  renameWorkspaceTabPath,
  renameKitableChildrenIndexPath,
  setActiveResourcePath,
  setActiveWorkspaceTabId,
  setAgentModifiedDocumentPaths,
  setEditorMode,
  setError,
  setFeedback,
  setSaving,
  setSelectedPlatform,
  treeState,
  updateSnapshots,
}: UseWorkspaceTreeActionsOptions) {
  const loaderActions = useWorkspaceTreeLoader({
    activeDocumentPath: activeDocument?.path || '',
    applyWorkspaceDocument,
    clearActiveDocumentSession,
    hasDocumentSnapshot,
    rememberDocumentSnapshot,
    setError,
    setFeedback,
    treeState,
  })

  const createActions = useWorkspaceTreeCreateActions({
    activeDocumentPath: activeDocument?.path || '',
    applyWorkspaceDocument,
    refreshWorkspaceDocuments: loaderActions.refreshWorkspaceDocuments,
    rememberDocumentSnapshot,
    rootPath: treeState.rootPath,
    setEditorMode,
    setError,
    setFeedback,
    setSaving,
    setSelectedPlatform,
    treeState,
  })

  const nodeActions = useWorkspaceTreeNodeActions({
    activeDocumentPath: activeDocument?.path || '',
    activeResourcePath,
    applyWorkspaceDocumentList: loaderActions.applyWorkspaceDocumentList,
    filterWorkspaceTabs,
    hasUnsavedChanges,
    persistActiveDocument,
    pruneOpenedDocumentDrafts,
    refreshWorkspaceDocuments: loaderActions.refreshWorkspaceDocuments,
    remapWorkspaceTabPaths,
    renameWorkspaceTabPath,
    renameKitableChildrenIndexPath,
    rootPath: treeState.rootPath,
    setActiveResourcePath,
    setActiveWorkspaceTabId,
    setAgentModifiedDocumentPaths,
    setError,
    setFeedback,
    setSaving,
    treeState,
    updateSnapshots,
  })

  return {
    ...loaderActions,
    ...createActions,
    ...nodeActions,
  }
}
