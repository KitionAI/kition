import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { forwardRef, useCallback, useMemo } from 'react'
import { useBufferedCodeMirrorValue } from '@/features/document/editor/hooks/useBufferedCodeMirrorValue'
import {
  canPasteNativeDocumentClipboardImage,
  collectDocumentClipboardImages,
  documentClipboardImagesFromFiles,
  importDocumentClipboardImages,
} from '@/features/document/lib/documentImagePaste'
import { cn } from '@/lib/utils'

const basicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  autocompletion: false,
  searchKeymap: false,
} as const

export type MarkdownCursorSnapshot = {
  markdown: string
  cursorOffset: number
}

type MarkdownSourceEditorProps = {
  value: string
  readOnly: boolean
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  onCreateEditor?: (view: EditorView) => void
  onCursorChange?: (snapshot: MarkdownCursorSnapshot) => void
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

const imagePasteExtension = EditorView.domEventHandlers({
  paste: (event, view) => {
    if (view.state.readOnly) return false
    const images = collectDocumentClipboardImages(event.clipboardData)
    if (!images.length && !canPasteNativeDocumentClipboardImage(event.clipboardData)) return false
    event.preventDefault()
    void importDocumentClipboardImages(images, { preferNativeClipboard: true }).then((snippets) => {
      insertImagesAtCursor(view, snippets)
    })
    return true
  },
  drop: (event, view) => {
    if (view.state.readOnly) return false
    const images = documentClipboardImagesFromFiles(event.dataTransfer?.files)
    if (!images.length) return false
    event.preventDefault()
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
    view.dispatch({ selection: { anchor: pos } })
    void importDocumentClipboardImages(images).then((snippets) => {
      insertImagesAtCursor(view, snippets)
    })
    return true
  },
})

export const MarkdownSourceEditor = forwardRef<ReactCodeMirrorRef, MarkdownSourceEditorProps>(
  function MarkdownSourceEditor(
    { value, readOnly, onChange, placeholder, className, onCreateEditor, onCursorChange },
    ref,
  ) {
    const {
      compositionExtension,
      editorValue,
      handleEditorChange,
    } = useBufferedCodeMirrorValue({ value, onChange })

    const extensions = useMemo(
      () => [
        markdownLanguage(),
        compositionExtension,
        EditorView.lineWrapping,
        imagePasteExtension,
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
      [compositionExtension, onCursorChange],
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
        value={editorValue}
        onChange={handleEditorChange}
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
