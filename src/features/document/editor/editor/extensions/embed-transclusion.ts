   
                                                  
  
                                                               
                                                          
                                                  
  
                                   
                                    
                                                            
                                
                                                 
   

import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view'
import i18next from 'i18next'

import { markdownToHtml } from '@/services/markdownRenderer'

import { parseWikilinks } from '../../lib/wikilink-parser'

import { attachClickToSource, attachResizeMeasure, detachResizeMeasure } from './_click-to-source'
import { sanitizeEmbed } from './_embed-sanitize'
import { sliceForEmbed } from './_embed-slice'

export type EmbedLoadResult = { content: string; path: string }
export type EmbedLoader = (target: string, sourcePath?: string) => Promise<EmbedLoadResult | null>

export type EmbedExtensionOptions = {
  sourcePath?: string
  load: EmbedLoader
  enabled?: boolean
                                                                          
  onNavigate?: (target: string, section?: string) => void
}

type EmbedEntry =
  | { state: 'loading' }
  | { state: 'ready'; content: string; path: string }
  | { state: 'error'; message: string }
  | { state: 'missing' }

const MEDIA_RE = /\.(png|jpe?g|gif|svg|webp|mp4|mp3|wav|pdf)$/i

const EXTERNAL_LINK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v7H3V3h7"/></svg>'

function titleText(link: {
  target: string
  heading?: string
  blockId?: string
  display?: string
}): string {
  if (link.display) return link.display
  if (link.heading) return link.heading
  if (link.blockId) return `^${link.blockId}`
  return link.target
}

class EmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly heading: string | undefined,
    readonly blockId: string | undefined,
    readonly display: string | undefined,
    readonly entry: EmbedEntry,
    readonly onNavigate?: (target: string, section?: string) => void,
    readonly block: boolean = false,
    readonly srcFrom: number = 0,
  ) {
    super()
  }

  eq(o: EmbedWidget): boolean {
    if (o.target !== this.target) return false
    if (o.heading !== this.heading) return false
    if (o.blockId !== this.blockId) return false
    if (o.display !== this.display) return false
    if (o.block !== this.block) return false
    if (o.srcFrom !== this.srcFrom) return false
    if (o.entry.state !== this.entry.state) return false
    if (o.entry.state === 'ready' && this.entry.state === 'ready') {
      return o.entry.content === this.entry.content && o.entry.path === this.entry.path
    }
    if (o.entry.state === 'error' && this.entry.state === 'error') {
      return o.entry.message === this.entry.message
    }
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div')
    root.className = 'markdown-embed inline-embed'
    root.setAttribute('data-target', this.target)
    const section = this.heading
      ? `#${this.heading}`
      : this.blockId
        ? `#^${this.blockId}`
        : ''
    root.setAttribute('data-section', section)

    const title = document.createElement('div')
    title.className = 'markdown-embed-title'
    title.textContent = titleText({
      target: this.target,
      heading: this.heading,
      blockId: this.blockId,
      display: this.display,
    })
    root.appendChild(title)

    const body = this.renderBody()
    root.appendChild(body)

    const openIcon = document.createElement('a')
    openIcon.className = 'markdown-embed-link'
    openIcon.setAttribute('role', 'button')
    openIcon.setAttribute('aria-label', i18next.getFixedT(null, 'document')('editor.extensions.embed.openLink'))
    openIcon.setAttribute('tabindex', '0')
    openIcon.innerHTML = EXTERNAL_LINK_SVG
    openIcon.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.onNavigate?.(this.target, section || undefined)
    })
    root.appendChild(openIcon)

    attachResizeMeasure(root, view)
    if (this.block) attachClickToSource(body, view, this.srcFrom)
    root.classList.add('is-loaded')
    return root
  }

  destroy(dom: HTMLElement): void {
    detachResizeMeasure(dom)
  }

  get estimatedHeight(): number {
    return this.block ? 220 : -1
  }

  ignoreEvent(event: Event): boolean {
    return !(event instanceof MouseEvent)
  }

  private renderBody(): HTMLElement {
    const t = i18next.getFixedT(null, 'document')
    const div = document.createElement('div')
    div.className = 'markdown-embed-content'
    switch (this.entry.state) {
      case 'loading':
        div.classList.add('markdown-embed-content--muted')
        div.textContent = t('editor.extensions.embed.loading')
        return div
      case 'missing':
        div.classList.add('markdown-embed-content--error')
        div.textContent = t('editor.extensions.embed.notFound')
        return div
      case 'error':
        div.classList.add('markdown-embed-content--error')
        div.textContent = t('editor.extensions.embed.loadFailed', { message: this.entry.message })
        return div
      case 'ready': {
        const slice = sliceForEmbed(this.entry.content, this.heading, this.blockId)
        if (!slice) {
          div.classList.add('markdown-embed-content--error')
          div.textContent = this.heading
            ? t('editor.extensions.embed.headingNotFound', { heading: this.heading })
            : this.blockId
              ? t('editor.extensions.embed.blockNotFound', { blockId: this.blockId })
              : t('editor.extensions.embed.emptyDoc')
          return div
        }
        try {
          div.innerHTML = markdownToHtml(slice)
        } catch {
          div.textContent = slice
        }
        sanitizeEmbed(div)
        return div
      }
    }
  }
}

