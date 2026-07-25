import type {
  WorkspaceDocumentFormat,
  WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import { getWorkspaceItemTitle } from '@/features/workspace/lib/workspace'

export type AgentMentionableDocument = {
  kind: 'file' | 'folder'
  path: string
  name: string
  title: string
  format?: WorkspaceDocumentFormat
}

export type AgentMentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; raw: string; path: string }

export type AgentMentionQuery = {
  query: string
  start: number
  end: number
}

const mentionableFormats = new Set<WorkspaceDocumentFormat>([
  'markdown',
  'text',
  'html',
  'json',
  'csv',
  'image',
  'pdf',
  'pptx',
  'docx',
  'xlsx',
])

const binaryAttachmentFormats = new Set<WorkspaceDocumentFormat>([
  'image',
  'pdf',
  'pptx',
  'docx',
  'xlsx',
])

const binaryAttachmentExtensionPattern = /\.(pdf|pptx?|docx?|xlsx?|png|jpe?g|gif|webp|svg)$/i

export function isBinaryAttachmentMention(
  format: WorkspaceDocumentFormat | undefined,
  path: string,
) {
  if (format && binaryAttachmentFormats.has(format)) {
    return true
  }
  return binaryAttachmentExtensionPattern.test(path)
}

export function flattenMentionableWorkspaceDocuments(
  items: WorkspaceDocumentTreeItem[],
): AgentMentionableDocument[] {
  const documents: AgentMentionableDocument[] = []

  function visit(entries: WorkspaceDocumentTreeItem[]) {
    for (const entry of entries) {
      if (entry.type === 'folder') {
        documents.push({
          kind: 'folder',
          path: entry.path,
          name: entry.name,
          title: getWorkspaceItemTitle(entry.name),
        })
        visit(entry.children || [])
        continue
      }
      if (!isMentionableWorkspaceFormat(entry.format, entry.path)) {
        continue
      }
      documents.push({
        kind: 'file',
        path: entry.path,
        name: entry.name,
        title: getWorkspaceItemTitle(entry.name),
        format: entry.format,
      })
    }
  }

  visit(items)
  return documents
}

export function isMentionableWorkspaceFormat(
  format: WorkspaceDocumentFormat | undefined,
  path: string,
) {
  if (format && mentionableFormats.has(format)) {
    return true
  }
  return /\.(md|markdown|txt|html|htm|json|csv|tsv|pdf|pptx?|docx?|xlsx?|png|jpe?g|gif|webp|svg)$/i.test(path)
}

export function extractAgentDocumentMentionTokens(content: string) {
  const tokens: string[] = []
  const pattern = /@\{([^}\n]+)\}/g
  let match: RegExpExecArray | null = null
  while ((match = pattern.exec(content)) !== null) {
    const token = String(match[1] || '').trim()
    if (token) {
      tokens.push(token)
    }
  }
  return tokens
}

export function parseAgentMentionSegments(content: string): AgentMentionSegment[] {
  const segments: AgentMentionSegment[] = []
  const pattern = /@\{([^}\n]+)\}/g
  let cursor = 0
  let match: RegExpExecArray | null = null
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > cursor) {
      segments.push({
        type: 'text',
        value: content.slice(cursor, match.index),
      })
    }
    const path = String(match[1] || '').trim()
    segments.push({
      type: 'mention',
      raw: match[0],
      path,
    })
    cursor = match.index + match[0].length
  }
  if (cursor < content.length) {
    segments.push({
      type: 'text',
      value: content.slice(cursor),
    })
  }
  return segments
}

export function findAgentMentionQuery(
  content: string,
  caret: number,
): AgentMentionQuery | null {
  const safeCaret = Math.max(0, Math.min(content.length, caret))
  const prefix = content.slice(0, safeCaret)
  let tokenStart = safeCaret
  while (tokenStart > 0 && !/\s/.test(prefix[tokenStart - 1])) {
    tokenStart -= 1
  }
  const candidate = prefix.slice(tokenStart)
  if (!candidate.startsWith('@')) {
    return null
  }
  if (candidate.startsWith('@{')) {
    if (candidate.includes('}')) {
      return null
    }
    return {
      query: candidate.slice(2),
      start: tokenStart,
      end: safeCaret,
    }
  }
  if (candidate.length === 1) {
    return {
      query: '',
      start: tokenStart,
      end: safeCaret,
    }
  }
  return {
    query: candidate.slice(1),
    start: tokenStart,
    end: safeCaret,
  }
}

