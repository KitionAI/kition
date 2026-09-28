/**
 * Workspace documents and folders: listing, reading, writing, creating, moving, and deleting, with the browser-only localStorage workspace used by the web preview.
 */
import { flushWorkspaceEditSessions } from '../workspaceEditSessions'
import { getCurrentLocale } from '@/i18n'
import { type WorkspaceDocument, type WorkspaceDocumentCreateRequest, type WorkspaceDocumentExternalChange, type WorkspaceDocumentFormat, type WorkspaceDocumentListResponse, type WorkspaceDocumentMoveRequest, type WorkspaceDocumentTreeItem, type WorkspaceFolderCreateRequest, type WorkspaceFolderCreateResponse, type WorkspaceFolderMoveRequest, type WorkspaceFolderMoveResponse, getDesktopBridge } from './bridge'

const browserWorkspaceStorageKey = 'kition.workspace.documents.v1'
const browserWorkspaceFolderStorageKey = 'kition.workspace.folders.v1'

type BrowserWorkspaceRecord = {
  content: string
  updated_at: string
}

function inferWorkspaceDocumentFormat(path: string): WorkspaceDocumentFormat {
  const lower = path.toLowerCase()
  if (lower.endsWith('.kitable')) return 'data'
  if (lower.endsWith('.kidesign')) return 'design'
  if (lower.endsWith('.kiboard')) return 'board'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx'
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) return 'pptx'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.txt')) return 'text'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(lower)) return 'image'
  if (/\.(mp4|mov|webm)$/i.test(lower)) return 'video'
  if (/\.(mp3|wav|m4a)$/i.test(lower)) return 'audio'
  return 'binary'
}

export function normalizeWorkspaceDocumentPath(path: string) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

function getBrowserWorkspaceParentPath(path: string) {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : ''
}

function getBrowserWorkspaceStem(path: string) {
  const filename = path.split('/').pop() || path
  return filename.replace(/\.(md|markdown|kitable)$/i, '')
}

function pickUniqueBrowserWorkspaceDocumentPath(
  records: Record<string, BrowserWorkspaceRecord>,
  targetFolder: string,
  filename: string,
) {
  const extensionMatch = filename.match(/\.(md|markdown|kitable)$/i)
  const extension = extensionMatch?.[0] || '.md'
  const stem = extensionMatch ? filename.slice(0, -extension.length) : filename
  const normalizedFilename = extensionMatch ? filename : `${filename}${extension}`
  let finalFilename = normalizedFilename
  let index = 2

  while (records[targetFolder ? `${targetFolder}/${finalFilename}` : finalFilename]) {
    finalFilename = `${stem} ${index}${extension}`
    index += 1
  }

  return targetFolder ? `${targetFolder}/${finalFilename}` : finalFilename
}

function createSeededBrowserWorkspaceDocuments(now: string): Record<string, BrowserWorkspaceRecord> {
  return {
    'index.md': {
      updated_at: now,
      content: [
        '# Kition document library',
        '',
        'Local Markdown document library. The desktop app saves to the app data directory; the browser dev mode keeps a copy in localStorage.',
        '',
        '## Getting started',
        '',
        '- Open or edit documents from the left',
        '- Create folders on demand for organization',
        '- Knowledge pages, idea notes, and assets can all live in the same workspace',
      ].join('\n'),
    },
    'complex-document-template.md': {
      updated_at: now,
      content: [
        '# Complex document title',
        '',
        'Type: knowledge page',
        'Status: draft',
        'Tags: #knowledge-base #longform',
        '',
        '## Background',
        '',
        'Start by describing the problem this document addresses, its scope, and the key constraints.',
        '',
        '## Structure',
        '',
        '- Goals',
        '- Decisions',
        '- Tasks',
        '- Risks',
      ].join('\n'),
    },
    'inbox.md': {
      updated_at: now,
      content: [
        '# Idea inbox',
        '',
        'Type: idea note',
        'Status: draft',
        'Tags: #inbox #note',
        '',
        '## To triage',
        '',
        'Drop loose ideas here first, then move them into specific knowledge pages later.',
      ].join('\n'),
    },
  }
}

