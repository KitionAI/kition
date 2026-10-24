import type { ApiTimestamp } from '@/types'
import { toEpochMs } from '@/lib/timestamps'
import { FileImage, FileText, FileVideo2, Volume2 } from 'lucide-react'
import type { ComponentType } from 'react'
import { kitIconComponent, type KitIconId } from '@/components/KitIcon'
import { getCurrentLocale } from '@/i18n'
import type {
  WorkspaceDocumentFormat,
  WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import { kitCreateExtensions } from '@/features/workspace/components/kits/kitFormats'

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
  | { id: string; type: 'gallery'; title: string; kind: WorkspaceMediaKind }
  | { id: string; type: 'design'; title: string; path: string }
  | {
      id: string
      type: 'workflow'
      title: string
      /** Optional: open the home view scoped to one table file's tables (e.g.
       *  "Leads.ktable"). When undefined the tab shows the global list. */
      tablePath?: string
      /** Optional: pre-select a specific workflow id when the tab mounts. */
      workflowId?: string
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

/**
 * Formats Kition's own editors (and `inferWorkspaceItemFormat` below) already know, with no kit
 * registry entry: aliases a kit's preview understands but never creates (`pptx`, `xls`, `ppt`,
 * `psb`, `kphoto`), and the native `.kidesign`/Markdown/media formats.
 */
const workspaceNonKitExtensions = [
  'md', 'markdown', 'kidesign',
  'pptx', 'xls', 'ppt', 'psb', 'kphoto',
  'csv', 'tsv', 'json', 'txt', 'html', 'htm',
  'png', 'jpe?g', 'gif', 'webp', 'svg',
  'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a',
]

/**
 * Drops a workspace file's extension from its tab title: every format the app knows, kit-owned
 * (from the kit registry's create extensions, `kitEditors.ts`, so a kit's own extension never
 * drifts out of date here) or not (`workspaceNonKitExtensions`).
 */
const workspaceTitleExtensionPattern = new RegExp(
  `\\.(${[...new Set([...workspaceNonKitExtensions, ...kitCreateExtensions()])].join('|')})$`,
  'i',
)
const workspaceEditableExtensionPattern = /\.(md|markdown|kboard|kidesign)$/i

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(getCurrentLocale()).format(value)
}

export function formatWorkspaceTime(value?: ApiTimestamp | null) {
  return value ? formatRelativeDateTime(value) : 'just now'
}

function formatRelativeDateTime(value?: ApiTimestamp | null) {
  if (!value) {
    return 'just now'
  }

  const target = new Date(toEpochMs(value))
  if (Number.isNaN(target.getTime())) {
    return String(value)
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
  if (path.toLowerCase().endsWith('.ktable')) return 'table'
  if (path.toLowerCase().endsWith('.kboard')) return 'board'
  if (path.toLowerCase().endsWith('.kidesign')) return 'design'
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
  if (/\.(psd|psb|kphoto)$/i.test(path)) {
    return 'photo'
  }
  if (/\.kitionfilm$/i.test(path)) {
    return 'film'
  }
  if (/\.kvector$/i.test(path)) {
    return 'vector'
  }
  if (/\.keffect$/i.test(path)) {
    return 'effect'
  }
  if (/\.kdesign$/i.test(path)) {
    return 'layout'
  }
  if (/\.dxf$/i.test(path)) {
    return 'cad'
  }
  if (/\.kitionslide$/i.test(path)) {
    return 'slide'
  }
  if (/\.(mp4|mov|webm)$/i.test(path)) {
    return 'video'
  }
  if (/\.(mp3|wav|m4a)$/i.test(path)) {
    return 'audio'
  }
  if (/\.(md|markdown)$/i.test(path)) {
    return 'markdown'
  }
  // Like the desktop shell (src-tauri/src/workspace/formats.rs): a file of no known kind is no note.
  return 'binary'
}

export function getWorkspaceItemTitle(name: string) {
  return name.replace(workspaceTitleExtensionPattern, '')
}

export function renameWorkspaceDocumentPath(path: string, title: string) {
  const normalizedPath = String(path || '').replace(/\\/g, '/').trim()
  const trimmedTitle = String(title || '').trim()
  if (!normalizedPath) {
    return normalizedPath
  }

  const filename = normalizedPath.split('/').pop() || normalizedPath
  const extension = filename.match(workspaceEditableExtensionPattern)?.[0] || ''
  const fallbackTitle = extension.toLowerCase() === '.kboard' ? 'Untitled board' : 'Untitled note'
  const nextFilename = `${trimmedTitle || getWorkspaceItemTitle(filename) || fallbackTitle}${extension}`
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

export type WorkspaceItemIcon = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>

/** The kit that owns a format; plain files (images, media, text) have none. */
export function getWorkspaceItemKitIcon(format?: WorkspaceDocumentFormat): KitIconId | null {
  switch (format) {
    case 'markdown':
      return 'document'
    case 'table':
      return 'table'
    case 'docx':
      return 'word'
    case 'xlsx':
    case 'csv':
      return 'sheet'
    case 'pptx':
    case 'slide':
      return 'slide'
    case 'pdf':
    case 'design':
    case 'layout':
    case 'board':
    case 'photo':
    case 'film':
    case 'vector':
    case 'effect':
    case 'cad':
      return format
    default:
      return null
  }
}

/** The kit whose color and icon a tab shows; plain files, galleries, and workflows have none. */
export function getWorkspaceTabKit(tab: WorkspaceTab): KitIconId | null {
  switch (tab.type) {
    case 'gallery':
      return null
    case 'file-viewer':
      return getWorkspaceItemKitIcon(tab.format)
    case 'workflow':
      return tab.tablePath ? 'table' : null
    case 'design':
      return tab.type
    default:
      return 'document'
  }
}

export function getWorkspaceItemIcon(format?: WorkspaceDocumentFormat): WorkspaceItemIcon {
  const kit = getWorkspaceItemKitIcon(format)
  if (kit) {
    return kitIconComponent(kit, { small: true })
  }
  switch (format) {
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
    case 'photo':
    case 'film':
    case 'vector':
    case 'effect':
    case 'layout':
    case 'cad':
      return 'text-violet-500'
    case 'slide':
      return 'text-orange-500'
    case 'design':
    case 'board':
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
    photo: 'Photo',
    film: 'Film',
    vector: 'Vector',
    effect: 'Effect',
    layout: 'Design',
    cad: 'CAD',
    slide: 'Slide',
    video: 'Video',
    audio: 'Audio',
    binary: 'File',
    board: 'Board',
    design: 'Design',
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
  return format === 'markdown' || format === 'html'
}

/** Formats Kition's native document tab opens (HTML's preview); every other format opens in a file tab, a kit's or a preview. */
export function opensInDocumentTab(format?: WorkspaceDocumentFormat): boolean {
  return format === 'html'
}

export function isOrganizableWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return isEditableWorkspaceFormat(format) || format === 'board' || format === 'design'
}

/**
 * Formats the tree can duplicate as a new document. A kit file (a board among them) is not one: a copy of its bytes
 * would keep the original's KDM document id.
 */
export function isDuplicableWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return isEditableWorkspaceFormat(format) || format === 'design'
}

/**
 * Formats that open in a Kition tab rather than the system app. Office files a kit edits (Word,
 * PowerPoint, Excel) open in the kit's editor, or the file preview when the kit's engine is not built in.
 */
export function isPreviewableWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return format === 'markdown' || format === 'image' || format === 'pdf' || format === 'photo' || format === 'film' || format === 'vector' || format === 'effect' || format === 'layout' || format === 'cad' || format === 'slide' || format === 'pptx' || format === 'docx' || format === 'xlsx' || format === 'table' || format === 'board' || format === 'video'
}

export function isSupportedWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return Boolean(format && format !== 'binary')
}
