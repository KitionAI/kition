import { useCallback } from 'react'
import type { KitIconId } from '@/components/KitIcon'
import { KITION_KIT_HOST, createKitFile } from '@/features/kits/public'
import { unusedWorkspacePath } from '@/features/workspace/lib/unusedWorkspacePath'
import { creatableKits, type KitCreateGroup, type KitCreateSpec, type KitEditorEntry } from '../components/kits/kitEditors'

/** A kit item as the create menu shows it. */
export type KitCreationItem = { id: string; label: string; kit: KitIconId; group: KitCreateGroup; extension: string; onCreate: () => void }

/** A kit's create menu item: what it makes, and how to make one in a folder. */
export type KitCreationSource = {
  id: string
  label: string
  kit: KitIconId
  group: KitCreateGroup
  extension: string
  create: (folder?: string) => Promise<void>
}

type UseKitCreationsOptions = {
  refreshWorkspaceDocuments: (path?: string, options?: { silent?: boolean }) => Promise<unknown> | unknown
  openPath: (path: string) => void
  onError: (message: string) => void
}

/**
 * The create menu's kit items ("Image", "Video project"): one per kit of this
 * build that the menu lists (`kits/menu.json`). A new file is made by the kit's engine in the page and
 * written to the workspace, then opened.
 */
export function useKitCreations({ refreshWorkspaceDocuments, openPath, onError }: UseKitCreationsOptions) {
  const create = useCallback(async (entry: KitEditorEntry & { create: KitCreateSpec }, folder?: string) => {
    try {
      const path = await unusedWorkspacePath(folder || '', entry.create.baseName, entry.create.extension)
      await createKitFile(KITION_KIT_HOST, entry.engine, path, entry.create.size)
      await refreshWorkspaceDocuments(path, { silent: true })
      openPath(path)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }, [onError, openPath, refreshWorkspaceDocuments])

  return creatableKits()
    .map<KitCreationSource>((entry) => ({ id: entry.create.id, label: entry.create.label, kit: entry.icon, group: entry.create.group, extension: entry.create.extension, create: (folder) => create(entry, folder) }))
}
