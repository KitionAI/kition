import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { editorContextMenuExtension } from './editor-context-menu'

describe('editorContextMenuExtension', () => {
  it('opens a menu on contextmenu and prevents default', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'hello', extensions: [editorContextMenuExtension()] }),
      parent: document.body,
    })
    const event = new MouseEvent('contextmenu', { clientX: 100, clientY: 100, bubbles: true, cancelable: true })
    view.contentDOM.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('.document-menu')).not.toBeNull()
    document.querySelectorAll('.document-menu-portal').forEach((n) => n.remove())
    view.destroy()
  })
})
