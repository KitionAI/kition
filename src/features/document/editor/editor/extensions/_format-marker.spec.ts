   
                         
  
                                                          
                                                                    
                                                     
                    
   
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, type SelectionRange } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { livePreviewExtension } from './live-preview'
import {
  buildSelectionContext,
  editorFocusEffect,
  editorFocusField,
  rangeIsActive,
  shouldHideLineMarker,
} from './_format-marker'

const makeState = (doc: string, focused: boolean) => {
  let state = EditorState.create({
    doc,
    extensions: [editorFocusField],
    selection: { anchor: 0 },
  })
  if (focused) {
    state = state.update({ effects: editorFocusEffect.of(true) }).state
  }
  return state
}

describe('buildSelectionContext', () => {
  it('returns empty active lines when editor is not focused', () => {
    const state = makeState('# H1\nbody', false)
    const ctx = buildSelectionContext(state)
    expect(ctx.activeLines.size).toBe(0)
    expect(ctx.ranges).toEqual([])
  })

  it('includes cursor line when editor is focused', () => {
    const state = makeState('# H1\nbody', true)
    const ctx = buildSelectionContext(state)
    expect(ctx.activeLines.has(1)).toBe(true)
    expect(ctx.activeLines.has(2)).toBe(false)
  })

  it('defaults to unfocused when field is not installed', () => {
    const state = EditorState.create({ doc: '# H1', selection: { anchor: 0 } })
    const ctx = buildSelectionContext(state)
    expect(ctx.activeLines.size).toBe(0)
  })
})

