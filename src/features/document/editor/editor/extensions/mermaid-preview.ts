import i18next from 'i18next'
import { renderMermaid } from '@/services/mermaid'
import './mermaid-preview.css'

/** A native modal keeps keyboard focus inside the enlarged diagram. */
export function openMermaidPreview(code: string) {
  const t = i18next.getFixedT(null, 'document')
  const dialog = document.createElement('dialog')
  dialog.className = 'document-mermaid-preview'
  dialog.setAttribute('aria-label', t('editor.mermaid.preview'))
  const header = document.createElement('header')
  const title = document.createElement('strong')
  title.textContent = t('editor.mermaid.preview')
  header.append(title)
  const stage = document.createElement('div')
  stage.className = 'document-mermaid-preview-stage'
  stage.textContent = t('editor.extensions.livePreview.renderingMermaid')
  let svg: SVGSVGElement | null = null
  let zoom = 1
  const fit = () => {
    if (!svg) return
    const box = svg.viewBox.baseVal
    if (!box.width || !box.height) return
    const scale = Math.min((stage.clientWidth - 48) / box.width, (stage.clientHeight - 48) / box.height) * zoom
    svg.style.width = `${box.width * scale}px`
    svg.style.height = `${box.height * scale}px`
    svg.style.maxWidth = 'none'
  }
  const button = (label: string, text: string, action: () => void) => {
    const control = document.createElement('button')
    control.type = 'button'
    control.textContent = text
    control.setAttribute('aria-label', label)
    control.title = label
    control.addEventListener('click', action)
    header.append(control)
    return control
  }
  button(t('editor.mermaid.zoomOut'), '−', () => { zoom = Math.max(0.25, zoom / 1.25); fit() })
  button(t('editor.mermaid.fit'), t('editor.mermaid.fit'), () => { zoom = 1; fit() })
  button(t('editor.mermaid.zoomIn'), '+', () => { zoom = Math.min(8, zoom * 1.25); fit() })
  const close = button(t('editor.image.closePreview'), '×', () => dialog.close())
  dialog.append(header, stage)
  document.body.append(dialog)
  const observer = new ResizeObserver(fit)
  observer.observe(stage)
  dialog.addEventListener('close', () => { observer.disconnect(); dialog.remove() }, { once: true })
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close() })
  dialog.showModal()
  close.focus()
  void renderMermaid(code).then((markup) => {
    if (!dialog.isConnected) return
    stage.innerHTML = markup
    svg = stage.querySelector('svg')
    fit()
  }, () => {
    if (dialog.isConnected) stage.textContent = t('editor.mermaid.previewFailed')
  })
}
