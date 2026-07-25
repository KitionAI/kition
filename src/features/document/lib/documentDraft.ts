import type { DocumentPlatform } from '@/features/document/lib/documentCreation'
import {
  inferWorkspaceItemFormat,
  isWorkspaceDataMarkerContent,
} from '@/features/workspace/lib/workspace'
import type { WorkspaceDocument, WorkspaceDocumentFormat } from '@/services/desktop'

export function inferDocumentPlatform(path: string, content: string): DocumentPlatform {
  const text = `${path}\n${content}`
  return /note|inbox|idea|journal/i.test(text) ? 'note' : 'page'
}

export function readWorkspaceDocumentDraft(document: WorkspaceDocument) {
  const format = document.format || inferWorkspaceItemFormat(document.path, document.content)

  if (format === 'data' || isWorkspaceDataMarkerContent(document.content)) {
    return {
      format: 'data' as WorkspaceDocumentFormat,
      markdown: '',
    }
  }

  return {
    format,
    markdown: document.content,
  }
}

export function visibleDraftLength(markdown: string) {
  return String(markdown || '').replace(/[\s​‌‍﻿]/g, '').length
}

export function getWorkspaceDocumentStoredContent(options: {
  document: WorkspaceDocument | null
  format: WorkspaceDocumentFormat
  markdown: string
}) {
  if (!options.document) {
    return ''
  }

  if (options.format === 'data') {
    return options.document.content
  }

  return options.markdown
}
