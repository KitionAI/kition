import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useWorkspaceTreeCreateActions } from '@/features/workspace/hooks/useWorkspaceTreeCreateActions'
import { useWorkspaceTreeLoader } from '@/features/workspace/hooks/useWorkspaceTreeLoader'
import { useWorkspaceTreeNodeActions } from '@/features/workspace/hooks/useWorkspaceTreeNodeActions'
import type { ApplyWorkspaceDocument } from '@/features/workspace/hooks/workspaceTreeActionShared'
import type { UseWorkspaceTreeStateResult } from '@/features/workspace/hooks/useWorkspaceTreeState'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

type UseWorkspaceTreeActionsOptions = {
  activeResourcePath: string
  applyWorkspaceDocument: ApplyWorkspaceDocument
  filterWorkspaceTabs: (predicate: (tab: WorkspaceTab) => boolean) => void
  remapWorkspaceTabPaths: (sourcePath: string, targetPath: string) => void
  renameWorkspaceTabPath: (fromPath: string, toPath: string) => void
  setActiveResourcePath: Dispatch<SetStateAction<string>>
  setActiveWorkspaceTabId: (tabId: string) => void
  setAgentModifiedDocumentPaths: Dispatch<SetStateAction<Set<string>>>
  setError: (message: string) => void
  setFeedback: (message: string) => void
  setSaving: Dispatch<SetStateAction<boolean>>
  treeState: UseWorkspaceTreeStateResult
}

export function useWorkspaceTreeActions({
  activeResourcePath,
  applyWorkspaceDocument,
  filterWorkspaceTabs,
  remapWorkspaceTabPaths,
  renameWorkspaceTabPath,
  setActiveResourcePath,
  setActiveWorkspaceTabId,
  setAgentModifiedDocumentPaths,
  setError,
  setFeedback,
  setSaving,
  treeState,
}: UseWorkspaceTreeActionsOptions) {
  const clearActiveResource = useCallback(() => setActiveResourcePath(''), [setActiveResourcePath])
  const loaderActions = useWorkspaceTreeLoader({
    activeDocumentPath: activeResourcePath,
    applyWorkspaceDocument,
    clearActiveDocumentSession: clearActiveResource,
    setError,
    setFeedback,
    treeState,
  })

  const createActions = useWorkspaceTreeCreateActions({
    activeDocumentPath: activeResourcePath,
    applyWorkspaceDocument,
    refreshWorkspaceDocuments: loaderActions.refreshWorkspaceDocuments,
    rootPath: treeState.rootPath,
    setError,
    setFeedback,
    setSaving,
    treeState,
  })

  const nodeActions = useWorkspaceTreeNodeActions({
    activeDocumentPath: activeResourcePath,
    activeResourcePath,
    applyWorkspaceDocumentList: loaderActions.applyWorkspaceDocumentList,
    filterWorkspaceTabs,
    refreshWorkspaceDocuments: loaderActions.refreshWorkspaceDocuments,
    remapWorkspaceTabPaths,
    renameWorkspaceTabPath,
    rootPath: treeState.rootPath,
    setActiveResourcePath,
    setActiveWorkspaceTabId,
    setAgentModifiedDocumentPaths,
    setError,
    setFeedback,
    setSaving,
    treeState,
  })

  return {
    ...loaderActions,
    ...createActions,
    ...nodeActions,
  }
}
