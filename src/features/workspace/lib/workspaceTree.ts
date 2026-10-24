import { getDocumentParentPath } from '@/features/document/lib/documentCreation'
import { getCurrentLocale } from '@/i18n'
import {
  getWorkspaceItemTitle,
  inferWorkspaceItemFormat,
  remapWorkspaceBranchPath,
  type WorkspaceTreeNode,
} from '@/features/workspace/lib/workspace'
import type { WorkspaceTreeMetadata } from '@/features/workspace/lib/workspacePersistence'
import type { WorkspaceDocument, WorkspaceDocumentTreeItem } from '@/services/desktop'

export function flattenWorkspaceDocumentItems(items: WorkspaceDocumentTreeItem[]) {
  const files: WorkspaceDocumentTreeItem[] = []

  function visit(nextItems: WorkspaceDocumentTreeItem[]) {
    nextItems.forEach((item) => {
      if (item.type === 'file') {
        files.push(item)
        return
      }
      visit(item.children || [])
    })
  }

  visit(items)
  return files
}

function getWorkspaceItemStem(name: string) {
  return getWorkspaceItemTitle(name)
}

function resolveWorkspaceTreeFormat(
  path: string,
  format?: WorkspaceDocument['format'],
  content?: string,
) {
  if (path.toLowerCase().endsWith('.kidesign')) return 'design' as const
  return format || inferWorkspaceItemFormat(path, content)
}

export function getChildFolderPathForNode(node: WorkspaceTreeNode) {
  if (node.type === 'folder') {
    return node.path
  }

  if (node.folderPath) {
    return node.folderPath
  }

  const parentPath = getDocumentParentPath(node.filePath || node.path)
  const stem = getWorkspaceItemStem(node.name)
  return parentPath ? `${parentPath}/${stem}` : stem
}

function sortWorkspaceTreeNodes(
  nodes: WorkspaceTreeNode[],
  parentPath: string,
  metadata: WorkspaceTreeMetadata,
) {
  const order = metadata.order[parentPath] || []
  const orderIndex = new Map(order.map((path, index) => [path, index]))

  return [...nodes].sort((left, right) => {
    const leftIndex = orderIndex.get(left.path)
    const rightIndex = orderIndex.get(right.path)

    if (leftIndex !== undefined || rightIndex !== undefined) {
      return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER)
    }

    if (left.type !== right.type) {
      return left.type === 'folder' ? -1 : 1
    }

    return left.title.localeCompare(right.title, getCurrentLocale())
  })
}

function buildWorkspaceTreeNodes(
  items: WorkspaceDocumentTreeItem[],
  metadata: WorkspaceTreeMetadata,
  parentPath = '',
): WorkspaceTreeNode[] {
  const folders = new Map<string, WorkspaceDocumentTreeItem>()
  const files: WorkspaceDocumentTreeItem[] = []

  items.forEach((item) => {
    if (item.type === 'folder') {
      folders.set(item.name, item)
      return
    }

    // Hide raw workflow storage from the tree. They live under the
    // workspace root and we don't want users
    // editing them by hand. Surface still works for advanced users via
    // OS-level reveal.
    if (parentPath === '' && (item.name === 'workflow.json' || item.name === 'workflow_runs.json')) {
      return
    }

    files.push(item)
  })

  const nodes: WorkspaceTreeNode[] = []
  const consumedFolders = new Set<string>()

  files.forEach((file) => {
    const title = getWorkspaceItemStem(file.name)
    const nestedFolder = folders.get(title)
    if (nestedFolder) {
      consumedFolders.add(nestedFolder.path)
    }

    const children = nestedFolder?.children?.length
      ? buildWorkspaceTreeNodes(nestedFolder.children, metadata, file.path)
      : []

    nodes.push({
      type: 'file',
      path: file.path,
      filePath: file.path,
      folderPath: nestedFolder?.path,
      name: file.name,
      title,
      format: resolveWorkspaceTreeFormat(file.path, file.format),
      parentPath,
      size: file.size,
      updated_at: file.updated_at,
      children,
    })
  })

  folders.forEach((folder) => {
    if (consumedFolders.has(folder.path)) {
      return
    }

    nodes.push({
      type: 'folder',
      path: folder.path,
      folderPath: folder.path,
      name: folder.name,
      title: folder.name,
      parentPath,
      updated_at: folder.updated_at,
      children: buildWorkspaceTreeNodes(folder.children || [], metadata, folder.path),
    })
  })

  return sortWorkspaceTreeNodes(nodes, parentPath, metadata)
}

