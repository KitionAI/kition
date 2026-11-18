import { useEffect } from 'react'

import { openFilesWithUnsavedEdits, saveOpenEditor } from '@/features/kits/public'
import type { UnsavedCloseChoice, UnsavedCloseScope } from '@/features/workspace/components/UnsavedCloseDialog'
import { getWorkspaceItemTitle } from '@/features/workspace/lib/workspace'
import { setDesktopLeaveGuard } from '@/services/desktopLeave'

/**
 * Asks before the desktop window closes, quits, or reloads while kit documents have unsaved edits:
 * Save saves every one and leaves only when all saved, Don't save leaves, Cancel stays.
 */
export function useUnsavedLeaveGuard(askUnsavedClose: (scope: UnsavedCloseScope) => Promise<UnsavedCloseChoice>) {
  useEffect(
    () =>
      setDesktopLeaveGuard(async () => {
        const paths = openFilesWithUnsavedEdits()
        if (!paths.length) return true
        const choice = await askUnsavedClose({ kind: 'window', names: paths.map((path) => getWorkspaceItemTitle(path.split('/').pop() ?? path)) })
        if (choice === 'cancel') return false
        if (choice === 'discard') return true
        const saved = await Promise.all(paths.map((path) => saveOpenEditor(path).catch(() => false)))
        return saved.every((done) => done === true)
      }),
    [askUnsavedClose],
  )
}
