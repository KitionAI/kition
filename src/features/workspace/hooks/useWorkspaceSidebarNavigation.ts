import { useCallback } from 'react'
import { revealInKit } from '@/features/kits/public'
import { parseKitPartPath } from '@/features/workspace/lib/kitOutlineChildren'

type UseWorkspaceSidebarNavigationOptions = {
  onCloseProfile?: () => void
  openDocument: (path: string) => Promise<void>
}

/**
 * Routes a click on a sidebar row to the right tab. Real files open by format (a kit's file in
 * its kit); a part of a file its kit's outline lists opens the file in the kit there.
 */
export function useWorkspaceSidebarNavigation({
  onCloseProfile,
  openDocument,
}: UseWorkspaceSidebarNavigationOptions) {
  const openSidebarPath = useCallback((path: string) => {
    onCloseProfile?.()
    const part = parseKitPartPath(path)
    if (part) {
      revealInKit(part.filePath, part.view)
      void openDocument(part.filePath)
      return
    }
    void openDocument(path)
  }, [onCloseProfile, openDocument])

  return { openSidebarPath }
}
