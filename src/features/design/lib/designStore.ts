import { validateDesign } from './designSerialization'
import {
  applyDesignHistory,
  designHistoryEntry,
  mergeDesignHistory,
  type DesignHistoryEntry,
} from './designHistory'
import { applyDesignCommand, type DesignCommand } from './designCommands'
import type { DesignDocument } from './designTypes'
import { topSelection } from './designGeometry'
import { previewDesignTransform } from './designTransformPreview'
import {
  createDesignVariant,
  foldDesignVariant,
  removeDesignVariant,
  resolveDesignVariant,
} from './designVariants'
/**
 * Holds the saved document (the base with its variants), the view the user
 * edits (the active variant resolved), an optional preview of a pending
 * gesture, and undo history over the base. Commands apply to the view and
 * fold back into the base, so variants stay in sync with shared edits.
 */
export class DesignStore {
  private coalescing: string | undefined
  private listeners = new Set<() => void>()
  private past: DesignHistoryEntry[] = []
  private future: DesignHistoryEntry[] = []
  private state: {
    document: DesignDocument
    view: DesignDocument
    variantId: string | null
    preview: DesignDocument | null
    selection: string[]
    canUndo: boolean
    canRedo: boolean
  }
  constructor(document: DesignDocument) {
    this.state = {
      document,
      view: document,
      variantId: null,
      preview: null,
      selection: [],
      canUndo: false,
      canRedo: false,
    }
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish() {
    this.state = {
      ...this.state,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
    }
    this.listeners.forEach((fn) => fn())
  }
  select(ids: string[]) {
    this.state = {
      ...this.state,
      selection: topSelection(this.state.view, ids),
    }
    this.publish()
  }
  /** Switches the edited artboard; null is the primary. */
  setVariant(variantId: string | null) {
    const id = variantId && this.state.document.variants?.[variantId] ? variantId : null
    this.state = {
      ...this.state,
      variantId: id,
      view: resolveDesignVariant(this.state.document, id),
      preview: null,
      selection: [],
    }
    this.publish()
  }
  addVariant(input: { name: string; width: number; height: number }) {
    const { document, variantId } = createDesignVariant(this.state.document, input)
    this.commitBase(document)
    this.setVariant(variantId)
    return variantId
  }
  removeVariant(variantId: string) {
    if (this.state.variantId === variantId) this.setVariant(null)
    this.commitBase(removeDesignVariant(this.state.document, variantId))
  }
  execute(command: DesignCommand, coalescing?: string) {
    this.commit(applyDesignCommand(this.state.view, command), coalescing)
  }
  endCoalescing() {
    this.coalescing = undefined
  }
  /** Records an edited view as one history step. */
  commit(view: DesignDocument, coalescing?: string) {
    if (view === this.state.view) {
      this.cancel()
      return
    }
    this.commitBase(
      foldDesignVariant(this.state.document, validateDesign(view), this.state.variantId),
      coalescing,
    )
  }
  private commitBase(document: DesignDocument, coalescing?: string) {
    if (document === this.state.document) return
    document = validateDesign(document)
    const entry = designHistoryEntry(this.state.document, document)
    const last = this.past[this.past.length - 1]
    if (coalescing && coalescing === this.coalescing && last)
      this.past[this.past.length - 1] = mergeDesignHistory(last, entry)
    else this.past.push(entry)
    this.coalescing = coalescing
    if (this.past.length > 100) this.past.shift()
    this.future = []
    this.setDocument(document, this.state.selection.filter((id) => document.nodes[id]))
  }
  private setDocument(document: DesignDocument, selection: string[]) {
    const next = { ...document, revision: this.state.document.revision + 1 }
    const variantId = this.state.variantId && next.variants?.[this.state.variantId] ? this.state.variantId : null
    this.state = {
      ...this.state,
      document: next,
      variantId,
      view: resolveDesignVariant(next, variantId),
      preview: null,
      selection,
    }
    this.publish()
  }
  preview(command: DesignCommand) {
    this.state = {
      ...this.state,
      preview: command.type === 'transform'
        ? previewDesignTransform(this.state.view, command.ids, command.matrix)
        : applyDesignCommand(this.state.view, command),
    }
    this.publish()
  }
  /** Shows a proposed document without touching history; commit or cancel ends it. */
  showPreview(document: DesignDocument) {
    this.state = { ...this.state, preview: document }
    this.publish()
  }
  commitPreview() {
    if (this.state.preview) this.commit(this.state.preview)
  }
  cancel() {
    if (this.state.preview) {
      this.state = { ...this.state, preview: null }
      this.publish()
    }
  }
  undo = () => {
    this.endCoalescing()
    const document = this.past.pop()
    if (!document) return
    this.future.push(document)
    this.setDocument(applyDesignHistory(this.state.document, document, 'before'), [])
  }
  redo = () => {
    this.endCoalescing()
    const document = this.future.pop()
    if (!document) return
    this.past.push(document)
    this.setDocument(applyDesignHistory(this.state.document, document, 'after'), [])
  }
}
