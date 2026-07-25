   
                              
  
                                           
                                                       
   

import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { expandSnippet, loadSnippets } from '../../hooks/useSnippets'

const STOP_CHARS = new Set([' ', '\t', '\n'])

type Loader = () => ReturnType<typeof loadSnippets>

function tryExpand(view: EditorView, loader: Loader, title?: string): boolean {
  const sel = view.state.selection.main
  if (!sel.empty) return false
  const head = sel.head
  if (head < 2) return false
  const lastCh = view.state.doc.sliceString(head - 1, head)
  if (!STOP_CHARS.has(lastCh)) return false
                            
  const lineObj = view.state.doc.lineAt(head)
  const lineText = view.state.doc.sliceString(lineObj.from, head - 1)          
  const m = /(\S+)$/.exec(lineText)
  if (!m) return false
  const trigger = m[1]
  const items = loader()
  const hit = items.find((it) => it.trigger === trigger)
  if (!hit) return false
  const tokenStart = head - 1 - trigger.length
  const tokenEnd = head           
                               
  const result = expandSnippet(hit.expansion, { title })
  view.dispatch({
    changes: { from: tokenStart, to: tokenEnd - 1, insert: result.text },
    selection: { anchor: tokenStart + result.cursorOffset },
    userEvent: 'input.snippet',
  })
  return true
}

export type SnippetExtensionOptions = {
                 
  sourcePath?: string
}

export function snippetExpandExtension(options: SnippetExtensionOptions = {}) {
  let cached: ReturnType<typeof loadSnippets> | null = null
  const loader: Loader = () => {
    if (!cached) cached = loadSnippets()
    return cached
  }
  const reload = () => {
    cached = null
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('kition:document:snippets-changed', reload)
  }

  const title = options.sourcePath
    ? (options.sourcePath.split('/').pop() ?? '').replace(/\.md$/i, '')
    : undefined

  return ViewPlugin.fromClass(
    class {
      constructor(_view: EditorView) {
        // noop
      }
      update(update: ViewUpdate) {
        if (!update.docChanged) return
                                      
        let injectedWhitespace = false
        update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
          if (injectedWhitespace) return
          const text = inserted.toString()
          if (!text) return
                                 
          for (const ch of text) {
            if (STOP_CHARS.has(ch)) {
              injectedWhitespace = true
              break
            }
          }
        })
        if (!injectedWhitespace) return
                                              
        queueMicrotask(() => tryExpand(update.view, loader, title))
      }
    },
  )
}