export function embedTransclusionExtension(options: EmbedExtensionOptions): Extension {
  const { sourcePath, load, enabled = true, onNavigate } = options
  if (!enabled) return []

  const cache = new Map<string, EmbedEntry>()
  let viewRef: EditorView | null = null

  function triggerRebuild() {
    if (!viewRef) return
    queueMicrotask(() => {
      try {
        viewRef?.dispatch({ selection: viewRef.state.selection })
      } catch {
        /* view destroyed */
      }
    })
  }

  function ensureLoaded(target: string) {
    if (cache.has(target)) return
    cache.set(target, { state: 'loading' })
    load(target, sourcePath)
      .then((result) => {
        if (!result) cache.set(target, { state: 'missing' })
        else cache.set(target, { state: 'ready', content: result.content, path: result.path })
        triggerRebuild()
      })
      .catch((err: unknown) => {
        cache.set(target, {
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
        triggerRebuild()
      })
  }

  function build(state: EditorState): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>()
    const cursorHead = state.selection.main.head
    const pending: { from: number; to: number; deco: Decoration }[] = []
    const text = state.doc.sliceString(0)
    const links = parseWikilinks(text)
    for (const link of links) {
      if (!link.embed) continue
      if (MEDIA_RE.test(link.target)) continue
      const absFrom = link.from
      const absTo = link.to
      // Skip if cursor is inside the embed range (allow editing source)
      if (cursorHead > absFrom && cursorHead < absTo) continue
      ensureLoaded(link.target)
      const entry = cache.get(link.target) ?? ({ state: 'loading' } as const)
      const line = state.doc.lineAt(absFrom)
      const before = line.text.slice(0, absFrom - line.from)
      const after = line.text.slice(absTo - line.from)
      const standalone = !before.trim() && !after.trim()
      if (standalone) {
        pending.push({
          from: line.from,
          to: line.to,
          deco: Decoration.replace({
            widget: new EmbedWidget(
              link.target,
              link.heading,
              link.blockId,
              link.display,
              entry,
              onNavigate,
              true,
              line.from,
            ),
            block: true,
          }),
        })
      } else {
        pending.push({
          from: absFrom,
          to: absTo,
          deco: Decoration.replace({
            widget: new EmbedWidget(
              link.target,
              link.heading,
              link.blockId,
              link.display,
              entry,
              onNavigate,
              false,
              absFrom,
            ),
            block: false,
          }),
        })
      }
    }
    pending.sort((a, b) => a.from - b.from || a.to - b.to)
    for (const p of pending) builder.add(p.from, p.to, p.deco)
    return builder.finish()
  }

  const field = StateField.define<DecorationSet>({
    create(state) {
      return build(state)
    },
    update(value, tr) {
      if (!tr.docChanged && !tr.selection) return value
      return build(tr.state)
    },
    provide: (f) => EditorView.decorations.from(f),
  })

  const viewRefPlugin = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        viewRef = view
      }
      destroy() {
        viewRef = null
      }
    },
  )

  return [field, viewRefPlugin, embedTheme]
}

const embedTheme = EditorView.theme({
  '.markdown-embed': {
    position: 'relative',
    margin: '0.5rem 0',
    paddingInlineStart: '0.75rem',
    borderInlineStart: '2px solid hsl(var(--primary, 215 85% 55%) / 0.45)',
    background: 'hsl(var(--muted, 215 15% 95%) / 0.25)',
    borderRadius: '4px',
    fontStyle: 'normal',
  },
  '.markdown-embed.inline-embed': {
    display: 'block',
    width: '100%',
  },
  '.markdown-embed-title': {
    padding: '0.5rem 0.75rem 0',
    fontSize: '0.85em',
    fontWeight: '600',
    color: 'hsl(var(--muted-foreground, 215 15% 45%))',
  },
  '.markdown-embed-content': {
    padding: '0.25rem 0.75rem 0.6rem',
    maxHeight: '22em',
    overflow: 'auto',
    lineHeight: '1.6',
  },
  '.markdown-embed-content h1, .markdown-embed-content h2, .markdown-embed-content h3': {
    margin: '0.4em 0 0.2em',
    fontSize: '1.05em',
  },
  '.markdown-embed-content p': { margin: '0.4em 0' },
  '.markdown-embed-content--muted': { color: 'hsl(var(--muted-foreground))' },
  '.markdown-embed-content--error': { color: 'hsl(var(--destructive, 0 70% 55%))' },
  '.markdown-embed-link': {
    position: 'absolute',
    top: '4px',
    insetInlineEnd: '4px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4px',
    borderRadius: '4px',
    color: 'hsl(var(--muted-foreground, 215 15% 55%))',
    cursor: 'pointer',
    opacity: '0.6',
    textDecoration: 'none',
  },
  '.markdown-embed-link:hover': {
    opacity: '1',
    background: 'hsl(var(--accent, 215 85% 55%) / 0.1)',
  },
})
