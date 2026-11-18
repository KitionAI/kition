/**
 * Which document opens after the workspace list loads. Pure so the
 * preference order is testable apart from the loader's side effects.
 */
import { inferWorkspaceItemFormat, isEditableWorkspaceFormat } from '@/features/workspace/lib/workspace'
import type { WorkspaceDocumentFormat } from '@/services/desktop'

type ListedItem = { path: string; format?: WorkspaceDocumentFormat }

/**
 * Preference order: the caller's explicit path, the document already
 * open, the last active document from a previous session, then Home.md,
 * then the first editable file. A candidate only counts when it is still
 * in the list. Returns '' when nothing is editable.
 */
export function resolveInitialDocumentPath(items: readonly ListedItem[], candidates: {
  preferredPath?: string
  activeDocumentPath?: string
  lastActivePath?: string
}): string {
  const editable = items.filter((item) => isEditableWorkspaceFormat(item.format || inferWorkspaceItemFormat(item.path)))
  const has = (path: string | undefined) => Boolean(path) && editable.some((item) => item.path === path)
  const home = editable.find((item) => item.path === 'Home.md')?.path
  for (const candidate of [candidates.preferredPath, candidates.activeDocumentPath, candidates.lastActivePath, home]) {
    if (has(candidate)) return candidate as string
  }
  return editable[0]?.path || ''
}
