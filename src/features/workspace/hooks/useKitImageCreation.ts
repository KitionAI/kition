import { useCallback, useEffect, useState } from 'react'

import { createKitDocument, listKits } from '@/api/kits'

type UseKitImageCreationOptions = {
  /** Reloads when the workspace changes, since kits run per workspace. */
  rootPath: string
  refreshWorkspaceDocuments: (path?: string, options?: { silent?: boolean }) => Promise<unknown> | unknown
  openPath: (path: string) => void
  onError: (message: string) => void
}

/**
 * "New image" in the create menu: offered only while an installed kit can
 * create PSD files, and opens the new file once it is saved.
 */
export function useKitImageCreation({ rootPath, refreshWorkspaceDocuments, openPath, onError }: UseKitImageCreationOptions) {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    listKits()
      .then((list) => {
        if (!cancelled) setAvailable(list.kits.some((kit) => kit.installed && kit.creates.includes('psd')))
      })
      .catch(() => {
        if (!cancelled) setAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [rootPath])

  const createImage = useCallback(async (folder?: string) => {
    try {
      const created = await createKitDocument({ folder: folder || '', extension: 'psd' })
      if (!created.path) return
      await refreshWorkspaceDocuments(created.path, { silent: true })
      openPath(created.path)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }, [onError, openPath, refreshWorkspaceDocuments])

  return available ? createImage : undefined
}
