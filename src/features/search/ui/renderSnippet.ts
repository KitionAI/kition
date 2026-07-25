// src/features/search/ui/renderSnippet.ts
const CONTEXT_CHARS = 50

export function renderSnippet(body: string, matches: Array<{ start: number; end: number }>): string {
  if (matches.length === 0) {
    return escapeHtml(body.slice(0, CONTEXT_CHARS * 2))
  }
  const first = matches[0]
  const start = Math.max(0, first.start - CONTEXT_CHARS)
  const end = Math.min(body.length, first.end + CONTEXT_CHARS)
  const slice = body.slice(start, end)
  const relMatchStart = first.start - start
  const relMatchEnd = first.end - start
  return [
    escapeHtml(slice.slice(0, relMatchStart)),
    '<mark>',
    escapeHtml(slice.slice(relMatchStart, relMatchEnd)),
    '</mark>',
    escapeHtml(slice.slice(relMatchEnd)),
  ].join('')
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;'  :
    c === '>' ? '&gt;'  :
    c === '"' ? '&quot;': '&#39;')
}
