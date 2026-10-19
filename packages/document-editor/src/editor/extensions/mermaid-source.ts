import { StateEffect, StateField } from '@codemirror/state'

type SourceRange = { from: number; to: number } | null
export const revealMermaidSourceEffect = StateEffect.define<SourceRange>()

/** Selection alone never opens diagram source; only its explicit edit control does. */
export const revealedMermaidSourceField = StateField.define<SourceRange>({
  create: () => null,
  update(value, transaction) {
    if (value && transaction.docChanged) {
      const from = transaction.changes.mapPos(value.from, -1)
      const to = transaction.changes.mapPos(value.to, 1)
      value = from < to ? { from, to } : null
    }
    for (const effect of transaction.effects) {
      if (effect.is(revealMermaidSourceEffect)) value = effect.value
    }
    if (value && transaction.selection && !transaction.state.selection.ranges.some(
      (range) => range.to >= value!.from && range.from <= value!.to,
    )) return null
    return value
  },
})
