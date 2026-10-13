/**
 * Undo and redo for editors bound to a document replica: the replica's undo stack replaces
 * CodeMirror's history, so undo reverts only this person's own changes (never a merged file
 * change) and survives editor remounts. Editors without a replica keep CodeMirror's history.
 */
import { redo, undo } from '@codemirror/commands'
import { Facet, Prec, type Extension } from '@codemirror/state'
import { keymap, type Command } from '@codemirror/view'

/** What an editor's undo and redo run against. */
export type DocumentHistory = {
  undo: () => boolean
  redo: () => boolean
}

/** The replica history of an editor, or `null` when it has none (CodeMirror's history then applies). */
const documentHistory = Facet.define<DocumentHistory, DocumentHistory | null>({
  combine: (values) => values[0] ?? null,
})

/** Undo: the replica's when the editor has one, otherwise CodeMirror's. */
export const undoDocument: Command = (view) => {
  const history = view.state.facet(documentHistory)
  if (!history) return undo(view)
  if (view.state.readOnly) return false
  history.undo()
  return true
}

/** Redo: the replica's when the editor has one, otherwise CodeMirror's. */
export const redoDocument: Command = (view) => {
  const history = view.state.facet(documentHistory)
  if (!history) return redo(view)
  if (view.state.readOnly) return false
  history.redo()
  return true
}

/** The bindings of CodeMirror's history keymap, running the replica's undo and redo. */
const documentHistoryKeymap = [
  { key: 'Mod-z', run: undoDocument, preventDefault: true },
  { key: 'Mod-y', mac: 'Mod-Shift-z', run: redoDocument, preventDefault: true },
  { linux: 'Ctrl-Shift-z', run: redoDocument, preventDefault: true },
]

/** Gives an editor the replica's undo and redo (the editor must not load CodeMirror's `history()`). */
export function documentHistoryExtension(history: DocumentHistory): Extension {
  return [documentHistory.of(history), Prec.high(keymap.of(documentHistoryKeymap))]
}
