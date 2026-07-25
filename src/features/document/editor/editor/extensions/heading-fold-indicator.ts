   
                         
  
                                 
                                             
                                                                
                                                
                                             
                                  
  
                                         
                                                                         
                                                                                   
   

import {
  foldEffect,
  foldable,
  foldedRanges,
  syntaxTree,
  unfoldEffect,
} from '@codemirror/language'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'

class HeadingFoldWidget extends WidgetType {
  constructor(readonly collapsed: boolean) {
    super()
  }

  eq(other: HeadingFoldWidget): boolean {
                                                             
                                                                
                                                                    
                                
                                             
    return other.collapsed === this.collapsed
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('span')
    container.className = 'cm-fold-indicator'
    if (this.collapsed) container.classList.add('is-collapsed')

    const indicator = document.createElement('span')
    indicator.className = 'collapse-indicator collapse-icon'
                                                  
    indicator.innerHTML
      = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'

    indicator.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
                                                             
                                                   
      const pos = view.posAtDOM(container)
      const line = view.state.doc.lineAt(pos)
      const range = foldable(view.state, line.from, line.to)
      if (!range) return
      const effect = this.collapsed
        ? unfoldEffect.of({ from: range.from, to: range.to })
        : foldEffect.of({ from: range.from, to: range.to })
      view.dispatch({ effects: effect })
    })

    container.appendChild(indicator)
    return container
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click'
  }
}

const HEADING_LINE_RE = /^(#{1,6})\s/

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { state } = view
  const { doc } = state
  const folded = foldedRanges(state)

  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = doc.lineAt(pos)
      if (HEADING_LINE_RE.test(line.text)) {
                                             
                                                                            
                                                                  
                                                         
                                                        
                                                                
                              
        const range = foldable(state, line.from, line.to)
        let collapsed = false
        if (range) {
          folded.between(range.from, range.from, (foldFrom, foldTo) => {
            if (foldFrom === range.from && foldTo === range.to) {
              collapsed = true
              return false
            }
            return undefined
          })
        }
        builder.add(
          line.from,
          line.from,
          Decoration.widget({
            widget: new HeadingFoldWidget(collapsed),
            side: 1,
          }),
        )
      }
      const nextLineStart = line.to + 1
      if (nextLineStart > doc.length) break
      pos = nextLineStart
    }
  }
  return builder.finish()
}

function foldedRangesChanged(update: ViewUpdate): boolean {
  return foldedRanges(update.startState) !== foldedRanges(update.state)
}

export function headingFoldIndicatorExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view)
      }
      update(update: ViewUpdate) {
                                                       
                                                        
                                                                   
                                                    
                                          
        if (
          update.docChanged
          || update.viewportChanged
          || foldedRangesChanged(update)
          || syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = buildDecorations(update.view)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}