const legacyKnowledgeDirectory = String.fromCodePoint(0x77e5, 0x8bc6, 0x5e93)
const legacyKnowledgeFile = String.fromCodePoint(0x590d, 0x6742, 0x6587, 0x6863, 0x6a21, 0x677f, 0x2e, 0x6d, 0x64)
const legacyIdeasDirectory = String.fromCodePoint(0x7075, 0x611f, 0x7b14, 0x8bb0)
const legacyInboxFile = String.fromCodePoint(0x6536, 0x4ef6, 0x7bb1, 0x2e, 0x6d, 0x64)

function migrateLegacyBrowserWorkspaceDocuments(records: Record<string, BrowserWorkspaceRecord>) {
  const nextRecords = { ...records }
  let changed = false

  const migrations = [
    [`${legacyKnowledgeDirectory}/${legacyKnowledgeFile}`, legacyKnowledgeFile],
    [`${legacyIdeasDirectory}/${legacyInboxFile}`, legacyInboxFile],
  ] as const

  migrations.forEach(([legacyPath, nextPath]) => {
    if (!nextRecords[legacyPath]) {
      return
    }
    if (!nextRecords[nextPath]) {
      nextRecords[nextPath] = nextRecords[legacyPath]
    }
    delete nextRecords[legacyPath]
    changed = true
  })

  return { records: nextRecords, changed }
}

function cleanupLegacyBrowserSeedFolders(records: Record<string, BrowserWorkspaceRecord>) {
  if (typeof window === 'undefined') {
    return
  }

  const staleRootFolders = [
    records[`${legacyKnowledgeDirectory}/${legacyKnowledgeFile}`] ? legacyKnowledgeDirectory : '',
    records[`${legacyIdeasDirectory}/${legacyInboxFile}`] ? legacyIdeasDirectory : '',
  ].filter(Boolean)

  if (!staleRootFolders.length) {
    return
  }

  const rawValue = window.localStorage.getItem(browserWorkspaceFolderStorageKey)
  if (!rawValue) {
    return
  }

  try {
    const parsed = JSON.parse(rawValue)
    if (!Array.isArray(parsed)) {
      return
    }

    const normalizedFolders = [...new Set(parsed.map((item) => normalizeWorkspaceDocumentPath(String(item || '')).trim()).filter(Boolean))]
    const nextFolders = normalizedFolders.filter((folderPath) => !staleRootFolders.includes(folderPath))

    if (nextFolders.length !== normalizedFolders.length) {
      saveBrowserWorkspaceFolders(nextFolders)
    }
  } catch {
    // Ignore malformed legacy folder storage and let later calls rebuild it.
  }
}

function loadBrowserWorkspaceDocuments(): Record<string, BrowserWorkspaceRecord> {
  if (typeof window === 'undefined') {
    return {}
  }

  const rawValue = window.localStorage.getItem(browserWorkspaceStorageKey)
  if (rawValue) {
    try {
      const parsed = JSON.parse(rawValue)
      if (parsed && typeof parsed === 'object') {
        const records = parsed as Record<string, BrowserWorkspaceRecord>
        const migrated = migrateLegacyBrowserWorkspaceDocuments(records)
        if (migrated.changed) {
          cleanupLegacyBrowserSeedFolders(records)
          saveBrowserWorkspaceDocuments(migrated.records)
        }
        return migrated.records
      }
    } catch {
      // Recreate the browser workspace if the local cache is malformed.
    }
  }

  const now = new Date().toISOString()
  const seeded = createSeededBrowserWorkspaceDocuments(now)

  window.localStorage.setItem(browserWorkspaceStorageKey, JSON.stringify(seeded))
  return seeded
}

function saveBrowserWorkspaceDocuments(records: Record<string, BrowserWorkspaceRecord>) {
  window.localStorage.setItem(browserWorkspaceStorageKey, JSON.stringify(records))
}

function loadBrowserWorkspaceFolders(): string[] {
  if (typeof window === 'undefined') {
    return []
  }

  const rawValue = window.localStorage.getItem(browserWorkspaceFolderStorageKey)
  if (!rawValue) {
    return []
  }

  try {
    const parsed = JSON.parse(rawValue)
    if (!Array.isArray(parsed)) {
      return []
    }
    return [...new Set(parsed.map((item) => normalizeWorkspaceDocumentPath(String(item || ''))).filter(Boolean))]
  } catch {
    return []
  }
}

