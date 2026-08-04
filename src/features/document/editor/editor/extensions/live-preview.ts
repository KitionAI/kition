   
                  
  
                                 
                                                                    
                                                    
                                           
                                                  
                                
                                             
                                                                                                 
                                                
                              
  
                                                             
                               
                                            
                                                 
                                           
                                                 
                                        
                                                   
                                               
                            
                             
                                       
                   
                                                                
   

import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { Facet, RangeSet, StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view'
import i18next from 'i18next'

import { renderMermaid } from '@/services/mermaid'
import { renderMath } from '@/services/math'
import { isWorkspaceImagePath, resolveWorkspaceImageURL } from '@/services/workspaceFiles'
import { parseWikilinks } from '../../lib/wikilink-parser'

const livePreviewSourcePathFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? '',
})

const livePreviewRevealSourceFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? true,
})

import {
  buildSelectionContext,
  editorFocusEffect,
  editorFocusField,
  rangeIsActive,
  shouldHideLineMarker,
} from './_format-marker'
import {
  attachClickToSource,
  attachResizeMeasure,
  detachResizeMeasure,
} from './_click-to-source'
import { TableWidget, parseTableFromNode } from './table-widget'

const CALLOUT_TYPES = new Set([
  'note', 'info', 'tip', 'hint', 'important',
  'success', 'check', 'done',
  'question', 'help', 'faq',
  'warning', 'caution', 'attention',
  'failure', 'fail', 'missing',
  'danger', 'error',
  'bug',
  'example',
  'quote', 'cite',
  'abstract', 'summary', 'tldr',
  'todo',
])

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number, readonly to: number) {
    super()
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-task-checkbox'
    wrap.setAttribute('aria-hidden', 'true')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = this.checked
    cb.tabIndex = -1
    cb.addEventListener('mousedown', (e) => e.stopPropagation())
    cb.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const cur = view.state.doc.sliceString(this.from, this.to)
      const next = /\[[xX]\]/.test(cur) ? '[ ]' : '[x]'
      view.dispatch({ changes: { from: this.from, to: this.to, insert: next } })
    })
    wrap.appendChild(cb)
    return wrap
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.from === this.from && other.to === this.to
  }
  ignoreEvent() {
    return false
  }
}

class BulletWidget extends WidgetType {
  toDOM() {
    const dot = document.createElement('span')
    dot.className = 'cm-md-bullet'
    dot.textContent = '•'
    return dot
  }
  eq() {
    return true
  }
  ignoreEvent() {
    return true
  }
}

class HRWidget extends WidgetType {
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-hr'
    wrap.setAttribute('aria-hidden', 'true')
    const line = document.createElement('span')
    line.className = 'cm-md-hr-line'
    wrap.appendChild(line)
    return wrap
  }
  eq() {
    return true
  }
  ignoreEvent() {
    return true
  }
}

                                                 
                                                   
                                                  
const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

                                                           
                         
function decodeHtmlEntity(raw: string): string | null {
  const m = /^&(?:#(\d+)|#[xX]([a-fA-F\d]+)|([A-Za-z][A-Za-z\d]*));$/.exec(raw)
  if (!m) return null
  if (m[1] !== undefined) {
    const code = Number(m[1])
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null
    return String.fromCodePoint(code)
  }
  if (m[2] !== undefined) {
    const code = parseInt(m[2], 16)
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null
    return String.fromCodePoint(code)
  }
  return NAMED_HTML_ENTITIES[m[3]!.toLowerCase()] ?? null
}

class HtmlEntityWidget extends WidgetType {
  constructor(private readonly decoded: string) {
    super()
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-md-entity'
    span.textContent = this.decoded
    return span
  }
  eq(other: HtmlEntityWidget) {
    return other.decoded === this.decoded
  }
  ignoreEvent() {
    return true
  }
}

                                                                                                   
                                                                                     
const EXTERNAL_LINK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="11" height="11" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="3"><path d="M14 9 L3 9 3 29 23 29 23 18 M18 4 L28 4 28 14 M28 4 L14 18"/></svg>'

class ExternalLinkIconWidget extends WidgetType {
  constructor(readonly url: string) {
    super()
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-link-external-icon'
    span.setAttribute('data-href', this.url)
    span.setAttribute('aria-label', 'external link')
    span.innerHTML = EXTERNAL_LINK_SVG
    return span
  }
  eq(other: ExternalLinkIconWidget): boolean {
    return other instanceof ExternalLinkIconWidget && other.url === this.url
  }
  ignoreEvent(): boolean {
    return false
  }
}

type RevealedImageSource = { from: number; to: number } | null

const revealImageSourceEffect = StateEffect.define<RevealedImageSource>()

const revealedImageSourceField = StateField.define<RevealedImageSource>({
  create: () => null,
  update(value, tr) {
    let next = value
    if (next && tr.docChanged) {
      next = {
        from: tr.changes.mapPos(next.from, 1),
        to: tr.changes.mapPos(next.to, -1),
      }
    }
    for (const effect of tr.effects) {
      if (effect.is(revealImageSourceEffect)) next = effect.value
    }
    if (next && tr.selection) {
      const head = tr.state.selection.main.head
      if (head < next.from || head > next.to) next = null
    }
    return next
  },
})

const IMAGE_SOURCE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'

// CM6 uses this height while standalone image widgets are outside the rendered
// viewport. Keep the loading placeholder in sync so rapid scrolling does not
// replace a one-line estimate with a several-hundred-pixel image all at once.
const BLOCK_IMAGE_ESTIMATED_HEIGHT = 320

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly sourcePath: string,
    readonly sourceFrom: number,
    readonly sourceTo: number,
    readonly block: boolean,
    readonly sourceVisible: boolean,
  ) {
    super()
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement(this.block ? 'div' : 'span')
    wrap.className = 'cm-md-image'
    if (this.block) wrap.classList.add('cm-md-image-block', 'is-loading')
    if (this.sourceVisible) wrap.classList.add('is-source-visible')
    const img = document.createElement('img')
    img.alt = this.alt
    // CM6 only creates widget DOM near the viewport, so eager loading here does
    // not fetch every image in the document.
    img.loading = 'eager'
    img.decoding = 'async'
    img.draggable = false
    img.addEventListener('mousedown', (e) => e.preventDefault())
    const finishLoading = () => {
      wrap.classList.remove('is-loading')
      view.requestMeasure()
    }
    img.addEventListener('load', finishLoading, { once: true })
    img.addEventListener('error', finishLoading, { once: true })
    img.src = resolveWorkspaceImageURL(this.url, this.sourcePath) || this.url
    wrap.appendChild(img)

    const sourceToggle = document.createElement('button')
    sourceToggle.type = 'button'
    sourceToggle.className = 'cm-md-image-source-toggle'
    sourceToggle.innerHTML = IMAGE_SOURCE_ICON_SVG
    sourceToggle.title = this.sourceVisible ? 'Hide image source' : 'Show image source'
    sourceToggle.setAttribute('aria-label', sourceToggle.title)
    sourceToggle.setAttribute('aria-pressed', String(this.sourceVisible))
    sourceToggle.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    sourceToggle.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const nextVisible = !this.sourceVisible
      view.dispatch({
        effects: revealImageSourceEffect.of(
          nextVisible ? { from: this.sourceFrom, to: this.sourceTo } : null,
        ),
        selection: {
          anchor: nextVisible
            ? Math.min(this.sourceTo, this.sourceFrom + 3)
            : this.sourceTo,
        },
      })
      view.focus()
    })
    wrap.appendChild(sourceToggle)
                                                    
                                                               
                                          
    attachResizeMeasure(wrap, view)
    return wrap
  }
  eq(other: ImageWidget) {
    return other.url === this.url
      && other.alt === this.alt
      && other.sourcePath === this.sourcePath
      && other.sourceFrom === this.sourceFrom
      && other.sourceTo === this.sourceTo
      && other.block === this.block
      && other.sourceVisible === this.sourceVisible
  }
  get estimatedHeight(): number {
    return this.block ? BLOCK_IMAGE_ESTIMATED_HEIGHT : -1
  }
  destroy(dom: HTMLElement): void {
    detachResizeMeasure(dom)
  }
  ignoreEvent() {
    return false
  }
}

                                                            
                             
const CALLOUT_ICON_ALIAS: Record<string, string> = {
  hint: 'tip', important: 'tip',
  check: 'success', done: 'success',
  help: 'question', faq: 'question',
  caution: 'warning', attention: 'warning',
  fail: 'failure', missing: 'failure',
  error: 'danger',
  cite: 'quote',
  summary: 'abstract', tldr: 'abstract',
}
const CALLOUT_ICON_PATHS: Record<string, string> = {
  note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  tip: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  success: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  question: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  failure: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  danger: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  bug: '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  example: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
  quote: '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>',
  abstract: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  todo: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
}
function calloutIconPaths(type: string): string {
  const key = CALLOUT_ICON_ALIAS[type] ?? type
  return CALLOUT_ICON_PATHS[key] ?? CALLOUT_ICON_PATHS.note
}

