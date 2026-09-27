import { useEffect, useRef } from 'react'

import { openDataDocumentByPath } from '@/api/dataDocuments'
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
 * Remove once the runtime lists tables from the file system (quality plan,
 * Task 2.2).
 */
export function useKitableRegistration(files: ReadonlyArray<TreeFileLike>, index: RegistrationIndex) {
  const attemptedRef = useRef<Set<string>>(new Set())
  const { status, docIdByKitablePath, refresh } = index
  useEffect(() => {
    if (status !== 'done') return
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
  }, [files, status, docIdByKitablePath, refresh])
}