function saveBrowserWorkspaceFolders(folders: string[]) {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(
    browserWorkspaceFolderStorageKey,
    JSON.stringify([...new Set(folders.map((item) => normalizeWorkspaceDocumentPath(item)).filter(Boolean))]),
  )
}

function buildBrowserWorkspaceTree(records: Record<string, BrowserWorkspaceRecord>, folders: string[] = []): WorkspaceDocumentTreeItem[] {
  const rootItems: WorkspaceDocumentTreeItem[] = []

  function ensureFolder(children: WorkspaceDocumentTreeItem[], folderPath: string, name: string) {
    let folder = children.find((item) => item.type === 'folder' && item.path === folderPath)
    if (!folder) {
      folder = { type: 'folder', path: folderPath, name, children: [] }
      children.push(folder)
    }
    return folder
  }

  folders.forEach((folderPath) => {
    const parts = folderPath.split('/').filter(Boolean)
    let children = rootItems
    let currentPath = ''

    parts.forEach((part) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const folder = ensureFolder(children, currentPath, part)
      children = folder.children || []
    })
  })

  for (const [documentPath, record] of Object.entries(records)) {
    const parts = documentPath.split('/').filter(Boolean)
    let children = rootItems
    let currentPath = ''

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      if (index === parts.length - 1) {
        children.push({
          type: 'file',
          path: currentPath,
          name: part,
          format: inferWorkspaceDocumentFormat(currentPath),
          size: record.content.length,
          updated_at: record.updated_at,
        })
        return
      }

      const folder = ensureFolder(children, currentPath, part)
      children = folder.children || []
    })
  }

  function sortItems(items: WorkspaceDocumentTreeItem[]) {
    items.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'folder' ? -1 : 1
      }
      return left.name.localeCompare(right.name, getCurrentLocale())
    })
    items.forEach((item) => {
      if (item.children) {
        sortItems(item.children)
      }
    })
  }

  sortItems(rootItems)
  return rootItems
}

export async function listWorkspaceDocuments(): Promise<WorkspaceDocumentListResponse> {
  const bridge = getDesktopBridge()
  if (bridge?.ListWorkspaceDocuments) {
    return bridge.ListWorkspaceDocuments()
  }

  return {
    root_path: 'browser-local-workspace',
    items: buildBrowserWorkspaceTree(loadBrowserWorkspaceDocuments(), loadBrowserWorkspaceFolders()),
  }
}

export async function readWorkspaceDocument(path: string, expectedRoot?: string): Promise<WorkspaceDocument> {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.ReadWorkspaceDocument) {
    return bridge.ReadWorkspaceDocument({ path: normalizedPath, ...(expectedRoot ? { expected_root: expectedRoot } : {}) })
  }

  const records = loadBrowserWorkspaceDocuments()
  const record = records[normalizedPath]
  if (!record) {
    throw new Error('document not found')
  }

  return {
    path: normalizedPath,
    name: normalizedPath.split('/').pop() || normalizedPath,
    content: record.content,
    format: inferWorkspaceDocumentFormat(normalizedPath),
    updated_at: record.updated_at,
    size: record.content.length,
  }
}

export function subscribeWorkspaceDocumentExternalChanges(
  handler: (change: WorkspaceDocumentExternalChange) => void,
): () => void {
  const bridge = getDesktopBridge()
  const eventName = bridge?.documentExternalChangeEvent
  if (!bridge?.EventsOn || !eventName) {
    return () => {}
  }

  return bridge.EventsOn(eventName, (payload: Partial<WorkspaceDocumentExternalChange>) => {
    const path = normalizeWorkspaceDocumentPath(String(payload?.path || ''))
    const eventType = payload?.eventType
    if (!path || (eventType !== 'add' && eventType !== 'change' && eventType !== 'unlink')) {
      return
    }
    handler({
      path,
      eventType,
      mtimeMs: typeof payload.mtimeMs === 'number' ? payload.mtimeMs : undefined,
    })
  }) || (() => {})
}

