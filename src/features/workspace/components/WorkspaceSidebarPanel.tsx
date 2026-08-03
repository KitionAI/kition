import { WorkspaceSidebar } from '@/features/workspace/components/WorkspaceSidebar'
import { WorkspaceTree } from '@/features/workspace/components/WorkspaceTree'
import type { DocumentCreateFormat } from '@/features/document/lib/documentCreation'
import type { WorkspaceImportEntry } from '@/features/workspace/hooks/useWorkspaceTreeCreateActions'
import type { WorkspaceTreeDropPosition, WorkspaceTreeNode } from '@/features/workspace/lib/workspace'

type WorkspaceSidebarPanelProps = {
  activePath: string
  createMenuOpen: boolean
  createMenuTriggerPath: string
  createMenuVariant?: 'workspace' | 'kitable'
  loading: boolean
  modifiedPaths: Set<string>
  moveTargets: WorkspaceTreeNode[]
  onCreateFolder: () => void
  onCreateDocument: (format: DocumentCreateFormat) => void
  onCreateInside: (node: WorkspaceTreeNode) => void
  onCreateTable: () => void
  onImportTableFile?: () => void
  onDelete: (node: WorkspaceTreeNode) => void
  onDuplicate: (node: WorkspaceTreeNode) => void
  onMoveToFolder: (node: WorkspaceTreeNode, targetNode: WorkspaceTreeNode | null) => void
  onAddToChat?: (node: WorkspaceTreeNode) => void
  onAddToNewChat?: (node: WorkspaceTreeNode) => void
  onRevealInOS?: (node: WorkspaceTreeNode) => void
  onOpen: (path: string) => void
  onOpenCreateMenu: () => void
  onCloseCreateMenu: () => void
  /** Called when the user picks `Create Workflow` on a .kitable container
   *  row. Opens the mode-chooser dialog (template / chat AI) — when the
   *  kitable has multiple tables a picker is shown first to resolve scope. */
  onCreateWorkflowForTable?: (node: WorkspaceTreeNode) => void
  showBrowserTab?: boolean
  onRefresh?: () => void
  /** Opens the workspace-global Workflows tab. Surfaced as a lightning-bolt
   *  icon in the sidebar header — replaces the old root-level virtual
   *  "Workflows" node so the tree stays clean. */
  onOpenWorkflows?: () => void
  onRename: (node: WorkspaceTreeNode, nextTitle: string) => void
  onSetIcon: (path: string, icon: string | null) => void
  onToggleFolder: (path: string) => void
  onTogglePrivate: () => void
  onToggleSidebar?: () => void
  onTreeDrop: (draggedPath: string, targetPath: string, position: WorkspaceTreeDropPosition) => void
  onImportFiles?: (files: File[], folder?: string) => void
  onPasteFiles?: (entries: WorkspaceImportEntry[]) => void
  privateExpanded: boolean
  rootPath: string
  treeExpandedPaths: Set<string>
  treeIcons: Record<string, string>
  workspaceDisplayName: string
  workspaceTreeNodes: WorkspaceTreeNode[]
  /** Opens the standalone full-text search modal (Codex-style palette). */
  onOpenSearch?: () => void
}

export function WorkspaceSidebarPanel({
  activePath,
  createMenuOpen,
  createMenuTriggerPath,
  createMenuVariant,
  loading,
  modifiedPaths,
  moveTargets,
  onCreateFolder,
  onCreateDocument,
  onCreateInside,
  onCreateTable,
  onImportTableFile,
  onDelete,
  onDuplicate,
  onMoveToFolder,
  onOpen,
  onOpenCreateMenu,
  onCloseCreateMenu,
  showBrowserTab,
  onRefresh,
  onOpenWorkflows,
  onRename,
  onSetIcon,
  onToggleFolder,
  onTogglePrivate,
  onToggleSidebar,
  onTreeDrop,
  onAddToChat,
  onAddToNewChat,
  onRevealInOS,
  onImportFiles,
  onPasteFiles,
  onCreateWorkflowForTable,
  privateExpanded,
  rootPath,
  treeExpandedPaths,
  treeIcons,
  workspaceDisplayName,
  workspaceTreeNodes,
  onOpenSearch,
}: WorkspaceSidebarPanelProps) {
  return (
    <WorkspaceSidebar
      loading={loading}
      rootPath={rootPath}
      workspaceDisplayName={workspaceDisplayName}
      privateExpanded={privateExpanded}
      createMenuOpen={createMenuOpen}
      createMenuTriggerPath={createMenuTriggerPath}
      createMenuVariant={createMenuVariant}
      onToggleSidebar={onToggleSidebar}
      onTogglePrivate={onTogglePrivate}
      onOpenCreateMenu={onOpenCreateMenu}
      onCloseCreateMenu={onCloseCreateMenu}
      onCreateFolder={onCreateFolder}
      onCreateTable={onCreateTable}
      onImportTableFile={onImportTableFile}
      onCreateDocument={onCreateDocument}
      onPasteFiles={onPasteFiles}
      showBrowserTab={showBrowserTab}
      onRefresh={onRefresh}
      onOpenWorkflows={onOpenWorkflows}
      onOpenSearch={onOpenSearch}
      treeContent={(
        <>
          <WorkspaceTree
            nodes={workspaceTreeNodes}
            activePath={activePath}
            expandedPaths={treeExpandedPaths}
            modifiedPaths={modifiedPaths}
            icons={treeIcons}
            moveTargets={moveTargets}
            onToggleFolder={onToggleFolder}
            onCreateInside={onCreateInside}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onRename={onRename}
            onMoveToFolder={onMoveToFolder}
            onSetIcon={onSetIcon}
            onDropNode={onTreeDrop}
            onAddToChat={onAddToChat}
            onAddToNewChat={onAddToNewChat}
            onRevealInOS={onRevealInOS}
            onImportFiles={onImportFiles}
            onCreateWorkflowForTable={onCreateWorkflowForTable}
            onOpen={onOpen}
            createMenuOpen={createMenuOpen}
            createMenuTriggerPath={createMenuTriggerPath}
            createMenuVariant={createMenuVariant}
            onCloseCreateMenu={onCloseCreateMenu}
            onCreateFolder={onCreateFolder}
            onCreateDocument={onCreateDocument}
            onCreateTable={onCreateTable}
          />
        </>
      )}
    />
  )
}
