   
                          
  
                                                
                        
  
                                  
   

import type { EditorState, Range } from '@codemirror/state'
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'

class FootnoteHintWidget extends WidgetType {
  constructor(readonly body: string) {
    super()
  }
  eq(other: FootnoteHintWidget): boolean {
    return other.body === this.body
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-footnote-hint'
    const max = 80
    span.textContent = this.body.length > max ? this.body.slice(0, max - 1) + '…' : this.body
    span.title = this.body
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

function buildFootnoteDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = state.doc
  const cursor = state.selection.main.head
  const cursorLine = doc.lineAt(cursor).number

                         
  const defs = new Map<string, string>()
  type LineInfo = { from: number; to: number; text: string; number: number; isDef: boolean }
  const lines: LineInfo[] = []
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const defMatch = /^\[\^([^\]\s]+)\]:\s*(.*)$/.exec(line.text)
    const isDef = !!defMatch
    if (defMatch) {
      const [, id, body] = defMatch
      if (body.trim()) defs.set(id, body.trim())
    }
    lines.push({ from: line.from, to: line.to, text: line.text, number: i, isDef })
  }
  if (defs.size === 0) return builder.finish()

                             
  const decos: Range<Decoration>[] = []
  for (const info of lines) {
    if (info.isDef) continue
    if (info.number === cursorLine) continue              
    let lastEnd = -1
    const regex = /\[\^([^\]\s]+)\]/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(info.text))) {
      const id = match[1]
      const body = defs.get(id)
      if (!body) continue
      const end = info.from + match.index + match[0].length
      if (end <= lastEnd) continue
      lastEnd = end
      decos.push(
        Decoration.widget({
          widget: new FootnoteHintWidget(body),
          side: 1,
        }).range(end),
      )
    }
  }
  decos.sort((a, b) => a.from - b.from)
  for (const d of decos) builder.add(d.from, d.to, d.value)
  return builder.finish()
}

export function footnotePreviewExtension() {
  const theme = EditorView.theme({
    '.cm-footnote-hint': {
      display: 'inline-block',
      marginLeft: '0.4em',
      padding: '0 6px',
      fontSize: '10.5px',
      lineHeight: '16px',
      color: 'var(--muted-foreground, #888)',
      background: 'var(--accent, rgba(0,0,0,0.04))',
      borderRadius: '4px',
      userSelect: 'none',
      verticalAlign: 'middle',
      maxWidth: '40ch',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  })
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildFootnoteDecorations(view.state)
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildFootnoteDecorations(update.state)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
  return [theme, plugin]
}
