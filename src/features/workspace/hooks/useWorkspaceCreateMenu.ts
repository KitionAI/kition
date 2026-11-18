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
  onCloseProfile?: () => void
}

/**
 * Handlers behind the sidebar's create menu, opened for the workspace or a
 * folder. Returned as one object so the sidebar props can spread it.
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
  onCloseProfile,
}: UseWorkspaceCreateMenuOptions) {
  return useMemo(() => ({
    onOpenCreateMenu: () => {
      expandPrivateSection()
      openCreateFormatMenu('')
    },
    onCloseCreateMenu: closeCreateMenu,
    onCreateDocument: () => {
      closeCreateMenu()
      openDocumentTemplateDialog(createMenuFolder)
    },
    onCreateFolder: () => {
      closeCreateMenu()
      createFlows.openFolderDialog()
    },
    onCreateInside: (node: WorkspaceTreeNode) => {
      void createDocumentInside(node)
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
    expandPrivateSection,
    onCloseProfile,
    openCreateFormatMenu,
    openDocumentTemplateDialog,
  ])
}
