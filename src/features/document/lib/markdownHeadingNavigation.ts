import { markdownLanguage } from '@codemirror/lang-markdown'
import { marked, type Token } from 'marked'

function inlineText(tokens: Token[]): string {
  return tokens.map((token) => {
    if ('tokens' in token && token.tokens) return inlineText(token.tokens)
    if (token.type === 'html') return ''
    return 'text' in token ? token.text : token.raw
  }).join('')
}

function headingSlug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, '').replace(/\s/g, '-')
}

/** Resolve against the full Markdown document, including headings outside the viewport. */
export function findMarkdownHeadingOffset(source: string, section: string): number | null {
  const target = section.replace(/^#/, '').toLowerCase()
  if (!target) return 0
  const headings: Array<{ from: number; text: string; slug: string }> = []
  const used = new Set<string>()
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (!/^(?:ATX|Setext)Heading[1-6]$/.test(node.name)) return
      const raw = source.slice(node.from, node.to)
        .replace(/^ {0,3}#{1,6}\s+/, '')
        .replace(/\s+#+\s*$/, '')
        .replace(/\n[ \t]*[=-]+[ \t]*$/, '')
        .trim()
      const text = inlineText(marked.Lexer.lexInline(raw)).trim()
      const base = headingSlug(text)
      let slug = base
      for (let suffix = 1; used.has(slug); suffix += 1) slug = `${base}-${suffix}`
      used.add(slug)
      headings.push({ from: node.from, text, slug })
      return false
    },
  })
  const exact = headings.find((heading) => heading.slug === target)
    ?? headings.find((heading) => heading.text.toLowerCase() === target)
  if (exact) return exact.from

  // Imported outlines may put a separator after a section number even when
  // the heading has no space there (especially with CJK headings).
  return headings.find((heading) => headingSlug(
    heading.text.replace(/^(\d+(?:\.\d+)*)[.)]?\s*(?=\p{L})/u, '$1 '),
  ) === target)?.from ?? null
}
