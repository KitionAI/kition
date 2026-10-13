// Copied from kition-sdk packages/kdm/src/overlay.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The pending effects of one transaction. `Tx` validates every operation against the committed
 * document plus this overlay, so a transaction sees its own earlier operations while nothing is
 * written to the engine until it succeeds.
 *
 * The overlay never copies a whole container: a list keeps its length and its pending edits, a
 * text its UTF-16 length and its pending edits, a tree the parents of the nodes this transaction
 * created or moved. The engine is asked for the rest.
 */
import type { LoroText, LoroTree, TreeID } from 'loro-crdt'
import { errors } from './errors'
import type { ObjectId } from './ids'
import { isLowSurrogate } from './value'

/** A tree node as a transaction sees it, tagged: `c:<TreeID>` for a node in the document, `p:<n>` for its n-th created node. */
export type NodeKey = `c:${string}` | `p:${number}`

export const committedKey = (id: string): NodeKey => `c:${id}`
export const pendingKey = (index: number): NodeKey => `p:${index}`
export const pendingIndex = (key: NodeKey): number | null => (key.startsWith('p:') ? Number(key.slice(2)) : null)
export const treeId = (key: NodeKey): TreeID => key.slice(2) as TreeID

/** One pending change of a text, in UTF-16 code units, with the engine operation's index meaning. */
type TextEdit = { index: number; insert: string } | { index: number; delete: number }

/** A text as a transaction sees it: the committed text (`null`: empty), its pending length, and the pending edits. */
export class TextState {
  readonly edits: TextEdit[] = []

  constructor(
    readonly committed: LoroText | null,
    public len: number,
  ) {}

  /**
   * Whether `position` falls between the two halves of a surrogate pair. Every stored string is
   * well formed, so that is when the code unit at `position` is a low surrogate. The position is
   * traced back through the pending edits to an inserted string or to the committed text.
   */
  splits(position: number): boolean {
    if (position <= 0 || position >= this.len) return false
    let at = position
    for (let index = this.edits.length - 1; index >= 0; index -= 1) {
      const edit = this.edits[index]
      if ('insert' in edit) {
        if (at < edit.index) continue
        if (at < edit.index + edit.insert.length) return isLowSurrogate(edit.insert.charCodeAt(at - edit.index))
        at -= edit.insert.length
      } else if (at >= edit.index) at += edit.delete
    }
    const text = this.committed
    if (!text || at <= 0 || at >= text.length) return false
    const scalar = text.convertPos(at, 'utf16', 'unicode')
    return scalar === undefined || text.convertPos(scalar, 'unicode', 'utf16') !== at
  }

  /** The committed text with the pending edits applied. */
  replay(committed: string): string {
    let text = committed
    for (const edit of this.edits) {
      text = 'insert' in edit ? text.slice(0, edit.index) + edit.insert + text.slice(edit.index) : text.slice(0, edit.index) + text.slice(edit.index + edit.delete)
    }
    return text
  }
}

/** One pending change of a list, with the same index meaning as the engine's operation (`move` leaves the item at `to`). */
type ListEdit = { insert: number; item: ObjectId } | { move: number; to: number } | { remove: number }

/** A list as a transaction sees it: its length (the engine's on first touch plus pending edits) and the edits, replayed only when the items are read. */
export class ListState {
  readonly edits: ListEdit[] = []

  constructor(public len: number) {}

  replay(items: ObjectId[]): ObjectId[] {
    const out = [...items]
    const inconsistent = () => errors.engine('a staged list edit does not fit the list')
    for (const edit of this.edits) {
      if ('insert' in edit) {
        if (edit.insert > out.length) throw inconsistent()
        out.splice(edit.insert, 0, edit.item)
      } else if ('move' in edit) {
        if (edit.move >= out.length || edit.to >= out.length) throw inconsistent()
        out.splice(edit.to, 0, ...out.splice(edit.move, 1))
      } else {
        if (edit.remove >= out.length) throw inconsistent()
        out.splice(edit.remove, 1)
      }
    }
    return out
  }
}

/** A tree as a transaction sees it: the engine's tree (`null` for a new one) plus the parents of the nodes this transaction created or moved. */
export class TreeState {
  /** `null` as a value: the node is a root. */
  readonly parents = new Map<NodeKey, NodeKey | null>()

  constructor(readonly committed: LoroTree | null) {}

  /** The node's parent (`null`: a root), or `undefined` if the tree has no such live node. */
  parent(node: NodeKey): NodeKey | null | undefined {
    if (this.parents.has(node)) return this.parents.get(node)
    if (pendingIndex(node) !== null || !this.committed) return undefined
    const found = this.committed.getNodeByID(treeId(node))
    if (!found || found.isDeleted()) return undefined
    const parent = found.parent()
    return parent ? committedKey(parent.id) : null
  }

  contains(node: NodeKey): boolean {
    return this.parent(node) !== undefined
  }

  /** Whether making `parent` the parent of `node` makes `node` its own ancestor. A looping chain (a corrupt tree) counts as a cycle. */
  wouldCycle(node: NodeKey, parent: NodeKey): boolean {
    const seen = new Set<NodeKey>()
    let current: NodeKey | null | undefined = parent
    while (current !== null && current !== undefined) {
      if (current === node || seen.has(current)) return true
      seen.add(current)
      current = this.parent(current)
    }
    return false
  }
}