export async function statWorkspaceDocument(
  path: string,
): Promise<{ mtime_ms: number; size: number } | null> {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.StatWorkspaceDocument) {
    return bridge.StatWorkspaceDocument({ path: normalizedPath })
  }
  return null
}

export async function writeWorkspaceDocument(path: string, content: string, guard?: { expected_root: string; expected_content: string | null }): Promise<WorkspaceDocument> {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.WriteWorkspaceDocument) {
    return bridge.WriteWorkspaceDocument({ path: normalizedPath, content, ...guard })
  }

  const records = loadBrowserWorkspaceDocuments()
  if (guard && (guard.expected_root !== 'browser-local-workspace' || (records[normalizedPath]?.content ?? null) !== guard.expected_content)) throw new Error('DESIGN_SAVE_CONFLICT')
  const updated_at = new Date().toISOString()
  records[normalizedPath] = { content, updated_at }
  saveBrowserWorkspaceDocuments(records)

  return {
    path: normalizedPath,
    name: normalizedPath.split('/').pop() || normalizedPath,
    content,
    format: inferWorkspaceDocumentFormat(normalizedPath),
    updated_at,
    size: content.length,
  }
}

export async function createWorkspaceDocument(request: WorkspaceDocumentCreateRequest = {}): Promise<WorkspaceDocument> {
  const bridge = getDesktopBridge()
  if (bridge?.CreateWorkspaceDocument) {
    return bridge.CreateWorkspaceDocument(request)
  }

  const records = loadBrowserWorkspaceDocuments()
  const folder = normalizeWorkspaceDocumentPath(request.folder || '')
  const format = request.format === 'data' ? 'data' : 'markdown'
  const fallbackTitle = format === 'data' ? 'Untitled table' : 'Untitled note'
  const title = String(request.title || fallbackTitle).trim() || fallbackTitle
  const extension = format === 'data' ? '.kitable' : '.md'
  const filename = /\.(md|kitable)$/i.test(title) ? title.replace(/\.(md|kitable)$/i, extension) : `${title}${extension}`
  let documentPath = folder ? `${folder}/${filename}` : filename
  const stem = documentPath.replace(/\.(md|kitable)$/i, '')
  let index = 2

  while (records[documentPath]) {
    documentPath = `${stem} ${index}${extension}`
    index += 1
  }

  const content = format === 'data'
    ? JSON.stringify({
      version: 1,
      format: 'kition-data-document',
      title: documentPath.split('/').pop()?.replace(/\.kitable$/i, '') || title,
    }, null, 2)
    : ''

  return writeWorkspaceDocument(documentPath, content)
}

function isMissingDesktopHandlerError(error: unknown) {
  return String((error as any)?.message || error || '').includes('No handler registered')
}

function collectWorkspaceItemPaths(items: WorkspaceDocumentTreeItem[], target = new Set<string>()) {
  for (const item of items) {
    target.add(item.path)
    if (item.type === 'folder' && Array.isArray(item.children)) {
      collectWorkspaceItemPaths(item.children, target)
    }
  }
  return target
}

