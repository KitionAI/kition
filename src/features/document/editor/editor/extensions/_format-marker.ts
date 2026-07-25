   
                                
  
                                                                  
  
                                      
                              
                    
                                                                       
                                                                  
                                                                
        
      
  
                                                                     
  
                                                   
                                                        
                   
                                                             
                                       
  
         
                                                                             
                                                                 
                                  
                                                                                      
                                                                                
                                                                                          
                                                                      
                                                                         
                                 
   

import { StateEffect, StateField, type EditorState } from '@codemirror/state'

   
                                                                            
                                          
   
export const editorFocusEffect = StateEffect.define<boolean>()

   
                                                           
                                                        
                                                          
                                                                              
   
export const editorFocusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(editorFocusEffect)) return e.value
    return value
  },
})

export type SelectionContext = {
     
                                                               
                                                         
     
  readonly activeLines: ReadonlySet<number>
     
                                                                        
                                                                                  
     
  readonly ranges: readonly { from: number; to: number }[]
}

export function buildSelectionContext(state: EditorState): SelectionContext {
                                                           
                              
  const focused = state.field(editorFocusField, false) ?? false
  const activeLines = new Set<number>()
  if (!focused) {
    return { activeLines, ranges: [] }
  }
  const ranges: { from: number; to: number }[] = []
  for (const r of state.selection.ranges) {
    activeLines.add(state.doc.lineAt(r.head).number)
    ranges.push({ from: r.head, to: r.head })
  }
  return { activeLines, ranges }
}

export function lineIsActive(ctx: SelectionContext, lineNumber: number): boolean {
  return ctx.activeLines.has(lineNumber)
}

   
                                 
  
                                                                  
  
                                                                     
                                                                               
  
                                                                        
                                                        
                                
  
                                                     
                                    
   
export function rangeIsActive(
  ctx: SelectionContext,
  from: number,
  to: number,
): boolean {
  return ctx.ranges.some((r) => r.from <= to && r.to >= from)
}

   
                                        
                           
  
                                                                  
   
export function lineTextIsJustMarker(
  state: EditorState,
  lineNumber: number,
  markerFrom: number,
  markerTo: number,
): boolean {
  const line = state.doc.line(lineNumber)
  const lineText = line.text.trim()
  const markerText = state.doc.sliceString(markerFrom, markerTo).trim()
  return lineText === markerText
}

   
                    
  
                                                      
   
export function shouldHideLineMarker(
  ctx: SelectionContext,
  state: EditorState,
  lineNumber: number,
  markerFrom: number,
  markerTo: number,
): boolean {
  if (lineIsActive(ctx, lineNumber)) return false
  if (lineTextIsJustMarker(state, lineNumber, markerFrom, markerTo)) return false
  return true
}

   
                    
  
                                            
                      
   
export function shouldHideInlineMarker(
  ctx: SelectionContext,
  from: number,
  to: number,
): boolean {
  return !rangeIsActive(ctx, from, to)
}
