/**
 * Renaming the active document from its inline title. Moves the file,
 * then updates every client record that named the old path: the tree, the
 * kitable index, snapshots, Agent-modified paths, tabs, and drafts. Errors
 * are thrown so the title editor can roll back its optimistic text.
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'

import { renameDataDocumentByPath } from '@/api/dataDocuments'
import { remapPathSetAfterMove, remapSnapshotsAfterMove } from '@/features/workspace/lib/documentRename'
import {
  getWorkspaceItemTitle,
  remapWorkspaceBranchPath,
  renameWorkspaceDocumentPath,
} from '@/features/workspace/lib/workspace'
import {
  renameWorkspaceTreeBranchMetadata,
  replaceWorkspaceTreeDocumentItem,
  updateWorkspaceTreeDocumentItem,
} from '@/features/workspace/lib/workspaceTree'
import type { UseWorkspaceTreeStateResult } from '@/features/workspace/hooks/useWorkspaceTreeState'
import { moveWorkspaceDocument, type WorkspaceDocument, type WorkspaceDocumentFormat } from '@/services/desktop'

type UseWorkspaceDocumentTitleRenameOptions<Snapshot extends { path: string; name: string }> = {
  rootPath: string
  activeDocument: WorkspaceDocument | null
  activeDocumentFormat: WorkspaceDocumentFormat | null | undefined
  activeResourcePath: string
  treeState: Pick<UseWorkspaceTreeStateResult, 'flatTreeNodes' | 'setTreeItems' | 'updateTreeMetadata'>
  renameKitableChildrenIndexPath: (sourcePath: string, targetPath: string) => void
  ensureActiveDocumentSaved: () => Promise<boolean>
  snapshots: Snapshot[]
  updateSnapshots: (next: Snapshot[]) => void
  setAgentModifiedDocumentPaths: Dispatch<SetStateAction<Set<string>>>
  remapWorkspaceTabPaths: (sourcePath: string, targetPath: string) => void
  remapOpenedDocumentDrafts: (sourcePath: string, targetPath: string) => void
  setActiveResourcePath: (path: string) => void
  setSaving: (saving: boolean) => void
  setError: (message: string) => void
  setFeedback: (message: string) => void
}

export function useWorkspaceDocumentTitleRename<Snapshot extends { path: string; name: string }>({
  rootPath,
  activeDocument,
  activeDocumentFormat,
  activeResourcePath,
  treeState,
  renameKitableChildrenIndexPath,
  ensureActiveDocumentSaved,
  snapshots,
  updateSnapshots,
  setAgentModifiedDocumentPaths,
  remapWorkspaceTabPaths,
  remapOpenedDocumentDrafts,
  setActiveResourcePath,
  setSaving,
  setError,
  setFeedback,
}: UseWorkspaceDocumentTitleRenameOptions<Snapshot>) {
  const { t } = useTranslation('workspace')

  const renameDocument = useCallback(async ({ path, title }: { path: string; title: string }) => {
    const nextTitle = String(title || '').trim()
    if (!path) throw new Error(t('errors.documentPathEmpty'))
    if (!nextTitle) throw new Error(t('errors.nameEmpty'))

    const targetPath = renameWorkspaceDocumentPath(path, nextTitle)
    if (!targetPath || targetPath === path) {
      const currentDocument = activeDocument?.path === path ? activeDocument : null
      return currentDocument || { path, name: path.split('/').pop() || path, content: '' }
    }

    const activePath = activeDocument?.path || ''
    if (remapWorkspaceBranchPath(activePath, path, targetPath) !== activePath) {
      const saved = await ensureActiveDocumentSaved()
      if (!saved) throw new Error(t('errors.saveBeforeRename'))
    }

    const targetFolder = targetPath.includes('/') ? targetPath.slice(0, targetPath.lastIndexOf('/')) : ''
    const targetName = targetPath.split('/').pop() || targetPath
    const renamedNode = treeState.flatTreeNodes.find((node) => node.path === path)

    setSaving(true)
    setError('')
    setFeedback('')
    try {
      const movedDocument = await moveWorkspaceDocument({ path, target_folder: targetFolder, target_name: targetName })

      // Keep the runtime's data-document row and the children index on the
      // new path. Best effort: a failure must not roll back the disk rename.
      if (path !== movedDocument.path && path.toLowerCase().endsWith('.kitable')) {
        renameKitableChildrenIndexPath(path, movedDocument.path)
        renameDataDocumentByPath({ path, target_path: movedDocument.path, workspace_root: rootPath })
          .catch((cleanupError) => {
            console.warn('[workspace] failed to sync kitable backend index', cleanupError)
          })
      }

      if (renamedNode) {
        treeState.updateTreeMetadata((current) => (
          renameWorkspaceTreeBranchMetadata(current, treeState.flatTreeNodes, renamedNode, movedDocument.path)
        ))
      }
      treeState.setTreeItems((current) => replaceWorkspaceTreeDocumentItem(current, path, movedDocument))
      updateSnapshots(remapSnapshotsAfterMove(snapshots, path, movedDocument.path, movedDocument.name))
      setAgentModifiedDocumentPaths((current) => remapPathSetAfterMove(current, path, movedDocument.path))
      remapWorkspaceTabPaths(path, movedDocument.path)
      remapOpenedDocumentDrafts(path, movedDocument.path)
      if (activeResourcePath && remapWorkspaceBranchPath(activeResourcePath, path, movedDocument.path) !== activeResourcePath) {
        setActiveResourcePath('')
      }

      setFeedback(t('feedback.nameUpdated'))
      return movedDocument
    } catch (requestError: unknown) {
      const message = (requestError as { message?: string } | null)?.message || t('errors.renameFailed')
      setError(message)
      throw new Error(message)
    } finally {
      setSaving(false)
    }
  }, [
    activeDocument,
    activeResourcePath,
    ensureActiveDocumentSaved,
    remapOpenedDocumentDrafts,
    remapWorkspaceTabPaths,
    renameKitableChildrenIndexPath,
    rootPath,
    setAgentModifiedDocumentPaths,
    setActiveResourcePath,
    setError,
    setFeedback,
    setSaving,
    snapshots,
    t,
    treeState,
    updateSnapshots,
  ])

  /** Inline title edit: shows the new name at once and rolls back when the rename fails. */
  const saveDocumentTitle = useCallback(async (nextTitleInput: string) => {
    if (!activeDocument || activeDocumentFormat === 'data') return
    const currentTitle = getWorkspaceItemTitle(activeDocument.name)
    const nextTitle = nextTitleInput.trim() || currentTitle
    if (nextTitle === currentTitle) return

    const targetPath = renameWorkspaceDocumentPath(activeDocument.path, nextTitle)
    const targetName = targetPath.split('/').pop() || activeDocument.name
    treeState.setTreeItems((current) => updateWorkspaceTreeDocumentItem(current, { ...activeDocument, name: targetName }))
    try {
      await renameDocument({ path: activeDocument.path, title: nextTitle })
    } catch {
      treeState.setTreeItems((current) => updateWorkspaceTreeDocumentItem(current, activeDocument))
    }
  }, [activeDocument, activeDocumentFormat, renameDocument, treeState])

  return { saveDocumentTitle }
}
