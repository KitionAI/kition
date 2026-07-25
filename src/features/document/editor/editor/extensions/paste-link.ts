   
                                     
  
      
                                            
                                       
                
   

import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

const URL_RE = /^https?:\/\/\S+$/i

export function pasteLinkExtension(): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const text = event.clipboardData?.getData('text/plain')?.trim() ?? ''
      if (!text || !URL_RE.test(text)) return false
      const main = view.state.selection.main
      if (main.empty) return false
      const selected = view.state.sliceDoc(main.from, main.to)
                           
      if (selected.includes('\n')) return false
      event.preventDefault()
      const insert = `[${selected}](${text})`
      view.dispatch({
        changes: { from: main.from, to: main.to, insert },
        selection: { anchor: main.from + insert.length },
      })
      return true
    },
  })
}
