import type { DocumentPlatform } from '@/features/document/lib/documentCreation'
import { inferWorkspaceItemFormat } from '@/features/workspace/lib/workspace'
import type { WorkspaceDocument } from '@/services/desktop'

export function inferDocumentPlatform(path: string, content: string): DocumentPlatform {
  const text = `${path}\n${content}`
  return /note|inbox|idea|journal/i.test(text) ? 'note' : 'page'
}

export function readWorkspaceDocumentDraft(document: WorkspaceDocument) {
  const format = document.format || inferWorkspaceItemFormat(document.path, document.content)

  return {
    format,
    markdown: document.content,
  }
}
