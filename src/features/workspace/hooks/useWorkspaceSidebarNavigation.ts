import { useCallback } from 'react'
import { revealInKit } from '@/features/kits/public'
import { parseTableFileChildPath } from '@/features/workspace/lib/tableFileChildren'

type UseWorkspaceSidebarNavigationOptions = {
  onCloseProfile?: () => void
  openDocument: (path: string) => Promise<void>
}

/**
 * Routes a click on a sidebar row to the right tab. Real files open by format (a table file
 * opens in the Table kit, like every kit file); a table file's table or dashboard opens the file
 * in the kit there.
 */
export function useWorkspaceSidebarNavigation({
  onCloseProfile,
  openDocument,
}: UseWorkspaceSidebarNavigationOptions) {
  const openSidebarPath = useCallback((path: string) => {
    onCloseProfile?.()
    const tableFileChild = parseTableFileChildPath(path)
    if (tableFileChild) {
      revealInKit(tableFileChild.filePath, tableFileChild.view)
      void openDocument(tableFileChild.filePath)
      return
    }
    void openDocument(path)
  }, [onCloseProfile, openDocument])

  return { openSidebarPath }
}
