import {
  canImportWorkspaceImageFromClipboard,
  importWorkspaceImageFromBlobURL,
  importWorkspaceImageFromClipboard,
  importWorkspaceImageFromFile,
} from '@/services/desktop'

const ATTACHMENT_FOLDER = 'Attachments'
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
  const parsed = new DOMParser().parseFromString(html, 'text/html')
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
  return !data.getData('text/plain').trim() && !data.getData('text/html').trim()
}

function escapeMarkdownAlt(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/]/g, '\\]')
}

function externalImageMarkdown(image: Extract<DocumentClipboardImage, { kind: 'source' }>) {
  const safeSource = image.source.replace(/>/g, '%3E')
  return `![${escapeMarkdownAlt(image.alt)}](<${safeSource}>)`
}

function importedImageMarkdown(importedPath: string, relativePath: string) {
  const normalizedImported = importedPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const normalizedRelative = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const path = normalizedImported
    || (normalizedRelative
      ? (normalizedRelative.startsWith(`${ATTACHMENT_FOLDER}/`)
        ? normalizedRelative
        : `${ATTACHMENT_FOLDER}/${normalizedRelative}`)
      : '')
  return path ? `![[${path}]]` : ''
}

export async function importDocumentClipboardImages(
  images: DocumentClipboardImage[],
  options: { preferNativeClipboard?: boolean } = {},
) {
  const limitedImages = images.slice(0, MAX_PASTED_IMAGES)
  if (options.preferNativeClipboard && limitedImages.length <= 1) {
    try {
      const imported = await importWorkspaceImageFromClipboard({
        folder: ATTACHMENT_FOLDER,
        index: 1,
      })
      if (imported) {
        const snippet = importedImageMarkdown(imported.importedPath, imported.relativePath)
        if (snippet) return [snippet]
      }
    } catch (error) {
      console.warn('document native clipboard image import failed', error)
    }
  }

  const snippets: string[] = []
  let index = 1
  for (const image of limitedImages) {
    try {
      const imported = image.kind === 'file'
        ? await importWorkspaceImageFromFile({
            file: image.file,
            folder: ATTACHMENT_FOLDER,
            index: index++,
          })
        : await importWorkspaceImageFromBlobURL({
            folder: ATTACHMENT_FOLDER,
            blobURL: image.source,
            index: index++,
          })
      const snippet = importedImageMarkdown(imported.importedPath, imported.relativePath)
      if (snippet) snippets.push(snippet)
    } catch (error) {
      if (image.kind === 'source') {
        snippets.push(externalImageMarkdown(image))
      } else {
        console.warn('document image paste import failed', error)
      }
    }
  }
  return snippets
}