export function applyAgentMentionSelection(input: {
  content: string
  mention: AgentMentionQuery
  path: string
}) {
  const nextToken = `@{${input.path}} `
  const nextContent =
    input.content.slice(0, input.mention.start) +
    nextToken +
    input.content.slice(input.mention.end)
  return {
    content: nextContent,
    caret: input.mention.start + nextToken.length,
  }
}

export function resolveAgentDocumentMentions(input: {
  content: string
  documents: AgentMentionableDocument[]
}) {
  const documentsByPath = new Map(
    input.documents.map((document) => [document.path.toLowerCase(), document]),
  )
  const documentsByName = new Map<string, AgentMentionableDocument[]>()
  for (const document of input.documents) {
    const keys = [
      document.path,
      document.name,
      document.title,
    ]
    for (const key of keys) {
      const normalized = key.trim().toLowerCase()
      if (!normalized) {
        continue
      }
      const bucket = documentsByName.get(normalized)
      if (bucket) {
        bucket.push(document)
      } else {
        documentsByName.set(normalized, [document])
      }
    }
  }

  const resolved: AgentMentionableDocument[] = []
  const unresolved: string[] = []
  for (const token of extractAgentDocumentMentionTokens(input.content)) {
    const normalized = token.toLowerCase()
    const exact = documentsByPath.get(normalized)
    if (exact) {
      if (!resolved.some((item) => item.path === exact.path)) {
        resolved.push(exact)
      }
      continue
    }
    const byName = documentsByName.get(normalized) || []
    if (byName.length === 1) {
      if (!resolved.some((item) => item.path === byName[0].path)) {
        resolved.push(byName[0])
      }
      continue
    }
    unresolved.push(token)
  }

  return {
    resolved,
    unresolved,
  }
}

export function buildAgentDocumentMentionPromptContext(input: {
  referencedDocuments: AgentMentionableDocument[]
  unresolvedTokens?: string[]
}) {
  const lines: string[] = []
  const referencedFiles = input.referencedDocuments.filter((document) => document.kind !== 'folder')
  const referencedFolders = input.referencedDocuments.filter((document) => document.kind === 'folder')
  const textFiles = referencedFiles.filter((document) => !isBinaryAttachmentMention(document.format, document.path))
  const binaryFiles = referencedFiles.filter((document) => isBinaryAttachmentMention(document.format, document.path))
  if (textFiles.length) {
    lines.push('Referenced workspace documents in this turn:')
    for (const document of textFiles) {
      lines.push(`- ${document.path}`)
    }
    lines.push(
      'If the answer depends on one of these files, read the exact referenced path first with document_read.',
    )
    lines.push(
      'If the user wants to update one referenced document, write back to that same path with document_write instead of creating a new file.',
    )
  }
  if (binaryFiles.length) {
    lines.push('Referenced binary attachments in this turn (already embedded as multimodal/text parts of this turn):')
    for (const document of binaryFiles) {
      lines.push(`- ${document.path}`)
    }
    lines.push(
      'Do NOT call document_read on these binary attachments — their contents are already provided in this turn (images as vision input, pdf/pptx/docx/xlsx as extracted text blocks).',
    )
  }
  if (referencedFolders.length) {
    lines.push('Referenced workspace folders in this turn:')
    for (const folder of referencedFolders) {
      lines.push(`- ${folder.path}`)
    }
    lines.push(
      'List a referenced folder with document_list before deciding which files matter, then read the specific files you need with document_read.',
    )
  }
  if (input.unresolvedTokens?.length) {
    lines.push(
      `Unresolved @mentions: ${input.unresolvedTokens.join(', ')}. If needed, ask for a clearer file selection instead of guessing.`,
    )
  }
  return lines.join('\n')
}
