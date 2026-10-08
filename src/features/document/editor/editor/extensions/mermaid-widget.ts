import { EditorView, WidgetType } from '@codemirror/view'
import i18next from 'i18next'
import { renderMermaid } from '@/services/mermaid'
import { attachResizeMeasure, detachResizeMeasure } from './_click-to-source'
import { revealMermaidSourceEffect } from './mermaid-source'
import { openMermaidPreview } from './mermaid-preview'

const CODE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string, readonly srcFrom: number, readonly sourceLength: number) {
    super()
  }
  toDOM(view: EditorView) {
    const t = i18next.getFixedT(null, 'document')
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-mermaid'

    const content = document.createElement('div')
    content.className = 'cm-md-mermaid-content'
    content.tabIndex = 0
    content.setAttribute('role', 'button')
    content.setAttribute('aria-label', t('editor.mermaid.openPreview'))
    content.title = t('editor.mermaid.openPreview')
    content.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      openMermaidPreview(this.code)
    })
    content.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      openMermaidPreview(this.code)
    })
    const indicator = document.createElement('span')
    indicator.className = 'cm-md-mermaid-loading'
    indicator.textContent = t('editor.extensions.livePreview.renderingMermaid')
    content.appendChild(indicator)
    wrap.appendChild(content)
    renderMermaid(this.code)
      .then((svg) => {
        if (!wrap.isConnected) return
        content.innerHTML = svg
        view.requestMeasure()
      })
      .catch((err: unknown) => {
        if (!wrap.isConnected) return
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
    edit.disabled = view.state.readOnly
    edit.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
    edit.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()

      const live = view.posAtDOM(wrap)
      const anchor = live >= 0 && live <= view.state.doc.length ? live : this.srcFrom
      view.dispatch({
        effects: revealMermaidSourceEffect.of({ from: anchor, to: anchor + this.sourceLength }),
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
    return other.code === this.code && other.sourceLength === this.sourceLength
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

