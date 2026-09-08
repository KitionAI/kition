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
export class DesignStore {
  private coalescing: string | undefined
  private listeners = new Set<() => void>()
  private past: DesignHistoryEntry[] = []
  private future: DesignHistoryEntry[] = []
  private state: {
    document: DesignDocument
    preview: DesignDocument | null
    selection: string[]
    canUndo: boolean
    canRedo: boolean
  }
  constructor(document: DesignDocument) {
    this.state = {
      document,
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
      selection: topSelection(this.state.document, ids),
    }
    this.publish()
  }
  execute(command: DesignCommand, coalescing?: string) {
    this.commit(applyDesignCommand(this.state.document, command), coalescing)
  }
  endCoalescing() {
    this.coalescing = undefined
  }
  commit(document: DesignDocument, coalescing?: string) {
    if (document === this.state.document) {
      this.cancel()
      return
    }
    document = validateDesign(document)
    const entry = designHistoryEntry(this.state.document, document)
    const last = this.past[this.past.length - 1]
    if (coalescing && coalescing === this.coalescing && last)
      this.past[this.past.length - 1] = mergeDesignHistory(last, entry)
    else this.past.push(entry)
    this.coalescing = coalescing
    if (this.past.length > 100) this.past.shift()
    this.future = []
    this.state = {
      ...this.state,
      document: { ...document, revision: this.state.document.revision + 1 },
      preview: null,
      selection: this.state.selection.filter((id) => document.nodes[id]),
    }
    this.publish()
  }
  preview(command: DesignCommand) {
    this.state = {
      ...this.state,
      preview: applyDesignCommand(this.state.document, command),
    }
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
    this.restore(applyDesignHistory(this.state.document, document, 'before'))
  }
  redo = () => {
    this.endCoalescing()
    const document = this.future.pop()
    if (!document) return
    this.past.push(document)
    this.restore(applyDesignHistory(this.state.document, document, 'after'))
  }
  private restore(document: DesignDocument) {
    this.state = {
      ...this.state,
      document: { ...document, revision: this.state.document.revision + 1 },
      preview: null,
      selection: [],
    }
    this.publish()
  }
}
