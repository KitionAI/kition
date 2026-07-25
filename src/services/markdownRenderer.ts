/**
 * Markdown rendering service
 *
 * Converts Markdown to HTML.
 */
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { marked, Renderer } from 'marked'
import { buildMermaidPlaceholderHtml } from '@/services/mermaid'

// Configure marked
marked.setOptions({
  gfm: true,        // GitHub Flavored Markdown
  breaks: true,     // newline becomes <br>
})

const mermaidRenderer = new Renderer()
const defaultCodeRenderer = mermaidRenderer.code.bind(mermaidRenderer)
mermaidRenderer.code = function code(code, infostring, escaped) {
  const lang = (infostring || '').trim().split(/\s+/)[0]
  if (lang === 'mermaid') {
    return buildMermaidPlaceholderHtml(code)
  }
  return defaultCodeRenderer(code, infostring, escaped)
}
marked.use({ renderer: mermaidRenderer })

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: 'html',
    })
    return displayMode ? `<div class="kition-math-block">${html}</div>` : html
  } catch (err) {
    const tag = displayMode ? 'div' : 'span'
    const msg = (err as Error)?.message ?? 'KaTeX error'
    return `<${tag} class="kition-math-error">${msg}</${tag}>`
  }
}

                                                                      
const blockMath = {
  name: 'blockMath',
  level: 'block' as const,
  start(src: string): number | undefined {
    const idx = src.indexOf('$$')
    return idx === -1 ? undefined : idx
  },
  tokenizer(src: string) {
    const match = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src)
    if (!match) return undefined
    const text = match[1].trim()
    if (!text) return undefined
    return { type: 'blockMath', raw: match[0], text }
  },
  renderer(token: { text: string }): string {
    return renderKatex(token.text, true)
  },
}

                                                                  
                                                     
const inlineMath = {
  name: 'inlineMath',
  level: 'inline' as const,
  start(src: string): number | undefined {
    const idx = src.indexOf('$')
    return idx === -1 ? undefined : idx
  },
  tokenizer(src: string) {
    if (!src.startsWith('$') || src.startsWith('$$')) return undefined
    const afterOpen = src[1]
    if (!afterOpen || /\s/.test(afterOpen)) return undefined
    let i = 1
    while (i < src.length) {
      const ch = src[i]
      if (ch === '\n') return undefined
      if (ch === '$' && src[i - 1] !== '\\') {
        if (src[i + 1] === '$') {
          i += 2
          continue
        }
        const before = src[i - 1] ?? ''
        if (/\s/.test(before)) {
          i += 1
          continue
        }
        const raw = src.slice(0, i + 1)
        const text = src.slice(1, i)
        if (!text.trim()) return undefined
        return { type: 'inlineMath', raw, text }
      }
      i += 1
    }
    return undefined
  },
  renderer(token: { text: string }): string {
    return renderKatex(token.text, false)
  },
}

marked.use({ extensions: [blockMath, inlineMath] })

/**
 * Adds async loading attributes to images so long docs don't block first paint.
 */
export function applyAsyncImageAttributes(html: string): string {
  if (!html) return ''

  return html.replace(/<img\b([^>]*)>/gi, (_match, attrs = '') => {
    const rawAttrs = String(attrs)
    const selfClosing = /\/\s*$/.test(rawAttrs)
    const trimmedAttrs = rawAttrs.replace(/\/\s*$/, '').trim()
    const nextAttrs = [trimmedAttrs]

    if (!/(^|\s)loading\s*=/i.test(trimmedAttrs)) {
      nextAttrs.push('loading="lazy"')
    }
    if (!/(^|\s)decoding\s*=/i.test(trimmedAttrs)) {
      nextAttrs.push('decoding="async"')
    }
    if (!/(^|\s)fetchpriority\s*=/i.test(trimmedAttrs)) {
      nextAttrs.push('fetchpriority="low"')
    }

    return `<img ${nextAttrs.filter(Boolean).join(' ')}${selfClosing ? ' /' : ''}>`
  })
}

function stripEmptyParagraphs(html: string): string {
  if (!html) return ''

  return html.replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '')
}

/**
 * Convert Markdown to HTML
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown) return ''
  return stripEmptyParagraphs(applyAsyncImageAttributes(marked.parse(markdown) as string))
}

const workspacePathExtensionPattern = /\.(?:md|markdown|kitable|txt|html|htm|json|csv|tsv|docx|xlsx|xls|pptx|ppt|pdf|png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|m4a)$/i

function isLikelyWorkspacePath(value: string) {
  const normalized = String(value || '').trim().replace(/\\/g, '/')
  if (!normalized) return false
  if (normalized.includes('://')) return false
  if (normalized.startsWith('/')) return false
  if (/^[a-z]:\//i.test(normalized)) return false
  if (!workspacePathExtensionPattern.test(normalized)) return false
  return !/[<>"']/.test(normalized)
}

function escapeHtmlAttribute(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function linkifyWorkspacePathsInHtml(html: string): string {
  if (!html) return ''

  return html.replace(/<code>([^<]+)<\/code>/gi, (match, rawValue = '') => {
    const value = String(rawValue || '').trim()
    if (!isLikelyWorkspacePath(value)) {
      return match
    }
    const escapedPath = escapeHtmlAttribute(value.replace(/\\/g, '/'))
    return `<button type="button" class="agent-inline-path" data-open-path="${escapedPath}"><code>${rawValue}</code></button>`
  })
}

export function markdownToInteractiveHtml(markdown: string): string {
  return linkifyWorkspacePathsInHtml(markdownToHtml(markdown))
}
