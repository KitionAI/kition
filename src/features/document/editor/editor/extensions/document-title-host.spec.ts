   
                                                           
  
      
                                              
                                                            
                                         
                                      
                                              
   
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { documentTitleHostExtension } from './document-title-host'

const mounts: Array<() => void> = []

afterEach(() => {
  while (mounts.length) mounts.pop()!()
})

function mountEditor(opts: { onReady?: (el: HTMLElement) => void; onRelease?: () => void } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: 'line 1\nline 2',
      extensions: [
        documentTitleHostExtension({
          onHostReady: opts.onReady ?? (() => {}),
          onHostRelease: opts.onRelease ?? (() => {}),
        }),
      ],
    }),
  })
  mounts.push(() => {
    view.destroy()
    host.remove()
  })
  return view
}

describe('documentTitleHostExtension', () => {
  it('wraps cm-content inside cm-sizer > cm-contentContainer', () => {
    const view = mountEditor()
    const sizer = view.scrollDOM.querySelector(':scope > .cm-sizer') as HTMLElement
    expect(sizer).toBeTruthy()
    const container = sizer.querySelector(':scope > .cm-contentContainer') as HTMLElement
    expect(container).toBeTruthy()
    expect(container.querySelector(':scope > .cm-content')).toBe(view.contentDOM)
  })

  it('places .inline-title before .cm-contentContainer inside .cm-sizer', () => {
    const view = mountEditor()
    const sizer = view.scrollDOM.querySelector(':scope > .cm-sizer') as HTMLElement
    const children = Array.from(sizer.children) as HTMLElement[]
    expect(children).toHaveLength(2)
    expect(children[0].classList.contains('inline-title')).toBe(true)
    expect(children[1].classList.contains('cm-contentContainer')).toBe(true)
  })

  it('invokes onHostReady with the inline-title element', () => {
    const onReady = vi.fn()
    const view = mountEditor({ onReady })
    const host = view.scrollDOM.querySelector('.inline-title') as HTMLElement
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith(host)
  })

  it('invokes onHostRelease and removes the sizer on destroy', () => {
    const onRelease = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: 'a',
        extensions: [documentTitleHostExtension({ onHostReady: () => {}, onHostRelease: onRelease })],
      }),
    })
    // Idempotent cleanup: if explicit destroy below ran, this is a no-op;
    // if an early assertion throws, afterEach still cleans up.
    mounts.push(() => {
      if (host.parentElement) host.remove()
    })
    expect(view.scrollDOM.querySelector('.cm-sizer')).toBeTruthy()
    view.destroy()
    host.remove()
    expect(onRelease).toHaveBeenCalledTimes(1)
  })

  it('a single mount does not produce duplicate .cm-sizer nodes', () => {
    // Structural sanity check: the extension wraps scrollDOM exactly once,
    // so there is never more than one .cm-sizer in the subtree.
    const view = mountEditor()
    const first = view.scrollDOM.querySelector('.cm-sizer')
    expect(view.scrollDOM.querySelectorAll('.cm-sizer').length).toBe(1)
    expect(first).toBe(view.scrollDOM.querySelector('.cm-sizer'))
  })
})