class CalloutTitleWidget extends WidgetType {
  constructor(readonly type: string, readonly hasTitle: boolean) {
    super()
  }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-callout-icon'
    wrap.setAttribute('aria-hidden', 'true')
    wrap.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${calloutIconPaths(this.type)}</svg>`
                                                   
    if (!this.hasTitle) {
      const label = document.createElement('span')
      label.className = 'cm-md-callout-title-text'
      label.textContent = this.type.charAt(0).toUpperCase() + this.type.slice(1)
      wrap.appendChild(label)
    }
    return wrap
  }
  eq(other: CalloutTitleWidget) {
    return other.type === this.type && other.hasTitle === this.hasTitle
  }
  ignoreEvent() {
    return true
  }
}

const COPY_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const CHECK_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
const CODE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'

   
                                                                
                                                                      
   
function editFenceLangAtWidget(view: EditorView, dom: HTMLElement, currentLang: string) {
  const t = i18next.getFixedT(null, 'document')
  const next = window.prompt(t('editor.extensions.codeblock.editLangPrompt'), currentLang)
  if (next === null) return
  const cleaned = next.trim().replace(/[`\s]/g, '')
  const state = view.state
  const pos = view.posAtDOM(dom)
  if (pos < 0 || pos > state.doc.length) return
  const line = state.doc.lineAt(pos)
  const match = line.text.match(/^(\s*)(`{3,}|~{3,})(.*)$/)
  if (!match) return
  const [, indent, fence] = match
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: `${indent}${fence}${cleaned}` },
  })
}

class CodeCopyWidget extends WidgetType {
  constructor(readonly lang: string) {
    super()
  }
  eq(other: CodeCopyWidget) {
                                                         
                                                                      
                                                                     
                                                       
                                                         
    return other.lang === this.lang
  }
  toDOM(view: EditorView) {
    const t = i18next.getFixedT(null, 'document')
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-codeblock-actions'
                                                
    const tag = document.createElement('span')
    tag.className = 'cm-md-codeblock-lang'
    tag.textContent = this.lang || t('editor.extensions.codeblock.plainText')
    tag.title = t('editor.extensions.codeblock.editLangTitle')
    tag.setAttribute('role', 'button')
    tag.addEventListener('mousedown', (e) => e.preventDefault())
    tag.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      editFenceLangAtWidget(view, wrap, this.lang)
    })
    wrap.appendChild(tag)
                                   
    const btn = document.createElement('button')
    btn.className = 'cm-md-codeblock-copy'
    btn.type = 'button'
    btn.innerHTML = COPY_ICON_SVG
    btn.title = t('editor.extensions.livePreview.copyCode')
    btn.setAttribute('aria-label', t('editor.extensions.livePreview.copyCode'))
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const code = readCodeAtWidget(view, wrap)
      if (code == null) return
      const restore = () => {
        btn.innerHTML = COPY_ICON_SVG
        btn.classList.remove('is-copied')
      }
      const succeed = () => {
        btn.innerHTML = CHECK_ICON_SVG
        btn.classList.add('is-copied')
        window.setTimeout(restore, 1200)
      }
      const fail = () => {
        btn.classList.add('is-failed')
        window.setTimeout(() => btn.classList.remove('is-failed'), 1200)
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(code).then(succeed).catch(fail)
      } else {
        const ta = document.createElement('textarea')
        ta.value = code
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try {
          document.execCommand('copy')
          succeed()
        } catch {
          fail()
        } finally {
          document.body.removeChild(ta)
        }
      }
    })
    wrap.appendChild(btn)
    return wrap
  }
  ignoreEvent() {
    return false
  }
}

   
                                               
                                                            
                                                              
                              
   
function readCodeAtWidget(view: EditorView, dom: HTMLElement): string | null {
  const pos = view.posAtDOM(dom)
  const state = view.state
  if (pos < 0 || pos > state.doc.length) return null
  let result: string | null = null
  syntaxTree(state).iterate({
    from: pos,
    to: Math.min(pos + 1, state.doc.length),
    enter(node) {
      if (node.name !== 'FencedCode') return undefined
      let codeFrom = -1
      let codeTo = -1
      node.node.cursor().iterate((inner) => {
        if (inner.name === 'CodeText') {
          codeFrom = inner.from
          codeTo = inner.to
        }
      })
      if (codeFrom !== -1 && codeTo !== -1) {
        result = state.doc.sliceString(codeFrom, codeTo)
      }
      return false
    },
  })
  return result
}

class MermaidWidget extends WidgetType {
  constructor(readonly code: string, readonly srcFrom: number) {
    super()
  }
  toDOM(view: EditorView) {
    const t = i18next.getFixedT(null, 'document')
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-mermaid'
    wrap.setAttribute('aria-hidden', 'true')
                                                             
                        
    const content = document.createElement('div')
    content.className = 'cm-md-mermaid-content'
    const indicator = document.createElement('span')
    indicator.className = 'cm-md-mermaid-loading'
    indicator.textContent = t('editor.extensions.livePreview.renderingMermaid')
    content.appendChild(indicator)
    wrap.appendChild(content)
    renderMermaid(this.code)
      .then((svg) => {
        content.innerHTML = svg
        view.requestMeasure()
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        content.innerHTML = ''
        const errEl = document.createElement('pre')
        errEl.className = 'cm-md-mermaid-error'
        errEl.textContent = `Mermaid error: ${message}`
        content.appendChild(errEl)
        view.requestMeasure()
      })
                                                              
                                           
    const edit = document.createElement('button')
    edit.className = 'cm-md-mermaid-edit'
    edit.type = 'button'
    edit.innerHTML = CODE_ICON_SVG
    edit.title = t('editor.extensions.livePreview.editSource')
    edit.setAttribute('aria-label', t('editor.extensions.livePreview.editSource'))
    edit.addEventListener('mousedown', (e) => e.preventDefault())
    edit.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
                                                       
                                           
      const live = view.posAtDOM(wrap)
      const anchor = live >= 0 && live <= view.state.doc.length ? live : this.srcFrom
      view.dispatch({
        selection: { anchor },
        scrollIntoView: true,
        userEvent: 'select.pointer',
      })
      view.focus()
    })
    wrap.appendChild(edit)
    attachResizeMeasure(wrap, view)
    return wrap
  }
                                                
                                                                 
                                                           
                                                      
                                                  
                                             
  eq(other: MermaidWidget) {
    return other.code === this.code
  }
                                                              
  get estimatedHeight(): number {
    return 280
  }
  destroy(dom: HTMLElement): void {
    detachResizeMeasure(dom)
  }
  ignoreEvent() {
    return true
  }
}

class MathWidget extends WidgetType {
  constructor(readonly source: string, readonly display: boolean, readonly srcFrom: number) {
    super()
  }
  toDOM(view: EditorView) {
    const tag = this.display ? 'div' : 'span'
    const wrap = document.createElement(tag)
    wrap.className = this.display ? 'cm-md-math cm-md-math-display' : 'cm-md-math cm-md-math-inline'
    wrap.setAttribute('aria-hidden', 'true')
    wrap.textContent = this.display ? '⏳' : '$…$'
    renderMath(this.source, this.display)
      .then((html) => {
        wrap.innerHTML = html
        view.requestMeasure()
      })
      .catch(() => {
        wrap.textContent = this.display ? `$$${this.source}$$` : `$${this.source}$`
        wrap.classList.add('cm-md-math-error')
        view.requestMeasure()
      })
    if (this.display) {
      attachResizeMeasure(wrap, view)
      attachClickToSource(wrap, view, () => {
        const live = view.posAtDOM(wrap)
        return live >= 0 && live <= view.state.doc.length ? live : this.srcFrom
      })
    }
    return wrap
  }
                                                                  
                                                                  
                                              
  eq(other: MathWidget) {
    return other.source === this.source && other.display === this.display
  }
                                                                
                          
  get estimatedHeight(): number {
    return this.display ? 60 : -1
  }
  destroy(dom: HTMLElement): void {
    detachResizeMeasure(dom)
  }
  ignoreEvent() {
    return true
  }
}

   
                                      
                                                     
                                     
                                       
                      
   

type CalloutInfo = {
  type: string
  startLine: number
  endLine: number
                                      
  markerFrom: number
  markerTo: number
                                  
  hasTitle: boolean
}

function detectCallout(
  state: EditorView['state'],
  blockFrom: number,
  blockTo: number,
): CalloutInfo | null {
  const startLine = state.doc.lineAt(blockFrom)
  const endLine = state.doc.lineAt(blockTo)
                                                   
  const match = /^>\s*\[!([A-Za-z]+)\]/.exec(startLine.text)
  if (!match) return null
  const type = match[1].toLowerCase()
  if (!CALLOUT_TYPES.has(type)) return null
  const idx = startLine.text.indexOf('[!')
  const after = /^>\s*\[![A-Za-z]+\]\s?/.exec(startLine.text)
  const consumedLen = after ? after[0].length : match[0].length
  const trueMarkerFrom = startLine.from + idx
  const trueMarkerTo = startLine.from + consumedLen
  const hasTitle = /^>\s*\[![A-Za-z]+\]\s+\S/.test(startLine.text)
  return {
    type,
    startLine: startLine.number,
    endLine: endLine.number,
    markerFrom: trueMarkerFrom,
    markerTo: trueMarkerTo,
    hasTitle,
  }
}

const FOOTNOTE_REF_RE = /\[\^([A-Za-z0-9_-]+)\]/g
const FOOTNOTE_DEF_RE = /^\[\^([A-Za-z0-9_-]+)\]:\s/
const MATH_DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g
                                     
const MATH_INLINE_RE = /(?<!\\)\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$/g

   
                               
  
                                                    
                                                               
                                                                   
                                                            
                                                                
  
                                                   
                                                           
   
type FencedBlockInfo = {
  openLineFrom: number
  openLineTo: number
  closeLineFrom: number
  closeLineTo: number
  openLineNumber: number
  closeLineNumber: number
  openMarkFrom: number
  openMarkTo: number
  closeMarkFrom: number
  closeMarkTo: number
  codeFrom: number
  codeTo: number
  lang: string
}

   
                   
  
                                                              
                                                                           
                                                                 
                                                        
                                                      
                                            
                                                        
  
                                                                
                                             
   
type ATXHeadingInfo = {
  line: number
  lineFrom: number
  lineTo: number
  level: number
                             
  markFrom: number
                                                                  
  markTo: number
}

             
export function scanATXHeadings(
  state: EditorState,
  fencedBlocks: FencedBlockInfo[],
): ATXHeadingInfo[] {
  const out: ATXHeadingInfo[] = []
  const doc = state.doc
  const inFence = (n: number): boolean => {
    for (const fb of fencedBlocks) {
      if (n >= fb.openLineNumber && n <= fb.closeLineNumber) return true
    }
    return false
  }
  for (let i = 1; i <= doc.lines; i++) {
    if (inFence(i)) continue
    const line = doc.line(i)
                                                               
    const m = line.text.match(/^( {0,3})(#{1,6})(?:[ \t]|$)/)
    if (!m) continue
    const [, indent, hashes] = m
    const markStart = line.from + indent.length
    const hashEnd = markStart + hashes.length
    const tail = line.text.charAt(indent.length + hashes.length)
    const hasTrailingSpace = tail === ' ' || tail === '\t'
    const markEnd = hasTrailingSpace ? hashEnd + 1 : hashEnd
    out.push({
      line: i,
      lineFrom: line.from,
      lineTo: line.to,
      level: hashes.length,
      markFrom: markStart,
      markTo: Math.min(line.to, markEnd),
    })
  }
  return out
}

                                    
export function scanFencedCodeBlocks(state: EditorState): FencedBlockInfo[] {
  const doc = state.doc
  const blocks: FencedBlockInfo[] = []
  type Open = {
    openLineFrom: number
    openLineTo: number
    openLineNumber: number
    openMarkFrom: number
    openMarkTo: number
    fence: string
    lang: string
  }
  const stack: Open[] = []
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const m = line.text.match(/^(\s*)(`{3,}|~{3,})(.*)$/)
    if (!m) continue
    const [, indent, fence, rest] = m
    const restTrimmed = rest.trim()
    if (
      stack.length > 0
      && stack[stack.length - 1].fence[0] === fence[0]
      && restTrimmed === ''
    ) {
      const open = stack.pop()!
      const closeMarkFrom = line.from + indent.length
      const closeMarkTo = closeMarkFrom + fence.length
      const codeFrom = Math.min(open.openLineTo + 1, line.from)
      const codeTo = line.from > codeFrom ? line.from - 1 : codeFrom
      blocks.push({
        openLineFrom: open.openLineFrom,
        openLineTo: open.openLineTo,
        closeLineFrom: line.from,
        closeLineTo: line.to,
        openLineNumber: open.openLineNumber,
        closeLineNumber: i,
        openMarkFrom: open.openMarkFrom,
        openMarkTo: open.openMarkTo,
        closeMarkFrom,
        closeMarkTo,
        codeFrom,
        codeTo,
        lang: open.lang,
      })
      continue
    }
    const markFrom = line.from + indent.length
    const markTo = markFrom + fence.length
    stack.push({
      openLineFrom: line.from,
      openLineTo: line.to,
      openLineNumber: i,
      openMarkFrom: markFrom,
      openMarkTo: markTo,
      fence,
      lang: restTrimmed.toLowerCase(),
    })
  }
  return blocks
}

