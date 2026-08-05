import { inlineMermaidBlocksInHtml } from '@/services/mermaid'
import { markdownToHtml } from '@/services/markdownRenderer'
import { copyDocumentHtmlToClipboard, isDesktopRuntime } from '@/services/desktop'
import { resolveWorkspaceImageURL } from '@/services/workspaceFiles'

export type DocumentPublishingClipboardContent = {
  html: string
  text: string
}

const publishingElementStyles: ReadonlyArray<readonly [string, string]> = [
  ['h1', 'margin: 0 0 0.7em; font-size: 2em; line-height: 1.25; font-weight: 700;'],
  ['h2', 'margin: 1.4em 0 0.55em; font-size: 1.5em; line-height: 1.25; font-weight: 700;'],
  ['h3', 'margin: 1.35em 0 0.5em; font-size: 1.25em; line-height: 1.3; font-weight: 700;'],
  ['h4, h5, h6', 'margin: 1.25em 0 0.45em; line-height: 1.35; font-weight: 700;'],
  ['p', 'margin: 0 0 1em;'],
  ['ul, ol', 'margin: 0 0 1em; padding-left: 1.6em;'],
  ['li', 'margin: 0.25em 0;'],
  ['blockquote', 'margin: 0 0 1em; padding-left: 1em; border-left: 4px solid #e5e3df; color: #5d5b54;'],
  ['pre', 'margin: 0 0 1em; padding: 1em; white-space: pre-wrap; background: #f6f5f4; border-radius: 8px;'],
  ['table', 'width: 100%; margin: 0 0 1em; border-collapse: collapse;'],
  ['th, td', 'padding: 0.5em 0.65em; border: 1px solid #e5e3df; text-align: left; vertical-align: top;'],
  ['hr', 'margin: 1.5em 0; border: 0; border-top: 1px solid #e5e3df;'],
  ['img', 'max-width: 100%; height: auto;'],
]

export function buildDocumentPublishingClipboardHtml(
  markdown: string,
  documentPath: string,
): string {
  const renderedHtml = resolveDocumentImageSources(markdownToHtml(markdown), documentPath)
  const parsed = new DOMParser().parseFromString(`<article>${renderedHtml}</article>`, 'text/html')
  const article = parsed.body.querySelector('article')
  if (!article) {
    return `<article>${renderedHtml}</article>`
  }

  article.setAttribute('style', 'line-height: 1.7;')
  publishingElementStyles.forEach(([selector, style]) => {
    article.querySelectorAll(selector).forEach((element) => {
      element.setAttribute('style', style)
    })
  })
  return article.outerHTML
}

export async function buildDocumentPublishingClipboardContent(
  markdown: string,
  documentPath: string,
): Promise<DocumentPublishingClipboardContent> {
  const html = buildDocumentPublishingClipboardHtml(markdown, documentPath)
  return {
    html: await inlineMermaidBlocksInHtml(html),
    text: markdown,
  }
}

export async function copyDocumentMarkdownForPublishing(
  markdown: string,
  documentPath: string,
  initialHtml?: string,
) {
  const content = initialHtml
    ? { html: await inlineMermaidBlocksInHtml(initialHtml), text: markdown }
    : await buildDocumentPublishingClipboardContent(markdown, documentPath)
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
