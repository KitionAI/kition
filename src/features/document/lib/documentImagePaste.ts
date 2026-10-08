import {
  canImportWorkspaceImageFromClipboard,
  importWorkspaceImageFromBlobURL,
  importWorkspaceImageFromClipboard,
  importWorkspaceImageFromFile,
} from '@/services/desktop'
import { clipboardHtmlFragment } from './documentClipboard'
import { documentAttachmentFolder } from './documentAttachments'

const MAX_PASTED_IMAGES = 8

export type DocumentClipboardImage =
  | { kind: 'file'; file: File; alt: string }
  | { kind: 'source'; source: string; alt: string }

function isImageFile(file: File) {
  return file.type.startsWith('image/') || /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(file.name)
}

export function documentClipboardImagesFromFiles(
  files: ArrayLike<File> | null | undefined,
): DocumentClipboardImage[] {
  if (!files) return []
  const images: DocumentClipboardImage[] = []
  for (let index = 0; index < files.length && images.length < MAX_PASTED_IMAGES; index += 1) {
    const file = files[index]
    if (!file || !isImageFile(file)) continue
    images.push({
      kind: 'file',
      file,
      alt: file.name.replace(/\.[^.]+$/, '') || 'image',
    })
  }
  return images
}

function normalizeClipboardImageSource(rawSource: string) {
  const source = rawSource.trim()
  if (!source) return ''
  if (source.startsWith('//')) return `https:${source}`
  if (/^data:image\//i.test(source)) return source
  try {
    const url = new URL(source)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function firstSrcsetSource(srcset: string) {
  return srcset.split(',')[0]?.trim().split(/\s+/)[0] || ''
}

export function extractImageOnlyClipboardHTML(html: string): DocumentClipboardImage[] {
  if (!html.trim() || typeof DOMParser === 'undefined') return []
  const parsed = new DOMParser().parseFromString(clipboardHtmlFragment(html), 'text/html')
  const imageElements = Array.from(parsed.querySelectorAll('img'))
  if (!imageElements.length) return []

  const contentWithoutImages = parsed.body.cloneNode(true) as HTMLElement
  contentWithoutImages
    .querySelectorAll('img, picture, source, script, style, noscript, meta, link')
    .forEach((element) => element.remove())
  if ((contentWithoutImages.textContent || '').replace(/\s+/g, '').trim()) {
    return []
  }

  const seen = new Set<string>()
  const images: DocumentClipboardImage[] = []
  for (const image of imageElements) {
    const source = normalizeClipboardImageSource(
      image.getAttribute('src')
        || image.getAttribute('data-src')
        || firstSrcsetSource(image.getAttribute('srcset') || ''),
    )
    if (!source || seen.has(source)) continue
    seen.add(source)
    images.push({
      kind: 'source',
      source,
      alt: image.getAttribute('alt')?.trim() || 'image',
    })
    if (images.length >= MAX_PASTED_IMAGES) break
  }
  return images
}

export function collectDocumentClipboardImages(data: DataTransfer | null | undefined) {
  if (!data) return []
  if (data.getData('text/markdown')) return []
  const html = data.getData('text/html') || ''
  if (html.trim()) {
    const parsed = new DOMParser().parseFromString(clipboardHtmlFragment(html), 'text/html')
    parsed.querySelectorAll('script, style, noscript').forEach((element) => element.remove())
    // A bitmap can be an alternative representation of an entire rich selection.
    if (parsed.body.textContent?.trim()) return []
  }
  const files: File[] = []
  Array.from(data.items || []).forEach((item) => {
    if (item.kind !== 'file') return
    const file = item.getAsFile()
    if (file && isImageFile(file)) files.push(file)
  })
  if (!files.length) {
    Array.from(data.files || []).forEach((file) => files.push(file))
  }
  const fileImages = documentClipboardImagesFromFiles(files)
  if (fileImages.length) return fileImages
  return extractImageOnlyClipboardHTML(data.getData('text/html') || '')
}

export function canPasteNativeDocumentClipboardImage(data: DataTransfer | null | undefined) {
  if (!canImportWorkspaceImageFromClipboard()) return false
  if (!data) return true
  return !data.getData('text/plain').trim() && !data.getData('text/html').trim() && !data.getData('text/markdown').trim()
}

function escapeMarkdownAlt(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/]/g, '\\]')
}

function splitWorkspacePath(path: string) {
  return String(path || '').replace(/\\/g, '/').split('/').filter((part) => part && part !== '.')
}

/**
 * Path from the folder that contains `documentPath` to `targetPath`, both
 * workspace-relative. This is what standard Markdown viewers resolve, so a
 * link written this way renders in Kition and in any other editor that opens
 * the same folder. A document at the root gets the target path unchanged.
 */
export function relativeMarkdownPath(documentPath: string, targetPath: string) {
  const folder = splitWorkspacePath(documentPath).slice(0, -1)
  const target = splitWorkspacePath(targetPath)
  let common = 0
  while (common < folder.length && common < target.length && folder[common] === target[common]) common += 1
  const up = folder.slice(common).map(() => '..')
  return [...up, ...target.slice(common)].join('/')
}

/** Markdown destination: wrapped in angle brackets when it contains characters that would end the link early. */
function markdownDestination(path: string) {
  const escaped = path.replace(/[%#?<>"]/g, (character) => encodeURIComponent(character))
  return /[\s()]/.test(escaped) ? `<${escaped}>` : escaped
}

function importedImageMarkdown(
  importedPath: string,
  relativePath: string,
  alt: string,
  documentPath: string,
) {
  const attachmentFolder = documentAttachmentFolder(documentPath)
  const normalizedImported = importedPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const normalizedRelative = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const workspacePath = normalizedImported
    || (normalizedRelative
      ? (normalizedRelative.startsWith('attachments/')
        ? normalizedRelative
        : `${attachmentFolder}/${normalizedRelative}`)
      : '')
  if (!workspacePath) return ''
  const destination = markdownDestination(relativeMarkdownPath(documentPath, workspacePath))
  return `![${escapeMarkdownAlt(alt)}](${destination})`
}

export type ImportDocumentClipboardImagesOptions = {
  preferNativeClipboard?: boolean
  startIndex?: number
  /** Workspace-relative path of the document being edited; links are written relative to its folder. */
  documentPath?: string
}

export async function importDocumentClipboardImages(
  images: DocumentClipboardImage[],
  options: ImportDocumentClipboardImagesOptions = {},
) {
  const documentPath = options.documentPath ?? ''
  const folder = documentAttachmentFolder(documentPath)
  const limitedImages = images.slice(0, MAX_PASTED_IMAGES)
  if (options.preferNativeClipboard && limitedImages.length <= 1) {
    try {
      const imported = await importWorkspaceImageFromClipboard({
        folder,
        index: options.startIndex ?? 1,
      })
      if (imported) {
        const alt = limitedImages[0]?.alt || 'image'
        const snippet = importedImageMarkdown(imported.importedPath, imported.relativePath, alt, documentPath)
        if (snippet) return [snippet]
      }
    } catch {
      console.warn('document native clipboard image import failed')
    }
  }

  if (options.preferNativeClipboard && !limitedImages.length) {
    throw new Error('no clipboard image could be saved locally')
  }
  const snippets: string[] = []
  let index = options.startIndex ?? 1
  for (const image of limitedImages) {
    try {
      const imported = image.kind === 'file'
        ? await importWorkspaceImageFromFile({
            file: image.file,
            folder,
            index: index++,
          })
        : await importWorkspaceImageFromBlobURL({
            folder,
            blobURL: image.source,
            index: index++,
          })
      const snippet = importedImageMarkdown(imported.importedPath, imported.relativePath, image.alt, documentPath)
      if (!snippet) throw new Error('image import returned no local path')
      snippets.push(snippet)
    } catch (cause) {
      throw new Error('image could not be saved to workspace attachments', { cause })
    }
  }
  return snippets
}