function buildLivePreviewDecorations(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = []
  const revealedImageSource = state.field(revealedImageSourceField, false)

  const selCtx = state.facet(livePreviewRevealSourceFacet)
    ? buildSelectionContext(state)
    : { activeLines: new Set<number>(), ranges: [] }
                                             
  const cursorLines = selCtx.activeLines
                                                              
                                                                    
                                           
  const decoratedQuoteLines = new Set<number>()
  const renderedTaskMarkers = new Set<number>()

                                      
                                                                    
                                                             
                                                     
                                                                           
          
  const fencedBlocks = scanFencedCodeBlocks(state)
                                                                
  const fenceMarkRanges: Array<[number, number]> = []
  for (const fb of fencedBlocks) {
    fenceMarkRanges.push([fb.openMarkFrom, fb.openMarkTo])
    fenceMarkRanges.push([fb.closeMarkFrom, fb.closeMarkTo])
  }
  const isInsideFenceMark = (from: number, to: number): boolean => {
    for (const [f, t] of fenceMarkRanges) {
      if (from >= f && to <= t) return true
    }
    return false
  }
  for (const fb of fencedBlocks) {
    const inBlock = state.selection.ranges.some(
      (r) => r.to >= fb.openLineFrom && r.from <= fb.closeLineTo,
    )
                                                           
    if (fb.lang === 'mermaid' && !inBlock && fb.codeTo > fb.codeFrom) {
      const code = state.doc.sliceString(fb.codeFrom, fb.codeTo).trim()
      if (code) {
        decos.push(
          Decoration.replace({
            widget: new MermaidWidget(code, fb.openLineFrom),
            block: true,
          }).range(fb.openLineFrom, fb.closeLineTo),
        )
        continue
      }
    }
          
    for (let n = fb.openLineNumber; n <= fb.closeLineNumber; n++) {
      const line = state.doc.line(n)
      const cls = n === fb.openLineNumber || n === fb.closeLineNumber
        ? 'cm-md-codeblock-line cm-md-codeblock-fence'
        : 'cm-md-codeblock-line'
      decos.push(Decoration.line({ class: cls }).range(line.from))
    }
                                                        
                                                           
                                                       
                                                        
    if (!rangeIsActive(selCtx, fb.openLineFrom, fb.openLineTo)) {
      if (fb.openLineTo > fb.openMarkFrom) {
        decos.push(Decoration.replace({}).range(fb.openMarkFrom, fb.openLineTo))
      }
    }
                      
    if (!rangeIsActive(selCtx, fb.closeMarkFrom, fb.closeMarkTo)) {
      decos.push(Decoration.replace({}).range(fb.closeMarkFrom, fb.closeMarkTo))
    }
                                           
    if (fb.codeTo > fb.codeFrom) {
      const code = state.doc.sliceString(fb.codeFrom, fb.codeTo)
      if (code.trim()) {
        decos.push(
          Decoration.widget({
            widget: new CodeCopyWidget(fb.lang),
            side: 1,
          }).range(fb.openLineTo),
        )
      }
    }
  }

                                                 
                                                                           
                                                        
                                                           
                                                             
                                                                     
                                                 
  const atxHeadings = scanATXHeadings(state, fencedBlocks)
  for (const h of atxHeadings) {
    decos.push(Decoration.line({ class: `cm-md-h cm-md-h${h.level}` }).range(h.lineFrom))
    const hidden = shouldHideLineMarker(selCtx, state, h.line, h.markFrom, h.markTo)
    const className = hidden ? 'cm-md-h-mark cm-md-h-mark-hidden' : 'cm-md-h-mark'
    decos.push(Decoration.mark({ class: className }).range(h.markFrom, h.markTo))
  }

  // ---------- YAML Frontmatter ----------
                                      
  if (state.doc.lines >= 2) {
    const first = state.doc.line(1)
    if (first.text === '---') {
      let endLine = -1
      for (let n = 2; n <= state.doc.lines; n++) {
        if (state.doc.line(n).text === '---') {
          endLine = n
          break
        }
      }
      if (endLine !== -1) {
        for (let n = 1; n <= endLine; n++) {
          const line = state.doc.line(n)
          const cls = n === 1 || n === endLine
            ? 'cm-md-frontmatter-line cm-md-frontmatter-fence'
            : 'cm-md-frontmatter-line'
          decos.push(Decoration.line({ class: cls }).range(line.from))
        }
      }
    }
  }

                                                   
                                                           
                              
  const scanRanges: { from: number; to: number }[] = [{ from: 0, to: state.doc.length }]
  for (const { from, to } of scanRanges) {
    const startLine = state.doc.lineAt(from).number
    const endLine = state.doc.lineAt(to).number
    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n)
      const defMatch = FOOTNOTE_DEF_RE.exec(line.text)
      if (defMatch) {
        decos.push(Decoration.line({ class: 'cm-md-footnote-def' }).range(line.from))
        decos.push(
          Decoration.mark({ class: 'cm-md-footnote-def-mark' })
            .range(line.from, line.from + defMatch[0].length),
        )
        continue
      }
      FOOTNOTE_REF_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = FOOTNOTE_REF_RE.exec(line.text)) !== null) {
        const refFrom = line.from + m.index
        const refTo = refFrom + m[0].length
        decos.push(Decoration.mark({ class: 'cm-md-footnote-ref' }).range(refFrom, refTo))
      }
    }
  }

  function rangeNearCursor(from: number, to: number): boolean {
    return rangeIsActive(selCtx, from, to)
  }

                                                                  
  const calloutByBlockStart = new Map<number, CalloutInfo>()

                               
                                                     
  const consumedMath: { from: number; to: number }[] = []
  for (const { from, to } of scanRanges) {
    const text = state.doc.sliceString(from, to)
    MATH_DISPLAY_RE.lastIndex = 0
    let dm: RegExpExecArray | null
    while ((dm = MATH_DISPLAY_RE.exec(text)) !== null) {
      const absFrom = from + dm.index
      const absTo = absFrom + dm[0].length
      consumedMath.push({ from: absFrom, to: absTo })
      const source = dm[1]
      if (rangeNearCursor(absFrom, absTo)) {
        decos.push(Decoration.mark({ class: 'cm-md-math-src' }).range(absFrom, absTo))
      } else {
        decos.push(
          Decoration.replace({ widget: new MathWidget(source, true, absFrom), block: true })
            .range(absFrom, absTo),
        )
      }
    }
  }
  for (const { from, to } of scanRanges) {
    const startLine = state.doc.lineAt(from).number
    const endLine = state.doc.lineAt(to).number
    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n)
      MATH_INLINE_RE.lastIndex = 0
      let im: RegExpExecArray | null
      while ((im = MATH_INLINE_RE.exec(line.text)) !== null) {
        const absFrom = line.from + im.index
        const absTo = absFrom + im[0].length
        if (consumedMath.some((r) => r.from <= absFrom && absTo <= r.to)) continue
        const source = im[1]
        if (rangeNearCursor(absFrom, absTo)) {
          decos.push(Decoration.mark({ class: 'cm-md-math-src' }).range(absFrom, absTo))
        } else {
          decos.push(
            Decoration.replace({ widget: new MathWidget(source, false, absFrom) }).range(absFrom, absTo),
          )
        }
      }
    }
  }

  for (const { from, to } of scanRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
                                   
                                                                 
                                                                
                                                              
                                                    
        const headingMatch = /^ATXHeading([1-6])$/.exec(node.name)
        if (headingMatch) {
          return false
        }

        if (node.name === 'HeaderMark') {
                                                                       
                                                                    
                                                              
                                                        
          const line = state.doc.lineAt(node.from)
          const end = Math.min(line.to, node.to + 1)
          const hidden = shouldHideLineMarker(selCtx, state, line.number, node.from, end)
          const className = hidden ? 'cm-md-h-mark cm-md-h-mark-hidden' : 'cm-md-h-mark'
          decos.push(Decoration.mark({ class: className }).range(node.from, end))
          return
        }

                                          
                                                                                
                                                                       
                                              
        //
                                                                       
                                                                     
                                            
        if (
          node.name === 'EmphasisMark'
          || node.name === 'CodeMark'
          || node.name === 'StrikethroughMark'
        ) {
          const parent = node.node.parent
          const refFrom = parent ? parent.from : node.from
          const refTo = parent ? parent.to : node.to
          if (!rangeNearCursor(refFrom, refTo)) {
            decos.push(Decoration.replace({}).range(node.from, node.to))
          }
          return
        }

                                               
                                                                           
                                                                
                                                       
        //
                                                                   
                                                                                    
        //
                                                           
        //   .hmd-inactive-line span.cm-hmd-escape-backslash { font-size:0!important }
        //   span.cm-hmd-escape-backslash                    { color: var(--text-faint) }
                                       
                                                   
        //
                                                                      
                                                            
                                                  
        if (node.name === 'Escape') {
          const line = state.doc.lineAt(node.from)
          const bsFrom = node.from
          const bsTo = node.from + 1
          const charFrom = node.from + 1
          const charTo = node.to
          if (cursorLines.has(line.number)) {
            decos.push(
              Decoration.mark({ class: 'cm-md-escape-backslash' }).range(bsFrom, bsTo),
            )
          } else {
            decos.push(Decoration.replace({}).range(bsFrom, bsTo))
          }
          if (charFrom < charTo) {
            decos.push(
              Decoration.mark({ class: 'cm-md-escape-char' }).range(charFrom, charTo),
            )
          }
          return
        }

        // ---------- HTML Entity `&nbsp;` / `&#160;` / `&#xa0;` ----------
                                                                
                                                                     
                                                               
                                                                     
                                                             
        //
                                              
                                                                    
                                                                             
                                      
        if (node.name === 'Entity') {
          const line = state.doc.lineAt(node.from)
          if (cursorLines.has(line.number)) {
            decos.push(
              Decoration.mark({ class: 'cm-md-entity-source' }).range(node.from, node.to),
            )
          } else {
            const raw = state.doc.sliceString(node.from, node.to)
            const decoded = decodeHtmlEntity(raw)
            if (decoded !== null) {
              decos.push(
                Decoration.replace({ widget: new HtmlEntityWidget(decoded) }).range(
                  node.from,
                  node.to,
                ),
              )
            } else {
              decos.push(
                Decoration.mark({ class: 'cm-md-entity-source' }).range(node.from, node.to),
              )
            }
          }
          return
        }

        if (node.name === 'StrongEmphasis') {
          decos.push(Decoration.mark({ class: 'cm-md-strong' }).range(node.from, node.to))
          return
        }
        if (node.name === 'Emphasis') {
          decos.push(Decoration.mark({ class: 'cm-md-em' }).range(node.from, node.to))
          return
        }
        if (node.name === 'InlineCode') {
          decos.push(Decoration.mark({ class: 'cm-md-code' }).range(node.from, node.to))
          return
        }
        if (node.name === 'Strikethrough') {
          decos.push(Decoration.mark({ class: 'cm-md-strike' }).range(node.from, node.to))
          return
        }

        // ---------- Blockquote & Callout ----------
        if (node.name === 'Blockquote') {
          const callout = detectCallout(state, node.from, node.to)
          if (callout) {
            calloutByBlockStart.set(node.from, callout)
            for (let n = callout.startLine; n <= callout.endLine; n++) {
              const line = state.doc.line(n)
              const parts = ['cm-md-callout', `cm-md-callout-${callout.type}`]
              if (n === callout.startLine) parts.push('cm-md-callout-head')
              if (n === callout.endLine) parts.push('cm-md-callout-foot')
              decos.push(Decoration.line({ class: parts.join(' ') }).range(line.from))
            }
            if (!cursorLines.has(callout.startLine)) {
              if (callout.markerFrom < callout.markerTo) {
                decos.push(
                  Decoration.replace({ widget: new CalloutTitleWidget(callout.type, callout.hasTitle) })
                    .range(callout.markerFrom, callout.markerTo),
                )
              }
            }
            return
          }
                                                                     
                                                          
          const startLine = state.doc.lineAt(node.from).number
          const endLine = state.doc.lineAt(node.to).number
          for (let n = startLine; n <= endLine; n++) {
            if (decoratedQuoteLines.has(n)) continue
            decoratedQuoteLines.add(n)
            const line = state.doc.line(n)
            decos.push(Decoration.line({ class: 'cm-md-quote-line' }).range(line.from))
          }
          return
        }

        if (node.name === 'QuoteMark') {
          const line = state.doc.lineAt(node.from)
                                                                
          const end = Math.min(line.to, node.to + 1)
          if (shouldHideLineMarker(selCtx, state, line.number, node.from, end)) {
            decos.push(Decoration.replace({}).range(node.from, end))
          }
          return
        }

                                   
        if (node.name === 'ListMark') {
          const text = state.doc.sliceString(node.from, node.to)
          const isBullet = /^[-*+]$/.test(text)
          const line = state.doc.lineAt(node.from)
          const afterMark = state.doc.sliceString(node.to, line.to)
          const taskMatch = /^(\s+)(\[[ xX]\])(?=\s|$)/.exec(afterMark)

          if (taskMatch) {
            const taskFrom = node.to + taskMatch[1].length
            const taskTo = taskFrom + taskMatch[2].length
            const checked = /\[[xX]\]/.test(taskMatch[2])
            renderedTaskMarkers.add(taskFrom)
            decos.push(
              Decoration.replace({ widget: new CheckboxWidget(checked, taskFrom, taskTo) })
                .range(node.from, taskTo),
            )
            return
          }

          // Replace source markers with the live-preview bullet widget.
                                                                
                                                       
          if (isBullet) {
            decos.push(
              Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
            )
          } else {
            decos.push(
              Decoration.mark({ class: 'cm-md-list-mark' }).range(node.from, node.to),
            )
          }
          return
        }

        if (node.name === 'TaskMarker') {
          const text = state.doc.sliceString(node.from, node.to)
          const checked = /\[[xX]\]/.test(text)
          const line = state.doc.lineAt(node.from)
          if (!renderedTaskMarkers.has(node.from)) {
            decos.push(
              Decoration.replace({ widget: new CheckboxWidget(checked, node.from, node.to) })
                .range(node.from, node.to),
            )
          }
          if (checked) {
            decos.push(
              Decoration.line({ class: 'cm-md-task-done' }).range(line.from),
            )
          }
          return
        }

                                                     
        if (node.name === 'Image') {
          let urlStart = -1
          let urlEnd = -1
          let altText = ''
          const linkMarks: { from: number; to: number }[] = []
          node.node.cursor().iterate((inner) => {
            if (inner.name === 'URL') {
              urlStart = inner.from
              urlEnd = inner.to
            }
            if (inner.name === 'LinkMark') {
              linkMarks.push({ from: inner.from, to: inner.to })
            }
          })
          if (linkMarks.length >= 2) {
            const altFrom = linkMarks[0].to
            const altTo = linkMarks[1].from
            if (altFrom < altTo) altText = state.doc.sliceString(altFrom, altTo)
          }

          let url = urlStart !== -1 && urlEnd !== -1
            ? state.doc.sliceString(urlStart, urlEnd)
            : ''
          if (!url) {
            const raw = state.doc.sliceString(node.from, node.to)
            const wikilink = parseWikilinks(raw).find((link) => link.embed)
            if (wikilink && isWorkspaceImagePath(wikilink.target)) {
              url = wikilink.target
              altText = wikilink.display || wikilink.target.split('/').pop() || wikilink.target
            }
          }
          if (!url) return false

          const line = state.doc.lineAt(node.from)
          const before = line.text.slice(0, node.from - line.from)
          const after = line.text.slice(node.to - line.from)
          const standalone = !before.trim() && !after.trim()
          const sourceVisible = revealedImageSource?.from === node.from
            && revealedImageSource.to === node.to
          const widget = new ImageWidget(
            url,
            altText,
            state.facet(livePreviewSourcePathFacet),
            node.from,
            node.to,
            standalone,
            sourceVisible,
          )
          if (sourceVisible) {
            decos.push(Decoration.mark({ class: 'cm-md-image-src' }).range(node.from, node.to))
            decos.push(
              Decoration.widget({ widget, side: 1, block: standalone })
                .range(standalone ? line.to : node.to),
            )
          } else {
            decos.push(
              Decoration.replace({ widget, block: standalone })
                .range(standalone ? line.from : node.from, standalone ? line.to : node.to),
            )
          }
          return false
        }

        // ---------- Link ----------
                                                                                       
                                                                  
                                                                  
        if (node.name === 'Link') {
          const cursorIn = rangeNearCursor(node.from, node.to)
          const linkMarks: { from: number; to: number }[] = []
          let urlStart = -1
          let urlEnd = -1
          node.node.cursor().iterate((inner) => {
            if (inner.name === 'URL') {
              urlStart = inner.from
              urlEnd = inner.to
            }
            if (inner.name === 'LinkMark') {
              linkMarks.push({ from: inner.from, to: inner.to })
            }
          })
          const hasUrl = urlStart !== -1 && urlEnd !== -1
          const url = hasUrl ? state.doc.sliceString(urlStart, urlEnd) : ''
          decos.push(
            Decoration.mark({
                                                                    
                                                    
              class: cursorIn ? 'cm-md-link cm-md-link-expanded' : 'cm-md-link',
              attributes: hasUrl ? { 'data-href': url, role: 'link' } : {},
            }).range(node.from, node.to),
          )
          if (!cursorIn && hasUrl && linkMarks.length >= 4) {
            const openBracket = linkMarks[0] // `[`
            const closeBracket = linkMarks[1] // `]`
            decos.push(Decoration.replace({}).range(openBracket.from, openBracket.to))
            if (closeBracket.from < node.to) {
              decos.push(
                Decoration.replace({ widget: new ExternalLinkIconWidget(url) })
                  .range(closeBracket.from, node.to),
              )
            }
          }
          return
        }

                                      
                                                                         
                                                                        
                                                                 
                                        
                                                  
        if (node.name === 'FencedCode') {
          return false
        }

                                      
        if (node.name === 'HorizontalRule') {
          const line = state.doc.lineAt(node.from)
          if (!cursorLines.has(line.number)) {
            decos.push(
              Decoration.replace({ widget: new HRWidget(), block: false })
                .range(line.from, line.to),
            )
          }
          decos.push(Decoration.line({ class: 'cm-md-hr-line-host' }).range(line.from))
          return
        }

                                       
                                                                              
                                                              
                                                   
        if (node.name === 'Table') {
          const model = parseTableFromNode(node.node, state)
          if (model) {
            decos.push(
              Decoration.replace({
                widget: new TableWidget(model),
                block: true,
              }).range(node.from, node.to),
            )
          }
                                                             
          return false
        }
      },
    })
  }

  return Decoration.set(decos, true)
}

                                                                       
const atomicPlaceholder = Decoration.replace({})

   
                                                       
                      
  
                                                              
                                                                    
                                                         
                                                                      
                                                   
  
                                                 
                                                          
                               
  
                                                       
             
   
function buildBlockAtomicRanges(set: DecorationSet, docLength: number): RangeSet<Decoration> {
  const ranges: Range<Decoration>[] = []
  set.between(0, docLength, (from, to, value) => {
    const widget = (value as unknown as { block?: boolean; widget?: unknown }).widget
    if (from < to && (value as unknown as { block?: boolean }).block === true && widget instanceof TableWidget) {
      const f = Math.max(0, from - 1)
      const t = Math.min(docLength, to + 1)
      ranges.push(atomicPlaceholder.range(f, t))
    }
  })
  return RangeSet.of(ranges, true)
}

                                                                     
                                                            
                                          
// Exported so the spec can call `view.state.field(livePreviewField)` and
// directly iterate decorations rather than relying on jsdom's small viewport.
export const livePreviewField = StateField.define<DecorationSet>({
  create(state) {
    return buildLivePreviewDecorations(state)
  },
  update(value, tr) {
                                                                   
                                                                  
                                                                
                                              
                                                               
                                                                  
    const focusChanged = tr.effects.some((e) => e.is(editorFocusEffect))
    const imageSourceChanged = tr.effects.some((e) => e.is(revealImageSourceEffect))
    const shouldRebuild =
      tr.docChanged ||
      tr.selection ||
      focusChanged ||
      imageSourceChanged ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    if (!shouldRebuild) return value

                                                   
                                                                      
                                                                  
                                                              
                                     
                                                     
                                                      
                                                                               
    if (!syntaxTreeAvailable(tr.state, tr.state.doc.length)) {
      return tr.docChanged ? value.map(tr.changes) : value
    }

    return buildLivePreviewDecorations(tr.state)
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) =>
      buildBlockAtomicRanges(view.state.field(f), view.state.doc.length),
    ),
  ],
})

