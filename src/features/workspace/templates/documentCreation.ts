import {
  createWorkspaceDocument,
  writeWorkspaceDocument,
  type WorkspaceDocument,
} from '@/services/desktop'

/** A new note's title and text, from a template. */
export type DocumentCreationPreset = {
  title: string
  content: string
  templateId?: string
}

/** Makes a note in `folder` (the workspace root when empty), blank or from a template. */
export async function createDocumentWorkspaceEntry({
  folder = '',
  preset,
}: {
  folder?: string
  preset?: DocumentCreationPreset
}): Promise<WorkspaceDocument> {
  const created = await createWorkspaceDocument({
    title: preset?.title || 'Untitled note',
    folder,
    format: 'markdown',
  })
  return preset ? writeWorkspaceDocument(created.path, preset.content) : created
}