export async function createWorkspaceFolder(request: WorkspaceFolderCreateRequest = {}): Promise<WorkspaceFolderCreateResponse> {
  const parentFolder = normalizeWorkspaceDocumentPath(request.parent_folder || '')
  const folderName = normalizeWorkspaceDocumentPath(String(request.name || '').trim()).split('/').pop() || 'Untitled folder'

  const bridge = getDesktopBridge()
  if (bridge?.CreateWorkspaceFolder) {
    try {
      return await bridge.CreateWorkspaceFolder({
        parent_folder: parentFolder,
        name: folderName,
      })
    } catch (error) {
      if (!isMissingDesktopHandlerError(error) || !bridge.WriteWorkspaceDocument || !bridge.ListWorkspaceDocuments) {
        throw error
      }

      const workspace = await listWorkspaceDocuments()
      const existingPaths = collectWorkspaceItemPaths(workspace.items)
      let createdPath = parentFolder ? `${parentFolder}/${folderName}` : folderName
      let index = 2

      while (
        existingPaths.has(createdPath)
        || Array.from(existingPaths).some((path) => path.startsWith(`${createdPath}/`))
      ) {
        createdPath = parentFolder ? `${parentFolder}/${folderName} ${index}` : `${folderName} ${index}`
        index += 1
      }

      await writeWorkspaceDocument(`${createdPath}/.keep.md`, '')
      const nextWorkspace = await listWorkspaceDocuments()
      return {
        root_path: nextWorkspace.root_path,
        items: nextWorkspace.items,
        created_path: createdPath,
      }
    }
  }

  const records = loadBrowserWorkspaceDocuments()
  const folders = loadBrowserWorkspaceFolders()
  let createdPath = parentFolder ? `${parentFolder}/${folderName}` : folderName
  let index = 2

  while (
    folders.includes(createdPath)
    || Object.keys(records).some((path) => path === createdPath || path.startsWith(`${createdPath}/`))
  ) {
    createdPath = parentFolder ? `${parentFolder}/${folderName} ${index}` : `${folderName} ${index}`
    index += 1
  }

  saveBrowserWorkspaceFolders([...folders, createdPath])
  return {
    root_path: 'browser-local-workspace',
    items: buildBrowserWorkspaceTree(records, [...folders, createdPath]),
    created_path: createdPath,
  }
}

export async function moveWorkspaceDocument(request: WorkspaceDocumentMoveRequest): Promise<WorkspaceDocument> {
  await flushWorkspaceEditSessions(request.path)
  const normalizedPath = normalizeWorkspaceDocumentPath(request.path)
  const sourceParent = getBrowserWorkspaceParentPath(normalizedPath)
  const targetFolder = request.target_folder === undefined
    ? sourceParent
    : normalizeWorkspaceDocumentPath(request.target_folder || '')
  const targetName = String(request.target_name || '').trim()
  const bridge = getDesktopBridge()
  if (bridge?.MoveWorkspaceDocument) {
    return bridge.MoveWorkspaceDocument({
      path: normalizedPath,
      target_folder: targetFolder,
      target_name: targetName,
    })
  }

  const records = loadBrowserWorkspaceDocuments()
  const folders = loadBrowserWorkspaceFolders()
  const record = records[normalizedPath]
  if (!record) {
    throw new Error('document not found')
  }

  const filename = normalizedPath.split('/').pop() || normalizedPath
  if (sourceParent === targetFolder && (!targetName || targetName === filename)) {
    return readWorkspaceDocument(normalizedPath)
  }

  const nextPath = pickUniqueBrowserWorkspaceDocumentPath(records, targetFolder, targetName || filename)
  records[nextPath] = {
    ...record,
    updated_at: new Date().toISOString(),
  }
  delete records[normalizedPath]

  const oldChildPrefix = sourceParent
    ? `${sourceParent}/${getBrowserWorkspaceStem(normalizedPath)}/`
    : `${getBrowserWorkspaceStem(normalizedPath)}/`
  const newChildPrefix = `${nextPath.replace(/\.(md|markdown|kitable)$/i, '')}/`

  for (const [path, childRecord] of Object.entries({ ...records })) {
    if (!path.startsWith(oldChildPrefix)) {
      continue
    }

    const movedChildPath = `${newChildPrefix}${path.slice(oldChildPrefix.length)}`
    records[movedChildPath] = childRecord
    delete records[path]
  }

  saveBrowserWorkspaceDocuments(records)
  saveBrowserWorkspaceFolders(
    folders.map((folderPath) => {
      if (folderPath === oldChildPrefix.slice(0, -1) || folderPath.startsWith(oldChildPrefix)) {
        return `${newChildPrefix.slice(0, -1)}${folderPath.slice(oldChildPrefix.length - 1)}`
      }
      return folderPath
    }),
  )
  return readWorkspaceDocument(nextPath)
}