describe('shouldHideLineMarker', () => {
  it('hides H1 hash marker when editor is unfocused even if selection sits on the line', () => {
    const state = makeState('# H1\nbody', false)
    const ctx = buildSelectionContext(state)
    // H1 marker range is [0, 2) -> `# `
    expect(shouldHideLineMarker(ctx, state, 1, 0, 2)).toBe(true)
  })

  it('keeps marker visible when focused and cursor on that line', () => {
    const state = makeState('# H1\nbody', true)
    const ctx = buildSelectionContext(state)
    expect(shouldHideLineMarker(ctx, state, 1, 0, 2)).toBe(false)
  })

  it('keeps marker visible when line text is just the marker (e.g. user just typed "#")', () => {
    // Even unfocused: lineTextIsJustMarker short-circuit protects single-marker lines
    const state = makeState('#', false)
    const ctx = buildSelectionContext(state)
    expect(shouldHideLineMarker(ctx, state, 1, 0, 1)).toBe(false)
  })
})

   
                                                               
                                                          
                                                 
   
describe('livePreviewExtension focus tracking (integration)', () => {
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
        ],
      }),
    })
    return { view, host, cleanup: () => { view.destroy(); host.remove() } }
  }

  const hashHidden = (view: EditorView): boolean => {
                                              
    const lineEl = view.dom.querySelector('.cm-content .cm-line')
    const mark = lineEl?.querySelector('.cm-md-h-mark')
    if (!mark) return false
    return mark.classList.contains('cm-md-h-mark-hidden')
  }

  it('hides H1 hash on mount (editor not yet focused)', () => {
    const { view, cleanup } = mountEditor('# H1\nbody')
    try {
      expect(view.state.field(editorFocusField, false)).toBe(false)
      expect(hashHidden(view)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('shows H1 hash after editor receives focus with cursor on heading', () => {
    const { view, cleanup } = mountEditor('# H1\nbody')
    try {
      // Simulate browser focus on the contenteditable
      view.contentDOM.focus()
      view.contentDOM.dispatchEvent(new FocusEvent('focus'))
      // Field should now be true and marker should be visible
      expect(view.state.field(editorFocusField, false)).toBe(true)
      // Selection is at pos 0 (line 1, the H1), so marker on line 1 should be visible
      expect(hashHidden(view)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('re-hides H1 hash when editor loses focus', () => {
    const { view, cleanup } = mountEditor('# H1\nbody')
    try {
      view.contentDOM.focus()
      view.contentDOM.dispatchEvent(new FocusEvent('focus'))
      expect(hashHidden(view)).toBe(false)
      view.contentDOM.dispatchEvent(new FocusEvent('blur'))
      expect(view.state.field(editorFocusField, false)).toBe(false)
      expect(hashHidden(view)).toBe(true)
    } finally {
      cleanup()
    }
  })
})

   
                                          
  
                                                   
                                                
                       
  
                                                             
                             
  
                                                                  
                                     
   
const makeFocusedState = (
  doc: string,
  selection: EditorSelection | SelectionRange,
): EditorState => {
  let state = EditorState.create({
    doc,
                                                                 
    extensions: [editorFocusField, EditorState.allowMultipleSelections.of(true)],
    selection: 'ranges' in selection ? selection : EditorSelection.create([selection]),
  })
  state = state.update({ effects: editorFocusEffect.of(true) }).state
  return state
}

describe('buildSelectionContext — head-only active line (Document fidelity)', () => {
  it('only the head line is active when selection spans multiple lines forward', () => {
    // doc: line1 [0,5), line2 [6,11), line3 [12,17)
    const state = makeFocusedState(
      'line1\nline2\nline3',
      EditorSelection.range(0, 14), // anchor on line 1, head on line 3
    )
    const ctx = buildSelectionContext(state)
    expect(ctx.activeLines.has(1)).toBe(false)
    expect(ctx.activeLines.has(2)).toBe(false)
    expect(ctx.activeLines.has(3)).toBe(true)
  })

  it('only the head line is active when selection is reversed (head on first line)', () => {
    const state = makeFocusedState(
      'line1\nline2\nline3',
      EditorSelection.range(14, 0), // anchor on line 3, head on line 1
    )
    const ctx = buildSelectionContext(state)
    expect(ctx.activeLines.has(1)).toBe(true)
    expect(ctx.activeLines.has(2)).toBe(false)
    expect(ctx.activeLines.has(3)).toBe(false)
  })

  it('ranges contain head positions (collapsed), not the full selection extent', () => {
    const state = makeFocusedState(
      'line1\nline2\nline3',
      EditorSelection.range(0, 14),
    )
    const ctx = buildSelectionContext(state)
    expect(ctx.ranges).toEqual([{ from: 14, to: 14 }])
  })

  it('multi-cursor: each head contributes its own active line', () => {
    const state = makeFocusedState(
      'line1\nline2\nline3',
      EditorSelection.create(
        [EditorSelection.cursor(2), EditorSelection.cursor(13)],
        0,
      ),
    )
    const ctx = buildSelectionContext(state)
    expect(ctx.activeLines.has(1)).toBe(true)
    expect(ctx.activeLines.has(2)).toBe(false)
    expect(ctx.activeLines.has(3)).toBe(true)
  })
})

describe('rangeIsActive — head-only marker reveal (Document fidelity)', () => {
  // doc: 'before [label](https://example.com) tail'
  //  '[' at 7, ']' at 13, '(' at 14, ')' at 34, link node = [7, 35)
  const linkDoc = 'before [label](https://example.com) tail'
  const linkFrom = 7
  const linkTo = 35

  it('returns false when selection covers the link but head is outside it', () => {
    const state = makeFocusedState(
      linkDoc,
      EditorSelection.range(0, linkDoc.length), // head at end of doc, past link
    )
    const ctx = buildSelectionContext(state)
    expect(rangeIsActive(ctx, linkFrom, linkTo)).toBe(false)
  })

  it('returns false when head is just past marker.to', () => {
    const state = makeFocusedState(linkDoc, EditorSelection.cursor(linkTo + 1))
    const ctx = buildSelectionContext(state)
    expect(rangeIsActive(ctx, linkFrom, linkTo)).toBe(false)
  })

  it('returns false when head is just before marker.from', () => {
    const state = makeFocusedState(linkDoc, EditorSelection.cursor(linkFrom - 1))
    const ctx = buildSelectionContext(state)
    expect(rangeIsActive(ctx, linkFrom, linkTo)).toBe(false)
  })

  it('returns true when head sits inside the link', () => {
    const state = makeFocusedState(linkDoc, EditorSelection.cursor(linkFrom + 3))
    const ctx = buildSelectionContext(state)
    expect(rangeIsActive(ctx, linkFrom, linkTo)).toBe(true)
  })

  it('returns true at the boundary head === marker.from (edge-inclusive)', () => {
    const state = makeFocusedState(linkDoc, EditorSelection.cursor(linkFrom))
    const ctx = buildSelectionContext(state)
    expect(rangeIsActive(ctx, linkFrom, linkTo)).toBe(true)
  })

  it('returns true at the boundary head === marker.to (edge-inclusive)', () => {
    const state = makeFocusedState(linkDoc, EditorSelection.cursor(linkTo))
    const ctx = buildSelectionContext(state)
    expect(rangeIsActive(ctx, linkFrom, linkTo)).toBe(true)
  })

  it('multi-cursor: returns true iff some head is inside the marker', () => {
    const state = makeFocusedState(
      linkDoc,
      EditorSelection.create(
        [EditorSelection.cursor(0), EditorSelection.cursor(linkFrom + 5)],
        0,
      ),
    )
    const ctx = buildSelectionContext(state)
    expect(rangeIsActive(ctx, linkFrom, linkTo)).toBe(true)
  })
})

   
                                                   
                                                  
      
   
describe('livePreviewExtension — selection across link does not reveal URL', () => {
  const mountFocused = (doc: string, selection: EditorSelection | SelectionRange) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: 'ranges' in selection ? selection : EditorSelection.create([selection]),
        extensions: [markdown({ base: markdownLanguage }), livePreviewExtension()],
      }),
    })
    view.contentDOM.focus()
    view.contentDOM.dispatchEvent(new FocusEvent('focus'))
    return { view, cleanup: () => { view.destroy(); host.remove() } }
  }

  it('keeps the link collapsed when selection spans the link but head is on a later line', () => {
                                                   
                         
    const doc = 'intro before [label](https://example.com) middle\nnext line tail'
    const headPos = doc.length                       
    const { view, cleanup } = mountFocused(doc, EditorSelection.range(0, headPos))
    try {
      const link = view.dom.querySelector('.cm-md-link')
      expect(link, 'link span should exist').not.toBeNull()
                                            
      expect(link!.classList.contains('cm-md-link-expanded')).toBe(false)
    } finally {
      cleanup()
    }
  })
})

