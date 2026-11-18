import type { WorkspaceDocument } from '@/services/desktop'

/** Shows a document read from disk in the editor (a Markdown one opens or reuses its session). */
export type ApplyWorkspaceDocument = (document: WorkspaceDocument) => void | Promise<void>
