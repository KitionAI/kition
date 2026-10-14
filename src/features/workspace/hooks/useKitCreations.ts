import { useCallback, useEffect, useState } from 'react'
import type { KitIconId } from '@/components/KitIcon'
import { createKitDocument, listKits } from '@/api/kits'
import { KITION_KIT_HOST, createKitFile } from '@/features/kits/public'
import { unusedWorkspacePath } from '@/features/workspace/lib/unusedWorkspacePath'
import { creatableKits, sdkAvailable, type KitCreateSpec, type KitEditorEntry } from '../components/kits/kitEditors'

/** A kit item as the create menu shows it. */
export type KitCreationItem = { id: string; label: string; kit: KitIconId; onCreate: () => void }

/** A kit's create menu item: what it makes, and how to make one in a folder. */
export type KitCreationSource = {
  id: string
  label: string
  kit: KitIconId
  create: (folder?: string) => Promise<void>
}

type UseKitCreationsOptions = {
  /** Reloads when the workspace changes, since kits run per workspace. */
  rootPath: string
  refreshWorkspaceDocuments: (path?: string, options?: { silent?: boolean }) => Promise<unknown> | unknown
  openPath: (path: string) => void
  onError: (message: string) => void
}

/** How this build can make a kit's files: in the page with its SDK, or through the runtime's kit process. */
async function creationMode(entry: KitEditorEntry & { create: KitCreateSpec }): Promise<'sdk' | 'runtime' | null> {
  if (await sdkAvailable(entry)) return 'sdk'
  if (!entry.create.runtimeFallback) return null
  try {
    const list = await listKits()
    return list.kits.some((kit) => kit.installed && kit.creates.includes(entry.create.extension)) ? 'runtime' : null
  } catch {
    return null
  }
}

/**
 * The create menu's kit items ("Image", "Video project"): one per registered
 * kit that can make files in this build. A new file is made by the kit's SDK
 * in the page and written to the workspace, then opened.
 */
export function useKitCreations({ rootPath, refreshWorkspaceDocuments, openPath, onError }: UseKitCreationsOptions) {
  const [modes, setModes] = useState<Record<string, 'sdk' | 'runtime'>>({})

  useEffect(() => {
    let cancelled = false
    void Promise.all(creatableKits().map(async (entry) => [entry.create.id, await creationMode(entry)] as const)).then((found) => {
      if (cancelled) return
      setModes(Object.fromEntries(found.filter((pair): pair is readonly [string, 'sdk' | 'runtime'] => pair[1] != null)))
    })
    return () => {
      cancelled = true
    }
  }, [rootPath])

  const create = useCallback(async (entry: KitEditorEntry & { create: KitCreateSpec }, folder?: string) => {
    try {
      let path: string | undefined
      if (modes[entry.create.id] === 'sdk') {
        path = await unusedWorkspacePath(folder || '', entry.create.baseName, entry.create.extension)
        await createKitFile(KITION_KIT_HOST, entry.sdk, path, entry.create.size)
      } else {
        path = (await createKitDocument({ folder: folder || '', extension: entry.create.extension })).path || undefined
      }
      if (!path) return
      await refreshWorkspaceDocuments(path, { silent: true })
      openPath(path)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }, [modes, onError, openPath, refreshWorkspaceDocuments])

  return creatableKits()
    .filter((entry) => modes[entry.create.id])
    .map<KitCreationSource>((entry) => ({ id: entry.create.id, label: entry.create.label, kit: entry.create.kit, create: (folder) => create(entry, folder) }))
}
