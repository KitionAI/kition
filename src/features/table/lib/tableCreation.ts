import { createDataDocument, createDataRecord } from '@/api/dataDocuments'
import type { DataFieldSeed, DataViewSeed } from '@/types/dataDocument'
import {
  createWorkspaceDocument,
  deleteWorkspaceDocument,
  type WorkspaceDocument,
} from '@/services/desktop'
import { getDocumentParentPath } from '@/features/document/lib/documentCreation'

export const DEFAULT_EMPTY_ROW_COUNT = 3

export const DEFAULT_NEW_TABLE_FIELDS: DataFieldSeed[] = [
  { title: 'Title', type: 'text', primary: true, required: false },
  { title: 'Status', type: 'single_select', options: { choices: ['Not started', 'In progress', 'Done'] } },
  { title: 'Notes', type: 'long_text' },
]

export const DEFAULT_NEW_TABLE_VIEWS: DataViewSeed[] = [
  { title: 'Grid view', type: 'grid' },
]

export async function seedDefaultEmptyRows(documentId: number, tableId: number) {
  try {
    await Promise.all(
      Array.from({ length: DEFAULT_EMPTY_ROW_COUNT }, () =>
        createDataRecord(documentId, tableId, {}),
      ),
    )
  } catch {
    // Records are a UX convenience — if seeding fails, the table is still usable.
  }
}

export async function createTableWorkspaceEntry({
  activeDocumentPath = '',
  folderOverride,
  rootPath,
}: {
  activeDocumentPath?: string
  folderOverride?: string
  rootPath: string
}): Promise<{
  document: WorkspaceDocument
  successMessage: string
  tableId: number | null
  tableTitle: string
}> {
  const folder = folderOverride ?? (getDocumentParentPath(activeDocumentPath) || '')
  const title = 'Untitled table'
  const markerDocument = await createWorkspaceDocument({
    title,
    folder,
    platform: 'Table',
    format: 'data',
  })
  const markerPath = normalizeDataDocumentWorkspacePath(markerDocument.path, title, folder)

  const dataDocument = await createDataDocument({
    title,
    workspace_root: rootPath,
    path: markerPath,
    description: 'Kition native table',
    tables: [{
      title: 'Table',
      fields: DEFAULT_NEW_TABLE_FIELDS,
      views: DEFAULT_NEW_TABLE_VIEWS,
    }],
  })

  const seededTable = dataDocument.tables?.[0]
  if (seededTable?.id != null) {
    await seedDefaultEmptyRows(dataDocument.id, seededTable.id)
  }

  if (markerDocument.path !== markerPath) {
    try {
      await deleteWorkspaceDocument(markerDocument.path)
    } catch {
      // Older desktop builds may already have skipped the temporary Markdown marker.
    }
  }

  return {
    document: {
      ...markerDocument,
      path: markerPath,
      name: markerPath.split('/').pop() || markerDocument.name,
      content: '',
      format: 'data',
      updated_at: new Date().toISOString(),
    },
    successMessage: 'Table created',
    tableId: seededTable?.id != null ? Number(seededTable.id) : null,
    tableTitle: String(seededTable?.title || 'Table'),
  }
}

function normalizeDataDocumentWorkspacePath(path: string, title: string, fallbackFolder = '') {
  const normalizedPath = String(path || '').replace(/\\/g, '/').trim()
  if (/\.kitable$/i.test(normalizedPath)) {
    return normalizedPath
  }

  const parentPath = getDocumentParentPath(normalizedPath) || fallbackFolder
  const rawFilename = normalizedPath.split('/').pop() || title || 'Untitled table'
  const filename = /\.(md|markdown)$/i.test(rawFilename)
    ? rawFilename.replace(/\.(md|markdown)$/i, '.kitable')
    : `${rawFilename.replace(/\.kitable$/i, '')}.kitable`

  return parentPath ? `${parentPath}/${filename}` : filename
}
