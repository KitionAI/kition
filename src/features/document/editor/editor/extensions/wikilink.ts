   
                                                     
  
                                                                                 
  
                                                                     
                                              
                                                                    
                                                             
                             
  
                                                      
   

import { Facet, RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'

import { parseWikilinks, type WikilinkParsed } from '../../lib/wikilink-parser'

export type WikilinkResolver = (target: string, sourcePath?: string) => boolean
export type WikilinkNavigate = (
  link: WikilinkParsed,
  opts?: { newPane?: boolean; sourcePath?: string },
) => void
export type WikilinkCreate = (target: string, sourcePath?: string) => void

export type WikilinkExtensionOptions = {
  sourcePath?: string
  resolve?: WikilinkResolver
  onNavigate?: WikilinkNavigate
  onCreateMissing?: WikilinkCreate
}

export const wikilinkRuntimeFacet = Facet.define<WikilinkExtensionOptions, WikilinkExtensionOptions>({
  combine: (values) => values[0] ?? {},
})

export const wikilinkResolverFacet = Facet.define<WikilinkResolver, WikilinkResolver>({
  combine: (vals) => vals[0] ?? (() => true),
})

                                                                        
function displayText(link: WikilinkParsed): string {
  if (link.display) return link.display
  if (link.heading) return `${link.target} › ${link.heading}`
  if (link.blockId) return `${link.target} › ^${link.blockId}`
  return link.target
}

class WikilinkChipWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly section: string,
    readonly display: string,
    readonly unresolved: boolean,
  ) {
    super()
  }

  eq(o: WikilinkChipWidget): boolean {
    return (
      o.target === this.target &&
      o.section === this.section &&
      o.display === this.display &&
      o.unresolved === this.unresolved
    )
  }

  toDOM(): HTMLElement {
    const root = document.createElement('span')
    root.className = 'cm-hmd-internal-link'
    if (this.unresolved) root.classList.add('is-unresolved')
    root.setAttribute('role', 'link')
    root.setAttribute('tabindex', '0')
    root.setAttribute('data-target', this.target)
    root.setAttribute('data-section', this.section)
    root.setAttribute('data-href', this.target + (this.section ?? ''))
    root.setAttribute('data-display', this.display)
    const inner = document.createElement('span')
    inner.className = 'cm-underline'
    inner.textContent = this.display
    root.appendChild(inner)
    return root
  }

  ignoreEvent(): boolean {
    return false
  }
}

const bracketMark = Decoration.mark({ class: 'cm-formatting-link' })
const innerMark = Decoration.mark({ class: 'cm-hmd-internal-link' })

