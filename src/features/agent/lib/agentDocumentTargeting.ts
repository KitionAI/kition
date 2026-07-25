import type { AgentMentionableDocument } from '@/features/agent/lib/documentMentions'

export function resolveAgentDocumentTarget(input: {
  currentDocumentPath?: string
  referencedDocuments?: AgentMentionableDocument[]
  bindDocumentContext?: boolean
  allowSaveMarkdown?: boolean
}) {
  const currentDocumentPath = String(input.currentDocumentPath || '').trim()
  const referencedDocumentPath = String(
    input.referencedDocuments?.[0]?.path || '',
  ).trim()
  const bindDocumentContext = input.bindDocumentContext !== false
  const requestActiveDocumentPath = bindDocumentContext
    ? currentDocumentPath
    : referencedDocumentPath || currentDocumentPath

  return {
    requestActiveDocumentPath,
    saveMarkdown:
      Boolean(input.allowSaveMarkdown) && !requestActiveDocumentPath,
  }
}
