import type { KitCreationItem, KitCreationSource } from './useKitCreations'
import { useMemo } from 'react'

import type { useWorkspaceCreateFlows } from '@/features/workspace/hooks/useWorkspaceCreateFlows'
import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'

type CreateFlows = ReturnType<typeof useWorkspaceCreateFlows>
type TreeActions = ReturnType<typeof useWorkspaceTreeActions>

type UseWorkspaceCreateMenuOptions = {
  createFlows: CreateFlows
  /** Folder the create menu was opened for. */
  createMenuFolder: string | undefined
  closeCreateMenu: () => void
  openCreateFormatMenu: (folder?: string, triggerPath?: string) => void
  /** The private section must be visible for the menu and its result. */
  expandPrivateSection: () => void
  createDocumentInside: TreeActions['createDocumentInside']
  openDocumentTemplateDialog: (folder?: string) => void
  /** Kit items (Image, Video project), each making a file in a folder. */
  kitCreations: readonly KitCreationSource[]
  openWorkspaceWorkflow: () => void
  /** A workflow for one of a table file's tables. */
  openTableFileWorkflow: (tablePath: string) => void
  onCloseProfile?: () => void
}

/**
 * Handlers behind the sidebar's create menu. The menu opens either for the
 * workspace (a folder) or for a table file, where it makes a workflow for
 * the file's tables. Returned as one object so the sidebar props
 * can spread it.
 */
export function useWorkspaceCreateMenu({
  createFlows,
  createMenuFolder,
  closeCreateMenu,
  openCreateFormatMenu,
  expandPrivateSection,
  createDocumentInside,
  openDocumentTemplateDialog,
  kitCreations,
  openWorkspaceWorkflow,
  openTableFileWorkflow,
  onCloseProfile,
}: UseWorkspaceCreateMenuOptions) {
  const { setTableFileCreateContext, createMenuVariant } = createFlows
  return useMemo(() => ({
    createMenuVariant,
    onOpenCreateMenu: () => {
      expandPrivateSection()
      openCreateFormatMenu('')
    },
    onCloseCreateMenu: () => {
      closeCreateMenu()
      setTableFileCreateContext(null)
    },
    onCreateDocument: () => {
      closeCreateMenu()
      openDocumentTemplateDialog(createMenuFolder)
    },
    onCreateFolder: () => {
      closeCreateMenu()
      createFlows.openFolderDialog()
    },
    onCreateInside: (node: WorkspaceTreeNode) => {
      if (node.type === 'file' && node.name.toLowerCase().endsWith('.ktable') && !node.virtual) {
        setTableFileCreateContext(node.path)
        expandPrivateSection()
        openCreateFormatMenu(undefined, node.path)
        return
      }
      void createDocumentInside(node)
    },
    onCreateWorkflowForTable: (node: WorkspaceTreeNode) => {
      closeCreateMenu()
      setTableFileCreateContext(null)
      onCloseProfile?.()
      openTableFileWorkflow(node.path)
    },
    onOpenWorkflows: () => {
      onCloseProfile?.()
      openWorkspaceWorkflow()
    },
    kitCreations: kitCreations.map<KitCreationItem>((kit) => ({
      id: kit.id,
      label: kit.label,
      kit: kit.kit,
      group: kit.group,
      extension: kit.extension,
      onCreate: () => {
        onCloseProfile?.()
        closeCreateMenu()
        void kit.create(createMenuFolder)
      },
    })),
  }), [
    closeCreateMenu,
    kitCreations,
    createDocumentInside,
    createFlows,
    createMenuFolder,
    createMenuVariant,
    expandPrivateSection,
    onCloseProfile,
    openCreateFormatMenu,
    openDocumentTemplateDialog,
    openTableFileWorkflow,
    openWorkspaceWorkflow,
    setTableFileCreateContext,
  ])
}