const HEADING_LINE_RE = /^\s*#{1,6}\s/
const TABLE_LINE_RE = /^\s*\|/
const FENCE_RE = /^\s*```/

function isSimpleSourceLineType(lineText: string, inFence: boolean): 'heading' | 'table' | 'fence' | null {
  if (inFence) return 'fence'
  if (HEADING_LINE_RE.test(lineText)) return 'heading'
  if (TABLE_LINE_RE.test(lineText)) return 'table'
  return null
}

export function wikilinkExtension(options: WikilinkExtensionOptions = {}): Extension {
  const { sourcePath, resolve, onNavigate, onCreateMissing } = options
  const localResolve = resolve

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }
      update(update: ViewUpdate) {
        const resolverChanged =
          update.startState.facet(wikilinkResolverFacet) !== update.state.facet(wikilinkResolverFacet)
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          resolverChanged
        ) {
          this.decorations = this.build(update.view)
        }
      }
      build(view: EditorView): DecorationSet {
        const facetResolve = view.state.facet(wikilinkResolverFacet)
        const resolveFn: WikilinkResolver = localResolve ?? facetResolve
        const items: { from: number; to: number; deco: Decoration }[] = []
        const cursorHead = view.state.selection.main.head

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to)
          const links = parseWikilinks(text)
          if (links.length === 0) continue
          let inFence = false
          const fenceByLine = new Map<number, boolean>()
          {
            const lines = text.split('\n')
            let lineStart = from
            for (const line of lines) {
              fenceByLine.set(lineStart, inFence)
              if (FENCE_RE.test(line)) inFence = !inFence
              lineStart += line.length + 1
            }
          }
          for (const link of links) {
            if (link.embed) continue
            const absFrom = from + link.from
            const absTo = from + link.to
            const lineObj = view.state.doc.lineAt(absFrom)
            const lineFenceState = fenceByLine.get(lineObj.from) ?? false
            const lineType = isSimpleSourceLineType(lineObj.text, lineFenceState)
            const cursorInside = cursorHead > absFrom && cursorHead < absTo

            if (cursorInside || lineType) {
              items.push({ from: absFrom, to: absFrom + 2, deco: bracketMark })
              items.push({ from: absFrom + 2, to: absTo - 2, deco: innerMark })
              items.push({ from: absTo - 2, to: absTo, deco: bracketMark })
              continue
            }

            const unresolved = !resolveFn(link.target, sourcePath)
            const section = link.heading
              ? `#${link.heading}`
              : link.blockId
                ? `#^${link.blockId}`
                : ''
            items.push({
              from: absFrom,
              to: absTo,
              deco: Decoration.replace({
                widget: new WikilinkChipWidget(link.target, section, displayText(link), unresolved),
              }),
            })
          }
        }
        items.sort((a, b) => a.from - b.from || a.to - b.to)
        const builder = new RangeSetBuilder<Decoration>()
        for (const it of items) builder.add(it.from, it.to, it.deco)
        return builder.finish()
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  )

  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null
      const widget = target?.closest('.cm-hmd-internal-link') as HTMLElement | null
      if (widget) {
        event.preventDefault()
        const t = widget.getAttribute('data-target') ?? ''
        const section = widget.getAttribute('data-section') ?? ''
        const display = widget.getAttribute('data-display') ?? undefined
        const unresolved = widget.classList.contains('is-unresolved')
        const newPane = event.button === 1 || (event.shiftKey && (event.metaKey || event.ctrlKey))
        if (unresolved) {
          onCreateMissing?.(t, sourcePath)
        } else {
          onNavigate?.(
            buildParsedLink(t, section, display),
            { newPane, sourcePath },
          )
        }
        return true
      }
      if (!(event.metaKey || event.ctrlKey)) return false
      const pos = view.posAtDOM(target as Node)
      if (pos == null) return false
      const line = view.state.doc.lineAt(pos)
      const local = pos - line.from
      const hit = parseWikilinks(line.text).find((l) => local >= l.from && local <= l.to && !l.embed)
      if (!hit) return false
      event.preventDefault()
      const facetResolve = view.state.facet(wikilinkResolverFacet)
      const resolveFn = localResolve ?? facetResolve
      if (!resolveFn(hit.target, sourcePath)) {
        onCreateMissing?.(hit.target, sourcePath)
      } else {
        onNavigate?.(hit, { sourcePath })
      }
      return true
    },
    keydown(event, view) {
      if (event.key !== 'Enter' && event.key !== ' ') return false
      const widget = (event.target as HTMLElement | null)?.closest(
        '.cm-hmd-internal-link',
      ) as HTMLElement | null
      if (!widget) return false
      event.preventDefault()
      const t = widget.getAttribute('data-target') ?? ''
      const section = widget.getAttribute('data-section') ?? ''
      const display = widget.getAttribute('data-display') ?? undefined
      const unresolved = widget.classList.contains('is-unresolved')
      if (unresolved) {
        onCreateMissing?.(t, sourcePath)
      } else {
        onNavigate?.(buildParsedLink(t, section, display), { sourcePath })
      }
      return true
    },
  })

  return [
    wikilinkRuntimeFacet.of({ sourcePath, resolve, onNavigate, onCreateMissing }),
    plugin,
    clickHandler,
    wikilinkBaseTheme,
  ]
}

function buildParsedLink(target: string, section: string, display?: string): WikilinkParsed {
  const heading = section.startsWith('#') && !section.startsWith('#^') ? section.slice(1) : undefined
  const blockId = section.startsWith('#^') ? section.slice(2) : undefined
  return {
    raw: `[[${target}${section}${display ? '|' + display : ''}]]`,
    embed: false,
    target,
    heading,
    blockId,
    display,
    from: 0,
    to: 0,
  }
}

const wikilinkBaseTheme = EditorView.theme({
  '.cm-hmd-internal-link': {
    color: 'hsl(var(--primary, 215 85% 55%))',
    cursor: 'pointer',
    fontWeight: '500',
  },
  '.cm-hmd-internal-link .cm-underline': {
    textDecoration: 'underline',
    textDecorationColor: 'hsl(var(--primary, 215 85% 55%) / 0.5)',
    textUnderlineOffset: '2px',
  },
  '.cm-hmd-internal-link:hover .cm-underline': {
    textDecorationColor: 'currentColor',
  },
  '.cm-hmd-internal-link.is-unresolved': {
    color: 'hsl(var(--destructive, 0 70% 55%))',
    opacity: '0.75',
  },
  '.cm-hmd-internal-link.is-unresolved .cm-underline': {
    textDecorationStyle: 'dashed',
  },
  '.cm-formatting-link': {
    color: 'hsl(var(--muted-foreground, 215 15% 55%))',
    opacity: '0.6',
  },
})
