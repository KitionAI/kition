import { notifyImageImportFailure } from '@kition/document-editor'
import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { forwardRef, useCallback, useMemo } from 'react'
import { useDocumentBinding } from '@kition/document-editor/editor'
import type { DocumentTextSource } from '@kition/document-editor/model'
import {
  canPasteNativeDocumentClipboardImage,
  collectDocumentClipboardImages,
  documentClipboardImagesFromFiles,
  importDocumentClipboardImages,
} from '@kition/document-editor'
import { cn } from '@kition/app-ui/utils'

const basicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  autocompletion: false,
  searchKeymap: false,
  // Undo and redo are the replica's (`useDocumentBinding`).
  history: false,
  historyKeymap: false,
} as const

export type MarkdownCursorSnapshot = {
  markdown: string
  cursorOffset: number
}

type MarkdownSourceEditorProps = {
  /** The document text the editor edits (a session's replica). */
  source: DocumentTextSource
  readOnly: boolean
  placeholder?: string
  className?: string
  onCreateEditor?: (view: EditorView) => void
  onCursorChange?: (snapshot: MarkdownCursorSnapshot) => void
  /** Workspace-relative path of the edited document; pasted image links are written relative to its folder. */
  documentPath?: string
}

function insertImagesAtCursor(view: EditorView, snippets: string[]) {
  if (!snippets.length) return
  const insert = snippets.join('\n\n')
  const { from, to } = view.state.selection.main
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
  })
  view.focus()
}

function createImagePasteExtension(documentPath: string) {
  return EditorView.domEventHandlers({
  paste: (event, view) => {
    if (view.state.readOnly) return false
    const images = collectDocumentClipboardImages(event.clipboardData)
    if (!images.length && !canPasteNativeDocumentClipboardImage(event.clipboardData)) return false
    event.preventDefault()
    void importDocumentClipboardImages(images, { preferNativeClipboard: true, documentPath }).then((snippets) => {
      insertImagesAtCursor(view, snippets)
    }).catch(notifyImageImportFailure)
    return true
  },
  drop: (event, view) => {
    if (view.state.readOnly) return false
    const images = documentClipboardImagesFromFiles(event.dataTransfer?.files)
    if (!images.length) return false
    event.preventDefault()
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
    view.dispatch({ selection: { anchor: pos } })
    void importDocumentClipboardImages(images, { documentPath }).then((snippets) => {
      insertImagesAtCursor(view, snippets)
    }).catch(notifyImageImportFailure)
    return true
  },
  })
}

export const MarkdownSourceEditor = forwardRef<ReactCodeMirrorRef, MarkdownSourceEditorProps>(
  function MarkdownSourceEditor(
    { source, readOnly, placeholder, className, onCreateEditor, onCursorChange, documentPath = '' },
    ref,
  ) {
    const { initialText, extension: bindingExtension } = useDocumentBinding(source)

    const extensions = useMemo(
      () => [
        markdownLanguage(),
        bindingExtension,
        EditorView.lineWrapping,
        createImagePasteExtension(documentPath),
        ...(onCursorChange
          ? [EditorView.updateListener.of((update) => {
            if (!update.selectionSet && !update.docChanged) return
            onCursorChange({
              markdown: update.state.doc.toString(),
              cursorOffset: update.state.selection.main.head,
            })
          })]
          : []),
        EditorView.theme({
          '&': {
            height: '100%',
            backgroundColor: 'transparent',
            color: 'inherit',
          },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': {
            fontFamily: 'inherit',
            lineHeight: '1.75',
            padding: '1.25rem 1.75rem',
          },
          '.cm-content': {
            padding: '0',
            caretColor: 'currentColor',
          },
          '.cm-line': { padding: '0' },
          '.cm-cursor': { borderLeftColor: 'currentColor' },

          '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
            backgroundColor: 'hsl(var(--primary) / 0.3)',
          },
        }),
      ],
      [bindingExtension, onCursorChange, documentPath],
    )

    const handleCreateEditor = useCallback((view: EditorView) => {
      onCreateEditor?.(view)
      onCursorChange?.({
        markdown: view.state.doc.toString(),
        cursorOffset: view.state.selection.main.head,
      })
    }, [onCreateEditor, onCursorChange])

    return (
      <CodeMirror
        ref={ref}
        value={initialText}
        readOnly={readOnly}
        extensions={extensions}
        basicSetup={basicSetup}
        placeholder={placeholder}
        height="100%"
        className={cn('document-markdown-source', className)}
        onCreateEditor={handleCreateEditor}
      />
    )
  },
)
