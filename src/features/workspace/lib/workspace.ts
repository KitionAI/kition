import {
  FileDown,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo2,
  Presentation,
  Volume2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getCurrentLocale } from '@/i18n'
import type {
  BrowserSessionProvider,
  WorkspaceDocumentFormat,
  WorkspaceDocumentTreeItem,
} from '@/services/desktop'

export type WorkspaceMediaKind = 'images' | 'videos'

export type WorkspaceTab =
  | {
      id: string
      type: 'document'
      title: string
      path: string
      format?: WorkspaceDocumentFormat
         
                                                                 
                                                            
                                                        
                                     
         
      uid?: string
    }
  | {
      id: string
      type: 'file-viewer'
      title: string
      path: string
      format: WorkspaceDocumentFormat
    }
  | {
      id: string
      type: 'browser'
      title: string
      provider: BrowserSessionProvider
      taskMode?: 'auto' | 'browse' | 'table'
      host?: string
      url?: string
      query?: string
      profileId?: string
      originTabId?: string
      originDocumentPath?: string
      originTableId?: number
      originLabel?: string
    }
  | { id: string; type: 'gallery'; title: string; kind: WorkspaceMediaKind }
  | { id: string; type: 'browser-sites'; title: string }
  | {
      id: string
      type: 'workflow'
      title: string
      /** Optional: open the home view scoped to a specific kitable's tables.
       *  When undefined the tab shows the global list. Path matches a kitable
       *  file path (e.g. "Leads.kitable") so the user can return to its
       *  table picker without re-resolving the doc tree. */
      kitablePath?: string
      /** Optional: pre-select a specific workflow id when the tab mounts. */
      workflowId?: string
    }
  | {
      id: string
      type: 'table'
      title: string
      kitablePath: string
      tableId: number
      format: 'data'  // existing format===data branches keep working
    }

export type WorkspaceTreeNode = {
  type: 'folder' | 'file'
  path: string
  name: string
  title: string
  format?: WorkspaceDocumentFormat
  virtual?: boolean
  parentPath: string
  filePath?: string
  folderPath?: string
  size?: number
  updated_at?: string
  children: WorkspaceTreeNode[]
}

export type WorkspaceTreeDropPosition = 'before' | 'inside' | 'after'

export const workspaceEmojiOptions = ['📄', '🧠', '📚', '✍️', '💡', '🗂️', '✅', '🚧', '⭐', '🔖', '🧩', '📌']
const workspaceTitleExtensionPattern = /\.(md|markdown|kitable|docx|xlsx|xls|pptx|ppt|pdf|csv|tsv|json|txt|html|htm|png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|m4a)$/i
const workspaceEditableExtensionPattern = /\.(md|markdown|kitable)$/i

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(getCurrentLocale()).format(value)
}

export function formatWorkspaceTime(value?: string | null) {
  return value ? formatRelativeDateTime(value) : 'just now'
}

function formatRelativeDateTime(value?: string | null) {
  if (!value) {
    return 'just now'
  }

  const target = new Date(value)
  if (Number.isNaN(target.getTime())) {
    return value
  }

  const diffMs = Date.now() - target.getTime()
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (diffMs < minute) {
    return 'just now'
  }
  if (diffMs < hour) {
    const minutes = Math.max(1, Math.floor(diffMs / minute))
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  }
  if (diffMs < day) {
    const hours = Math.max(1, Math.floor(diffMs / hour))
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  if (diffMs < 2 * day) {
    return 'yesterday'
  }
  if (diffMs < 7 * day) {
    const days = Math.floor(diffMs / day)
    return `${days} ${days === 1 ? 'day' : 'days'} ago`
  }

  return target.toLocaleDateString(getCurrentLocale(), {
    month: 'numeric',
    day: 'numeric',
  })
}

export function inferWorkspaceItemFormat(path: string, content?: string): WorkspaceDocumentFormat {
  if (isWorkspaceDataMarkerContent(content)) {
    return 'data'
  }
  if (path.toLowerCase().endsWith('.kitable')) {
    return 'data'
  }
  if (path.toLowerCase().endsWith('.docx')) {
    return 'docx'
  }
  if (/\.(xlsx|xls)$/i.test(path)) {
    return 'xlsx'
  }
  if (/\.(pptx|ppt)$/i.test(path)) {
    return 'pptx'
  }
  if (path.toLowerCase().endsWith('.pdf')) {
    return 'pdf'
  }
  if (/\.(csv|tsv)$/i.test(path)) {
    return 'csv'
  }
  if (path.toLowerCase().endsWith('.json')) {
    return 'json'
  }
  if (path.toLowerCase().endsWith('.txt')) {
    return 'text'
  }
  if (/\.(html|htm)$/i.test(path)) {
    return 'html'
  }
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
    return 'image'
  }
  if (/\.(mp4|mov|webm)$/i.test(path)) {
    return 'video'
  }
  if (/\.(mp3|wav|m4a)$/i.test(path)) {
    return 'audio'
  }
  return 'markdown'
}

export function isWorkspaceDataMarkerContent(content?: string) {
  const trimmed = String(content || '').trim()
  if (!trimmed.startsWith('{')) {
    return false
  }

  try {
    const marker = JSON.parse(trimmed) as { format?: string }
    return marker.format === 'kition-data-document'
  } catch {
    return false
  }
}

