import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { DocumentAgentActionRequest } from '@/features/document/lib/documentAgentActions'
import { buildEditorContextMenu } from '../buildEditorContextMenu'

export function editorContextMenuExtension(options: {
  onAskAgent?: (request: DocumentAgentActionRequest) => void
  /** Opens the translation card for the current selection. */
  onTranslate?: () => void
} = {}): Extension {
  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      const menu = buildEditorContextMenu(view, options)
      menu.showAtMouseEvent(event)
      return true
    },
  })
}
