import DOMPurify from 'dompurify'
import { sanitizeRenderedHtml } from '../markdown/htmlSanitizer'

/** Keep table semantics and content, without source-editor styling or metadata. */
export function sanitizeDocumentTableHtml(html: string): string {
  return DOMPurify.sanitize(sanitizeRenderedHtml(html), {
    ALLOWED_TAGS: [
      'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      'p', 'div', 'span', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike',
      'code', 'pre', 'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'sub', 'sup',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ],
    ALLOWED_ATTR: ['rowspan', 'colspan', 'span', 'scope', 'start', 'href', 'src', 'alt', 'title'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  })
}

/** Only consume complete table blocks, never unrelated HTML or trailing prose. */
export function isDocumentTableHtml(html: string): boolean {
  if (!/^\s*<table(?:\s|>)/i.test(html)) return false
  const document = new DOMParser().parseFromString(html, 'text/html')
  const nodes = Array.from(document.body.childNodes).filter((node) =>
    node.nodeType !== Node.COMMENT_NODE && (node.nodeType !== Node.TEXT_NODE || node.textContent?.trim()),
  )
  return nodes.length > 0 && nodes.every((node) => node.nodeName === 'TABLE')
    && /<\/table>\s*$/i.test(html)
}
