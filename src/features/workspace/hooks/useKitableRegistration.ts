import { useEffect, useRef, useState } from 'react'

import { openDataDocumentByPath, runtimeListsTablesFromFileSystem } from '@/api/dataDocuments'
import { getDesktopBackendStatus } from '@/services/desktop'
import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'

type TreeFileLike = { type: string; path: string }
type RegistrationIndex = Pick<KitableChildrenIndex, 'status' | 'docIdByKitablePath' | 'refresh'>

/** .kitable files the tree knows about that the runtime has not indexed and that were not attempted yet. */
export function findUnregisteredKitables(
  files: ReadonlyArray<TreeFileLike>,
  docIdByKitablePath: Record<string, string>,
  attempted: ReadonlySet<string>,
): string[] {
  return files
    .filter((file) => file.type === 'file' && file.path.toLowerCase().endsWith('.kitable'))
    .map((file) => file.path)
    .filter((path) => !(path in docIdByKitablePath) && !attempted.has(path))
}

/**
 * Workaround for the runtime keeping a separate index of .kitable files:
 * files that arrive on disk through onboarding imports or drag-and-drop have
 * no index row, so the tree shows the container without table leaves. This
 * hook registers each unseen file once and refreshes the children index when
 * any registration succeeds. Unreadable files are attempted once and then
 * left leafless instead of looping.
 *
 * Runtimes that advertise `data_documents_fs_listing_v1` index the file
 * system themselves when listing, so the workaround stays off for them.
 * Delete this hook once every supported runtime has the capability.
 */
export function useKitableRegistration(files: ReadonlyArray<TreeFileLike>, index: RegistrationIndex) {
  const attemptedRef = useRef<Set<string>>(new Set())
  const { status, docIdByKitablePath, refresh } = index
  const runtimeLists = useRuntimeListsTablesFromFileSystem()
  useEffect(() => {
    if (status !== 'done' || runtimeLists !== false) return
    const unregistered = findUnregisteredKitables(files, docIdByKitablePath, attemptedRef.current)
    if (unregistered.length === 0) return
    unregistered.forEach((path) => attemptedRef.current.add(path))
    void (async () => {
      let registeredAny = false
      for (const path of unregistered) {
        try {
          await openDataDocumentByPath({ path })
          registeredAny = true
        } catch {
          // Corrupt or unreadable .kitable: leave it leafless rather than retrying.
        }
      }
      if (registeredAny) {
        void refresh()
      }
    })()
  }, [files, status, docIdByKitablePath, refresh, runtimeLists])
}

/** null while the runtime status is unknown, so nothing is registered before we know. */
function useRuntimeListsTablesFromFileSystem() {
  const [lists, setLists] = useState<boolean | null>(null)
  useEffect(() => {
    let active = true
    void getDesktopBackendStatus()
      .then((status) => {
        if (active) setLists(runtimeListsTablesFromFileSystem(status?.capabilities))
      })
      .catch(() => {
        if (active) setLists(false)
      })
    return () => {
      active = false
    }
  }, [])
  return lists
}
