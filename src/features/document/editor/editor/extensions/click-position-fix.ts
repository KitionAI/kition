   
                      
  
                                                                                  
                                                                 
                                                                   
                                                                
                                                  
                                                    
                       
  
                                                                           
                                                        
                                                              
  
                                                       
                                                                              
                                                      
                   
  
              
                                                                
                                                          
                                                              
                                            
                                                               
                                            
   

import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

                                            
function domPosFromPoint(view: EditorView, x: number, y: number): number | null {
  const anyDoc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  let node: Node | null = null
  let offset = 0
  if (anyDoc.caretPositionFromPoint) {
    const c = anyDoc.caretPositionFromPoint(x, y)
    if (!c) return null
    node = c.offsetNode
    offset = c.offset
  } else if (anyDoc.caretRangeFromPoint) {
    const r = anyDoc.caretRangeFromPoint(x, y)
    if (!r) return null
    node = r.startContainer
    offset = r.startOffset
  } else {
    return null
  }
  if (!node || !view.contentDOM.contains(node)) return null
  try {
    return view.posAtDOM(node, offset)
  } catch {
    return null
  }
}

export function clickPositionFixExtension(): Extension {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0) return null
                                                       
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return null
                        
    if (event.detail > 1) return null
                                                        
    const target = event.target as HTMLElement | null
    if (!target || !target.closest('.cm-line')) return null

                                                 
    const posAt = (ev: MouseEvent): number => {
      const dom = domPosFromPoint(view, ev.clientX, ev.clientY)
      if (dom != null) return dom
      return view.posAtCoords({ x: ev.clientX, y: ev.clientY }, false) ?? view.state.selection.main.head
    }

                                                          
    //
                                                              
                                                                               
                                                          
                                                                
                                                  
    //
                                                         
                                  
    //
                                                                   
                                                                      
                                                               
                
    const downEvent = event
    let anchor = posAt(event)
    let startSel = view.state.selection

    return {
      update(update) {
        if (update.docChanged) {
          anchor = update.changes.mapPos(anchor)
          startSel = startSel.map(update.changes)
        }
      },
      get(curEvent, extend, multiple) {
                                              
        if (curEvent === downEvent) {
          if (extend) return startSel.replaceRange(startSel.main.extend(anchor))
          const range = EditorSelection.cursor(anchor)
          if (multiple) return startSel.addRange(range, false)
          return EditorSelection.create([range])
        }
                                                          
        const head = posAt(curEvent)
        if (extend) return startSel.replaceRange(startSel.main.extend(head))
        const range = head === anchor ? EditorSelection.cursor(head) : EditorSelection.range(anchor, head)
        if (multiple) return startSel.addRange(range, false)
        return EditorSelection.create([range])
      },
    }
  })
}