const livePreviewTheme = EditorView.baseTheme({
                                            
  '.cm-md-h': {
    padding: '1rem 0 0',           // --p-spacing
    textDecoration: 'none',
  },
  '.cm-md-h *': {
    textDecoration: 'none !important',
  },
                                                                                
  '.cm-md-h-mark, .cm-md-h .cm-md-h-mark': {
    color: 'hsl(var(--muted-foreground) / 0.55) !important',
    fontWeight: 'normal !important',
    textDecoration: 'none !important',
  },
                                                       
                                                                             
                                                              
                                                                
                                         
  '.cm-md-h-mark-hidden': {
    fontSize: '0 !important',
    display: 'inline-block',
    width: '0',
    overflow: 'hidden',
    verticalAlign: 'baseline',
  },
  '.cm-md-h1': {
    fontSize: '1.618em',
    fontWeight: '700',
    lineHeight: '1.2',
    letterSpacing: '-0.015em',
  },
  '.cm-md-h2': {
    fontSize: '1.462em',
    fontWeight: '600',
    lineHeight: '1.2',
    letterSpacing: '-0.011em',
  },
  '.cm-md-h3': {
    fontSize: '1.318em',
    fontWeight: '600',
    lineHeight: '1.3',
    letterSpacing: '-0.008em',
  },
  '.cm-md-h4': {
    fontSize: '1.188em',
    fontWeight: '600',
    lineHeight: '1.4',
    letterSpacing: '-0.005em',
  },
  '.cm-md-h5': {
    fontSize: '1.076em',
    fontWeight: '600',
    letterSpacing: '-0.002em',
  },
  '.cm-md-h6': {
    fontSize: '1em',
    fontWeight: '600',
    letterSpacing: '0',
  },
  '.cm-md-strong': { fontWeight: '700' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-strike': { textDecoration: 'line-through' },
                                           
                                                            
                         
  '.cm-md-escape-backslash': {
    color: 'hsl(var(--muted-foreground) / 0.5)',
  },
                                                            
                                                                      
                                                                   
                                    
  '.cm-md-escape-char': {
    color: 'inherit !important',
  },
                                                  
                                                                          
                                                                      
                                     
  '.cm-md-entity-source': {
    color: 'inherit !important',
  },
  '.cm-md-entity': {
                                                      
  },
  '.cm-md-code': {
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: '0.9em',
    backgroundColor: 'hsl(var(--muted, 215 15% 90%) / 0.55)',
    padding: '0.05em 0.35em',
    borderRadius: '0.25rem',
  },
                                                                                 
                                                                               
                                                                      
                                                                    
                                                                 
                                                 
                                                              
                                        
  '.cm-line.cm-md-quote-line': {
    borderInlineStart: '2px solid hsl(var(--primary))',
    paddingInlineStart: '1em',
    color: 'inherit',
  },
  '.cm-md-list-mark': {
    color: 'hsl(var(--muted-foreground) / 0.55)',
  },
  '.cm-md-bullet': {
    display: 'inline-block',
    width: '1.2em',
    color: 'hsl(var(--muted-foreground) / 0.55)',
    fontWeight: '700',
  },
  '.cm-md-task-checkbox': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.2em',
  },
  '.cm-md-task-checkbox input[type="checkbox"]': {
    margin: '0',
    cursor: 'default',
    accentColor: 'hsl(var(--primary, 220 90% 55%))',
  },
  '.cm-line.cm-md-task-done': {
    textDecoration: 'line-through',
    color: 'var(--document-muted-text, hsl(var(--muted-foreground, 215 15% 55%)))',
  },
  '.cm-md-link': {
    color: 'hsl(var(--primary, 220 90% 55%))',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
                                                
                                                   
  '.cm-md-link.cm-md-link-expanded': {
    cursor: 'text',
  },
                                                           
                                                                         
  '.cm-md-link-external-icon': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '0.85em',
    height: '0.85em',
    marginLeft: '2px',
    color: 'hsl(var(--primary, 220 90% 55%))',
    opacity: '0.7',
    cursor: 'pointer',
    verticalAlign: '-0.05em',
  },
  '.cm-md-link-external-icon:hover': {
    opacity: '1',
  },
  '.cm-md-link-external-icon svg': {
    width: '100%',
    height: '100%',
  },
                                                       
                                                                         
                                            
  '.cm-line.cm-md-codeblock-line': {
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: '0.9em',
    backgroundColor: 'hsl(var(--muted, 215 15% 90%) / 0.55)',
    position: 'relative',
                                                   
                 
    paddingLeft: '1rem',
    paddingRight: '1rem',
  },
  '.cm-md-codeblock-fence': {
    color: 'hsl(var(--muted-foreground, 215 15% 55%))',
  },
  '.cm-md-codeblock-actions': {
    position: 'absolute',
    right: '8px',
    top: '4px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    pointerEvents: 'auto',
  },
                          
  '.cm-md-codeblock-lang': {
    fontSize: '0.72rem',
    fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
    color: 'hsl(var(--muted-foreground, 215 15% 55%) / 0.75)',
    letterSpacing: '0.03em',
    cursor: 'pointer',
    userSelect: 'none',
    borderRadius: '4px',
    padding: '0 2px',
    transition: 'color 120ms ease',
  },
  '.cm-md-codeblock-lang:hover': {
    color: 'hsl(var(--foreground, 215 15% 15%))',
  },
                                          
  '.cm-md-codeblock-copy': {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    padding: '0',
    border: 'none',
    background: 'transparent',
    color: 'hsl(var(--muted-foreground, 215 15% 45%))',
    borderRadius: '5px',
    cursor: 'pointer',
    opacity: '0',
    transition: 'opacity 120ms ease, color 120ms ease, background 120ms ease',
  },
  '.cm-md-codeblock-line:hover .cm-md-codeblock-copy, .cm-md-codeblock-line.is-fence-focused .cm-md-codeblock-copy': {
    opacity: '1',
  },
  '.cm-md-codeblock-copy:hover': {
    color: 'hsl(var(--foreground, 215 15% 15%))',
    background: 'hsl(var(--muted, 215 15% 90%) / 0.6)',
  },
  '.cm-md-codeblock-copy.is-copied': {
    opacity: '1',
    color: 'hsl(var(--success, 142 70% 45%))',
  },
  '.cm-md-codeblock-copy.is-failed': {
    opacity: '1',
    color: 'hsl(var(--destructive, 0 70% 55%))',
  },

  // HR
  '.cm-md-hr': {
    display: 'inline-block',
    width: '100%',
    verticalAlign: 'middle',
  },
  '.cm-md-hr-line': {
    display: 'block',
    height: '0',
    borderTop: '1px solid hsl(var(--border, 215 15% 80%))',
    margin: '0.6em 0',
  },
  '.cm-md-hr-line-host': {
    color: 'hsl(var(--muted-foreground, 215 15% 55%))',
  },

       
  '.cm-md-image': {
    display: 'inline-block',
    position: 'relative',
    maxWidth: '100%',
    verticalAlign: 'top',
  },
  '.cm-md-image-block': {
    display: 'block',
    width: 'fit-content',
    margin: '0.5em 0',
  },
  '.cm-md-image-block.is-loading': {
    width: '100%',
    height: `${BLOCK_IMAGE_ESTIMATED_HEIGHT}px`,
  },
  '.cm-md-image img': {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '420px',
    borderRadius: '0.375rem',
    boxShadow: '0 1px 2px hsl(var(--border, 215 15% 80%) / 0.5)',
  },
  '.cm-md-image-source-toggle': {
    appearance: 'none',
    position: 'absolute',
    top: '8px',
    right: '8px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    padding: '0',
    border: '1px solid hsl(var(--border, 215 15% 85%))',
    background: 'hsl(var(--background, 0 0% 100%) / 0.88)',
    color: 'hsl(var(--muted-foreground, 215 15% 45%))',
    borderRadius: '6px',
    boxShadow: '0 1px 3px hsl(var(--foreground, 215 15% 10%) / 0.12)',
    cursor: 'pointer',
    opacity: '0',
    transition: 'opacity 120ms ease, color 120ms ease, background 120ms ease',
  },
  '.cm-md-image:hover .cm-md-image-source-toggle, .cm-md-image.is-source-visible .cm-md-image-source-toggle, .cm-md-image-source-toggle:focus-visible': {
    opacity: '1',
  },
  '.cm-md-image-source-toggle:hover': {
    color: 'hsl(var(--foreground, 215 15% 15%))',
    background: 'hsl(var(--muted, 215 15% 90%) / 0.94)',
  },
  '.cm-md-image-src': {
    color: 'hsl(var(--muted-foreground, 215 15% 55%)) !important',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.9em',
    textDecoration: 'none !important',
    cursor: 'text',
  },
  '.cm-md-image-src *': {
    color: 'inherit !important',
    textDecoration: 'none !important',
  },

                                                      
                                                    
                                          
                                                                       
                                                                                     
  '.cm-line.cm-md-callout': {
    paddingLeft: '1rem',
    paddingRight: '1rem',
    backgroundColor: 'hsl(var(--callout-color, var(--muted-foreground, 215 15% 55%)) / 0.1)',
  },
  '.cm-line.cm-md-callout-head': {
    fontWeight: '600',
    paddingTop: '0.6rem',
    paddingBottom: '0.25rem',
    borderTopLeftRadius: '0.5rem',
    borderTopRightRadius: '0.5rem',
    color: 'hsl(var(--callout-color, var(--muted-foreground, 215 15% 55%)))',
  },
  '.cm-line.cm-md-callout-foot': {
    paddingBottom: '0.6rem',
    borderBottomLeftRadius: '0.5rem',
    borderBottomRightRadius: '0.5rem',
  },
  '.cm-md-callout-icon': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    marginRight: '0.45rem',
    verticalAlign: '-0.18em',
    color: 'hsl(var(--callout-color, var(--muted-foreground, 215 15% 55%)))',
  },
  '.cm-md-callout-icon svg': { display: 'block' },
  '.cm-md-callout-title-text': { fontWeight: '600' },

                                                
  '.cm-md-callout-note': { '--callout-color': '210 90% 62%' },
  '.cm-md-callout-info': { '--callout-color': '200 85% 58%' },
  '.cm-md-callout-tip': { '--callout-color': '168 66% 52%' },
  '.cm-md-callout-hint': { '--callout-color': '168 66% 52%' },
  '.cm-md-callout-important': { '--callout-color': '280 75% 68%' },
  '.cm-md-callout-success': { '--callout-color': '140 60% 55%' },
  '.cm-md-callout-check': { '--callout-color': '140 60% 55%' },
  '.cm-md-callout-done': { '--callout-color': '140 60% 55%' },
  '.cm-md-callout-question': { '--callout-color': '45 90% 58%' },
  '.cm-md-callout-help': { '--callout-color': '45 90% 58%' },
  '.cm-md-callout-faq': { '--callout-color': '45 90% 58%' },
  '.cm-md-callout-warning': { '--callout-color': '35 95% 60%' },
  '.cm-md-callout-caution': { '--callout-color': '35 95% 60%' },
  '.cm-md-callout-attention': { '--callout-color': '35 95% 60%' },
  '.cm-md-callout-failure': { '--callout-color': '0 80% 65%' },
  '.cm-md-callout-fail': { '--callout-color': '0 80% 65%' },
  '.cm-md-callout-missing': { '--callout-color': '0 80% 65%' },
  '.cm-md-callout-danger': { '--callout-color': '355 82% 62%' },
  '.cm-md-callout-error': { '--callout-color': '355 82% 62%' },
  '.cm-md-callout-bug': { '--callout-color': '10 78% 60%' },
  '.cm-md-callout-example': { '--callout-color': '270 62% 68%' },
  '.cm-md-callout-quote': { '--callout-color': '215 12% 62%' },
  '.cm-md-callout-cite': { '--callout-color': '215 12% 62%' },
  '.cm-md-callout-abstract': { '--callout-color': '190 65% 55%' },
  '.cm-md-callout-summary': { '--callout-color': '190 65% 55%' },
  '.cm-md-callout-tldr': { '--callout-color': '190 65% 55%' },
  '.cm-md-callout-todo': { '--callout-color': '220 80% 65%' },

                                                                             
                                                             
  '.cm-table-widget': {
    display: 'block',
    padding: '16px',                                                                            
    margin: '0 -16px',                                                                
    overflowX: 'auto',
    overflowY: 'hidden',
  },
  '.cm-table-widget .table-wrapper': {
    position: 'relative',                                                                     
    width: 'fit-content',                                                                      
  },
  '.cm-table-widget table': {
    borderCollapse: 'collapse',
    fontSize: '0.95em',
  },
                                                                                             
                                                            
  '.cm-table-widget th, .cm-table-widget td': {
    border: '1px solid hsl(var(--border, 215 15% 80%))',
    cursor: 'text',
    minWidth: '6em',
    overflow: 'visible',
    padding: '0',                                                                     
    position: 'relative',                                                           
    verticalAlign: 'top',
  },
  '.cm-table-widget th': {
    backgroundColor: 'hsl(var(--muted, 215 15% 90%) / 0.4)',
    fontWeight: '600',
  },
                                     
  '.cm-table-widget.is-cell-selecting': {
    userSelect: 'none',
  },
  '.cm-table-widget.is-cell-selecting .table-cell-wrapper': {
    userSelect: 'none',
    cursor: 'default',
  },
                                                     
  '.cm-table-widget td.is-cell-selected, .cm-table-widget th.is-cell-selected': {
    backgroundColor: 'hsl(var(--primary, 247 63% 55%) / 0.15)',
  },
  '.cm-table-widget .table-cell-selection-box': {
    position: 'absolute',
    pointerEvents: 'none',
    border: '2px solid hsl(var(--primary, 247 63% 55%))',
    borderRadius: '3px',
    boxSizing: 'border-box',
    zIndex: '3',
  },
  '.cm-table-widget .table-cell-wrapper': {
    display: 'block',
    minHeight: '1.6em',                                                
    padding: '4px 8px',                              // var(--size-2-2) var(--size-4-2)
    outline: 'none',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  '.cm-table-widget .table-cell-wrapper:focus': {
    background: 'hsl(var(--primary, 220 90% 55%) / 0.06)',
  },
  '.cm-table-widget tbody tr.is-row-selected td': {
    background: 'hsl(var(--primary, 220 90% 55%) / 0.12)',
  },
                                                           
  '.cm-table-widget tbody tr.is-row-selected td::after': {
    content: '""',
    position: 'absolute',
    inset: '0',
    background: 'hsl(var(--primary, 220 90% 55%) / 0.08)',
    pointerEvents: 'none',
  },
                                                                  
  '.cm-table-widget thead th.is-col-selected, .cm-table-widget tbody td.is-col-selected': {
    background: 'hsl(var(--primary, 220 90% 55%) / 0.12)',
  },
  '.cm-table-widget thead th.is-col-selected::after, .cm-table-widget tbody td.is-col-selected::after': {
    content: '""',
    position: 'absolute',
    inset: '0',
    background: 'hsl(var(--primary, 220 90% 55%) / 0.08)',
    pointerEvents: 'none',
  },

                                                           
                                                                
                                                        
                                                             
                                                       
  '.cm-table-widget .table-row-drag-handle, .cm-table-widget .table-col-drag-handle': {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'hsl(var(--primary, 220 90% 55%) / 0.85)',
    color: '#fff',
    cursor: 'grab',
    opacity: '0',
    transition: 'opacity 80ms ease',
    zIndex: '3',
  },
  '.cm-table-widget .table-row-drag-handle': {
    top: '0',
    right: '100%',
    width: '14px',
    height: '100%',
    borderRadius: '3px 0 0 3px',
  },
  '.cm-table-widget .table-col-drag-handle': {
    bottom: '100%',
    left: '0',
    width: '100%',
    height: '14px',
    borderRadius: '3px 3px 0 0',
  },
  '.cm-table-widget .table-row-drag-handle > svg, .cm-table-widget .table-col-drag-handle > svg': {
    pointerEvents: 'none',
  },
  '.cm-table-widget .table-row-drag-handle:hover, .cm-table-widget .table-col-drag-handle:hover, .cm-table-widget .table-row-drag-handle.is-active, .cm-table-widget .table-col-drag-handle.is-active': {
    opacity: '1',
  },
  '.cm-table-widget .table-row-drag-handle:active, .cm-table-widget .table-col-drag-handle:active': {
    cursor: 'grabbing',
  },
                                                           
                                                    
                                                   
  '.cm-table-widget.is-mounting .table-row-drag-handle, .cm-table-widget.is-mounting .table-col-drag-handle': {
    opacity: '0 !important',
    transition: 'none !important',
    pointerEvents: 'none !important',
  },

                                                                                     
                                                                 
                                                                           
                                                                                  
                                                                          
  '.cm-table-widget .table-row-btn, .cm-table-widget .table-col-btn': {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'hsl(var(--muted-foreground, 215 15% 55%))',
    background: 'transparent',
    border: '1px solid hsl(var(--border, 215 15% 80%))',
    padding: '0',                                                           
    margin: '0',
    font: 'inherit',                                                     
    opacity: '0',
    transition: 'opacity 0s 0.1s',
    userSelect: 'none',
    cursor: 'pointer',
    zIndex: '2',
  },
  '.cm-table-widget .table-row-btn > svg, .cm-table-widget .table-col-btn > svg': {
    pointerEvents: 'none',                                                     
  },
  '.cm-table-widget .table-row-btn:hover, .cm-table-widget .table-row-btn:focus-visible, .cm-table-widget .table-col-btn:hover, .cm-table-widget .table-col-btn:focus-visible': {
    opacity: '1',
  },
  '.cm-table-widget .table-row-btn:hover, .cm-table-widget .table-col-btn:hover': {
    background: 'hsl(var(--accent, 215 15% 92%))',
    color: 'hsl(var(--foreground, 215 15% 15%))',
  },
                                              
  '.cm-table-widget .table-row-btn': {
    top: '100%',
    left: '0',
    width: '100%',
    height: '16px',
    borderTop: 'none',
    cursor: 's-resize',
  },
                                                         
  '.cm-table-widget .table-col-btn': {
    top: '0',
    left: '100%',
    height: '100%',
    width: '16px',
    borderLeft: 'none',
    cursor: 'e-resize',
  },

            
  '.cm-table-menu': {
    minWidth: '200px',
    padding: '4px 0',
    background: 'hsl(var(--popover, 0 0% 100%))',
    color: 'hsl(var(--popover-foreground, 215 15% 15%))',
    border: '1px solid hsl(var(--border, 215 15% 80%))',
    borderRadius: '6px',
    boxShadow: '0 8px 24px hsl(var(--foreground, 215 15% 15%) / 0.15)',
    fontSize: '0.9em',
    userSelect: 'none',
  },
  '.cm-table-menu-item': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '6px 12px',
    textAlign: 'left',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'inherit',
    font: 'inherit',
  },
  '.cm-table-menu-item:hover': {
    background: 'hsl(var(--accent, 215 15% 92%))',
    color: 'hsl(var(--accent-foreground, 215 15% 15%))',
  },
                                            
  '.cm-table-menu-item.is-warning': {
    color: 'hsl(var(--destructive, 0 72% 51%))',
  },
  '.cm-table-menu-item.is-warning .cm-table-menu-icon': {
    color: 'hsl(var(--destructive, 0 72% 51%))',
  },
  '.cm-table-menu-item.is-warning:hover': {
    background: 'hsl(var(--destructive, 0 72% 51%) / 0.12)',
    color: 'hsl(var(--destructive, 0 72% 51%))',
  },
  '.cm-table-menu-icon': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    color: 'hsl(var(--muted-foreground, 215 15% 55%))',
    flexShrink: '0',
  },
  '.cm-table-menu-label': {
    flex: '1',
    whiteSpace: 'nowrap',
  },
  '.cm-table-menu-sep': {
    height: '1px',
    margin: '4px 0',
    background: 'hsl(var(--border, 215 15% 80%) / 0.6)',
  },

  // YAML Frontmatter
  '.cm-md-frontmatter-line': {
    backgroundColor: 'hsl(var(--muted, 215 15% 90%) / 0.45)',
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: '0.88em',
    color: 'hsl(var(--muted-foreground, 215 15% 55%))',
  },
  '.cm-md-frontmatter-fence': {
    color: 'hsl(var(--muted-foreground, 215 15% 55%))',
    borderTop: '1px solid hsl(var(--border, 215 15% 80%) / 0.6)',
    borderBottom: '1px solid hsl(var(--border, 215 15% 80%) / 0.6)',
  },

       
  '.cm-md-footnote-ref': {
    color: 'hsl(var(--primary, 220 90% 55%))',
    fontSize: '0.78em',
    verticalAlign: 'super',
    lineHeight: '1',
  },
  '.cm-md-footnote-def': {
    fontSize: '0.92em',
    color: 'hsl(var(--muted-foreground, 215 15% 55%))',
    paddingLeft: '1rem',
  },
  '.cm-md-footnote-def-mark': {
    color: 'hsl(var(--primary, 220 90% 55%))',
    fontWeight: '600',
  },

  // Mermaid
  '.cm-md-mermaid': {
    display: 'block',
    position: 'relative',
    margin: '0.6em 0',
    padding: '0.25rem 0',
    textAlign: 'center',
    overflowX: 'auto',
  },
  '.cm-md-mermaid svg': {
    maxWidth: '100%',
    height: 'auto',
  },
  '.cm-md-mermaid-edit': {
    appearance: 'none',
    position: 'absolute',
    top: '6px',
    right: '6px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    padding: '0',
    border: '1px solid hsl(var(--border, 215 15% 85%))',
    background: 'hsl(var(--background, 0 0% 100%) / 0.85)',
    color: 'hsl(var(--muted-foreground, 215 15% 45%))',
    borderRadius: '5px',
    cursor: 'pointer',
    opacity: '0',
    transition: 'opacity 120ms ease, color 120ms ease, background 120ms ease',
  },
  '.cm-md-mermaid:hover .cm-md-mermaid-edit': {
    opacity: '1',
  },
  '.cm-md-mermaid-edit:hover': {
    color: 'hsl(var(--foreground, 215 15% 15%))',
    background: 'hsl(var(--muted, 215 15% 90%) / 0.9)',
  },
  '.cm-md-mermaid-loading': {
    color: 'hsl(var(--muted-foreground, 215 15% 55%))',
    fontStyle: 'italic',
    fontSize: '0.9em',
  },
  '.cm-md-mermaid-error': {
    color: 'hsl(var(--destructive, 0 70% 55%))',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.85em',
    whiteSpace: 'pre-wrap',
    textAlign: 'left',
  },

                
  '.cm-md-math': {
    fontFamily: 'KaTeX_Main, Cambria Math, serif',
  },
  '.cm-md-math-inline': {
    display: 'inline-block',
    verticalAlign: 'baseline',
  },
  '.cm-md-math-display': {
    display: 'block',
    margin: '0.5em 0',
    textAlign: 'center',
    overflowX: 'auto',
  },
  '.cm-md-math-error': {
    color: 'hsl(var(--destructive, 0 70% 55%))',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },
  '.cm-md-math-src': {
    color: 'hsl(var(--accent-foreground, 215 50% 35%))',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.9em',
    backgroundColor: 'hsl(var(--muted, 215 15% 90%) / 0.35)',
    padding: '0 2px',
    borderRadius: '2px',
  },
})

