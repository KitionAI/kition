import { inlineMermaidBlocksInHtml } from '@/services/mermaid'
import { markdownToHtml } from '@/services/markdownRenderer'
import { copyDocumentHtmlToClipboard, isDesktopRuntime } from '@/services/desktop'
import { resolveWorkspaceImageURL } from '@/services/workspaceFiles'

export type DocumentPublishingClipboardContent = {
  html: string
  text: string
}

export async function buildDocumentPublishingClipboardContent(
  markdown: string,
  documentPath: string,
): Promise<DocumentPublishingClipboardContent> {
  const renderedHtml = resolveDocumentImageSources(markdownToHtml(markdown), documentPath)
  const bodyHtml = await inlineMermaidBlocksInHtml(renderedHtml)
  return {
    html: `<article>${bodyHtml}</article>`,
    text: markdown,
  }
}

export async function copyDocumentMarkdownForPublishing(
  markdown: string,
  documentPath: string,
) {
  const content = await buildDocumentPublishingClipboardContent(markdown, documentPath)
  const html = isDesktopRuntime()
    ? content.html
    : await inlineBrowserClipboardImages(content.html)
  return copyDocumentHtmlToClipboard({
    html,
    text: content.text,
    documentPath,
  })
}

export async function inlineBrowserClipboardImages(html: string): Promise<string> {
  const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html')
  const images = Array.from(parsed.body.querySelectorAll('img'))
  const sourceDataURLs = new Map<string, string>()
  const sources = Array.from(new Set(images
    .map((image) => image.getAttribute('src')?.trim() || '')
    .filter((source) => source && !/^data:image\//i.test(source))))

  await Promise.all(sources.map(async (source) => {
    const response = await fetch(source)
    if (!response.ok) {
      throw new Error(`failed to load clipboard image: ${response.status}`)
    }
    const blob = await response.blob()
    if (!/^image\//i.test(blob.type)) {
      throw new Error('clipboard image response is not an image')
    }
    sourceDataURLs.set(source, await blobToDataURL(blob))
  }))

  images.forEach((image) => {
    const source = image.getAttribute('src')?.trim() || ''
    const dataURL = sourceDataURLs.get(source)
    if (dataURL) {
      image.setAttribute('src', dataURL)
    }
  })

  return parsed.body.innerHTML
}

function resolveDocumentImageSources(html: string, documentPath: string) {
  const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html')
  parsed.body.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src') || ''
    const resolved = resolveWorkspaceImageURL(source, documentPath)
    if (resolved) {
      image.setAttribute('src', resolved)
    }
    image.removeAttribute('loading')
    image.removeAttribute('decoding')
    image.removeAttribute('fetchpriority')
  })
  return parsed.body.innerHTML
}

function blobToDataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result || '')), { once: true })
    reader.addEventListener('error', () => reject(reader.error || new Error('failed to encode clipboard image')), { once: true })
    reader.readAsDataURL(blob)
  })
}
