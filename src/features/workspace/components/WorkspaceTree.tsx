import { ChevronRight, Copy, CornerUpRight, FilePlus2, FileText, FolderOpen, GripVertical, LayoutDashboard, MessageSquareDashed, MessageSquarePlus, MoreHorizontal, Pencil, Plus, Smile, Trash2, Zap } from 'lucide-react'
import type { DragEvent as ReactDragEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { DocumentCreateFormat } from '@/features/document/lib/documentCreation'
import { WorkspaceCreateMenu, useAnchoredMenuCoords } from '@/features/workspace/components/WorkspaceCreateMenu'
import {
  getWorkspaceItemIcon,
  getWorkspaceItemIconColorClass,
  inferWorkspaceItemFormat,
  isEditableWorkspaceFormat,
  isSupportedWorkspaceFormat,
  workspaceEmojiOptions,
  workspaceFolderIconColorClass,
  type WorkspaceTreeDropPosition,
  type WorkspaceTreeNode,
} from '@/features/workspace/lib/workspace'
import { useDraftTitleForPath } from '@/features/workspace/lib/draftTitleStore'
import {
  getChildFolderPathForNode,
  parseKitableDashboardVirtualPath,
  parseKitableWorkflowVirtualPath,
  parseKitableTableVirtualPath,
} from '@/features/workspace/lib/workspaceTree'
import { cn } from '@/lib/utils'
import { useDismissableLayer } from '@/registry/hooks/use-on-click-outside'

type WorkspaceTreeDropIndicator = { path: string; position: WorkspaceTreeDropPosition }

export function WorkspaceTree({
  nodes,
  activePath,
  onOpen,
  expandedPaths,
  modifiedPaths,
  icons,
  moveTargets,
  onToggleFolder,
  onCreateInside,
  onDelete,
  onDuplicate,
  onRename,
  onMoveToFolder,
  onSetIcon,
  onDropNode,
  onAddToChat,
  onAddToNewChat,
  onRevealInOS,
  onImportFiles,
  onCreateWorkflowForTable,
  actionMenuPath,
  onActionMenuChange,
  draggingPath,
  dropIndicator,
  onDragNodeStart,
  onDragNodeOver,
  onDragNodeEnd,
  createMenuOpen,
  createMenuTriggerPath,
  createMenuVariant,
  onCloseCreateMenu,
  onCreateFolder,
  onCreateDocument,
  onCreateTable,
  depth = 0,
}: {
  nodes: WorkspaceTreeNode[]
  activePath: string
  onOpen: (path: string) => void
  expandedPaths: Set<string>
  modifiedPaths: Set<string>
  icons: Record<string, string>
  moveTargets: WorkspaceTreeNode[]
  onToggleFolder: (path: string) => void
  onCreateInside: (node: WorkspaceTreeNode) => void
  onDelete: (node: WorkspaceTreeNode) => void
  onDuplicate: (node: WorkspaceTreeNode) => void
  onRename: (node: WorkspaceTreeNode, nextTitle: string) => void
  onMoveToFolder: (node: WorkspaceTreeNode, targetNode: WorkspaceTreeNode | null) => void
  onSetIcon: (path: string, icon: string | null) => void
  onDropNode: (draggedPath: string, targetPath: string, position: WorkspaceTreeDropPosition) => void
  onAddToChat?: (node: WorkspaceTreeNode) => void
  onAddToNewChat?: (node: WorkspaceTreeNode) => void
  onRevealInOS?: (node: WorkspaceTreeNode) => void
  onImportFiles?: (files: File[], folder?: string) => void
  /** Open the Workflow create-mode dialog scoped to a .kitable. The handler
   *  receives the .kitable container node (e.g. row for `Leads.kitable`) and
   *  is responsible for resolving the target table — if the kitable has
   *  exactly one table, that table is used directly; otherwise the handler
   *  pops a table picker before opening the mode dialog. The legacy
   *  virtual-table-leaf entry has been retired in favour of this scope. */
  onCreateWorkflowForTable?: (node: WorkspaceTreeNode) => void
  actionMenuPath?: string
  onActionMenuChange?: (path: string) => void
  draggingPath?: string
  dropIndicator?: WorkspaceTreeDropIndicator | null
  onDragNodeStart?: (path: string) => void
  onDragNodeOver?: (path: string, position: WorkspaceTreeDropPosition) => void
  onDragNodeEnd?: () => void
  createMenuOpen?: boolean
  createMenuTriggerPath?: string
  createMenuVariant?: 'workspace' | 'kitable'
  onCloseCreateMenu?: () => void
  onCreateFolder?: () => void
  onCreateDocument?: (format: DocumentCreateFormat) => void
  onCreateTable?: () => void
  depth?: number
}) {
  const [localActionMenuPath, setLocalActionMenuPath] = useState('')
  const { t } = useTranslation('workspace')
  const currentActionMenuPath = actionMenuPath ?? localActionMenuPath
  const setCurrentActionMenuPath = onActionMenuChange ?? setLocalActionMenuPath
  const managesActionMenuState = actionMenuPath === undefined && onActionMenuChange === undefined

  // Submenu/rename state only applies to rows rendered directly at this depth;
  // recursive subtrees manage their own copies so we do not forward these props.
  const [iconPickerPath, setIconPickerPath] = useState('')
  const [moveMenuPath, setMoveMenuPath] = useState('')
  const [renamingPath, setRenamingPath] = useState('')
  const [renameValue, setRenameValue] = useState('')
  // Placement flips when the row sits near the viewport bottom so the menu
  // does not get hidden under the sidebar footer. Computed at trigger click.
  const [menuPlacement, setMenuPlacement] = useState<'top' | 'bottom'>('bottom')
  // Anchor elements captured at click time so the portaled menus (create / action
  // / move) can position themselves at the bottom-right of the trigger row, even
  // though the sidebar itself is overflow-hidden.
  const [createMenuAnchorEl, setCreateMenuAnchorEl] = useState<HTMLElement | null>(null)
  const [actionMenuAnchorEl, setActionMenuAnchorEl] = useState<HTMLElement | null>(null)
  const actionMenuCoords = useAnchoredMenuCoords(Boolean(currentActionMenuPath), actionMenuAnchorEl, { estimatedHeight: 300 })
  const moveMenuCoords = useAnchoredMenuCoords(Boolean(moveMenuPath), actionMenuAnchorEl, { estimatedHeight: 300 })

  // Depth 0 owns the drag state; recursive subtrees share it via props so every
  // level reads from a single source, avoiding mismatched drop indicators.
  const [localDraggingPath, setLocalDraggingPath] = useState('')
  const [localDropIndicator, setLocalDropIndicator] = useState<WorkspaceTreeDropIndicator | null>(null)
  const managesDragState = onDragNodeStart === undefined
  const currentDraggingPath = managesDragState ? localDraggingPath : (draggingPath ?? '')
  const currentDropIndicator = managesDragState ? localDropIndicator : (dropIndicator ?? null)
  const handleDragNodeStart = onDragNodeStart ?? ((path: string) => {
    setLocalDraggingPath(path)
    setLocalDropIndicator(null)
  })
  const handleDragNodeOver = onDragNodeOver ?? ((path: string, position: WorkspaceTreeDropPosition) => {
    setLocalDropIndicator((current) => (
      current && current.path === path && current.position === position ? current : { path, position }
    ))
  })
  const handleDragNodeEnd = onDragNodeEnd ?? (() => {
    setLocalDraggingPath('')
    setLocalDropIndicator(null)
  })

  function closeRowMenus() {
    setCurrentActionMenuPath('')
    setMoveMenuPath('')
  }

  useEffect(() => {
    if (!managesActionMenuState || !currentActionMenuPath) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }
      // Action and move menus are portaled to <body> for anchored positioning,
      // so the clicked button no longer lives inside `.document-tree-menu-wrap`
      // ancestor chain. Treat `.document-tree-menu` itself as the inside guard.
      if (target.closest('.document-tree-menu-wrap, .document-tree-menu')) {
        return
      }
      setCurrentActionMenuPath('')
      setMoveMenuPath('')
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setCurrentActionMenuPath('')
        setMoveMenuPath('')
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [currentActionMenuPath, managesActionMenuState, setCurrentActionMenuPath])

  function startRename(node: WorkspaceTreeNode) {
    closeRowMenus()
    setRenamingPath(node.path)
    setRenameValue(node.title)
  }

  function commitRename(node: WorkspaceTreeNode) {
    const nextTitle = renameValue.trim()
    setRenamingPath('')
    if (nextTitle && nextTitle !== node.title) {
      onRename(node, nextTitle)
    }
  }

  return (
    <div className={cn(depth === 0 ? 'space-y-1' : 'mt-1 space-y-1')}>
      {nodes.map((node) => {
        const icon = icons[node.path]
        const isActive = node.type === 'file' && activePath === node.path
        const isModified = node.type === 'file' && modifiedPaths.has(node.path)
        const isWorkflowsVirtual = node.virtual && node.path.startsWith('workflows://')
        const isWorkflowVirtual = node.virtual && node.path.startsWith('workflow://')
        const isDashboardVirtual = node.virtual && node.path.startsWith('dashboard://')
        const FormatIcon = isDashboardVirtual
          ? LayoutDashboard
          : isWorkflowsVirtual || isWorkflowVirtual
            ? Zap
            : getWorkspaceItemIcon(node.format)
        const formatIconColorClass = isWorkflowsVirtual || isWorkflowVirtual || isDashboardVirtual
          ? 'text-brand'
          : getWorkspaceItemIconColorClass(node.format)
        const isEditable = isEditableWorkspaceFormat(node.format)
        const isKitableContainer = node.type === 'file'
          && !node.virtual
          && node.name.toLowerCase().endsWith('.kitable')
        // A plain file that has absorbed a same-named sibling folder tracks its
        // expansion under the FOLDER path (which is what expandedPaths / the
        // collapsed metadata key on), not the file path. Folders and kitables
        // already key on node.path, so fall back to it for them.
        const disclosureKey = isKitableContainer ? node.path : (node.folderPath ?? node.path)
        const expanded = expandedPaths.has(disclosureKey)
        // Virtual leaf representing a backend table inside a .kitable. These
        // rows are not real files but we still let the user rename / delete
        // them (routed to data-document API) and spawn an workflow scoped
        // to the table without going through a picker.
        const isKitableTableLeaf = node.virtual && parseKitableTableVirtualPath(node.path) != null
        const isKitableDashboardLeaf = node.virtual && parseKitableDashboardVirtualPath(node.path) != null
        // Virtual leaf representing an individual workflow under a .kitable.
        // Not a real file either — delete is routed through the workflow
        // API by useKitableWorkflowLeafActions.
        const parsedKitableWorkflow = node.virtual ? parseKitableWorkflowVirtualPath(node.path) : null
        const isKitableWorkflowLeaf = parsedKitableWorkflow != null
        const isFormSyncWorkflowLeaf = parsedKitableWorkflow?.workflowId.startsWith('formsync_') || false
        const visibleChildren = isKitableContainer
          ? node.children.filter((child) => !child.virtual)
          : node.children
        const hasDisclosure = visibleChildren.length > 0 || node.type === 'folder'
        const canCreateInside = !node.virtual && (node.type === 'folder' || isEditable || isKitableContainer)
        const canDelete = isKitableTableLeaf
          || isKitableDashboardLeaf
          || (isKitableWorkflowLeaf && !isFormSyncWorkflowLeaf)
          || (!node.virtual && (node.type === 'folder' || isSupportedWorkspaceFormat(node.format || inferWorkspaceItemFormat(node.path))))
        const canSetIcon = !node.virtual
        const canRename = isKitableTableLeaf
          || isKitableDashboardLeaf
          || isKitableWorkflowLeaf
          || (!node.virtual && (node.type === 'folder' || isEditable))
        const canDuplicate = !node.virtual && node.type === 'file' && isEditable
        const canMove = !node.virtual && (node.type === 'folder' || isEditable)
        const canAddToChat = !node.virtual && Boolean(onAddToChat)
        const canAddToNewChat = !node.virtual && Boolean(onAddToNewChat)
        const canRevealInOS = !node.virtual && Boolean(onRevealInOS)
        const canCreateWorkflowForTable = isKitableContainer && Boolean(onCreateWorkflowForTable)
        const hasMenu = canSetIcon || canRename || canDuplicate || canMove || canDelete || canAddToChat || canAddToNewChat || canRevealInOS
        const actionMenuOpen = currentActionMenuPath === node.path
        const moveMenuOpen = moveMenuPath === node.path
        const iconPickerOpen = iconPickerPath === node.path
        const isRenaming = renamingPath === node.path
                                                             
                                             
        const isLiveLabelTarget = isActive && !node.virtual && node.type === 'file'
        const fallbackIcon = node.type === 'folder'
          ? <FolderOpen className={cn('size-4', workspaceFolderIconColorClass)} />
          : <FormatIcon className={cn('size-4', formatIconColorClass)} />
        const paddingLeft = 8 + depth * 14
        const dropPosition = currentDropIndicator?.path === node.path ? currentDropIndicator.position : null

        const nodeChildPrefix = `${getChildFolderPathForNode(node)}/`
        const moveOptions = moveTargets.filter((target) => (
          target.path !== node.path
          && target.path !== node.parentPath
          && !target.path.startsWith(nodeChildPrefix)
        ))

        function handleDragOver(event: ReactDragEvent<HTMLDivElement>) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          // Do not show the indicator on the dragged node itself or any descendant.
          if (
            !currentDraggingPath
            || node.virtual
            || currentDraggingPath === node.path
            || node.path.startsWith(`${currentDraggingPath}/`)
          ) {
            return
          }
          // Handlers live on the wrap so a drop over the opened insertion slot
          // (which is pointer-events-none) still targets this node. Measure the
          // ratio against the row itself, not the wrap, so slot displacement
          // does not skew before/inside/after classification.
          const rowEl = event.currentTarget.querySelector<HTMLElement>('.document-tree-row')
          const rect = (rowEl ?? event.currentTarget).getBoundingClientRect()
          const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5
          const rawPosition: WorkspaceTreeDropPosition = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside'
          const position: WorkspaceTreeDropPosition = isKitableContainer && rawPosition === 'inside' ? 'after' : rawPosition
          handleDragNodeOver(node.path, position)
        }

        function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
          event.preventDefault()
          event.stopPropagation()
          const osFiles = Array.from(event.dataTransfer.files || [])
          handleDragNodeEnd()
          if (osFiles.length && onImportFiles) {
            const targetFolder = node.type === 'folder' ? node.path : node.parentPath
            onImportFiles(osFiles, targetFolder)
            return
          }
          const draggedPath = event.dataTransfer.getData('text/plain')
          const fallback: WorkspaceTreeDropPosition = isKitableContainer ? 'after' : 'inside'
          const position = currentDropIndicator?.path === node.path ? currentDropIndicator.position : fallback
          onDropNode(draggedPath, node.path, position)
        }

        return (
          <div
            key={node.path}
            className="document-tree-node"
            draggable={!node.virtual && !isRenaming}
            onDragStart={(event) => {
              if (node.virtual || isRenaming) {
                event.preventDefault()
                return
              }
              event.stopPropagation()
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', node.path)
              handleDragNodeStart(node.path)
            }}
            onDragEnd={handleDragNodeEnd}
          >
            <div className="document-tree-row-wrap" onDragOver={handleDragOver} onDrop={handleDrop}>
              {dropPosition === 'before' ? (
                <div className="document-tree-drop-slot" style={{ marginLeft: `${paddingLeft}px` }} />
              ) : null}
              <div
                className={cn(
                  'document-tree-row group',
                  node.type === 'folder' ? 'document-tree-folder' : 'document-tree-page',
                  isActive && 'is-active',
                  currentDraggingPath === node.path && 'is-dragging',
                  dropPosition === 'inside' && 'is-drop-target',
                )}
                data-testid={isKitableWorkflowLeaf
                  ? 'kitable-workflow-leaf'
                  : isKitableDashboardLeaf
                    ? 'kitable-dashboard-leaf'
                    : undefined}
                data-workflow-id={isKitableWorkflowLeaf ? (parseKitableWorkflowVirtualPath(node.path)?.workflowId ?? '') : undefined}
                style={{ paddingLeft: `${paddingLeft}px` }}
                onClick={(event) => {
                                                          
                                                      
                  if (event.detail > 1) {
                    return
                  }
                  if (isRenaming) {
                    return
                  }
                  closeRowMenus()
                  // A kitable is a selected workspace container, matching Feishu's
                  // multidimensional-table entry. Only real folder children expand;
                  // tables and workflows live in the inner navigation.
                  if (isKitableContainer) {
                    if (visibleChildren.length) {
                      onToggleFolder(node.path)
                    }
                    onOpen(node.path)
                    return
                  }
                  if (node.type === 'file') {
                    onOpen(node.path)
                    return
                  }
                  onToggleFolder(node.path)
                }}
                role="button"
                tabIndex={0}
              >
                <GripVertical className="document-tree-drag-handle size-3.5" />
                <span className="document-tree-lead">
                  {hasDisclosure ? (
                    <button
                      type="button"
                      className="document-tree-lead-toggle"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (event.detail > 1) {
                          return
                        }
                        onToggleFolder(disclosureKey)
                      }}
                      aria-label={expanded ? t('tree.collapse') : t('tree.expand')}
                    >
                      <span className="document-tree-lead-icon">{icon || fallbackIcon}</span>
                      <ChevronRight className={cn('document-tree-lead-chevron size-3.5', expanded && 'rotate-90')} />
                    </button>
                  ) : (
                    <span className="document-tree-lead-icon document-tree-lead-static">{icon || fallbackIcon}</span>
                  )}
                  {iconPickerOpen ? (
                    <WorkspaceRowIconPicker
                      onChange={(nextIcon) => {
                        onSetIcon(node.path, nextIcon)
                        setIconPickerPath('')
                      }}
                      onClose={() => setIconPickerPath('')}
                    />
                  ) : null}
                </span>
                {isModified ? <span className="document-tree-at" title={t('tree.modifiedByAgent')}>@</span> : null}
                {isRenaming ? (
                  <input
                    className="document-tree-rename-input"
                    value={renameValue}
                    autoFocus
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => commitRename(node)}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitRename(node)
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        setRenamingPath('')
                      }
                    }}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-left">
                    {isLiveLabelTarget
                      ? <LiveActiveLabel path={node.path} title={node.title} fallback={node.name} />
                      : node.name}
                  </span>
                )}
                {!isRenaming && (canCreateInside || hasMenu) ? (
                  <span className={cn('document-tree-actions', (actionMenuOpen || moveMenuOpen || iconPickerOpen) && 'is-open')}>
                    {canCreateInside ? (
                      <span className="relative document-create-menu-anchor">
                        <button
                          type="button"
                          className="document-tree-action"
                          onClick={(event) => {
                            event.stopPropagation()
                            // Pre-compute placement before opening so the
                            // menu does not render past the sidebar bottom.
                            const rect = event.currentTarget.getBoundingClientRect()
                            const margin = 8
                            const estimatedMenuHeight = 240
                            const spaceBelow = window.innerHeight - rect.bottom - margin
                            const spaceAbove = rect.top - margin
                            setMenuPlacement(spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow ? 'top' : 'bottom')
                            setCreateMenuAnchorEl(event.currentTarget)
                            onCreateInside(node)
                          }}
                          aria-label={t('tree.createInside')}
                          title={t('tree.createInside')}
                        >
                          <Plus className="size-3.5" />
                        </button>
                        {createMenuOpen && createMenuTriggerPath === node.path ? (
                          <WorkspaceCreateMenu
                            open
                            placement={menuPlacement}
                            variant={createMenuVariant ?? 'workspace'}
                            anchorEl={createMenuAnchorEl}
                            onCreateFolder={onCreateFolder ?? (() => undefined)}
                            onCreateDocument={onCreateDocument ?? (() => undefined)}
                            onCreateTable={onCreateTable ?? (() => undefined)}
                            onCreateWorkflow={canCreateWorkflowForTable ? () => onCreateWorkflowForTable?.(node) : undefined}
                          />
                        ) : null}
                      </span>
                    ) : null}
                    {hasMenu ? (
                      <span className="document-tree-menu-wrap">
                        <button
                          type="button"
                          className="document-tree-action"
                          onClick={(event) => {
                            event.stopPropagation()
                            setMoveMenuPath('')
                            if (actionMenuOpen) {
                              setCurrentActionMenuPath('')
                              return
                            }
                            const rect = event.currentTarget.getBoundingClientRect()
                            const margin = 8
                            const estimatedMenuHeight = 300
                            const spaceBelow = window.innerHeight - rect.bottom - margin
                            const spaceAbove = rect.top - margin
                            setMenuPlacement(spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow ? 'top' : 'bottom')
                            setActionMenuAnchorEl(event.currentTarget)
                            setCurrentActionMenuPath(node.path)
                          }}
                          aria-label={t('tree.moreActions')}
                          aria-expanded={actionMenuOpen}
                          title={t('tree.moreActions')}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </button>
                        {actionMenuOpen && actionMenuCoords ? createPortal(
                          <span
                            className="document-tree-menu document-tree-menu--portal"
                            data-placement={menuPlacement}
                            data-window-drag-exclude="true"
                            style={{ position: 'fixed', left: actionMenuCoords.left, top: actionMenuCoords.top, right: 'auto', bottom: 'auto' }}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {canAddToChat ? (
                              <button
                                type="button"
                                className="document-tree-menu-item"
                                onClick={() => {
                                  setCurrentActionMenuPath('')
                                  onAddToChat?.(node)
                                }}
                              >
                                <MessageSquarePlus className="size-4" />
                                {t('tree.addToChat')}
                              </button>
                            ) : null}
                            {canAddToNewChat ? (
                              <button
                                type="button"
                                className="document-tree-menu-item"
                                onClick={() => {
                                  setCurrentActionMenuPath('')
                                  onAddToNewChat?.(node)
                                }}
                              >
                                <MessageSquareDashed className="size-4" />
                                {t('tree.addToNewChat')}
                              </button>
                            ) : null}
                            {canSetIcon ? (
                              <button
                                type="button"
                                className="document-tree-menu-item"
                                onClick={() => {
                                  setCurrentActionMenuPath('')
                                  setIconPickerPath(node.path)
                                }}
                              >
                                <Smile className="size-4" />
                                {t('tree.changeIcon')}
                              </button>
                            ) : null}
                            {canRename ? (
                              <button
                                type="button"
                                className="document-tree-menu-item"
                                data-testid={
                                  isKitableTableLeaf
                                    ? 'kitable-table-action-rename'
                                    : isKitableDashboardLeaf
                                      ? 'kitable-dashboard-action-rename'
                                    : isKitableWorkflowLeaf
                                      ? 'kitable-workflow-action-rename'
                                      : undefined
                                }
                                onClick={() => startRename(node)}
                              >
                                <Pencil className="size-4" />
                                {t('tree.rename')}
                              </button>
                            ) : null}
                            {canDuplicate ? (
                              <button
                                type="button"
                                className="document-tree-menu-item"
                                onClick={() => {
                                  setCurrentActionMenuPath('')
                                  onDuplicate(node)
                                }}
                              >
                                <Copy className="size-4" />
                                {t('tree.duplicate')}
                              </button>
                            ) : null}
                            {canMove ? (
                              <button
                                type="button"
                                className="document-tree-menu-item"
                                onClick={() => {
                                  setCurrentActionMenuPath('')
                                  setMoveMenuPath(node.path)
                                }}
                              >
                                <CornerUpRight className="size-4" />
                                {t('tree.moveTo')}
                              </button>
                            ) : null}
                            {canRevealInOS ? (
                              <button
                                type="button"
                                className="document-tree-menu-item"
                                onClick={() => {
                                  setCurrentActionMenuPath('')
                                  onRevealInOS?.(node)
                                }}
                              >
                                <FolderOpen className="size-4" />
                                {t('tree.showInFinder')}
                              </button>
                            ) : null}
                            {canDelete ? (
                              <button
                                type="button"
                                className="document-tree-menu-item is-danger"
                                data-testid={
                                  isKitableTableLeaf
                                    ? 'kitable-table-action-delete'
                                    : isKitableDashboardLeaf
                                      ? 'kitable-dashboard-action-delete'
                                    : isKitableWorkflowLeaf
                                      ? 'kitable-workflow-action-delete'
                                      : undefined
                                }
                                onClick={() => {
                                  setCurrentActionMenuPath('')
                                  onDelete(node)
                                }}
                              >
                                <Trash2 className="size-4" />
                                {t('tree.delete')}
                              </button>
                            ) : null}
                          </span>,
                          document.body,
                        ) : null}
                        {moveMenuOpen && moveMenuCoords ? createPortal(
                          <span
                            className="document-tree-menu document-tree-move-menu document-tree-menu--portal"
                            data-placement={menuPlacement}
                            data-window-drag-exclude="true"
                            style={{ position: 'fixed', left: moveMenuCoords.left, top: moveMenuCoords.top, right: 'auto', bottom: 'auto' }}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <span className="document-tree-move-title">{t('tree.moveToTitle')}</span>
                            {node.parentPath ? (
                              <button
                                type="button"
                                className="document-tree-menu-item"
                                onClick={() => {
                                  setMoveMenuPath('')
                                  onMoveToFolder(node, null)
                                }}
                              >
                                <FilePlus2 className="size-4" />
                                {t('tree.moveToRoot')}
                              </button>
                            ) : null}
                            {moveOptions.length ? (
                              moveOptions.map((target) => {
                                const TargetIcon = target.type === 'folder' ? FolderOpen : getWorkspaceItemIcon(target.format)
                                const targetIcon = icons[target.path]
                                return (
                                  <button
                                    key={target.path}
                                    type="button"
                                    className="document-tree-menu-item"
                                    onClick={() => {
                                      setMoveMenuPath('')
                                      onMoveToFolder(node, target)
                                    }}
                                  >
                                    {targetIcon ? <span className="document-tree-move-emoji">{targetIcon}</span> : <TargetIcon className={cn('size-4', target.type === 'folder' ? workspaceFolderIconColorClass : getWorkspaceItemIconColorClass(target.format))} />}
                                    <span className="min-w-0 flex-1 truncate">{target.title}</span>
                                  </button>
                                )
                              })
                            ) : (
                              <span className="document-tree-move-empty">{t('tree.noDestinations')}</span>
                            )}
                          </span>,
                          document.body,
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </div>
              {dropPosition === 'after' ? (
                <div className="document-tree-drop-slot" style={{ marginLeft: `${paddingLeft}px` }} />
              ) : null}
            </div>
            {expanded && visibleChildren.length ? (
              <WorkspaceTree
                nodes={visibleChildren}
                activePath={activePath}
                expandedPaths={expandedPaths}
                modifiedPaths={modifiedPaths}
                icons={icons}
                moveTargets={moveTargets}
                onToggleFolder={onToggleFolder}
                onCreateInside={onCreateInside}
                onDelete={onDelete}
                onDuplicate={onDuplicate}
                onRename={onRename}
                onMoveToFolder={onMoveToFolder}
                onSetIcon={onSetIcon}
                onDropNode={onDropNode}
                onAddToChat={onAddToChat}
                onAddToNewChat={onAddToNewChat}
                onRevealInOS={onRevealInOS}
                onImportFiles={onImportFiles}
                onCreateWorkflowForTable={onCreateWorkflowForTable}
                onOpen={onOpen}
                actionMenuPath={currentActionMenuPath}
                onActionMenuChange={setCurrentActionMenuPath}
                draggingPath={currentDraggingPath}
                dropIndicator={currentDropIndicator}
                onDragNodeStart={handleDragNodeStart}
                onDragNodeOver={handleDragNodeOver}
                onDragNodeEnd={handleDragNodeEnd}
                createMenuOpen={createMenuOpen}
                createMenuTriggerPath={createMenuTriggerPath}
                createMenuVariant={createMenuVariant}
                onCloseCreateMenu={onCloseCreateMenu}
                onCreateFolder={onCreateFolder}
                onCreateDocument={onCreateDocument}
                onCreateTable={onCreateTable}
                depth={depth + 1}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function WorkspaceRowIconPicker({
  onChange,
  onClose,
}: {
  onChange: (icon: string | null) => void
  onClose: () => void
}) {
  const popoverRef = useRef<HTMLSpanElement | null>(null)
  const { t } = useTranslation('workspace')
  useDismissableLayer(popoverRef, true, onClose)

  return (
    <span ref={popoverRef} className="document-emoji-popover" onClick={(event) => event.stopPropagation()}>
      <span className="grid grid-cols-6 gap-1">
        {workspaceEmojiOptions.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="document-emoji-option"
            onClick={() => onChange(emoji)}
          >
            {emoji}
          </button>
        ))}
      </span>
      <button
        type="button"
        className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => onChange(null)}
      >
        <FileText className="size-3.5" />
        {t('tree.clearIcon')}
      </button>
    </span>
  )
}

function LiveActiveLabel({
  path,
  title,
  fallback,
}: {
  path: string
  title: string
  fallback: string
}) {
  const { t } = useTranslation('workspace')
  const draft = useDraftTitleForPath(path)
  if (draft === null) return <>{fallback}</>
                                                                    
  const extension = fallback.slice(title.length)
  const display = `${draft.trim() || t('tree.untitled')}${extension}`
  return <>{display}</>
}
