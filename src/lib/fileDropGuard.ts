/**
 * A file dropped outside a drop zone must not reach the webview's default
 * action, which navigates to the file (and the desktop shell then opens it in
 * another app). Drop zones call `preventDefault()` themselves; anything left
 * over is refused with the "not allowed" cursor.
 */
export function carriesFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes('Files')
}

export function installFileDropGuard(target: Window = window) {
  const refuse = (event: DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
  }
  target.addEventListener('dragover', refuse)
  target.addEventListener('drop', refuse)
  return () => {
    target.removeEventListener('dragover', refuse)
    target.removeEventListener('drop', refuse)
  }
}
