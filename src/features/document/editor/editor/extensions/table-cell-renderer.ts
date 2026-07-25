import type { EditorView } from '@codemirror/view'
import { marked } from 'marked'

import '@/services/markdownRenderer'

import { parseWikilinks, type WikilinkParsed } from '../../lib/wikilink-parser'
import { wikilinkResolverFacet, wikilinkRuntimeFacet } from './wikilink'

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE_MAP[character] ?? character)
}

function displayText(link: WikilinkParsed): string {
  if (link.display) return link.display
  if (link.heading) return `${link.target} › ${link.heading}`
  if (link.blockId) return `${link.target} › ^${link.blockId}`
  return link.target
}

function renderWikilinkHtml(link: WikilinkParsed): string {
  const section = link.heading
    ? `#${link.heading}`
    : link.blockId
      ? `#^${link.blockId}`
      : ''
  const display = displayText(link)
  return [
    '<span class="cm-hmd-internal-link table-cell-wikilink"',
    ' role="link" tabindex="0" contenteditable="false"',
    ` data-target="${escapeHtml(link.target)}"`,
    ` data-section="${escapeHtml(section)}"`,
    ` data-alias="${escapeHtml(link.display ?? '')}">`,
    `<span class="cm-underline">${escapeHtml(display)}</span>`,
    '</span>',
  ].join('')
}

export function renderCellHtml(text: string): string {
  if (!text) return ''
  try {
    const links = parseWikilinks(text).filter((link) => !link.embed && link.target)
    let markdown = text
    for (let index = links.length - 1; index >= 0; index--) {
      const link = links[index]
      markdown = markdown.slice(0, link.from) + renderWikilinkHtml(link) + markdown.slice(link.to)
    }
    return marked.parseInline(markdown) as string
  } catch {
    return escapeHtml(text)
  }
}

function parsedLinkFromElement(element: HTMLElement): WikilinkParsed | null {
  const target = element.dataset.target?.trim() ?? ''
  if (!target) return null
  const section = element.dataset.section ?? ''
  const display = element.dataset.alias || undefined
  const heading = section.startsWith('#') && !section.startsWith('#^')
    ? section.slice(1)
    : undefined
  const blockId = section.startsWith('#^') ? section.slice(2) : undefined
  return {
    raw: `[[${target}${section}${display ? `|${display}` : ''}]]`,
    embed: false,
    target,
    heading,
    blockId,
    display,
    from: 0,
    to: 0,
  }
}

export function activateTableCellWikilink(
  target: EventTarget | null,
  event: MouseEvent | KeyboardEvent,
  view: EditorView,
): boolean {
  const element = target instanceof HTMLElement
    ? target.closest<HTMLElement>('.table-cell-wikilink')
    : null
  if (!element) return false
  if (event instanceof MouseEvent && event.button !== 0 && event.button !== 1) return false

  const link = parsedLinkFromElement(element)
  if (!link) return false

  const runtime = view.state.facet(wikilinkRuntimeFacet)
  const resolve = runtime.resolve ?? view.state.facet(wikilinkResolverFacet)
  const resolved = resolve(link.target, runtime.sourcePath)
  const action = resolved ? runtime.onNavigate : runtime.onCreateMissing
  if (!action) return false

  event.preventDefault()
  event.stopPropagation()
  if (resolved) {
    const mouseEvent = event instanceof MouseEvent ? event : null
    runtime.onNavigate?.(link, {
      newPane: Boolean(
        mouseEvent
        && (mouseEvent.button === 1 || (mouseEvent.shiftKey && (mouseEvent.metaKey || mouseEvent.ctrlKey))),
      ),
      sourcePath: runtime.sourcePath,
    })
  } else {
    runtime.onCreateMissing?.(link.target, runtime.sourcePath)
  }
  return true
}
