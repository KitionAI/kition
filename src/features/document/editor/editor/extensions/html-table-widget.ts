import { pendingImageElement } from './pending-image-widget'
import { EditorView, WidgetType } from '@codemirror/view'
import { sanitizeDocumentTableHtml } from '../../../lib/documentTableHtml'
import { resolveWorkspaceImageURL } from '@/services/workspaceFiles'
import { attachResizeMeasure, detachResizeMeasure } from './_click-to-source'

export class HtmlTableWidget extends WidgetType {
  constructor(readonly html: string, readonly sourcePath: string) { super() }

  eq(other: HtmlTableWidget) {
    return this.html === other.html && this.sourcePath === other.sourcePath
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-widget cm-html-table-widget'
    wrap.contentEditable = 'false'
    wrap.innerHTML = sanitizeDocumentTableHtml(this.html)
    for (const image of wrap.querySelectorAll('img')) {
      const source = image.getAttribute('src') || ''
      const pending = pendingImageElement(source, this.sourcePath, view)
      if (pending) { image.replaceWith(pending); continue }
      image.referrerPolicy = 'no-referrer'
      image.src = resolveWorkspaceImageURL(source, this.sourcePath)
      image.addEventListener('load', () => view.requestMeasure())
    }
    for (const link of wrap.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      link.classList.add('cm-md-link')
      link.setAttribute('data-href', link.getAttribute('href')!)
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    }
    attachResizeMeasure(wrap, view)
    return wrap
  }

  destroy(dom: HTMLElement) { detachResizeMeasure(dom) }
  ignoreEvent() { return false }
}

export const htmlTableTheme = EditorView.baseTheme({
  '.cm-html-table-widget': { whiteSpace: 'normal', lineHeight: '1.55' },
  '.cm-html-table-widget table': { width: '100%', tableLayout: 'auto' },
  '.cm-table-widget.cm-html-table-widget td, .cm-table-widget.cm-html-table-widget th': {
    padding: '6px 10px',
    overflowWrap: 'anywhere',
    minWidth: '4em',
  },
  '.cm-html-table-widget p': { margin: '0', minHeight: '1.55em' },
  '.cm-html-table-widget p + p': { marginTop: '0.35em' },
  '.cm-html-table-widget img': { maxWidth: '100%', height: 'auto' },
  '.cm-html-table-widget pre': { whiteSpace: 'pre-wrap' },
  '.cm-html-table-widget ul, .cm-html-table-widget ol': { paddingInlineStart: '1.5em' },
})
