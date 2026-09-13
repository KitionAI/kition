   
                                                      
                                                                                            
                                                                    
  
                                                                       
                          
                                              
                                                                  
                                                         
                                                 
                                   
  
                                                            
                                                    
                                                                
                         
   
import { type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view'

export type DocumentTitleHostOptions = {
  onHostReady: (el: HTMLElement) => void
  onHostRelease: () => void
}

export function documentTitleHostExtension(opts: DocumentTitleHostOptions): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private titleHost: HTMLElement | null = null
      private sizerEl: HTMLElement | null = null
      private contentContainerEl: HTMLElement | null = null
      private originalGuttersParent: HTMLElement | null = null
      private originalContentParent: HTMLElement | null = null

      constructor(private readonly view: EditorView) {
        this.install(view)
        view.scrollDOM.addEventListener('mousedown', this.handleBlankSpaceMouseDown)
      }

      private readonly handleBlankSpaceMouseDown = (event: MouseEvent) => {
        const view = this.view
        if (event.defaultPrevented || event.button !== 0 || event.detail > 1
          || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey
          || view.state.readOnly || !view.state.facet(EditorView.editable)) return

        // CodeMirror handles clicks inside contentDOM; its surrounding page needs its own focus target.
        if (event.target !== view.scrollDOM && event.target !== this.sizerEl
          && event.target !== this.contentContainerEl) return

        const bounds = view.scrollDOM.getBoundingClientRect()
        if (event.clientX >= bounds.left + view.scrollDOM.clientWidth
          || event.clientY >= bounds.top + view.scrollDOM.clientHeight) return

        event.preventDefault()
        view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true, userEvent: 'select.pointer' })
        view.focus()
      }

      update(_update: ViewUpdate) {
        // No-op: the surgery only runs at init/destroy.
      }

      private install(view: EditorView) {
        const scrollDOM = view.scrollDOM
        const contentDOM = view.contentDOM
        const guttersEl = scrollDOM.querySelector<HTMLElement>(':scope > .cm-gutters')

        // HMR re-entry: surgery already happened. Reuse the existing host.
        const existingSizer = scrollDOM.querySelector<HTMLElement>(':scope > .cm-sizer')
        if (existingSizer) {
          const existingHost = existingSizer.querySelector<HTMLElement>(':scope > .inline-title')
          if (existingHost) {
            this.titleHost = existingHost
            this.sizerEl = existingSizer
            this.contentContainerEl = existingSizer.querySelector<HTMLElement>(':scope > .cm-contentContainer')
            opts.onHostReady(existingHost)
            return
          }
        }

        this.originalContentParent = contentDOM.parentElement
        this.originalGuttersParent = guttersEl ? guttersEl.parentElement : null

        const sizer = document.createElement('div')
        sizer.className = 'cm-sizer'
        const container = document.createElement('div')
        container.className = 'cm-contentContainer'
        sizer.appendChild(container)

        if (guttersEl) container.appendChild(guttersEl)
        container.appendChild(contentDOM)

        const host = document.createElement('div')
        host.className = 'inline-title'
        sizer.prepend(host)

        scrollDOM.appendChild(sizer)

        this.titleHost = host
        this.sizerEl = sizer
        this.contentContainerEl = container

        opts.onHostReady(host)
      }

      destroy() {
        this.view.scrollDOM.removeEventListener('mousedown', this.handleBlankSpaceMouseDown)
        opts.onHostRelease()
        if (!this.sizerEl) return

        const scrollDOM = this.sizerEl.parentElement
        const contentDOM = this.contentContainerEl?.querySelector<HTMLElement>(':scope > .cm-content')
        const guttersEl = this.contentContainerEl?.querySelector<HTMLElement>(':scope > .cm-gutters')

        if (scrollDOM) {
          if (guttersEl && this.originalGuttersParent) this.originalGuttersParent.appendChild(guttersEl)
          if (contentDOM && this.originalContentParent) this.originalContentParent.appendChild(contentDOM)
          this.sizerEl.remove()
        }
        this.titleHost = null
        this.sizerEl = null
        this.contentContainerEl = null
      }
    },
  )
}
