   
                                                       
  
                                               
  
                                                            
                                                      
                                                                            
                                                      
                         
  
                                                        
                     
   
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { headingFoldIndicatorExtension } from './heading-fold-indicator'
import { livePreviewExtension } from './live-preview'

const mounts: Array<() => void> = []

afterEach(() => {
  while (mounts.length) mounts.pop()!()
})

const mountEditor = (doc: string) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreviewExtension(),
        headingFoldIndicatorExtension(),
      ],
    }),
  })
  const cleanup = () => {
    view.destroy()
    host.remove()
  }
  mounts.push(cleanup)
  return view
}

const firstHeadingFoldIndicator = (view: EditorView): Element | null => {
  const firstLine = view.dom.querySelector('.cm-content .cm-line')
  return firstLine?.querySelector('.cm-fold-indicator') ?? null
}

describe('headingFoldIndicatorExtension', () => {
  it('keeps the fold-indicator DOM stable when typing under the heading', () => {
                                                    
    const view = mountEditor('## Intro\nseed\n## Body\n')

    const before = firstHeadingFoldIndicator(view)
    expect(before, 'fold indicator should render on heading line').not.toBeNull()

                                          
    const line2 = view.state.doc.line(2)
    view.dispatch({
      changes: { from: line2.to, insert: '3' },
    })

    const after = firstHeadingFoldIndicator(view)
    expect(after, 'fold indicator should still exist after edit').not.toBeNull()
                                                     
                      
    expect(after).toBe(before)
  })

  it('keeps the fold-indicator DOM stable across multiple keystrokes', () => {
    const view = mountEditor('## Intro\nx\n## Body\n')

    const initial = firstHeadingFoldIndicator(view)
    expect(initial).not.toBeNull()

                                            
    for (let i = 0; i < 3; i++) {
      const line2 = view.state.doc.line(2)
      view.dispatch({
        changes: { from: line2.to, insert: '3' },
      })
      const current = firstHeadingFoldIndicator(view)
      expect(current, `keystroke ${i + 1}: fold indicator should be stable`).toBe(initial)
    }
  })

  it('renders the indicator on a heading whose section is empty when lang-markdown foldable() returns null', () => {
                                                               
                                                          
                                                                    
                                                 
                                  
                                                     
    const view = mountEditor('## Intro\n\n\n## Body\nbody-text\n')
    const indicator = firstHeadingFoldIndicator(view)
    expect(indicator, 'An empty heading section should still have a fold indicator').not.toBeNull()
  })
})
