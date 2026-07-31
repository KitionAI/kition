import {
  createWorkspaceDocument,
  writeWorkspaceDocument,
  type WorkspaceDocument,
} from '@/services/desktop'

export type DocumentPlatform = 'page' | 'note'
export type DocumentCreateFormat = 'markdown' | 'table'
export type DocumentCreationPreset = {
  title: string
  content: string
  templateId?: string
}

const documentPlatformOptions: Array<{ value: DocumentPlatform; label: string; folder: string }> = [
  { value: 'page', label: 'Knowledge page', folder: 'Knowledge base' },
  { value: 'note', label: 'Note', folder: 'Notes' },
]

export const documentCreateFormatOptions: Array<{
  value: DocumentCreateFormat
  label: string
  description: string
}> = [
  { value: 'markdown', label: 'Document', description: 'Save as .md and edit in a single pane' },
  { value: 'table', label: 'Table', description: 'Create a .kitable and enter the native table editor' },
]

export function getDocumentParentPath(path: string) {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : ''
}

export async function createDocumentWorkspaceEntry({
  activeDocumentPath = '',
  folderOverride,
  platform,
  preset,
}: {
  activeDocumentPath?: string
  folderOverride?: string
  platform: DocumentPlatform
  preset?: DocumentCreationPreset
}): Promise<{ document: WorkspaceDocument; successMessage: string }> {
  const option = documentPlatformOptions.find((item) => item.value === platform) || documentPlatformOptions[0]
  const folder = folderOverride ?? (getDocumentParentPath(activeDocumentPath) || option.folder)
  const createdDocument = await createWorkspaceDocument({
    title: preset?.title || (platform === 'note' ? 'Untitled note' : 'Untitled knowledge page'),
    folder,
    platform: option.label,
    format: 'markdown',
  })
  const document = preset
    ? await writeWorkspaceDocument(createdDocument.path, preset.content)
    : createdDocument

  return {
    document,
    successMessage: 'Document created',
  }
}