export function livePreviewExtension(options: {
  sourcePath?: string
  revealSourceOnFocus?: boolean
} = {}) {
  return [
    editorFocusField,
    revealedImageSourceField,
    livePreviewRevealSourceFacet.of(options.revealSourceOnFocus !== false),
                                                           
                                                                    
                                                                
                                      
    EditorView.domEventHandlers({
      focus(_e, view) {
        if (view.state.field(editorFocusField, false)) return
        view.dispatch({ effects: editorFocusEffect.of(true) })
      },
      blur(_e, view) {
        if (!view.state.field(editorFocusField, false)) return
        view.dispatch({ effects: editorFocusEffect.of(false) })
      },
                                                                      
                                                                        
                                                         
                                                               
                    
      //
                                                            
                                                       
                                         
      mousedown(event, view) {
        if (event.button !== 0) return false
        const target = event.target as HTMLElement | null
        if (!target) return false
        const linkEl = target.closest<HTMLElement>(
          '.cm-md-link[data-href], .cm-md-link-external-icon[data-href]',
        )
        if (!linkEl) return false
        const href = linkEl.getAttribute('data-href')
        if (!href) return false
        const isExternalIcon = linkEl.classList.contains('cm-md-link-external-icon')
        if (!isExternalIcon) {
          const pos = view.posAtDOM(linkEl)
          let linkFrom = -1
          let linkTo = -1
          syntaxTree(view.state).iterate({
            from: pos,
            to: Math.min(pos + 1, view.state.doc.length),
            enter(node) {
              if (node.name === 'Link') {
                linkFrom = node.from
                linkTo = node.to
              }
            },
          })
          if (linkFrom !== -1) {
            const ctx = buildSelectionContext(view.state)
            if (rangeIsActive(ctx, linkFrom, linkTo)) {
              return false
            }
          }
        }
        event.preventDefault()
        event.stopPropagation()
        window.open(href, '_blank', 'noopener,noreferrer')
        return true
      },
    }),
    livePreviewField,
    livePreviewTheme,
    livePreviewSourcePathFacet.of(options.sourcePath ?? ''),
  ]
}