export function buildPrivateSectionTreeNodes(
  items: WorkspaceDocumentTreeItem[],
  metadata: WorkspaceTreeMetadata,
): WorkspaceTreeNode[] {
  // Include media (images, videos) in the main tree so AI-generated artifacts
  // like Agent/images/<session>/*.png are visible to the user. The earlier
  // design routed media into a separate gallery section that was never wired
  // up, leaving image folders silently invisible after image_generation runs.
  //
  // The global "Workflows" entry used to be appended here as a virtual root
  // node, but it now lives as a lightning-bolt icon in the sidebar header
  // (between the New Page + and Refresh buttons). The routing path
  // (`workflows://`) is unchanged — the icon dispatches it through the same
  // WorkspaceScreen.onOpen handler.
  return buildWorkspaceTreeNodes(items, metadata, '')
}

export function updateWorkspaceTreeDocumentItem(
  items: WorkspaceDocumentTreeItem[],
  document: WorkspaceDocument,
): WorkspaceDocumentTreeItem[] {
  return items.map((item) => {
    if (item.type === 'file' && item.path === document.path) {
      return {
        ...item,
        name: document.name,
        format: resolveWorkspaceTreeFormat(document.path, document.format, document.content),
        size: document.size ?? document.content.length,
        updated_at: document.updated_at,
      }
    }

    if (item.children?.length) {
      return {
        ...item,
        children: updateWorkspaceTreeDocumentItem(item.children, document),
      }
    }

    return item
  })
}

export function replaceWorkspaceTreeDocumentItem(
  items: WorkspaceDocumentTreeItem[],
  previousPath: string,
  document: WorkspaceDocument,
): WorkspaceDocumentTreeItem[] {
  const containsPreviousPath = flattenWorkspaceDocumentItems(items)
    .some((item) => item.path === previousPath)
  const pathToReplace = containsPreviousPath ? previousPath : document.path

  return replaceWorkspaceTreeDocumentItemAtPath(items, pathToReplace, document)
}

function replaceWorkspaceTreeDocumentItemAtPath(
  items: WorkspaceDocumentTreeItem[],
  pathToReplace: string,
  document: WorkspaceDocument,
): WorkspaceDocumentTreeItem[] {
  return items.map((item) => {
    if (item.type === 'file' && item.path === pathToReplace) {
      return {
        ...item,
        path: document.path,
        name: document.name,
        format: resolveWorkspaceTreeFormat(document.path, document.format, document.content),
        size: document.size ?? document.content.length,
        updated_at: document.updated_at,
      }
    }

    if (item.children?.length) {
      return {
        ...item,
        children: replaceWorkspaceTreeDocumentItemAtPath(item.children, pathToReplace, document),
      }
    }

    return item
  })
}

// Splice a freshly-created document into the raw tree without a full
// listWorkspaceDocuments() refetch. The render layer (buildWorkspaceTreeNodes)
// re-sorts every level, so we only need to drop the item under the right parent
// folder — order doesn't matter. Avoids the whole-tree flash on create.
export function insertWorkspaceTreeDocumentItem(
  items: WorkspaceDocumentTreeItem[],
  document: WorkspaceDocument,
): WorkspaceDocumentTreeItem[] {
  const newItem: WorkspaceDocumentTreeItem = {
    type: 'file',
    path: document.path,
    name: document.name,
    format: resolveWorkspaceTreeFormat(document.path, document.format, document.content),
    size: document.size ?? document.content.length,
    updated_at: document.updated_at,
  }
  return insertItemUnderParent(items, getDocumentParentPath(document.path), newItem)
}

function insertItemUnderParent(
  items: WorkspaceDocumentTreeItem[],
  parentPath: string,
  newItem: WorkspaceDocumentTreeItem,
): WorkspaceDocumentTreeItem[] {
  if (!parentPath) {
    return upsertTreeSibling(items, newItem)
  }
  return items.map((item) => {
    if (item.type !== 'folder') {
      return item
    }
    if (item.path === parentPath) {
      return { ...item, children: upsertTreeSibling(item.children || [], newItem) }
    }
    if (parentPath.startsWith(`${item.path}/`)) {
      return { ...item, children: insertItemUnderParent(item.children || [], parentPath, newItem) }
    }
    return item
  })
}

function upsertTreeSibling(
  items: WorkspaceDocumentTreeItem[],
  newItem: WorkspaceDocumentTreeItem,
): WorkspaceDocumentTreeItem[] {
  return [...items.filter((item) => item.path !== newItem.path), newItem]
}

export function flattenWorkspaceTreeNodes(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenWorkspaceTreeNodes(node.children)])
}