export function getWorkspaceItemTitle(name: string) {
  return name.replace(workspaceTitleExtensionPattern, '')
}

export const KITABLE_WORKSPACE_TAB_PREFIX = 'kitable:'

/** Kitable tabs represent the file, while table/workflow are internal views. */
export function buildKitableWorkspaceTabId(kitablePath: string) {
  return `${KITABLE_WORKSPACE_TAB_PREFIX}${kitablePath}`
}

export function getKitableWorkspaceTabTitle(kitablePath: string) {
  const filename = kitablePath.split('/').pop() || kitablePath
  return getWorkspaceItemTitle(filename)
}

export function renameWorkspaceDocumentPath(path: string, title: string) {
  const normalizedPath = String(path || '').replace(/\\/g, '/').trim()
  const trimmedTitle = String(title || '').trim()
  if (!normalizedPath) {
    return normalizedPath
  }

  const filename = normalizedPath.split('/').pop() || normalizedPath
  const extension = filename.match(workspaceEditableExtensionPattern)?.[0] || ''
  const nextFilename = `${trimmedTitle || getWorkspaceItemTitle(filename) || 'Untitled document'}${extension}`
  const parentPath = normalizedPath.includes('/')
    ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
    : ''
  return parentPath ? `${parentPath}/${nextFilename}` : nextFilename
}

export function remapWorkspaceBranchPath(path: string, sourcePath: string, targetPath: string) {
  const normalizedPath = String(path || '').replace(/\\/g, '/').trim()
  const normalizedSourcePath = String(sourcePath || '').replace(/\\/g, '/').trim()
  const normalizedTargetPath = String(targetPath || '').replace(/\\/g, '/').trim()
  if (!normalizedPath || !normalizedSourcePath || !normalizedTargetPath) {
    return normalizedPath
  }
  if (normalizedPath === normalizedSourcePath) {
    return normalizedTargetPath
  }

  const sourceChildPrefix = `${normalizedSourcePath.replace(workspaceEditableExtensionPattern, '')}/`
  if (!normalizedPath.startsWith(sourceChildPrefix)) {
    return normalizedPath
  }

  const targetChildPrefix = `${normalizedTargetPath.replace(workspaceEditableExtensionPattern, '')}/`
  return `${targetChildPrefix}${normalizedPath.slice(sourceChildPrefix.length)}`
}

export function getWorkspaceItemIcon(format?: WorkspaceDocumentFormat): LucideIcon {
  switch (format) {
    case 'data':
      return FileSpreadsheet
    case 'docx':
      return FileType2
    case 'xlsx':
    case 'csv':
      return FileSpreadsheet
    case 'pptx':
      return Presentation
    case 'pdf':
      return FileDown
    case 'image':
      return FileImage
    case 'video':
      return FileVideo2
    case 'audio':
      return Volume2
    default:
      return FileText
  }
}

export const workspaceFolderIconColorClass = 'text-amber-400'

export function getWorkspaceItemIconColorClass(format?: WorkspaceDocumentFormat): string {
  switch (format) {
    case 'markdown':
      return 'text-sky-500'
    case 'docx':
      return 'text-blue-600'
    case 'data':
    case 'table':
    case 'xlsx':
    case 'csv':
      return 'text-emerald-500'
    case 'pptx':
      return 'text-orange-500'
    case 'pdf':
      return 'text-red-500'
    case 'json':
      return 'text-amber-500'
    case 'html':
      return 'text-orange-600'
    case 'image':
      return 'text-violet-500'
    case 'video':
      return 'text-pink-500'
    case 'audio':
      return 'text-indigo-500'
    case 'text':
    case 'binary':
    default:
      return 'text-muted-foreground'
  }
}

export function getWorkspaceItemFormatLabel(format?: WorkspaceDocumentFormat) {
  const labels: Record<WorkspaceDocumentFormat, string> = {
    markdown: 'MD',
    data: 'Table',
    table: 'Table',
    docx: 'Word',
    xlsx: 'Excel',
    pptx: 'PPT',
    pdf: 'PDF',
    csv: 'CSV',
    json: 'JSON',
    text: 'TXT',
    html: 'HTML',
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    binary: 'File',
  }

  return labels[format || 'markdown']
}

export function isMediaWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return format === 'image' || format === 'video'
}

export function isImageWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return format === 'image'
}

export function isVideoWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return format === 'video'
}

export function filterWorkspaceTreeItems(
  items: WorkspaceDocumentTreeItem[],
  predicate: (item: WorkspaceDocumentTreeItem, format: WorkspaceDocumentFormat) => boolean,
): WorkspaceDocumentTreeItem[] {
  const filteredItems: WorkspaceDocumentTreeItem[] = []

  items.forEach((item) => {
    if (item.type === 'file') {
      const format = item.format || inferWorkspaceItemFormat(item.path)
      if (predicate(item, format)) {
        filteredItems.push({ ...item, format })
      }
      return
    }

    const children = filterWorkspaceTreeItems(item.children || [], predicate)
    if (!item.children?.length || children.length) {
      filteredItems.push({ ...item, children })
    }
  })

  return filteredItems
}

export function isEditableWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return format === 'markdown' || format === 'data' || format === 'html'
}

export function isPreviewableWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return format === 'image' || format === 'pdf'
}

export function isSupportedWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return Boolean(format && format !== 'binary')
}
