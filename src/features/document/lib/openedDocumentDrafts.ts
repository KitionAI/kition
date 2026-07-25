import type { DocumentPlatform } from '@/features/document/lib/documentCreation'
import type { WorkspaceDocument, WorkspaceDocumentFormat } from '@/services/desktop'

export type OpenedDocumentDraftCacheEntry = {
  document: WorkspaceDocument
  format: WorkspaceDocumentFormat
  markdown: string
  platform: DocumentPlatform
}

export function createOpenedDocumentDraftCacheEntry(options: {
  document: WorkspaceDocument
  format: WorkspaceDocumentFormat
  markdown: string
  platform: DocumentPlatform
}): OpenedDocumentDraftCacheEntry {
  return {
    document: options.document,
    format: options.format,
    markdown: options.markdown,
    platform: options.platform,
  }
}
