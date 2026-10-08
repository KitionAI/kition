import { EditorView } from '@codemirror/view'
import i18next from 'i18next'
import { pendingImageId, pendingImageStatus, retryPendingImage } from '../../../lib/pendingImageImports'

export function pendingImageElement(source: string, documentPath: string, view: EditorView): HTMLElement | null {
  const id = pendingImageId(source)
  if (!id) return null
  const wrap = document.createElement('span')
  wrap.className = 'cm-pending-image'
  wrap.contentEditable = 'false'
  const label = document.createElement('span')
  const button = document.createElement('button')
  button.type = 'button'
  const t = i18next.getFixedT(null, 'document')
  const update = () => {
    const state = pendingImageStatus(id)
    label.textContent = t(`editor.image.importErrors.${state.reason}`)
    button.textContent = t('editor.image.retryImport')
    button.disabled = view.state.readOnly || !state.available
    view.requestMeasure()
  }
  const replace = (destination: string) => {
    if (!wrap.isConnected || view.state.readOnly) return
    const text = view.state.doc.toString()
    const changes = []
    let from = text.indexOf(source)
    while (from !== -1) {
      changes.push({ from, to: from + source.length, insert: destination })
      from = text.indexOf(source, from + source.length)
    }
    if (changes.length) view.dispatch({ changes, userEvent: 'input.image.retry' })
  }
  button.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation() })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    button.disabled = true
    button.textContent = t('editor.image.savingLocal')
    void retryPendingImage(id, documentPath).then(replace, update)
  })
  wrap.append(label, button)
  update()
  return wrap
}

export const pendingImageTheme = EditorView.baseTheme({
  '.cm-pending-image': {
    display: 'inline-flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
    padding: '12px', border: '1px solid hsl(var(--border))', borderRadius: '12px',
    whiteSpace: 'normal', fontSize: '0.9em', color: 'hsl(var(--muted-foreground))',
  },
  '.cm-pending-image button': {
    padding: '4px 10px', border: '1px solid hsl(var(--border))', borderRadius: '8px',
    color: 'hsl(var(--primary))', backgroundColor: 'hsl(var(--background))', cursor: 'pointer',
  },
})
