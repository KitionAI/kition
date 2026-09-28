import { EditorView } from '@codemirror/view'

import {
  canPasteNativeDocumentClipboardImage,
  collectDocumentClipboardImages,
  importDocumentClipboardImages,
} from '@/features/document/lib/documentImagePaste'

export type PasteImageExtensionOptions = {
  /** Workspace-relative path of the edited document; pasted image links are written relative to its folder. */
  sourcePath?: string
}

/**
 * Pasting an image (a file, an image-only HTML fragment, or a native
 * clipboard bitmap) stores it in the workspace attachments folder and
 * inserts a standard Markdown image link at the cursor.
 */
export function pasteImageExtension({ sourcePath = '' }: PasteImageExtensionOptions = {}) {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const data = event.clipboardData
      const images = collectDocumentClipboardImages(data)
      if (images.length === 0 && !canPasteNativeDocumentClipboardImage(data)) return false
      event.preventDefault()
      void (async () => {
        const inserts = await importDocumentClipboardImages(images, {
          preferNativeClipboard: true,
          documentPath: sourcePath,
        })
        if (inserts.length === 0) return
        const sel = view.state.selection.main
        const insertText = inserts.join('\n')
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: insertText },
          selection: { anchor: sel.from + insertText.length },
          userEvent: 'input.paste',
        })
      })()
      return true
    },
  })
}
