import type { ApiTimestamp } from '@/types'
import { toEpochMs } from '@/lib/timestamps'
import { FileImageIcon as FileImage, FileTextIcon as FileText, FileVideoCameraIcon as FileVideo2, Volume2Icon as Volume2 } from '@kition/tessera/icons/react'
import type { ComponentType } from 'react'
import { kitIconComponent, type KitIconId } from '@/components/KitIcon'
import { getCurrentLocale } from '@/i18n'
import type {
  WorkspaceDocumentFormat,
  WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import { kitEditingExtension } from '@/lib/kitCatalog'
import { inferWorkspaceItemFormat, kitForWorkspaceFormat, knownWorkspaceExtensions, workspaceFormatLabel } from '@/services/workspaceFormats'

export { inferWorkspaceItemFormat }

export type WorkspaceMediaKind = 'images' | 'videos'

export type WorkspaceTab =
  | {
      id: string
      type: 'file-viewer'
      title: string
      path: string
      format: WorkspaceDocumentFormat
    }
  | { id: string; type: 'gallery'; title: string; kind: WorkspaceMediaKind }

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

/** Drops a workspace file's extension from its name: any extension Kition or a kit of this build knows. */
export function getWorkspaceItemTitle(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 && knownWorkspaceExtensions().includes(name.slice(dot + 1).toLowerCase()) ? name.slice(0, dot) : name
}

export function renameWorkspaceDocumentPath(path: string, title: string) {
  const normalizedPath = String(path || '').replace(/\\/g, '/').trim()
  const trimmedTitle = String(title || '').trim()
  if (!normalizedPath) {
    return normalizedPath
  }

  // The file keeps its own extension (any file's, not only a note's), unless the new name has it.
  const filename = normalizedPath.split('/').pop() || normalizedPath
  const extension = filename.match(/.(\.[^./]+)$/)?.[1] || ''
  // An empty name falls back to the name the file's kit gives a new document (`kit.json` `creates[].baseName`).
  const created = extension.slice(1).toLowerCase()
  const fallbackTitle = kitEditingExtension(created)?.creates.find((create) => create.extension === created)?.baseName ?? 'Untitled'
  const nextTitle = trimmedTitle || getWorkspaceItemTitle(filename) || fallbackTitle
  const nextFilename = extension && nextTitle.toLowerCase().endsWith(extension.toLowerCase()) ? nextTitle : `${nextTitle}${extension}`
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

  // A file's child pages are the folder named as the file without its extension (`workspaceTree`).
  const sourceChildPrefix = `${getWorkspaceItemTitle(normalizedSourcePath)}/`
  if (!normalizedPath.startsWith(sourceChildPrefix)) {
    return normalizedPath
  }

  const targetChildPrefix = `${getWorkspaceItemTitle(normalizedTargetPath)}/`
  return `${targetChildPrefix}${normalizedPath.slice(sourceChildPrefix.length)}`
}

export type WorkspaceItemIcon = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>

/** The kit that owns a format; plain files (images, media, text) have none. */
export function getWorkspaceItemKitIcon(format?: WorkspaceDocumentFormat): KitIconId | null {
  return kitForWorkspaceFormat(format, { views: true })?.name ?? null
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
  return workspaceFormatLabel(format)
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
  return format === 'markdown'
}

/**
 * Formats the tree can duplicate as a new document. A kit file (a board among them) is not one: a copy of its bytes
 * would keep the original's KDM document id.
 */
export function isDuplicableWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return isEditableWorkspaceFormat(format)
}

/**
 * Formats that open in a Kition tab rather than the system app. Office files a kit edits (Doc,
 * PowerPoint, Excel) open in the kit's editor, or the file preview when the kit's engine is not built in.
 */
export function isPreviewableWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return format === 'html' || format === 'markdown' || format === 'image' || format === 'pdf' || format === 'pptx' || format === 'docx' || format === 'xlsx' || format === 'video' || Boolean(kitForWorkspaceFormat(format))
}

export function isSupportedWorkspaceFormat(format?: WorkspaceDocumentFormat) {
  return Boolean(format && format !== 'binary')
}
