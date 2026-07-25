// src/features/search/ui/searchHitFlash.ts
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField, EditorSelection } from '@codemirror/state'

const setFlash = StateEffect.define<{ from: number; to: number } | null>()

const flashField = StateField.define<DecorationSet>({
  create() { return Decoration.none },
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        if (e.value === null) return Decoration.none
        return Decoration.set([
          Decoration.mark({ class: 'cm-search-hit-flash' }).range(e.value.from, e.value.to),
        ])
      }
    }
    return deco
  },
  provide: f => EditorView.decorations.from(f),
})

export function searchHitFlashExtension() { return [flashField] }

export function flashHit(view: EditorView, from: number, to: number, ms = 1500) {
  view.dispatch({
    effects: setFlash.of({ from, to }),
    selection: EditorSelection.cursor(from),
    scrollIntoView: true,
  })
  setTimeout(() => {
    view.dispatch({ effects: setFlash.of(null) })
  }, ms)
}
