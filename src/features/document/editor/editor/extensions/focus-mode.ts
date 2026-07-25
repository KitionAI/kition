   
                          
  
                                     
                                
  
                                     
   

import { StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

const toggleFocusEffect = StateEffect.define<boolean>()
const toggleTypewriterEffect = StateEffect.define<boolean>()

const focusModeField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(toggleFocusEffect)) return e.value
    return value
  },
})

const typewriterField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(toggleTypewriterEffect)) return e.value
    return value
  },
})

const dimDeco = Decoration.line({ class: 'cm-document-focus-dim' })
const focusDeco = Decoration.line({ class: 'cm-document-focus-active' })

const focusViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.build(update.view)
      }
    }

    private build(view: EditorView): DecorationSet {
      if (!view.state.field(focusModeField)) return Decoration.none
      const head = view.state.selection.main.head
      const activeLine = view.state.doc.lineAt(head).number
      const builder: { from: number; deco: Decoration }[] = []
      for (const { from, to } of view.visibleRanges) {
        const fromLine = view.state.doc.lineAt(from).number
        const toLine = view.state.doc.lineAt(to).number
        for (let n = fromLine; n <= toLine; n++) {
          const line = view.state.doc.line(n)
          builder.push({ from: line.from, deco: n === activeLine ? focusDeco : dimDeco })
        }
      }
      builder.sort((a, b) => a.from - b.from)
      const set = Decoration.none
      // Use RangeSetBuilder via Decoration.set
      return Decoration.set(builder.map((b) => b.deco.range(b.from)), true)
      void set
    }
  },
  {
    decorations: (v) => v.decorations,
  },
)

const typewriterScrollPlugin = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (!update.state.field(typewriterField)) return
      if (!update.selectionSet && !update.docChanged) return
      const view = update.view
      const head = view.state.selection.main.head
      const block = view.lineBlockAt(head)
      const scroller = view.scrollDOM
      const desired = scroller.clientHeight / 2 - (block.bottom - block.top) / 2
      const coords = view.coordsAtPos(head)
      if (!coords) return
      const scrollerRect = scroller.getBoundingClientRect()
      const relativeTop = coords.top - scrollerRect.top
      const delta = relativeTop - desired
      if (Math.abs(delta) < 4) return
      scroller.scrollTop += delta
    }
  },
)

const focusTheme = EditorView.theme({
  '.cm-document-focus-dim': {
    opacity: '0.32',
    transition: 'opacity 200ms ease',
  },
  '.cm-document-focus-active': {
    opacity: '1',
    transition: 'opacity 200ms ease',
  },
})

export function focusModeExtension(): Extension {
  return [focusModeField, focusViewPlugin, focusTheme]
}

export function typewriterModeExtension(): Extension {
  return [typewriterField, typewriterScrollPlugin]
}

export function setFocusMode(view: EditorView, enabled: boolean): void {
  view.dispatch({ effects: toggleFocusEffect.of(enabled) })
}

export function setTypewriterMode(view: EditorView, enabled: boolean): void {
  view.dispatch({ effects: toggleTypewriterEffect.of(enabled) })
}

export function isFocusModeOn(view: EditorView): boolean {
  return view.state.field(focusModeField, false) ?? false
}

export function isTypewriterModeOn(view: EditorView): boolean {
  return view.state.field(typewriterField, false) ?? false
}
