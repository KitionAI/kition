// Copied from kition-sdk packages/kdm/src/overlay.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The pending effects of one transaction. `Tx` validates every operation against the committed
 * document plus this overlay, so a transaction sees its own earlier operations while nothing is
 * written to the engine until it succeeds.
 *
 * The overlay never copies a whole container, with one exception: a list keeps its length and its
 * pending edits, a text its UTF-16 length and its pending edits (and reads the committed text once
 * when a transaction checks more positions in it than the engine answers cheaply), a tree the
 * parents of the nodes this transaction created or moved. The engine is asked for the rest.
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

/**
 * A run of a text as a transaction sees it: `length` code units of `text` from `start`, where a
 * `null` text is the committed text.
 */
type Piece = { text: string | null; start: number; length: number }

/**
 * How many positions in the committed text a transaction checks through the engine before it
 * reads the whole committed text instead. The engine's check costs little on a text built from
 * many insertions but scans a text inserted at once, and reading the text costs about as much as
 * one such scan; a keystroke checks one or two positions.
 */
const ENGINE_CHECKS = 4

/**
 * A text as a transaction sees it: the committed text (`null`: empty), its pending length, and
 * the pending edits, kept as a sequence of pieces of the committed text and of inserted strings.
 * The sequence is a gap buffer: the pieces before a cursor in order, and those after it in
 * reverse, so that edits at nearby positions (a sorted list of edits, or typing) cost amortised
 * constant time, and moving the cursor costs the pieces it passes.
 */
export class TextState {
  /** The pieces before the cursor, in order, and their total length (the cursor's position). */
  private readonly before: Piece[] = []
  private beforeLength = 0
  /** The pieces after the cursor, last first: the piece right after the cursor is the last element. */
  private readonly after: Piece[]
  /** The committed text, once read. */
  private committedString: string | null = null
  private engineChecks = 0

  constructor(
    readonly committed: LoroText | null,
    public len: number,
  ) {
    this.after = len > 0 ? [{ text: null, start: 0, length: len }] : []
  }

  /**
   * Whether `position` falls between the two halves of a surrogate pair. Every stored string is
   * well formed, so that is when the code unit at `position` is a low surrogate, in an inserted
   * string or in the committed text.
   */
  splits(position: number): boolean {
    if (position <= 0 || position >= this.len) return false
    this.seek(position)
    const piece = this.after[this.after.length - 1]
    const at = piece.start + position - this.beforeLength
    return piece.text !== null ? isLowSurrogate(piece.text.charCodeAt(at)) : this.committedSplits(at)
  }

  /** Inserts `content` (well formed) at `index`. */
  insert(index: number, content: string): void {
    if (!content) return
    this.cut(index)
    this.before.push({ text: content, start: 0, length: content.length })
    this.beforeLength += content.length
    this.len += content.length
  }

  /** Deletes `count` code units from `index`. */
  delete(index: number, count: number): void {
    if (count === 0) return
    this.cut(index)
    for (let left = count; left > 0; ) {
      const piece = this.after.pop()!
      if (piece.length > left) {
        this.after.push({ text: piece.text, start: piece.start + left, length: piece.length - left })
        break
      }
      left -= piece.length
    }
    this.len -= count
  }

  /** The text with the pending edits applied. */
  text(): string {
    const committed = this.before.some((piece) => piece.text === null) || this.after.some((piece) => piece.text === null) ? this.committedText() : ''
    const slice = (piece: Piece) => (piece.text ?? committed).slice(piece.start, piece.start + piece.length)
    let out = ''
    for (const piece of this.before) out += slice(piece)
    for (let index = this.after.length - 1; index >= 0; index -= 1) out += slice(this.after[index])
    return out
  }

  private committedText(): string {
    this.committedString ??= this.committed?.toString() ?? ''
    return this.committedString
  }

  /** Whether position `at` of the committed text falls inside a surrogate pair. */
  private committedSplits(at: number): boolean {
    const text = this.committed
    if (!text || at <= 0 || at >= text.length) return false
    if (this.committedString === null && this.engineChecks < ENGINE_CHECKS) {
      this.engineChecks += 1
      const scalar = text.convertPos(at, 'utf16', 'unicode')
      return scalar === undefined || text.convertPos(scalar, 'unicode', 'utf16') !== at
    }
    return isLowSurrogate(this.committedText().charCodeAt(at))
  }

  /**
   * Moves the cursor to the start of the piece holding `position` (`position` < `len`), or to the
   * end when `position` is the length.
   */
  private seek(position: number): void {
    const { before, after } = this
    while (this.beforeLength > position) {
      const piece = before.pop()!
      this.beforeLength -= piece.length
      after.push(piece)
    }
    while (after.length > 0 && this.beforeLength + after[after.length - 1].length <= position) {
      const piece = after.pop()!
      this.beforeLength += piece.length
      before.push(piece)
    }
  }

  /** Moves the cursor to `position`, splitting the piece there if `position` falls inside it. */
  private cut(position: number): void {
    this.seek(position)
    const head = position - this.beforeLength
    if (head === 0) return
    const piece = this.after.pop()!
    this.before.push({ text: piece.text, start: piece.start, length: head })
    this.after.push({ text: piece.text, start: piece.start + head, length: piece.length - head })
    this.beforeLength = position
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
