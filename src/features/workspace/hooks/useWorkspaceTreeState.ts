import { useCallback, useMemo, useState } from 'react'
import type { SetStateAction, Dispatch } from 'react'
import {
  getDefaultWorkspaceTreeMetadata,
  getWorkspaceDisplayName,
  readRecentWorkspacePaths,
  readWorkspaceTreeMetadataMap,
  writeWorkspaceTreeMetadataMap,
  type WorkspaceTreeMetadata,
  type WorkspaceTreeMetadataMap,
} from '@/features/workspace/lib/workspacePersistence'
import {
  buildPrivateSectionTreeNodes,
  collectAllFolderPaths,
  collectAllKitableFilePaths,
  flattenWorkspaceDocumentItems,
  flattenWorkspaceTreeNodes,
} from '@/features/workspace/lib/workspaceTree'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import type { WorkspaceDocumentTreeItem } from '@/services/desktop'

export type UseWorkspaceTreeStateResult = {
  createMenuFolder: string | undefined
  createMenuOpen: boolean
  createMenuTriggerPath: string
  expandFolders: (paths: string[]) => void
  expandedPaths: Set<string>
  files: WorkspaceDocumentTreeItem[]
  flatTreeNodes: WorkspaceTreeNode[]
  loading: boolean
  openCreateFormatMenu: (folder?: string, triggerPath?: string) => void
  recentWorkspacePaths: string[]
  rootPath: string
  setCreateMenuFolder: Dispatch<SetStateAction<string | undefined>>
  setCreateMenuOpen: Dispatch<SetStateAction<boolean>>
  setLoading: Dispatch<SetStateAction<boolean>>
  setRecentWorkspacePaths: Dispatch<SetStateAction<string[]>>
  setRootPath: Dispatch<SetStateAction<string>>
  setTreeItems: Dispatch<SetStateAction<WorkspaceDocumentTreeItem[]>>
  setWorkspaceItemIcon: (path: string, icon: string | null) => void
  toggleFolder: (path: string) => void
  treeItems: WorkspaceDocumentTreeItem[]
  treeMetadata: WorkspaceTreeMetadata
  updateTreeMetadata: (updater: (metadata: WorkspaceTreeMetadata) => WorkspaceTreeMetadata) => void
  workspaceDisplayName: string
  workspaceTreeNodes: WorkspaceTreeNode[]
}

