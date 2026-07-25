   
                  
  
                                                       
                                       
  
                                   
                                          
                                               
   

import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view'
import katex from 'katex'
import 'katex/dist/katex.min.css'

import {
  attachClickToSource,
  attachResizeMeasure,
  detachResizeMeasure,
} from './_click-to-source'

export type MathSpan = {
                             
  from: number
                             
  to: number
                      
  tex: string
                                      
  display: boolean
}

   
                                    
                              
                    
                                     
   
export function findMathSpans(source: string): MathSpan[] {
  const spans: MathSpan[] = []
  const lines = source.split('\n')
                    
  const lineFrom: number[] = []
  {
    let off = 0
    for (const ln of lines) {
      lineFrom.push(off)
      off += ln.length + 1
    }
  }

  let inFence = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      i++
      continue
    }
    if (inFence) {
      i++
      continue
    }

                       
                                   
    const blockStartMatch = /(^|[^\\$])\$\$/.exec(line)
    if (blockStartMatch && /^\s*\$\$/.test(line)) {
      const startOnLine = line.indexOf('$$')
      const startGlobal = lineFrom[i] + startOnLine
                  
      const rest = line.slice(startOnLine + 2)
      const closeOnSameLine = rest.indexOf('$$')
      if (closeOnSameLine !== -1) {
        const tex = rest.slice(0, closeOnSameLine).trim()
        if (tex.length > 0) {
          spans.push({
            from: startGlobal,
            to: startGlobal + 2 + closeOnSameLine + 2,
            tex,
            display: true,
          })
        }
        i++
        continue
      }
                          
      let j = i + 1
      let closingLine = -1
      let closingCol = -1
      while (j < lines.length) {
        const cur = lines[j]
        const found = cur.indexOf('$$')
        if (found !== -1) {
          closingLine = j
          closingCol = found
          break
        }
        j++
      }
      if (closingLine !== -1) {
        const endGlobal = lineFrom[closingLine] + closingCol + 2
        const inner = source.slice(startGlobal + 2, lineFrom[closingLine] + closingCol)
        const tex = inner.trim()
        if (tex.length > 0) {
          spans.push({ from: startGlobal, to: endGlobal, tex, display: true })
        }
        i = closingLine + 1
        continue
      }
                     
      i++
      continue
    }

                           
    let p = 0
    while (p < line.length) {
      const dollar = line.indexOf('$', p)
      if (dollar === -1) break
             
      if (dollar > 0 && line[dollar - 1] === '\\') {
        p = dollar + 1
        continue
      }
                
      if (line[dollar + 1] === '$') {
        p = dollar + 2
        continue
      }
                             
      const afterOpen = line[dollar + 1]
      if (afterOpen === undefined || /\s/.test(afterOpen)) {
        p = dollar + 1
        continue
      }
            
      let q = dollar + 1
      let close = -1
      while (q < line.length) {
        const next = line.indexOf('$', q)
        if (next === -1) break
        if (line[next - 1] === '\\') {
          q = next + 1
          continue
        }
        if (line[next + 1] === '$') {
          q = next + 2
          continue
        }
                  
        const before = line[next - 1]
        if (before !== undefined && /\s/.test(before)) {
          q = next + 1
          continue
        }
        close = next
        break
      }
      if (close === -1) {
        p = dollar + 1
        continue
      }
      const tex = line.slice(dollar + 1, close)
      if (tex.trim().length === 0) {
        p = close + 1
        continue
      }
      spans.push({
        from: lineFrom[i] + dollar,
        to: lineFrom[i] + close + 1,
        tex,
        display: false,
      })
      p = close + 1
    }
    i++
  }

  return spans
}

