   
                    
  
                                                                             
                        
   

import { Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

const STORAGE_KEY = 'kition.document.spellcheck'

const spellcheckCompartment = new Compartment()

function readPref(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writePref(on: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

export function spellcheckExtension() {
  return spellcheckCompartment.of(
    EditorView.contentAttributes.of({ spellcheck: readPref() ? 'true' : 'false' }),
  )
}

export function isSpellcheckOn(view: EditorView): boolean {
  const attrs = view.state.facet(EditorView.contentAttributes)
  return Array.isArray(attrs)
    ? attrs.some((a) => a?.spellcheck === 'true')
    : (attrs as { spellcheck?: string } | undefined)?.spellcheck === 'true'
}

export function setSpellcheck(view: EditorView, on: boolean): void {
  writePref(on)
  view.dispatch({
    effects: spellcheckCompartment.reconfigure(
      EditorView.contentAttributes.of({ spellcheck: on ? 'true' : 'false' }),
    ),
  })
}

export function readSpellcheckPref(): boolean {
  return readPref()
}