export function reorderWorkspaceTreeMetadata(
  metadata: WorkspaceTreeMetadata,
  flatTreeNodes: WorkspaceTreeNode[],
  draggedPath: string,
  targetPath: string,
  position: 'before' | 'after' = 'before',
) {
  if (!draggedPath || draggedPath === targetPath) {
    return metadata
  }

  const draggedNode = flatTreeNodes.find((node) => node.path === draggedPath)
  const targetNode = flatTreeNodes.find((node) => node.path === targetPath)

  if (!draggedNode || !targetNode || draggedNode.parentPath !== targetNode.parentPath) {
    return metadata
  }

  const siblings = flatTreeNodes.filter((node) => node.parentPath === targetNode.parentPath)
  const nextOrder = siblings.map((node) => node.path)
  const draggedIndex = nextOrder.indexOf(draggedPath)

  if (draggedIndex < 0) {
    return metadata
  }

  nextOrder.splice(draggedIndex, 1)
  const targetIndex = nextOrder.indexOf(targetPath)
  if (targetIndex < 0) {
    return metadata
  }
  nextOrder.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, draggedPath)

  return {
    ...metadata,
    order: {
      ...metadata.order,
      [targetNode.parentPath]: nextOrder,
    },
  }
}

export function removeWorkspaceTreeBranchMetadata(
  metadata: WorkspaceTreeMetadata,
  nodePath: string,
  childFolderPath: string,
) {
  const childPrefix = `${childFolderPath}/`
  const nextIcons: Record<string, string> = {}

  for (const [path, icon] of Object.entries(metadata.icons)) {
    if (path !== nodePath && !path.startsWith(childPrefix)) {
      nextIcons[path] = icon
    }
  }

  const nextOrder: Record<string, string[]> = {}
  for (const [parentPath, order] of Object.entries(metadata.order)) {
    if (parentPath !== nodePath && !parentPath.startsWith(childPrefix)) {
      nextOrder[parentPath] = order.filter((path) => path !== nodePath && !path.startsWith(childPrefix))
    }
  }

  const nextCollapsed = metadata.collapsed.filter(
    (path) => path !== nodePath && !path.startsWith(childPrefix),
  )
  const nextExpandedFolders = metadata.expandedFolders.filter(
    (path) => path !== nodePath && !path.startsWith(childPrefix),
  )

  return {
    ...metadata,
    icons: nextIcons,
    order: nextOrder,
    collapsed: nextCollapsed,
    expandedFolders: nextExpandedFolders,
  }
}

export function moveWorkspaceTreeBranchMetadata(
  metadata: WorkspaceTreeMetadata,
  draggedNode: WorkspaceTreeNode,
  movedPath: string,
) {
  const nextIcons: Record<string, string> = {}

  for (const [path, icon] of Object.entries(metadata.icons)) {
    const nextPath = remapWorkspaceBranchPath(path, draggedNode.path, movedPath)
    if (nextPath === path) {
      nextIcons[path] = icon
      continue
    }
    nextIcons[nextPath] = icon
  }

  const nextOrder: Record<string, string[]> = {}
  for (const [parentPath, order] of Object.entries(metadata.order)) {
    const nextParentPath = remapWorkspaceBranchPath(parentPath, draggedNode.path, movedPath)
    nextOrder[nextParentPath] = order
      .filter((path) => path !== draggedNode.path)
      .map((path) => remapWorkspaceBranchPath(path, draggedNode.path, movedPath))
  }

  const nextCollapsed = metadata.collapsed.map((path) =>
    remapWorkspaceBranchPath(path, draggedNode.path, movedPath),
  )
  const nextExpandedFolders = metadata.expandedFolders.map((path) =>
    remapWorkspaceBranchPath(path, draggedNode.path, movedPath),
  )

  return {
    icons: nextIcons,
    order: nextOrder,
    collapsed: nextCollapsed,
    expandedFolders: nextExpandedFolders,
  }
}

export function renameWorkspaceTreeBranchMetadata(
  metadata: WorkspaceTreeMetadata,
  flatTreeNodes: WorkspaceTreeNode[],
  renamedNode: WorkspaceTreeNode,
  movedPath: string,
) {
  const movedMetadata = moveWorkspaceTreeBranchMetadata(metadata, renamedNode, movedPath)
  const siblingOrder = flatTreeNodes
    .filter((node) => node.parentPath === renamedNode.parentPath)
    .map((node) => node.path === renamedNode.path ? movedPath : node.path)

  if (!siblingOrder.includes(movedPath)) {
    return movedMetadata
  }

  return {
    ...movedMetadata,
    order: {
      ...movedMetadata.order,
      [renamedNode.parentPath]: siblingOrder,
    },
  }
}

export function collectAllFolderPaths(items: WorkspaceDocumentTreeItem[]) {
  const paths = new Set<string>()

  function visit(nextItems: WorkspaceDocumentTreeItem[]) {
    nextItems.forEach((item) => {
      if (item.type !== 'folder') {
        return
      }
      paths.add(item.path)
      visit(item.children || [])
    })
  }

  visit(items)
  return paths
}
