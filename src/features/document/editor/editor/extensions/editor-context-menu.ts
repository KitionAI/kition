import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { buildEditorContextMenu } from '../buildEditorContextMenu'

export function editorContextMenuExtension(): Extension {
  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      const menu = buildEditorContextMenu(view)
      menu.showAtMouseEvent(event)
      return true
    },
  })
}
