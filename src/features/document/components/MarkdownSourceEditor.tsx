import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView } from '@codemirror/view'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { forwardRef, useMemo } from 'react'
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

type MarkdownSourceEditorProps = {
  value: string
  readOnly: boolean
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  onCreateEditor?: (view: EditorView) => void
}

function collectImageFiles(list: DataTransferItemList | FileList | null | undefined): File[] {
  if (!list) return []
  const files: File[] = []
  if ('length' in list) {
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i]
      if (!entry) continue
      if (entry instanceof File) {
        if (entry.type.startsWith('image/')) files.push(entry)
        continue
      }
      const item = entry as DataTransferItem
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
  }
  return files
}

function insertImagesAtCursor(view: EditorView, files: File[]) {
  if (!files.length) return
  const snippets = files.map((file) => {
    const url = URL.createObjectURL(file)
    const baseName = (file.name || '').replace(/\.[^.]+$/, '') || 'image'
    return `![${baseName}](${url})`
  })
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
    const files = collectImageFiles(event.clipboardData?.items)
    if (!files.length) return false
    event.preventDefault()
    insertImagesAtCursor(view, files)
    return true
  },
  drop: (event, view) => {
    if (view.state.readOnly) return false
    const files = collectImageFiles(event.dataTransfer?.files)
    if (!files.length) return false
    event.preventDefault()
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
    view.dispatch({ selection: { anchor: pos } })
    insertImagesAtCursor(view, files)
    return true
  },
})

export const MarkdownSourceEditor = forwardRef<ReactCodeMirrorRef, MarkdownSourceEditorProps>(
  function MarkdownSourceEditor(
    { value, readOnly, onChange, placeholder, className, onCreateEditor },
    ref,
  ) {
    const extensions = useMemo(
      () => [
        markdownLanguage(),
        EditorView.lineWrapping,
        imagePasteExtension,
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
      [],
    )

    return (
      <CodeMirror
        ref={ref}
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        extensions={extensions}
        basicSetup={basicSetup}
        placeholder={placeholder}
        height="100%"
        className={cn('document-markdown-source', className)}
        onCreateEditor={onCreateEditor}
      />
    )
  },
)
