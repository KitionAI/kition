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

export type AgentMentionSearchInput = {
  documents: AgentMentionableDocument[]
  query: string
  currentDocumentPath?: string
  contextPaths?: string[]
}

const mentionableFormats = new Set<WorkspaceDocumentFormat>([
  'markdown',
  'data',
  'table',
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

/**
 * Files a kit opens, and the agent tools that edit them (`<prefix>_inspect`, `_commands`,
 * `_run`): the runtime's kit definitions (`crates/kition-kits/src/manager.rs`) as the prompt
 * names them.
 */
const KIT_FILE_KINDS = [
  { format: 'photo', extensions: /\.(?:psd|psb|kphoto)$/i, prefix: 'photo', kit: 'Photo', one: 'a layered image', many: 'layered images', data: 'image data' },
  { format: 'film', extensions: /\.kitionfilm$/i, prefix: 'film', kit: 'Film', one: 'a video project', many: 'video projects', data: 'project data' },
  { format: 'vector', extensions: /\.kvector$/i, prefix: 'vector', kit: 'Vector', one: 'a vector drawing', many: 'vector drawings', data: 'drawing data' },
  { format: 'effect', extensions: /\.kitioneffect$/i, prefix: 'effect', kit: 'Effect', one: 'a motion graphics project', many: 'motion graphics projects', data: 'project data' },
  { format: 'layout', extensions: /\.kdesign$/i, prefix: 'design', kit: 'Design', one: 'a page layout', many: 'page layouts', data: 'layout data' },
  { format: 'cad', extensions: /\.dxf$/i, prefix: 'cad', kit: 'CAD', one: 'a CAD drawing', many: 'CAD drawings', data: 'drawing data' },
  // PowerPoint files stay attachments whose text is extracted; only .kitionslide files are kit-only.
  { format: 'slide', extensions: /\.kitionslide$/i, prefix: 'slide', kit: 'Kition Slide', one: 'a slide file', many: 'slide files', data: 'slide data' },
] as const

type KitFileKind = (typeof KIT_FILE_KINDS)[number]

/** The kit that opens a file, by its workspace format or extension. */
function kitFileKind(format: WorkspaceDocumentFormat | undefined, path: string): KitFileKind | null {
  return KIT_FILE_KINDS.find((kind) => format === kind.format || kind.extensions.test(path)) ?? null
}

function kitToolsHint(kind: KitFileKind) {
  return `Inspect it with ${kind.prefix}_inspect and edit it with ${kind.prefix}_commands and ${kind.prefix}_run; never use document_read or document_write on it, because it is binary ${kind.data}.`
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
  return /\.(md|markdown|kitable|txt|html|htm|json|csv|tsv|pdf|pptx?|docx?|xlsx?|png|jpe?g|gif|webp|svg)$/i.test(path)
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

export function getUniqueAgentDocumentMentionPaths(content: string) {
  return Array.from(new Set(extractAgentDocumentMentionTokens(content)))
}

export function stripAgentDocumentMentions(content: string) {
  const contentWithoutTrailingMentionLine = content.replace(
    /(?:^|\n)[ \t]*(?:@\{[^}\n]+\}[ \t]*)+$/,
    '',
  )
  return contentWithoutTrailingMentionLine
    .replace(/@\{([^}\n]+)\}/g, '')
    .replace(/[ \t]+(?=\n)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
}

export function buildAgentDraftWithDocumentMentions(
  content: string,
  paths: string[],
) {
  const uniquePaths = Array.from(
    new Set(paths.map((path) => path.trim()).filter(Boolean)),
  )
  if (!uniquePaths.length) {
    return content
  }
  const body = content.replace(/\n[ \t]*$/, '')
  const mentionLine = uniquePaths.map((path) => `@{${path}}`).join(' ')
  return body ? `${body}\n${mentionLine}` : mentionLine
}

export function removeAgentDocumentMention(content: string, path: string) {
  const nextPaths = getUniqueAgentDocumentMentionPaths(content).filter(
    (candidate) => candidate !== path,
  )
  return buildAgentDraftWithDocumentMentions(
    stripAgentDocumentMentions(content),
    nextPaths,
  )
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
  const tokenStart = prefix.lastIndexOf('@')
  if (tokenStart < 0 || prefix.slice(tokenStart).includes('\n')) {
    return null
  }
  if (tokenStart > 0 && !/[\s([{]/.test(prefix[tokenStart - 1])) {
    return null
  }
  const candidate = prefix.slice(tokenStart)
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

function normalizeMentionSearchValue(value: string) {
  return value.normalize('NFKC').trim().toLowerCase()
}

function normalizeMentionDocumentPath(value: string) {
  return value.trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

export function resolveAgentMentionDocumentPath(
  documents: AgentMentionableDocument[],
  path: string,
) {
  const normalizedPath = normalizeMentionDocumentPath(path)
  if (!normalizedPath) {
    return ''
  }
  const exactMatch = documents.find(
    (document) => normalizeMentionDocumentPath(document.path) === normalizedPath,
  )
  if (exactMatch) {
    return exactMatch.path
  }
  const foldedPath = normalizedPath.toLowerCase()
  const foldedMatches = documents.filter(
    (document) => normalizeMentionDocumentPath(document.path).toLowerCase() === foldedPath,
  )
  return foldedMatches.length === 1 ? foldedMatches[0].path : normalizedPath
}

function withoutMentionableExtension(value: string) {
  return value.replace(/\.(?:md|markdown|kitable|txt|html?|json|csv|tsv|pdf|pptx?|docx?|xlsx?|png|jpe?g|gif|webp|svg)$/i, '')
}

function scoreMentionDocument(document: AgentMentionableDocument, query: string) {
  if (!query) {
    return 100
  }
  const title = normalizeMentionSearchValue(document.title)
  const name = normalizeMentionSearchValue(document.name)
  const nameWithoutExtension = normalizeMentionSearchValue(withoutMentionableExtension(document.name))
  const path = normalizeMentionSearchValue(document.path)
  const pathParts = path.split('/').filter(Boolean)
  if (title === query || nameWithoutExtension === query || name === query) return 0
  if (title.startsWith(query)) return 10
  if (nameWithoutExtension.startsWith(query) || name.startsWith(query)) return 20
  if (pathParts.some((part) => part.startsWith(query))) return 30
  if (title.includes(query)) return 40
  if (nameWithoutExtension.includes(query) || name.includes(query)) return 50
  if (path.includes(query)) return 60
  const terms = query.split(/\s+/).filter(Boolean)
  if (terms.length > 1 && terms.every((term) => `${title} ${name} ${path}`.includes(term))) {
    return 70
  }
  return Number.POSITIVE_INFINITY
}

export function searchAgentMentionableDocuments({
  documents,
  query,
  currentDocumentPath = '',
  contextPaths = [],
}: AgentMentionSearchInput) {
  const normalizedQuery = normalizeMentionSearchValue(query)
  const resolvedCurrentDocumentPath = resolveAgentMentionDocumentPath(
    documents,
    currentDocumentPath,
  )
  const contextOrder = new Map(contextPaths.map((path, index) => [
    resolveAgentMentionDocumentPath(documents, path),
    index,
  ]))
  return documents
    .map((document, index) => ({
      document,
      index,
      score: scoreMentionDocument(document, normalizedQuery),
    }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => {
      const leftCurrent = left.document.path === resolvedCurrentDocumentPath ? 0 : 1
      const rightCurrent = right.document.path === resolvedCurrentDocumentPath ? 0 : 1
      if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent
      const leftContext = contextOrder.get(left.document.path) ?? Number.POSITIVE_INFINITY
      const rightContext = contextOrder.get(right.document.path) ?? Number.POSITIVE_INFINITY
      if (leftContext !== rightContext) return leftContext - rightContext
      if (left.score !== right.score) return left.score - right.score
      if (left.document.kind !== right.document.kind) {
        return left.document.kind === 'file' ? -1 : 1
      }
      return left.index - right.index
    })
    .map((candidate) => candidate.document)
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
  activeDocumentPath?: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  referencedDocuments: AgentMentionableDocument[]
  unresolvedTokens?: string[]
}) {
  const lines: string[] = []
  const activeDocumentPath = String(input.activeDocumentPath || '').trim()
  if (activeDocumentPath) {
    lines.push('Current workspace document for this turn:')
    lines.push(`- ${activeDocumentPath}`)
    const activeKit = kitFileKind(input.activeDocumentFormat, activeDocumentPath)
    if (activeKit) {
      lines.push(`This current document is ${activeKit.one} open in ${activeKit.kit}. ${kitToolsHint(activeKit)}`)
    } else if (isBinaryAttachmentMention(input.activeDocumentFormat, activeDocumentPath)) {
      lines.push(
        'This current document is attached to the turn. Analyze it before responding; it is implicit context even without an @ mention.',
      )
    } else if (
      input.activeDocumentFormat === 'data'
      || input.activeDocumentFormat === 'table'
      || activeDocumentPath.toLowerCase().endsWith('.kitable')
    ) {
      lines.push(
        'Analyze the current structured document with the active table context before responding; it is implicit context even without an @ mention.',
      )
    } else {
      lines.push(
        'Read this exact path with document_read and analyze it before responding; it is implicit context even without an @ mention.',
      )
    }
    lines.push(
      'Do not ask which document the user means while this current document is available.',
    )
  }
  const referencedFiles = input.referencedDocuments.filter(
    (document) => document.kind !== 'folder' && document.path !== activeDocumentPath,
  )
  const referencedFolders = input.referencedDocuments.filter((document) => document.kind === 'folder')
  const structuredFiles = referencedFiles.filter(
    (document) => document.format === 'data'
      || document.format === 'table'
      || document.path.toLowerCase().endsWith('.kitable'),
  )
  const kitFiles = referencedFiles.filter((document) => kitFileKind(document.format, document.path))
  const textFiles = referencedFiles.filter(
    (document) => !structuredFiles.includes(document)
      && !kitFiles.includes(document)
      && !isBinaryAttachmentMention(document.format, document.path),
  )
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
  for (const kind of KIT_FILE_KINDS) {
    const files = kitFiles.filter((document) => kitFileKind(document.format, document.path) === kind)
    if (!files.length) continue
    lines.push(`Referenced ${kind.many} in this turn (open them in ${kind.kit}):`)
    for (const document of files) {
      lines.push(`- ${document.path}`)
    }
    lines.push(kitToolsHint(kind))
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
  if (structuredFiles.length) {
    lines.push('Referenced structured workspace documents in this turn:')
    for (const document of structuredFiles) {
      lines.push(`- ${document.path}`)
    }
    lines.push(
      'Analyze each referenced structured document with the table/data tools available for its exact path before responding.',
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