export function useWorkspaceTreeState(): UseWorkspaceTreeStateResult {
  const [treeItems, setTreeItems] = useState<WorkspaceDocumentTreeItem[]>([])
  const [rootPath, setRootPath] = useState('')
  const [treeMetadataMap, setTreeMetadataMap] = useState<WorkspaceTreeMetadataMap>(
    () => readWorkspaceTreeMetadataMap(),
  )
  const [recentWorkspacePaths, setRecentWorkspacePaths] = useState<string[]>(() => readRecentWorkspacePaths())
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [createMenuFolder, setCreateMenuFolder] = useState<string | undefined>(undefined)
  // '' = sidebar header trigger. Any other value = the tree node path whose
  // inline `+` button opened the menu. The matching anchor is the only place
  // that renders the popup, so it ends up next to the actual trigger.
  const [createMenuTriggerPath, setCreateMenuTriggerPath] = useState('')
  const [loading, setLoading] = useState(true)

  const treeMetadata = useMemo<WorkspaceTreeMetadata>(
    () => treeMetadataMap[rootPath] ?? getDefaultWorkspaceTreeMetadata(),
    [treeMetadataMap, rootPath],
  )

  const files = useMemo(() => flattenWorkspaceDocumentItems(treeItems), [treeItems])
  const workspaceDisplayName = useMemo(() => getWorkspaceDisplayName(rootPath), [rootPath])
  const workspaceTreeNodes = useMemo(
    () => buildPrivateSectionTreeNodes(treeItems, treeMetadata),
    [treeItems, treeMetadata],
  )
  const flatTreeNodes = useMemo(
    () => flattenWorkspaceTreeNodes(workspaceTreeNodes),
    [workspaceTreeNodes],
  )

  const allFolderPaths = useMemo(() => collectAllFolderPaths(treeItems), [treeItems])
  const allKitableFilePaths = useMemo(() => collectAllKitableFilePaths(treeItems), [treeItems])
  const expandedPaths = useMemo(() => {
    const collapsed = new Set(treeMetadata.collapsed)
    const next = new Set<string>()
    // Folders: default EXPANDED — include unless collapsed.
    allFolderPaths.forEach((path) => {
      if (!collapsed.has(path)) {
        next.add(path)
      }
    })
    // Kitable files: default COLLAPSED — include (i.e. expand) only when the
    // user has toggled them, which adds them to the `collapsed` set (inverted
    // semantics so the same `toggleFolder` mechanic works for both cases).
    allKitableFilePaths.forEach((path) => {
      if (collapsed.has(path)) {
        next.add(path)
      }
    })
    return next
  }, [allFolderPaths, allKitableFilePaths, treeMetadata.collapsed])

  const updateTreeMetadata = useCallback((updater: (metadata: WorkspaceTreeMetadata) => WorkspaceTreeMetadata) => {
    setTreeMetadataMap((current) => {
      const bucket = current[rootPath] ?? getDefaultWorkspaceTreeMetadata()
      const next = updater(bucket)
      const nextMap = { ...current, [rootPath]: next }
      writeWorkspaceTreeMetadataMap(nextMap)
      return nextMap
    })
  }, [rootPath])

  const openCreateFormatMenu = useCallback((folder?: string, triggerPath: string = '') => {
    setCreateMenuFolder(folder)
    setCreateMenuTriggerPath(triggerPath)
    setCreateMenuOpen((value) => !value || createMenuTriggerPath !== triggerPath)
  }, [createMenuTriggerPath])

  const toggleFolder = useCallback((path: string) => {
    updateTreeMetadata((current) => {
      const collapsed = new Set(current.collapsed)
      if (collapsed.has(path)) {
        collapsed.delete(path)
      } else {
        collapsed.add(path)
      }
      return { ...current, collapsed: [...collapsed] }
    })
  }, [updateTreeMetadata])

  const expandFolders = useCallback((paths: string[]) => {
    const targets = paths.filter((path) => typeof path === 'string' && path.length > 0)
    if (targets.length === 0) {
      return
    }
    updateTreeMetadata((current) => {
      if (current.collapsed.length === 0) {
        return current
      }
      const removal = new Set(targets)
      const nextCollapsed = current.collapsed.filter((path) => !removal.has(path))
      if (nextCollapsed.length === current.collapsed.length) {
        return current
      }
      return { ...current, collapsed: nextCollapsed }
    })
  }, [updateTreeMetadata])

  const setWorkspaceItemIcon = useCallback((path: string, icon: string | null) => {
    updateTreeMetadata((current) => {
      const nextIcons = { ...current.icons }
      if (icon) {
        nextIcons[path] = icon
      } else {
        delete nextIcons[path]
      }

      return {
        ...current,
        icons: nextIcons,
      }
    })
  }, [updateTreeMetadata])

  return {
    createMenuFolder,
    createMenuOpen,
    createMenuTriggerPath,
    expandFolders,
    expandedPaths,
    files,
    flatTreeNodes,
    loading,
    openCreateFormatMenu,
    recentWorkspacePaths,
    rootPath,
    setCreateMenuFolder,
    setCreateMenuOpen,
    setLoading,
    setRecentWorkspacePaths,
    setRootPath,
    setTreeItems,
    setWorkspaceItemIcon,
    toggleFolder,
    treeItems,
    treeMetadata,
    updateTreeMetadata,
    workspaceDisplayName,
    workspaceTreeNodes,
  }
}
