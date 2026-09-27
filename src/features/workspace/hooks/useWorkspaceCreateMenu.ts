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
  openKitableTemplateDialog: (folder?: string) => void
  createDesign: (folder?: string) => Promise<unknown> | void
  openBoardTemplateDialog: (folder?: string) => void
  openWorkspaceWorkflow: () => void
  onCloseProfile?: () => void
}

/**
 * Handlers behind the sidebar's create menu. The menu opens either for the
 * workspace (a folder) or for a .kitable container, and "New table" means
 * a template picker in the first case and a table inside the file in the
 * second. Returned as one object so the sidebar props can spread it.
 */
export function useWorkspaceCreateMenu({
  createFlows,
  createMenuFolder,
  closeCreateMenu,
  openCreateFormatMenu,
  expandPrivateSection,
  createDocumentInside,
  openDocumentTemplateDialog,
  openKitableTemplateDialog,
  createDesign,
  openBoardTemplateDialog,
  openWorkspaceWorkflow,
  onCloseProfile,
}: UseWorkspaceCreateMenuOptions) {
  const { kitableCreateContext, setKitableCreateContext, createMenuVariant } = createFlows
  return useMemo(() => ({
    createMenuVariant,
    onOpenCreateMenu: () => {
      expandPrivateSection()
      openCreateFormatMenu('')
    },
    onCloseCreateMenu: () => {
      closeCreateMenu()
      setKitableCreateContext(null)
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
      if (node.type === 'file' && node.name.toLowerCase().endsWith('.kitable') && !node.virtual) {
        setKitableCreateContext(node.path)
        expandPrivateSection()
        openCreateFormatMenu(undefined, node.path)
        return
      }
      void createDocumentInside(node)
    },
    onCreateTable: () => {
      if (kitableCreateContext) {
        void createFlows.createTableFromCreateMenu()
        return
      }
      closeCreateMenu()
      openKitableTemplateDialog(createMenuFolder)
    },
    onImportTableFile: createMenuVariant === 'workspace'
      ? () => {
          closeCreateMenu()
          createFlows.requestTableFileImport(createMenuFolder ?? '')
        }
      : undefined,
    onOpenWorkflows: () => {
      onCloseProfile?.()
      openWorkspaceWorkflow()
    },
    onCreateDesign: () => {
      onCloseProfile?.()
      void createDesign(createMenuFolder)
    },
    onCreateBoard: () => {
      onCloseProfile?.()
      openBoardTemplateDialog(createMenuFolder)
    },
  }), [
    closeCreateMenu,
    createDesign,
    createDocumentInside,
    createFlows,
    createMenuFolder,
    createMenuVariant,
    expandPrivateSection,
    kitableCreateContext,
    onCloseProfile,
    openBoardTemplateDialog,
    openCreateFormatMenu,
    openDocumentTemplateDialog,
    openKitableTemplateDialog,
    openWorkspaceWorkflow,
    setKitableCreateContext,
  ])
}