export async function moveWorkspaceFolder(request: WorkspaceFolderMoveRequest): Promise<WorkspaceFolderMoveResponse> {
  await flushWorkspaceEditSessions(request.path)
  const normalizedPath = normalizeWorkspaceDocumentPath(request.path)
  const sourceParent = getBrowserWorkspaceParentPath(normalizedPath)
  const sourceName = normalizedPath.split('/').pop() || normalizedPath
  const targetFolder = request.target_folder === undefined
    ? sourceParent
    : normalizeWorkspaceDocumentPath(request.target_folder || '')
  const targetName = String(request.target_name || '').trim() || sourceName
  const nextFolderPath = targetFolder ? `${targetFolder}/${targetName}` : targetName

  if (!normalizedPath || normalizedPath === nextFolderPath || nextFolderPath.startsWith(`${normalizedPath}/`)) {
    throw new Error('invalid target folder')
  }

  const bridge = getDesktopBridge()
  if (bridge?.MoveWorkspaceFolder) {
    return bridge.MoveWorkspaceFolder({
      path: normalizedPath,
      target_folder: targetFolder,
      target_name: targetName,
    })
  }

  const records = loadBrowserWorkspaceDocuments()
  const folders = loadBrowserWorkspaceFolders()
  const prefix = `${normalizedPath}/`
  const hasFolder = folders.includes(normalizedPath) || folders.some((folderPath) => folderPath.startsWith(prefix))
  const branchEntries = Object.entries(records).filter(([path]) => path.startsWith(prefix))
  if (!branchEntries.length && !hasFolder) {
    throw new Error('folder not found')
  }

  const finalFolderPath = (() => {
    let candidate = nextFolderPath
    let index = 2
    while (Object.keys(records).some((path) => path === candidate || path.startsWith(`${candidate}/`))) {
      candidate = targetFolder ? `${targetFolder}/${targetName} ${index}` : `${targetName} ${index}`
      index += 1
    }
    return candidate
  })()

  const nextRecords = { ...records }
  branchEntries.forEach(([path, record]) => {
    const movedPath = `${finalFolderPath}/${path.slice(prefix.length)}`
    nextRecords[movedPath] = {
      ...record,
      updated_at: new Date().toISOString(),
    }
    delete nextRecords[path]
  })
  saveBrowserWorkspaceDocuments(nextRecords)
  const nextFolders = folders.map((folderPath) => {
      if (folderPath === normalizedPath || folderPath.startsWith(prefix)) {
        return `${finalFolderPath}${folderPath.slice(normalizedPath.length)}`
      }
      return folderPath
    })
  saveBrowserWorkspaceFolders(nextFolders)

  return {
    root_path: 'browser-local-workspace',
    items: buildBrowserWorkspaceTree(nextRecords, nextFolders),
    moved_path: finalFolderPath,
  }
}

export async function deleteWorkspaceDocument(path: string): Promise<WorkspaceDocumentListResponse> {
  await flushWorkspaceEditSessions(path)
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.DeleteWorkspaceDocument) {
    return bridge.DeleteWorkspaceDocument({ path: normalizedPath })
  }

  const records = loadBrowserWorkspaceDocuments()
  if (!records[normalizedPath]) {
    throw new Error('document not found')
  }

  delete records[normalizedPath]

  const childPrefix = `${normalizedPath.replace(/\.(md|markdown|kitable)$/i, '')}/`
  Object.keys(records).forEach((recordPath) => {
    if (recordPath.startsWith(childPrefix)) {
      delete records[recordPath]
    }
  })

  saveBrowserWorkspaceDocuments(records)
  return listWorkspaceDocuments()
}

export async function deleteWorkspaceFolder(path: string): Promise<WorkspaceDocumentListResponse> {
  await flushWorkspaceEditSessions(path)
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  if (!normalizedPath) {
    throw new Error('the workspace root cannot be deleted')
  }
  const bridge = getDesktopBridge()
  if (bridge?.DeleteWorkspaceFolder) {
    return bridge.DeleteWorkspaceFolder({ path: normalizedPath })
  }

  const childPrefix = `${normalizedPath}/`
  const records = loadBrowserWorkspaceDocuments()
  Object.keys(records).forEach((recordPath) => {
    if (recordPath === normalizedPath || recordPath.startsWith(childPrefix)) {
      delete records[recordPath]
    }
  })
  saveBrowserWorkspaceDocuments(records)

  const folders = loadBrowserWorkspaceFolders()
  saveBrowserWorkspaceFolders(
    folders.filter((folderPath) => folderPath !== normalizedPath && !folderPath.startsWith(childPrefix)),
  )

  return listWorkspaceDocuments()
}
