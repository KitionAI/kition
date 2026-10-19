import TurndownService from 'turndown'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

import { sanitizeRenderedHtml } from '../markdown/htmlSanitizer'
import { normalizeClipboardHtmlStructure } from './clipboardHtmlStructure'
import { sanitizeDocumentTableHtml } from './documentTableHtml'
import { clipboardHtmlFragment } from './clipboardHtmlFragment'

export type DocumentClipboardDecision = {
  format: 'markdown' | 'html' | 'text' | 'empty'
  markdown: string
}

export { clipboardHtmlFragment }

export function parseClipboardHtml(html: string) {
  const document = new DOMParser().parseFromString(
    sanitizeRenderedHtml(clipboardHtmlFragment(html)), 'text/html',
  )
  normalizeClipboardHtmlStructure(document.body)
  // Normalization may promote a data attribute to a URL attribute.
  document.body.innerHTML = sanitizeRenderedHtml(document.body.innerHTML)
  return document
}

export function clipboardHtmlToMarkdown(html: string, importedImages: ReadonlyMap<string, string> = new Map()) {
  const document = parseClipboardHtml(html)
  const converter = new TurndownService({
    headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced',
  })
  converter.addRule('importedImage', {
    filter: (node) => node.tagName === 'IMG' && importedImages.has(node.getAttribute('src') || ''),
    replacement: (_content, node) => importedImages.get(node.getAttribute('src') || '')!,
  })
  converter.addRule('strikethrough', {
    filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
    replacement: (content) => `~~${content}~~`,
  })
  converter.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = node as HTMLTableElement
      // Merged cells and nested tables cannot be represented faithfully in GFM.
      if (table.querySelector('[rowspan]:not([rowspan="1"]), [colspan]:not([colspan="1"]), table')) {
        const preserved = table.cloneNode(true) as HTMLTableElement
        for (const image of preserved.querySelectorAll('img')) {
          const markdown = importedImages.get(image.getAttribute('src') || '')
          if (!markdown) continue
          const replacement = new DOMParser().parseFromString(
            sanitizeDocumentTableHtml(marked.parseInline(markdown) as string), 'text/html',
          ).querySelector('img')
          if (replacement) image.replaceWith(replacement)
        }
        return `\n\n${sanitizeDocumentTableHtml(preserved.outerHTML)}\n\n`
      }
      const rows = Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) =>
        converter.turndown(cell.innerHTML).replace(/\|/g, '\\|').replace(/\n/g, '<br>'),
      ))
      const width = Math.max(0, ...rows.map((row) => row.length))
      if (!width) return ''
      const renderRow = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`
      const hasHeader = Array.from(table.rows[0].cells).every((cell) => cell.tagName === 'TH')
        || table.rows[0].parentElement?.tagName === 'THEAD'
      const header = hasHeader ? rows.shift()! : []
      return `\n\n${[renderRow(header), renderRow(Array(width).fill('---')), ...rows.map(renderRow)].join('\n')}\n\n`
    },
  })
  return converter.turndown(document.body)
}

/** A structural preview must not fetch resources or navigate to pasted links. */
export function clipboardHtmlPreview(html: string) {
  return DOMPurify.sanitize(sanitizeRenderedHtml(html), {
    FORBID_ATTR: ['src', 'srcset', 'href', 'style', 'background', 'poster'],
  })
}

/** Explicit Markdown is authoritative; plain text is the lossless fallback. */
export function resolveDocumentClipboard(data: Pick<DataTransfer, 'getData'> | null): DocumentClipboardDecision {
  if (!data) return { format: 'empty', markdown: '' }
  const markdown = data.getData('text/markdown')
  if (markdown) return { format: 'markdown', markdown }
  const html = data.getData('text/html')
  const text = data.getData('text/plain')
  if (html.trim()) {
    try {
      // Code editors and chat apps also put literal Markdown in styled HTML.
      // Only prefer the plain source if the HTML contains that same literal text.
      // Rendered rich headings/lists do not include their Markdown delimiters.
      if (/^ {0,3}(?:#{1,6}\s+\S|`{3,}|~{3,})/m.test(text)) {
        const body = new DOMParser().parseFromString(
          sanitizeRenderedHtml(clipboardHtmlFragment(html)), 'text/html',
        ).body
        const compact = (value: string) => value.replace(/\s/g, '')
        const code = body.querySelector('pre, code')
        const fencedSource = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/m.test(text)
        const markdownCode = code?.matches('.language-markdown, .language-md')
          || code?.querySelector('.language-markdown, .language-md')
        if ((!code || fencedSource || markdownCode) && compact(body.textContent || '') === compact(text)) {
          return { format: 'markdown', markdown: text }
        }
      }
      const converted = clipboardHtmlToMarkdown(html)
      if (converted.trim()) return { format: 'html', markdown: converted }
    } catch {
      // An unsupported HTML payload must never swallow its plain-text fallback.
    }
  }
  return { format: text ? 'text' : 'empty', markdown: text }
}

export function inspectDocumentClipboard(data: DataTransfer) {
  return {
    capturedAt: new Date().toISOString(),
    types: Array.from(data.types),
    payloads: Object.fromEntries(Array.from(data.types)
      .filter((type) => type !== 'Files').map((type) => [type, data.getData(type)])),
    items: Array.from(data.items).map((item) => ({ kind: item.kind, type: item.type })),
    files: Array.from(data.files).map((file) => ({ name: file.name, type: file.type, size: file.size })),
    documentConversion: resolveDocumentClipboard(data),
  }
}
