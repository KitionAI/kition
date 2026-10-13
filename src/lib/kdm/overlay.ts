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
 * A cursor remembers the last piece looked at, so edits at nearby positions (such as a sorted
 * list of edits, or typing) find their piece in amortised constant time.
 */
export class TextState {
  private readonly pieces: Piece[]
  /** The index of the piece at the cursor, and the position where that piece starts. */
  private cursor = 0
  private cursorAt = 0
  /** The committed text, once read. */
  private committedString: string | null = null
  private engineChecks = 0

  constructor(
    readonly committed: LoroText | null,
    public len: number,
  ) {
    this.pieces = len > 0 ? [{ text: null, start: 0, length: len }] : []
  }

  /**
   * Whether `position` falls between the two halves of a surrogate pair. Every stored string is
   * well formed, so that is when the code unit at `position` is a low surrogate, in an inserted
   * string or in the committed text.
   */
  splits(position: number): boolean {
    if (position <= 0 || position >= this.len) return false
    this.seek(position)
    const piece = this.pieces[this.cursor]
    const at = piece.start + position - this.cursorAt
    return piece.text !== null ? isLowSurrogate(piece.text.charCodeAt(at)) : this.committedSplits(at)
  }

  /** Inserts `content` (well formed) at `index`. */
  insert(index: number, content: string): void {
    if (!content) return
    const at = this.boundary(index)
    this.pieces.splice(at, 0, { text: content, start: 0, length: content.length })
    this.len += content.length
  }

  /** Deletes `count` code units from `index`. */
  delete(index: number, count: number): void {
    if (count === 0) return
    const from = this.boundary(index)
    const to = this.boundary(index + count)
    this.pieces.splice(from, to - from)
    this.cursor = from
    this.cursorAt = index
    this.len -= count
  }

  /** The text with the pending edits applied. */
  text(): string {
    const committed = this.pieces.some((piece) => piece.text === null) ? this.committedText() : ''
    let out = ''
    for (const piece of this.pieces) out += (piece.text ?? committed).slice(piece.start, piece.start + piece.length)
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
   * Moves the cursor to the piece holding `position`, or past the last piece when `position` is
   * the length.
   */
  private seek(position: number): void {
    const pieces = this.pieces
    while (this.cursor > 0 && this.cursorAt > position) {
      this.cursor -= 1
      this.cursorAt -= pieces[this.cursor].length
    }
    while (this.cursor < pieces.length && this.cursorAt + pieces[this.cursor].length <= position) {
      this.cursorAt += pieces[this.cursor].length
      this.cursor += 1
    }
  }

  /** Splits the piece holding `position` there, if it does not start there; answers the index of the piece starting at `position` (the cursor is on it). */
  private boundary(position: number): number {
    this.seek(position)
    if (this.cursor === this.pieces.length || this.cursorAt === position) return this.cursor
    const piece = this.pieces[this.cursor]
    const head = position - this.cursorAt
    this.pieces.splice(this.cursor + 1, 0, { text: piece.text, start: piece.start + head, length: piece.length - head })
    piece.length = head
    this.cursorAt = position
    this.cursor += 1
    return this.cursor
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
