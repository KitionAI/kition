   
                         
  
                                                                   
                                                          
                                          
                                                         
                                             
  
                                                           
                                       
  
                                                     
                                                            
                                                            
                                 
   

import type { EditorView } from '@codemirror/view'

const RO_KEY = '__cmClickToSourceRO'

   
                                                     
  
                                                    
                                                                  
                                 
  
      
                                                                
                                                
                                                                 
   
export function attachClickToSource(
  dom: HTMLElement,
  view: EditorView,
  srcPos: number | (() => number),
): void {
  dom.addEventListener('mousedown', (event) => {
                                            
    const target = event.target as HTMLElement | null
    if (target && target !== dom) {
                                                      
      const interactive = target.closest('button, a, input, textarea, select')
      if (interactive && dom.contains(interactive)) return
    }
    event.preventDefault()
    event.stopPropagation()
    const total = view.state.doc.length
    const resolved = typeof srcPos === 'function' ? srcPos() : srcPos
    const anchor = Math.max(0, Math.min(resolved, total))
    view.dispatch({
      selection: { anchor },
      scrollIntoView: true,
      userEvent: 'select.pointer',
    })
    view.focus()
  })
}

   
                                                                 
                          
  
                                               
                                           
                                                 
                              
   
export function attachResizeMeasure(dom: HTMLElement, view: EditorView): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}
  detachResizeMeasure(dom)
  let lastH = 0
  const ro = new ResizeObserver(() => {
    const h = dom.offsetHeight
    if (h !== lastH) {
      lastH = h
      view.requestMeasure()
    }
  })
  ro.observe(dom)
  ;(dom as unknown as Record<string, unknown>)[RO_KEY] = ro
  return () => detachResizeMeasure(dom)
}

export function detachResizeMeasure(dom: HTMLElement): void {
  const slot = dom as unknown as Record<string, unknown>
  const ro = slot[RO_KEY] as ResizeObserver | undefined
  if (ro) {
    ro.disconnect()
    slot[RO_KEY] = undefined
  }
}
