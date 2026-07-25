import type { WorkspaceDocument } from '@/services/desktop'

export type ApplyWorkspaceDocument = (
  document: WorkspaceDocument,
  options?: { resetEditor?: boolean; restoreFromCache?: boolean },
) => void