class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly srcFrom: number) {
    super()
  }
  eq(other: MathWidget): boolean {
    return (
      other.tex === this.tex &&
      other.display === this.display &&
      other.srcFrom === this.srcFrom
    )
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement(this.display ? 'div' : 'span')
    root.className = this.display ? 'cm-document-math-block' : 'cm-document-math-inline'
    try {
      const html = katex.renderToString(this.tex, {
        displayMode: this.display,
        throwOnError: false,
        output: 'html',
      })
      root.innerHTML = html
    } catch (err) {
      root.textContent = `[Math error] ${(err as Error).message}`
      root.classList.add('cm-document-math-error')
    }
    if (this.display) {
      attachResizeMeasure(root, view)
    }
                                                         
                                                     
    attachClickToSource(root, view, this.srcFrom + 1)
    return root
  }
  destroy(dom: HTMLElement): void {
    detachResizeMeasure(dom)
  }
  ignoreEvent(): boolean {
    return true
  }
}

   
                                           
                                                  
                                          
  
                                   
   
class MathEditPreviewWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super()
  }
  eq(other: MathEditPreviewWidget): boolean {
    return other.tex === this.tex && other.display === this.display
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement(this.display ? 'div' : 'span')
    root.className = this.display
      ? 'cm-document-math-edit-preview'
      : 'cm-document-math-edit-hint'
    try {
      const html = katex.renderToString(this.tex, {
        displayMode: this.display,
        throwOnError: false,
        output: 'html',
      })
      root.innerHTML = html
    } catch (err) {
      root.textContent = `[Math error] ${(err as Error).message}`
      root.classList.add('cm-document-math-error')
    }
    if (this.display) {
      attachResizeMeasure(root, view)
    }
    return root
  }
  destroy(dom: HTMLElement): void {
    if (this.display) detachResizeMeasure(dom)
  }
  ignoreEvent(): boolean {
                                         
                         
    return false
  }
}

export function mathPreviewExtension(): Extension {
  function build(state: EditorState): DecorationSet {
    const doc = state.doc
    if (doc.length === 0) return Decoration.none
    const source = doc.sliceString(0)
    const spans = findMathSpans(source)
    if (spans.length === 0) return Decoration.none
    const head = state.selection.main.head
    const anchor = state.selection.main.anchor
    const selMin = Math.min(head, anchor)
    const selMax = Math.max(head, anchor)
    const decos: Range<Decoration>[] = []
    for (const span of spans) {
      const cursorInside = !(selMax < span.from || selMin > span.to)
      if (!cursorInside) {
        if (span.display) {
          const startLine = doc.lineAt(span.from)
          const endLine = doc.lineAt(span.to)
          decos.push(
            Decoration.replace({
              widget: new MathWidget(span.tex, true, startLine.from),
              block: true,
            }).range(startLine.from, endLine.to),
          )
        } else {
          decos.push(
            Decoration.replace({
              widget: new MathWidget(span.tex, false, span.from),
            }).range(span.from, span.to),
          )
        }
        continue
      }
                                     
      if (span.display) {
        const endLine = doc.lineAt(span.to)
        decos.push(
          Decoration.widget({
            widget: new MathEditPreviewWidget(span.tex, true),
            block: true,
            side: 1,
          }).range(endLine.to),
        )
      } else {
        const lineEnd = doc.lineAt(span.from).to
        decos.push(
          Decoration.widget({
            widget: new MathEditPreviewWidget(span.tex, false),
            side: 1,
          }).range(lineEnd),
        )
      }
    }
    return Decoration.set(decos, true)
  }

  const field = StateField.define<DecorationSet>({
    create(state) {
      return build(state)
    },
    update(value, tr) {
      if (!tr.docChanged && !tr.selection) return value
      return build(tr.state)
    },
    provide: (f) => EditorView.decorations.from(f),
  })

  return [field, mathTheme]
}

const mathTheme = EditorView.theme({
  '.cm-document-math-inline': {
    padding: '0 0.15em',
    fontFamily: 'KaTeX_Main, serif',
    cursor: 'text',
  },
  '.cm-document-math-block': {
    display: 'block',
    padding: '0.5em 0',
    textAlign: 'center',
  },
  '.cm-document-math-error': {
    color: 'hsl(var(--destructive))',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85em',
  },
  '.cm-document-math-edit-preview': {
    display: 'block',
    margin: '0.25em 0 0.5em',
    padding: '0.6em 0.75em',
    border: '1px solid hsl(var(--border))',
    borderRadius: 'var(--radius-s, 6px)',
    background: 'hsl(var(--muted) / 0.3)',
    textAlign: 'center',
    overflowX: 'auto',
  },
  '.cm-document-math-edit-hint': {
    display: 'inline-block',
    marginInlineStart: '0.5em',
    padding: '0 0.4em',
    borderRadius: '4px',
    background: 'hsl(var(--muted) / 0.4)',
    color: 'hsl(var(--muted-foreground))',
    fontSize: '0.9em',
    verticalAlign: 'middle',
  },
})
