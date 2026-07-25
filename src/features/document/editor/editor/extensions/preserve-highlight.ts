   
                                        
  
                                                                       
                                                   
                                                  
  
                                                          
                                                               
                                              
                                                                
                                                                         
                                                               
                                                                  
                                                    
                                                                  
                                                 
                                                              
                                                  
  
                                                              
                                                           
                                               
                                   
  
                                         
                                                   
                            
  
                                               
  
      
                                                            
                                                         
                                                                        
                                                                          
                                                            
                                                                     
                                                                          
                                                            
                                                      
                                                                  
                                                                    
                                                         
                                                       
                                                            
                                    
   

import { defaultHighlightStyle, HighlightStyle, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { highlightTree, tags } from '@lezer/highlight'
import type { Tree } from '@lezer/common'

                                                                  
                                                          
                                                         
                                                             
//
                                                                       
                                                               
                                                     
                                                                     
const themedLinkHighlightStyle = HighlightStyle.define([
  { tag: tags.url, color: 'hsl(var(--primary)) !important', textDecoration: 'underline' },
  { tag: tags.link, color: 'hsl(var(--primary)) !important', textDecoration: 'underline' },
])
                                                        
                                                                     
                                                                    
                                                            
                                                      
                   
//
                                                           
                                                         
                                                           
                                                                
                                                  
const codeThemeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'hsl(var(--code-keyword)) !important' },
  { tag: [tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: 'hsl(var(--code-keyword)) !important' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'hsl(var(--code-function)) !important' },
  // legacy shell "builtin"(mkdir/cd/git/npm…) → tags.standard(variableName)
  { tag: [tags.standard(tags.variableName), tags.standard(tags.name)], color: 'hsl(var(--code-function)) !important' },
  { tag: [tags.typeName, tags.namespace, tags.className], color: 'hsl(var(--code-function)) !important' },
                                                                             
  { tag: [tags.attributeName, tags.propertyName], color: 'hsl(var(--code-attr)) !important' },
  { tag: tags.operator, color: 'hsl(var(--code-attr)) !important' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'hsl(var(--code-string)) !important' },
  { tag: [tags.number, tags.integer, tags.float, tags.literal, tags.bool, tags.atom], color: 'hsl(var(--code-number)) !important' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'hsl(var(--code-comment)) !important', fontStyle: 'italic' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: 'hsl(var(--code-text)) !important' },
                                                                  
                                                                  
                                                           
  { tag: tags.labelName, color: 'hsl(var(--muted-foreground)) !important' },
])
                                                                       
                                                                 
const activeHighlighters = [defaultHighlightStyle, themedLinkHighlightStyle, codeThemeHighlightStyle]

class PreserveHighlighter {
  decorations: DecorationSet
  private tree: Tree
  private decoratedTo: number
  private readonly markCache: Record<string, Decoration> = Object.create(null)

  constructor(view: EditorView) {
    this.tree = syntaxTree(view.state)
    this.decorations = this.buildDeco(view)
    this.decoratedTo = view.viewport.to
  }

  update(update: ViewUpdate) {
    const view = update.view
    const viewportTo = view.viewport.to
    const ready = syntaxTreeAvailable(update.state, viewportTo)

    if (!ready) {
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes)
        this.decoratedTo = update.changes.mapPos(this.decoratedTo, 1)
      }
      return
    }

    const newTree = syntaxTree(update.state)
    if (newTree !== this.tree || update.viewportChanged || update.docChanged) {
      this.tree = newTree
      this.decorations = this.buildDeco(view)
      this.decoratedTo = viewportTo
    }
  }

  private buildDeco(view: EditorView): DecorationSet {
    if (!this.tree.length) return Decoration.none
    const builder = new RangeSetBuilder<Decoration>()
    for (const { from, to } of view.visibleRanges) {
      highlightTree(
        this.tree,
        activeHighlighters,
        (a, b, cls) => {
          builder.add(
            a,
            b,
            this.markCache[cls] ?? (this.markCache[cls] = Decoration.mark({ class: cls })),
          )
        },
        from,
        to,
      )
    }
    return builder.finish()
  }
}

                                                                
                
const preserveHighlightPlugin = ViewPlugin.fromClass(PreserveHighlighter, {
  decorations: (v) => v.decorations,
})
                                                                   
                                                                     
                                                
                                                       
const preserveHighlightStyle = [
  ...(defaultHighlightStyle.module ? [EditorView.styleModule.of(defaultHighlightStyle.module)] : []),
  ...(themedLinkHighlightStyle.module ? [EditorView.styleModule.of(themedLinkHighlightStyle.module)] : []),
  ...(codeThemeHighlightStyle.module ? [EditorView.styleModule.of(codeThemeHighlightStyle.module)] : []),
]
const cachedExtension = [preserveHighlightPlugin, ...preserveHighlightStyle]

export function preserveHighlightExtension() {
  return cachedExtension
}
