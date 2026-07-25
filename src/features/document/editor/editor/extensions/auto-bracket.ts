   
                
  
                                                                   
                  
                    
                           
                
                                 
                                            
   

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'

export function autoBracketExtension() {
  return [
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
    EditorState.languageData.of(() => [
      {
        closeBrackets: {
          brackets: ['(', '[', '{', '"', "'", '`', '*', '_', '~', '$'],
        },
      },
    ]),
  ]
}
