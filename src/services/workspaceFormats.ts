/**
 * What kind of file a workspace path is. Kition knows a few kinds of file itself (`HOST_FORMATS`:
 * Markdown, the office and portable formats, images, media, plain text); every other kind is a
 * kit's, named by the kit's name, and comes from the kit catalog (the manifests of this build's
 * kits). No kit's extension is written here.
 */
import { kitByName, kitEditingExtension, kitExtensions, kitViewingExtension, type KitCatalogEntry } from '@/lib/kitCatalog'
import type { HostDocumentFormat, WorkspaceDocumentFormat } from './desktopClient/bridge'

/** Kition's own formats and their extensions; the first extension is the format's usual one. */
const HOST_FORMATS: readonly { format: Exclude<HostDocumentFormat, 'binary'>; extensions: readonly string[]; label: string }[] = [
  { format: 'markdown', extensions: ['md', 'markdown'], label: 'MD' },
  { format: 'docx', extensions: ['docx'], label: 'Doc' },
  { format: 'xlsx', extensions: ['xlsx', 'xls'], label: 'Excel' },
  { format: 'pptx', extensions: ['pptx', 'ppt'], label: 'PPT' },
  { format: 'pdf', extensions: ['pdf'], label: 'PDF' },
  { format: 'csv', extensions: ['csv', 'tsv'], label: 'CSV' },
  { format: 'json', extensions: ['json'], label: 'JSON' },
  { format: 'text', extensions: ['txt'], label: 'TXT' },
  { format: 'html', extensions: ['html', 'htm'], label: 'HTML' },
  { format: 'image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'], label: 'Image' },
  { format: 'video', extensions: ['mp4', 'mov', 'webm'], label: 'Video' },
  { format: 'audio', extensions: ['mp3', 'wav', 'm4a'], label: 'Audio' },
]

const hostFormatByExtension = new Map(HOST_FORMATS.flatMap(({ format, extensions }) => extensions.map((extension) => [extension, format] as const)))
const hostFormats = new Map(HOST_FORMATS.map((each) => [each.format as string, each]))

/** The path's extension, lowercase, without the dot; empty for a name without one or a dotfile. */
function workspacePathExtension(path: string) {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Kition's own format for the path, or the name of the kit that edits (or only views) it, or `binary`. */
export function inferWorkspaceItemFormat(path: string): WorkspaceDocumentFormat {
  const extension = workspacePathExtension(path)
  return hostFormatByExtension.get(extension) ?? kitEditingExtension(extension)?.name ?? kitViewingExtension(extension)?.name ?? 'binary'
}

/**
 * The kit of this build that opens files of `format`: the kit the format is named after, or the
 * kit that edits the format's usual extension (Markdown's `md`). With `views`, also a kit that
 * only views that extension.
 */
export function kitForWorkspaceFormat(format: WorkspaceDocumentFormat | undefined, { views = false }: { views?: boolean } = {}): KitCatalogEntry | undefined {
  if (!format) return undefined
  const extension = hostFormats.get(format)?.extensions[0]
  return kitByName(format) ?? (extension ? kitEditingExtension(extension) ?? (views ? kitViewingExtension(extension) : undefined) : undefined)
}

/** A short name of the format: Kition's own, or the kit's name. */
export function workspaceFormatLabel(format: WorkspaceDocumentFormat | undefined) {
  if (format === 'binary') return 'File'
  const known = hostFormats.get(format ?? 'markdown')
  return known?.label ?? kitByName(format ?? '')?.title ?? 'File'
}

/** Every extension Kition or a kit of this build knows, lowercase, without the dot. */
export function knownWorkspaceExtensions(): string[] {
  return [...new Set([...hostFormatByExtension.keys(), ...kitExtensions()])]
}

/**
 * The kit of this build that owns the path: its extension is no format of Kition's own, and the
 * kit edits it (or only views it). A Word document has none: Kition knows `docx` itself.
 */
export function kitOwningWorkspacePath(path: string): KitCatalogEntry | undefined {
  const extension = workspacePathExtension(path)
  return hostFormatByExtension.has(extension) ? undefined : kitEditingExtension(extension) ?? kitViewingExtension(extension)
}

/** The extensions of Kition's own `formats`, lowercase, without the dot. */
export function hostFormatExtensions(formats: Iterable<WorkspaceDocumentFormat>): string[] {
  return [...formats].flatMap((format) => hostFormats.get(format)?.extensions ?? [])
}
