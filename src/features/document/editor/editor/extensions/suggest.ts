   
                              
  
                               
                                      
                                               
                         
  
                                                                  
   

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import i18next from 'i18next'

export type WikilinkSuggestion = {
                               
  target: string
                        
  label?: string
                
  detail?: string
}

export type AnchorSuggestion = {
                   
  text: string
             
  level?: number
}

export type BlockIdSuggestion = {
                       
  id: string
                
  preview?: string
}

export type TagSuggestion = {
                   
  name: string
             
  count?: number
}

export type SuggestProviders = {
  wikilinks?: (query: string) => WikilinkSuggestion[] | Promise<WikilinkSuggestion[]>
                                             
  headingsOf?: (target: string) => AnchorSuggestion[] | Promise<AnchorSuggestion[]>
                                                      
  blockIdsOf?: (target: string) => BlockIdSuggestion[] | Promise<BlockIdSuggestion[]>
  tags?: (query: string) => TagSuggestion[] | Promise<TagSuggestion[]>
}

export function wikilinkCompletionSource(
  providers: SuggestProviders,
): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos)
    const before = line.text.slice(0, context.pos - line.from)
    const open = before.lastIndexOf('[[')
    if (open < 0) return null
                           
    const inner = before.slice(open + 2)
    if (/[\]\n]/.test(inner)) return null

    const hashIdx = inner.indexOf('#')
    if (hashIdx >= 0) {
                             
      const target = inner.slice(0, hashIdx)
      const rest = inner.slice(hashIdx + 1)
                        
      if (rest.startsWith('^') && providers.blockIdsOf) {
        const q = rest.slice(1).toLowerCase()
        const ids = await providers.blockIdsOf(target)
        const options: Completion[] = ids
          .filter((b) => !q || b.id.toLowerCase().includes(q))
          .slice(0, 50)
          .map((b) => ({
            label: `^${b.id}`,
            detail: b.preview,
            type: 'constant',
            apply: `^${b.id}`,
          }))
        return {
          from: line.from + open + 2 + hashIdx + 1,
          options,
          validFor: /^\^?[\w-]*$/,
        }
      }
      if (providers.headingsOf) {
        const q = rest.toLowerCase()
        const headings = await providers.headingsOf(target)
        const options: Completion[] = headings
          .filter((h) => !q || h.text.toLowerCase().includes(q))
          .slice(0, 50)
          .map((h) => ({
            label: h.text,
            detail: h.level != null ? `H${h.level}` : undefined,
            type: 'property',
            apply: h.text,
          }))
        return {
          from: line.from + open + 2 + hashIdx + 1,
          options,
          validFor: /^[^\]\n]*$/,
        }
      }
      return null
    }

            
    if (!providers.wikilinks) return null
    const query = inner
    const from = line.from + open + 2

    const suggestions = await providers.wikilinks(query)
    const options: Completion[] = suggestions.slice(0, 50).map((s) => ({
      label: s.label ?? s.target,
      detail: s.detail,
      type: 'class',
      apply: (view, _completion, applyFrom, applyTo) => {
        const after = view.state.doc.sliceString(applyTo, applyTo + 2) === ']]' ? '' : ']]'
        view.dispatch({
          changes: { from: applyFrom, to: applyTo, insert: s.target + after },
          selection: { anchor: applyFrom + s.target.length + after.length },
        })
      },
    }))
    return {
      from,
      options,
      validFor: /^[^\[\]\n|#]*$/,
    }
  }
}

export function tagCompletionSource(
  provider: NonNullable<SuggestProviders['tags']>,
): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos)
    const before = line.text.slice(0, context.pos - line.from)
    const m = /(?:^|[\s(>])#([\w/-]*)$/.exec(before)
    if (!m) return null
    const query = m[1]
    const startInLine = (m.index ?? 0) + m[0].length - m[1].length
    const from = line.from + startInLine
    if (!context.explicit && query.length === 0) return null

    const suggestions = await provider(query)
    const options: Completion[] = suggestions
      .slice(0, 50)
      .map((s) => ({
        label: s.name,
        detail: s.count != null ? i18next.getFixedT(null, 'document')('editor.extensions.suggest.occurrences', { count: s.count }) : undefined,
        type: 'enum',
        boost: s.count ?? 0,
      }))
    return {
      from,
      options,
      validFor: /^[\w/-]*$/,
    }
  }
}
