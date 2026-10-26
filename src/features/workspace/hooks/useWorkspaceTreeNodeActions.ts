import { flushWorkspaceEditSessions } from '@/services/workspaceEditSessions'
import { loadDesignLib } from '@/features/design/public'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { isTableFilePath, reportTableFileDeleted, reportTableFileRenamed } from '@/api/kitTables'
import { useConfirm } from '@kition/tessera-ui'
import {
  syncDocumentFileDeleted,
  syncDocumentFileDuplicated,
  syncDocumentFileMoved,
  syncDocumentFolderDeleted,
  syncDocumentFolderMoved,
} from '@/features/workspace/lib/documentIdentity'
import type { UseWorkspaceTreeStateResult } from '@/features/workspace/hooks/useWorkspaceTreeState'
import type { WorkspaceTab, WorkspaceTreeDropPosition, WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import {
  inferWorkspaceItemFormat,
  isDuplicableWorkspaceFormat,
  isOrganizableWorkspaceFormat,
  remapWorkspaceBranchPath,
  renameWorkspaceDocumentPath,
  isSupportedWorkspaceFormat,
} from '@/features/workspace/lib/workspace'
import {
  readLastActiveDocumentPath,
  writeLastActiveDocumentPath,
} from '@/features/workspace/lib/workspacePersistence'
import type { WorkspaceTreeMetadata } from '@/features/workspace/lib/workspacePersistence'
import {
  getChildFolderPathForNode,
  getDocumentParentPath,
  moveWorkspaceTreeBranchMetadata,
  renameWorkspaceTreeBranchMetadata,
  removeWorkspaceTreeBranchMetadata,
  reorderWorkspaceTreeMetadata,
} from '@/features/workspace/lib/workspaceTree'
import {
  deleteWorkspaceDocument,
  deleteWorkspaceFolder,
  moveWorkspaceFolder,
  moveWorkspaceDocument,
  readWorkspaceDocument,
  writeWorkspaceDocument,
  type WorkspaceDocumentListResponse,
} from '@/services/desktop'

type UseWorkspaceTreeNodeActionsOptions = {
  activeDocumentPath: string
  activeResourcePath: string
  applyWorkspaceDocumentList: (
    response: WorkspaceDocumentListResponse,
    preferredPath?: string,
  ) => Promise<void>
  filterWorkspaceTabs: (predicate: (tab: WorkspaceTab) => boolean) => void
  refreshWorkspaceDocuments: (preferredPath?: string, options?: { silent?: boolean; treeOnly?: boolean }) => Promise<boolean>
  remapWorkspaceTabPaths: (sourcePath: string, targetPath: string) => void
  renameWorkspaceTabPath: (fromPath: string, toPath: string) => void
  rootPath: string
  setActiveResourcePath: (path: string) => void
  setActiveWorkspaceTabId: (tabId: string) => void
  setAgentModifiedDocumentPaths: (updater: (current: Set<string>) => Set<string>) => void
  setError: (message: string) => void
  setFeedback: (message: string) => void
  setSaving: (value: boolean) => void
  treeState: Pick<
    UseWorkspaceTreeStateResult,
    'expandFolders' | 'flatTreeNodes' | 'updateTreeMetadata'
  >
}

// Workflows, form sync, and email sync name table files by path: a renamed or moved table
// file (or a folder holding some) is followed there. Fire-and-forget by design — failure here
// mustn't roll back the disk op.
function followMovedTableFiles(fromPath: string, toPath: string) {
  if (!fromPath || !toPath || fromPath === toPath) {
    return
  }
  reportTableFileRenamed(fromPath, toPath).catch((cleanupError) => {
    console.warn('[workspace] failed to follow a moved table file', cleanupError)
  })
}

// The workflows, form syncs, and email syncs bound to a deleted table file (or to the table files
// of a deleted folder) go with it. Fire-and-forget, as for moves: the file is already in the Trash.
function followDeletedTableFiles(node: WorkspaceTreeNode) {
  const gone = new Set<string>()
  if (node.type === 'folder' || isTableFilePath(node.path)) gone.add(node.path)
  if (node.type === 'file' && node.folderPath) gone.add(node.folderPath)
  for (const path of gone) {
    reportTableFileDeleted(path).catch((cleanupError) => {
      console.warn('[workspace] failed to follow a deleted table file', cleanupError)
    })
  }
}

function getWorkspaceDeleteConfirmationMessage(
  node: Pick<WorkspaceTreeNode, 'title' | 'type'>,
  childCount: number,
) {
  const childPageSummary = childCount > 0
    ? ` and its ${childCount} ${node.type === 'folder' ? 'page' : 'child page'}${childCount === 1 ? '' : 's'}`
    : ''
  const target = node.type === 'folder'
    ? `folder "${node.title}"`
    : `"${node.title}"`

  return `Move ${target}${childPageSummary} to the system Trash? You can restore it from there.`
}

export function useWorkspaceTreeNodeActions({
  activeDocumentPath,
  activeResourcePath,
  applyWorkspaceDocumentList,
  filterWorkspaceTabs,
  refreshWorkspaceDocuments,
  remapWorkspaceTabPaths,
  renameWorkspaceTabPath,
  rootPath,
  setActiveResourcePath,
  setActiveWorkspaceTabId,
  setAgentModifiedDocumentPaths,
  setError,
  setFeedback,
  setSaving,
  treeState,
}: UseWorkspaceTreeNodeActionsOptions) {
  const { expandFolders, flatTreeNodes, updateTreeMetadata } = treeState
  const confirm = useConfirm()
  const { t } = useTranslation('workspace')

  const deleteDocumentNode = useCallback(async (node: WorkspaceTreeNode) => {
    if (node.virtual) {
      return
    }
    if (node.type === 'file' && !isSupportedWorkspaceFormat(node.format || inferWorkspaceItemFormat(node.path))) {
      setError(t('errors.fileTypeNotDeletable'))
      return
    }

    const childFolderPath = getChildFolderPathForNode(node)
    const childPrefix = `${childFolderPath}/`
    const isFolder = node.type === 'folder'

    const childCount = flatTreeNodes
      .filter((item) => item.path.startsWith(childPrefix) && item.type === 'file')
      .length
    const message = getWorkspaceDeleteConfirmationMessage(node, childCount)
    if (!(await confirm({
      message,
      confirmLabel: t('tree.delete'),
      variant: 'danger',
    }))) {
      return
    }

    setSaving(true)
    setError('')
    setFeedback('')

    try {
      const response = isFolder
        ? await deleteWorkspaceFolder(node.path)
        : await deleteWorkspaceDocument(node.path)
      await (isFolder ? syncDocumentFolderDeleted(rootPath, node.path) : syncDocumentFileDeleted(rootPath, node.path))
      followDeletedTableFiles(node)
      updateTreeMetadata((current) => removeWorkspaceTreeBranchMetadata(current, node.path, childFolderPath))
      setAgentModifiedDocumentPaths(
        (current) => new Set([...current].filter((path) => path !== node.path && !path.startsWith(childPrefix))),
      )
      filterWorkspaceTabs(
        (tab) => (
          (tab.type !== 'file-viewer' && tab.type !== 'design')
          || (tab.path !== node.path && !tab.path.startsWith(childPrefix))
        ),
      )

      if (activeResourcePath === node.path || activeResourcePath.startsWith(childPrefix)) {
        setActiveResourcePath('')
      }
      if (activeDocumentPath === node.path || activeDocumentPath.startsWith(childPrefix)) {
        setActiveWorkspaceTabId('')
      }

      const lastActivePath = readLastActiveDocumentPath()
      if (lastActivePath === node.path || lastActivePath.startsWith(childPrefix)) {
        writeLastActiveDocumentPath('')
      }

      await applyWorkspaceDocumentList(response)
      setFeedback(isFolder ? 'Folder moved to Trash' : 'Document moved to Trash')
    } catch (requestError: any) {
      setError(requestError?.message || (isFolder ? 'Failed to move folder to Trash' : 'Failed to move document to Trash'))
    } finally {
      setSaving(false)
    }
  }, [
    activeDocumentPath,
    activeResourcePath,
    applyWorkspaceDocumentList,
    confirm,
    filterWorkspaceTabs,
    flatTreeNodes,
    rootPath,
    setActiveResourcePath,
    setActiveWorkspaceTabId,
    setAgentModifiedDocumentPaths,
    setError,
    setFeedback,
    setSaving,
    t,
    updateTreeMetadata,
  ])

  const dropWorkspaceNode = useCallback(async (
    draggedPath: string,
    targetPath: string,
    position: WorkspaceTreeDropPosition = 'inside',
  ) => {
    if (!draggedPath || draggedPath === targetPath) {
      return
    }

    const draggedNode = flatTreeNodes.find((node) => node.path === draggedPath)
    const targetNode = flatTreeNodes.find((node) => node.path === targetPath)

    if (!draggedNode || !targetNode || draggedNode.virtual) {
      return
    }

    // Cannot drag a node into its own subtree.
    if (targetPath === draggedNode.path || targetPath.startsWith(`${draggedNode.path}/`)) {
      return
    }

    // inside = move into the target (the folder itself / the file's same-named child folder);
    // before/after = place at the target's own level. Note: in the tree, files "absorb" a
    // same-named folder, so displayParent (used for ordering metadata) and destinationFolder
    // (the filesystem directory passed to the backend move) may differ. A child's parentPath
    // is always equal to its parent's path.
    const destinationFolder = position === 'inside'
      ? getChildFolderPathForNode(targetNode)
      : getDocumentParentPath(targetNode.filePath || targetNode.path)
    const displayParent = position === 'inside' ? targetNode.path : targetNode.parentPath

    // The dragged item is already at the target level: inside is a no-op; before/after just reorders on the client.
    if (draggedNode.parentPath === displayParent) {
      if (position === 'inside') {
        return
      }
      updateTreeMetadata((current) => reorderWorkspaceTreeMetadata(current, flatTreeNodes, draggedPath, targetPath, position))
      return
    }

    const buildSiblingOrder = (movedPath: string) => {
      const order = flatTreeNodes
        .filter((node) => node.parentPath === displayParent && node.path !== movedPath)
        .map((node) => node.path)
      const targetIndex = order.indexOf(targetPath)
      const insertAt = targetIndex < 0
        ? order.length
        : position === 'after' ? targetIndex + 1 : targetIndex
      order.splice(insertAt, 0, movedPath)
      return order
    }

    const applyMovedMetadata = (current: WorkspaceTreeMetadata, movedPath: string) => {
      const moved = moveWorkspaceTreeBranchMetadata(current, draggedNode, movedPath)
      if (position === 'inside') {
        return moved
      }
      return {
        ...moved,
        order: { ...moved.order, [displayParent]: buildSiblingOrder(movedPath) },
      }
    }

    if (draggedNode.type === 'folder') {
      if (destinationFolder === draggedNode.path || destinationFolder.startsWith(`${draggedNode.path}/`)) {
        setError('A folder cannot be moved into its own subfolder.')
        return
      }

      setSaving(true)
      setError('')
      setFeedback('')

      try {
        const response = await moveWorkspaceFolder({
          path: draggedNode.path,
          target_folder: destinationFolder,
        })
        const movedPath = response.moved_path
        await syncDocumentFolderMoved(rootPath, draggedNode.path, movedPath)
        updateTreeMetadata((current) => applyMovedMetadata(current, movedPath))
        remapWorkspaceTabPaths(draggedNode.path, movedPath)
        if (destinationFolder) {
          expandFolders([destinationFolder])
        }
        await applyWorkspaceDocumentList(
          response,
          activeDocumentPath.startsWith(`${draggedNode.path}/`)
            ? remapWorkspaceBranchPath(activeDocumentPath, draggedNode.path, movedPath)
            : undefined,
        )
        setFeedback(`Moved folder "${draggedNode.title}"`)
      } catch (requestError: any) {
        setError(requestError?.message || 'Failed to move folder')
      } finally {
        setSaving(false)
      }
      return
    }

    if (!isOrganizableWorkspaceFormat(draggedNode.format)) {
      setError(t('errors.onlyWorkspaceItemsMovable'))
      return
    }

    const draggedChildFolder = getChildFolderPathForNode(draggedNode)
    if (destinationFolder === draggedChildFolder || destinationFolder.startsWith(`${draggedChildFolder}/`)) {
      setError('A page cannot be moved into its own child page.')
      return
    }

    setSaving(true)
    setError('')
    setFeedback('')

    try {
      const movedDocument = await moveWorkspaceDocument({
        path: draggedNode.path,
        target_folder: destinationFolder,
      })
      followMovedTableFiles(draggedNode.path, movedDocument.path)
      await syncDocumentFileMoved(rootPath, draggedNode.path, movedDocument.path)
      updateTreeMetadata((current) => applyMovedMetadata(current, movedDocument.path))
      remapWorkspaceTabPaths(draggedNode.path, movedDocument.path)
      const expandTargets: string[] = []
      if (destinationFolder) expandTargets.push(destinationFolder)
      if (position === 'inside') expandTargets.push(targetNode.path)
      if (expandTargets.length > 0) expandFolders(expandTargets)
      setFeedback(position === 'inside' ? `Moved under ${targetNode.title}` : `Moved "${draggedNode.title}"`)
      await refreshWorkspaceDocuments(movedDocument.path)
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to move page')
    } finally {
      setSaving(false)
    }
  }, [
    activeDocumentPath,
    applyWorkspaceDocumentList,
    expandFolders,
    flatTreeNodes,
    refreshWorkspaceDocuments,
    remapWorkspaceTabPaths,
    rootPath,
    setError,
    setFeedback,
    setSaving,
    t,
    updateTreeMetadata,
  ])

  const duplicateDocumentNode = useCallback(async (node: WorkspaceTreeNode) => {
    if (node.virtual || node.type !== 'file' || !isDuplicableWorkspaceFormat(node.format)) {
      setError(t('errors.onlyWorkspaceItemsDuplicable'))
      return
    }

    const parentFolder = getDocumentParentPath(node.filePath || node.path)
    const extension = node.name.match(/\.[^./]+$/)?.[0] || ''
    const stem = extension ? node.name.slice(0, -extension.length) : node.name
    const existingPaths = new Set(flatTreeNodes.map((item) => item.path))
    let copyPath = parentFolder ? `${parentFolder}/${stem} copy${extension}` : `${stem} copy${extension}`
    let index = 2
    while (existingPaths.has(copyPath)) {
      const nextName = `${stem} copy ${index}${extension}`
      copyPath = parentFolder ? `${parentFolder}/${nextName}` : nextName
      index += 1
    }

    setSaving(true)
    setError('')
    setFeedback('')

    try {
      await flushWorkspaceEditSessions(node.path)
      const source = await readWorkspaceDocument(node.path)
      if (node.path.toLowerCase().endsWith('.kidesign')) {
        const { createDesignFile, parseDesign } = await loadDesignLib()
        const design = parseDesign(source.content)
        const created = await createDesignFile(rootPath, parentFolder, { ...design, title: `${stem} copy` })
        await refreshWorkspaceDocuments(undefined, { treeOnly: true })
        window.dispatchEvent(new CustomEvent('kition:search:open-path', { detail: { path: created.path } }))
        return
      }
      const created = await writeWorkspaceDocument(copyPath, source.content)
      if (/\.(md|markdown)$/i.test(created.path)) {
        // The copy is a new document: it gets its own identity when first opened.
        await syncDocumentFileDuplicated(rootPath, node.path, created.path)
      }
      setFeedback(`Duplicated "${node.title}"`)
      await refreshWorkspaceDocuments(created.path)
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to duplicate page')
    } finally {
      setSaving(false)
    }
  }, [
    flatTreeNodes,
    rootPath,
    refreshWorkspaceDocuments,
    setError,
    setFeedback,
    setSaving,
    t,
  ])

  const renameWorkspaceNode = useCallback(async (node: WorkspaceTreeNode, nextTitle: string) => {
    const trimmed = String(nextTitle || '').trim()
    if (node.virtual || !trimmed || trimmed === node.title) {
      return
    }

    setSaving(true)
    setError('')
    setFeedback('')

    try {
      if (node.type === 'folder') {
        const response = await moveWorkspaceFolder({ path: node.path, target_name: trimmed })
        const movedPath = response.moved_path
        await syncDocumentFolderMoved(rootPath, node.path, movedPath)
        updateTreeMetadata((current) => (
          renameWorkspaceTreeBranchMetadata(current, flatTreeNodes, node, movedPath)
        ))
        remapWorkspaceTabPaths(node.path, movedPath)
        await applyWorkspaceDocumentList(
          response,
          activeDocumentPath.startsWith(`${node.path}/`)
            ? remapWorkspaceBranchPath(activeDocumentPath, node.path, movedPath)
            : undefined,
        )
        setFeedback(t('feedback.renamed'))
        return
      }

      if (!isOrganizableWorkspaceFormat(node.format)) {
        setError(t('errors.onlyWorkspaceItemsRenamable'))
        return
      }

      const targetName = renameWorkspaceDocumentPath(node.path, trimmed).split('/').pop() || ''
      const moved = await moveWorkspaceDocument({ path: node.path, target_name: targetName })
      followMovedTableFiles(node.path, moved.path)
      await syncDocumentFileMoved(rootPath, node.path, moved.path)
      updateTreeMetadata((current) => (
        renameWorkspaceTreeBranchMetadata(current, flatTreeNodes, node, moved.path)
      ))
      remapWorkspaceTabPaths(node.path, moved.path)
      // A table file's workflow tab follows the file.
      if (node.path.toLowerCase().endsWith('.ktable')) {
        renameWorkspaceTabPath(node.path, moved.path)
      }
      setFeedback(t('feedback.renamed'))
      await refreshWorkspaceDocuments(moved.path)
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to rename')
    } finally {
      setSaving(false)
    }
  }, [
    activeDocumentPath,
    applyWorkspaceDocumentList,
    refreshWorkspaceDocuments,
    remapWorkspaceTabPaths,
    renameWorkspaceTabPath,
    rootPath,
    setError,
    setFeedback,
    setSaving,
    t,
    updateTreeMetadata,
  ])

  const moveWorkspaceNodeToFolder = useCallback(async (
    node: WorkspaceTreeNode,
    targetNode: WorkspaceTreeNode | null,
  ) => {
    if (node.virtual) {
      return
    }

    const destinationFolder = targetNode ? getChildFolderPathForNode(targetNode) : ''
    const currentFolder = getDocumentParentPath(node.filePath || node.path)
    if (currentFolder === destinationFolder) {
      setFeedback(t('feedback.alreadyInLocation'))
      return
    }
    if (destinationFolder === node.path || destinationFolder.startsWith(`${node.path}/`)) {
      setError('A node cannot be moved into its own subfolder.')
      return
    }

    if (node.type === 'folder') {
      setSaving(true)
      setError('')
      setFeedback('')
      try {
        const response = await moveWorkspaceFolder({ path: node.path, target_folder: destinationFolder })
        const movedPath = response.moved_path
        await syncDocumentFolderMoved(rootPath, node.path, movedPath)
        updateTreeMetadata((current) => moveWorkspaceTreeBranchMetadata(current, node, movedPath))
        remapWorkspaceTabPaths(node.path, movedPath)
        {
          const expandTargets: string[] = []
          if (destinationFolder) expandTargets.push(destinationFolder)
          if (targetNode) expandTargets.push(targetNode.path)
          if (expandTargets.length > 0) expandFolders(expandTargets)
        }
        await applyWorkspaceDocumentList(
          response,
          activeDocumentPath.startsWith(`${node.path}/`)
            ? remapWorkspaceBranchPath(activeDocumentPath, node.path, movedPath)
            : undefined,
        )
        setFeedback(targetNode ? `Moved folder "${node.title}" to ${targetNode.title}` : `Moved folder "${node.title}" to root`)
      } catch (requestError: any) {
        setError(requestError?.message || 'Failed to move folder')
      } finally {
        setSaving(false)
      }
      return
    }

    if (!isOrganizableWorkspaceFormat(node.format)) {
      setError(t('errors.onlyWorkspaceItemsMovable'))
      return
    }

    const draggedChildFolder = getChildFolderPathForNode(node)
    if (destinationFolder === draggedChildFolder || destinationFolder.startsWith(`${draggedChildFolder}/`)) {
      setError('A page cannot be moved into its own child page.')
      return
    }

    setSaving(true)
    setError('')
    setFeedback('')
    try {
      const moved = await moveWorkspaceDocument({ path: node.path, target_folder: destinationFolder })
      followMovedTableFiles(node.path, moved.path)
      await syncDocumentFileMoved(rootPath, node.path, moved.path)
      updateTreeMetadata((current) => moveWorkspaceTreeBranchMetadata(current, node, moved.path))
      remapWorkspaceTabPaths(node.path, moved.path)
      {
        const expandTargets: string[] = []
        if (destinationFolder) expandTargets.push(destinationFolder)
        if (targetNode) expandTargets.push(targetNode.path)
        if (expandTargets.length > 0) expandFolders(expandTargets)
      }
      setFeedback(targetNode ? `Moved under ${targetNode.title}` : 'Moved to root')
      await refreshWorkspaceDocuments(moved.path)
    } catch (requestError: any) {
      setError(requestError?.message || 'Failed to move page')
    } finally {
      setSaving(false)
    }
  }, [
    activeDocumentPath,
    applyWorkspaceDocumentList,
    expandFolders,
    refreshWorkspaceDocuments,
    remapWorkspaceTabPaths,
    rootPath,
    setError,
    setFeedback,
    setSaving,
    t,
    updateTreeMetadata,
  ])

  return {
    deleteDocumentNode,
    dropWorkspaceNode,
    duplicateDocumentNode,
    moveWorkspaceNodeToFolder,
    renameWorkspaceNode,
  }
}
